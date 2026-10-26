// Part 1 through the connector: mark_silences, mark_fillers, list_marks and get_retakes measure and never cut;
// apply_edits add_marks / update_mark / delete_mark keep the AI's marks with the edit (and undo takes them back);
// cut_silences and remove_fillers are refused with what to do instead; apply_style sets looks only.
// Needs a database and Redis (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Line, Transcript, Word } from "@rendrr/shared";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

let wn = 0;
function line(id: string, start: number, text: string, fillers: string[] = []): Line {
  const words: Word[] = text.split(" ").map((w, i) => ({ id: `w${wn++}`, text: w, t: +(start + i * 0.35).toFixed(3), end: +(start + i * 0.35 + 0.3).toFixed(3), filler: fillers.includes(w.toLowerCase().replace(/[^a-z]/g, "")) }));
  return { id, start, end: words[words.length - 1].end, gapBefore: 0, words };
}
const tr: Transcript = [
  line("l0", 0.5, "Hi everyone, welcome back to the channel."),
  line("l1", 3.5, "Today we are going to build a"),
  line("l2", 6.5, "Today we are going to build a, um, website.", ["um"]),
  line("l3", 11.5, "Sorry, let me start again."),
  line("l4", 14, "Today we are going to build a website from scratch in ten minutes."),
  line("l5", 19, "It is it is really easy, uh, if you follow along.", ["uh"]),
];

describe("marks through the connector", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");

  let userId = "", videoId = "", projectId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `marks_${run}` });
  const timelineOf = async () => (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { marks?: { id: string; kind: string; note?: string }[]; markEdits?: Record<string, unknown>; cut: string[] };

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `marks_${run}`, email: `marks-${run}@test.rendrr.dev`, name: "Marks" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Marks's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: tr as never, silences: [{ start: 2.9, end: 3.45 }, { start: 24, end: 30 }] as never, sceneCuts: [10], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 30, width: 1920, height: 1080, source: "drive", status: "ready", analysis } })).id;
    projectId = (await createProject(userId, { videoId })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
  });

  it("mark_silences lists silences with exact times and levels, and cuts nothing", async () => {
    const before = await timelineOf();
    const r = await TOOL_HANDLERS.mark_silences(c(), { videoId });
    assert.match(r.text, /^SILENCES 0\.3s\+ in "Talk \w+": \d+\. Footage seconds; level_db -35/);
    assert.match(r.text, /\nid start-end length level_db\n/);
    assert.match(r.text, /\nsil_0_\w{4} 0-0\.5 0\.500 null\n/); // before the first word
    assert.match(r.text, /\nsil_2900_\w{4} 2\.9-3\.5 0\.600 -35\n/); // quiet in the audio
    assert.match(r.text, /Nothing was cut/);
    // minLength: only longer ones.
    const long = await TOOL_HANDLERS.mark_silences(c(), { videoId, minLength: 1.5 });
    assert.doesNotMatch(long.text, /sil_2900_/);
    assert.match(long.text, /after the last word|\d+\.\d+-30 /);
    assert.deepEqual(await timelineOf(), before);
  });

  it("on an edit: where each silence plays, ones already cut left out (and counted)", async () => {
    await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "cut_words", from: 2.9, to: 3.5 }] });
    const r = await TOOL_HANDLERS.mark_silences(c(), { projectId });
    assert.match(r.text, /\(1 more already cut from the edit: includeCut true lists them\)/);
    assert.match(r.text, /\nid start-end length level_db \| edit start-end\n/);
    assert.match(r.text, /\nsil_0_\w{4} 0-0\.5 0\.500 null \| edit 0-0\.5\n/);
    const all = await TOOL_HANDLERS.mark_silences(c(), { projectId, includeCut: true });
    assert.match(all.text, /sil_2900_\w{4} 2\.9-3\.5 0\.600 -35 \| cut/);
  });

  it("mark_fillers gives word ids; the AI cuts the ones it chooses with cut_words", async () => {
    const r = await TOOL_HANDLERS.mark_fillers(c(), { projectId });
    const ids = [...r.text.matchAll(/\nfil_\S+ (w\d+) "([^"]+)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(ids.map((x) => x[1]), ["um,", "uh,"]);
    await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "cut_words", wordIds: [ids[0][0]] }] });
    const after1 = await TOOL_HANDLERS.mark_fillers(c(), { projectId });
    assert.match(after1.text, /FILLERS in edit "[^"]+": 1 \(1 more already cut/);
  });

  it("list_marks: every kind with counts, a kind filter, and edit seconds", async () => {
    const r = await TOOL_HANDLERS.list_marks(c(), { projectId });
    assert.match(r.text, /^MARKS on edit "[^"]+": \d+ \(silence \d+, filler 2, retake 3, stumble 1, false_start 2, director_note 1, scene_change 1\)/);
    assert.match(r.text, /scene_change/);
    const only = await TOOL_HANDLERS.list_marks(c(), { projectId, kind: ["retake", "director_note"] });
    const rows = only.text.split("\n").filter((l) => /^(rt|dir)_/.test(l));
    assert.equal(rows.length, 4);
    assert.match(only.text, /rt_3500_\w{4} retake 3\.5-5\.9 rendrr [\d.]+ "rt1 take 1 of 3" \(score [\d.]+: 7 words, 0 fillers, 0 stumbles, \d+ wpm\) \| edit 2\.9-5\.3/);
    assert.match(only.text, /dir_11500_\w{4} director_note .*"let me start again"/);
    const early = await TOOL_HANDLERS.list_marks(c(), { projectId, from: 0, to: 2, edit: true });
    assert.doesNotMatch(early.text, /rt_/);
    await assert.rejects(TOOL_HANDLERS.list_marks(c(), { videoId, from: 0, to: 2, edit: true }), /edit true needs projectId/);
  });

  it("get_retakes: groups of takes, each measured; Rendrr never picks one", async () => {
    const r = await TOOL_HANDLERS.get_retakes(c(), { projectId });
    assert.match(r.text, /^RETAKES in edit "[^"]+": 1 group .*Rendrr never picks a take/);
    const groups = JSON.parse(r.text.split("\n")[1]) as { groupId: string; takes: { lineId: string; words: number; fillers: number; score: number; edit: unknown }[] }[];
    assert.equal(groups[0].groupId, "rt1");
    assert.deepEqual(groups[0].takes.map((t) => t.lineId), ["l1", "l2", "l4"]);
    assert.ok(groups[0].takes[2].score > groups[0].takes[0].score);
    assert.ok(groups[0].takes.every((t) => "edit" in t));
  });

  it("add_marks, a note on Rendrr's mark, delete_mark; undo takes them back", async () => {
    const add = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "add_marks", marks: [{ kind: "retake", start: 14, end: 18.5, note: "best take" }] }] });
    const id = /added mark (mk_\w+)/.exec(add.text)![1];
    assert.equal((await timelineOf()).marks![0].note, "best take");
    const dir = /\n(dir_11500_\w{4})/.exec((await TOOL_HANDLERS.list_marks(c(), { projectId, kind: "director_note" })).text)![1];
    const note = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "update_mark", id: dir, note: "cut l3, it is a note to the crew" }] });
    assert.match(note.text, /updated Rendrr's mark dir_11500_\w{4}: note/);
    const listed = await TOOL_HANDLERS.list_marks(c(), { projectId, kind: ["director_note", "retake"], source: undefined });
    assert.match(listed.text, new RegExp(`${id} retake 14-18\\.5 ai \\(best take\\)`));
    assert.match(listed.text, /dir_11500_\w{4} director_note .*\(cut l3, it is a note to the crew\)/);
    await assert.rejects(TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "update_mark", id: "sil_77777_zzzz", note: "x" }] }), /There is no mark sil_77777_zzzz/);
    await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "delete_mark", ids: [dir] }] });
    assert.doesNotMatch((await TOOL_HANDLERS.list_marks(c(), { projectId, kind: "director_note" })).text, /dir_/);
    assert.match((await TOOL_HANDLERS.list_marks(c(), { projectId, kind: "director_note", includeHidden: true })).text, /dir_11500_\w{4} .* hidden/);
    // Undo three times: the hide, the note and the mark go back.
    await TOOL_HANDLERS.undo(c(), { projectId, steps: 3 });
    const tl = await timelineOf();
    assert.equal(tl.marks, undefined);
    assert.equal(tl.markEdits, undefined);
  });

  it("cut_silences and remove_fillers are refused with what to do instead, and nothing is saved", async () => {
    const v0 = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersion;
    await assert.rejects(TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "cut_silences", overSeconds: 0.4 }] }), /cut_silences is retired.*mark_silences/);
    await assert.rejects(TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "remove_fillers" }] }), /remove_fillers is retired.*mark_fillers/);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersion, v0);
  });

  it("apply_style sets the captions only and names the rest; get_project counts the marks", async () => {
    const p0 = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "apply_style", styleId: "s1" }] });
    assert.match(r.text, /applied style .* \(looks only\): captions \w+\. Its other rules, for you to do with explicit edits if you want them: /);
    const p1 = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.equal(p1.outputSeconds, p0.outputSeconds);
    assert.deepEqual((p1.timeline as { tracks: unknown }).tracks, (p0.timeline as { tracks: unknown }).tracks);
    const g = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(g.text, /Marks on the footage \(list_marks, mark_silences, mark_fillers, get_retakes\): silence \d+, filler 2, retake 3/);
    const style = await TOOL_HANDLERS.get_style(c(), { styleId: "s1" });
    assert.match(style.text, /apply_style sets its captions only\. Its other rules, for you to carry out with explicit edits: /);
  });
});
