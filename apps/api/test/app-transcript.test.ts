// The Transcript tab of the Rendrr app in the chat: the footage word by word with each word's state in the edit (in,
// cut, out) and where it plays in the render watched; Apply cuts words and brings cut ones back as one new version made
// by the user, with the same ops as the editor and the AI (cut_words, restore_words); words a range cut took out come
// back too; nobody else's edit; nothing to apply is refused.
// Needs a database, Redis and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import type { AppTranscript, AppTranscriptChange, AppWord } from "@rendrr/shared";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("the app's transcript: cut words and bring them back from the chat", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS, APP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { APP_HANDLERS } = await import("../src/services/claudeApp");
  const { redis } = await import("@rendrr/core");

  let userId = "", otherId = "", videoId = "", projectId = "", previewV1 = "";
  const app = async <T,>(name: string, input: Record<string, unknown>, id = userId) => (await APP_HANDLERS[name]({ userId: id, ai: "claude" }, APP_TOOLS.find((t) => t.name === name)!.input.parse(input))) as { text: string; data: T };
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const words = (t: AppTranscript) => t.lines.flatMap((l) => l.words);
  const byId = (t: AppTranscript) => new Map(words(t).map((w) => [w[0], w] as [string, AppWord]));

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `atr_${run}`, email: `atr-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `atr2_${run}`, email: `atr2-${run}@test.rendrr.dev`, name: "Other" } })).id;
    await prisma.folder.create({ data: { userId, name: "Client A", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1080, height: 1920, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, thumbKey: `thumbs/${run}.jpg`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Reel ${run}` })).id;
    previewV1 = (await prisma.render.create({ data: { projectId, userId, kind: "preview", version: 1, status: "done", outputKey: `renders/${run}-v1.mp4`, seconds: 20, quality: "540p", steps: [] } })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await redis().quit().catch(() => {});
  });

  it("shows every word in the edit, with where it plays, line by line", async () => {
    const { data: t, text } = await app<AppTranscript>("app_get_transcript", { projectId });
    console.log(text);
    assert.equal(t.version, 1);
    assert.ok(t.lines.length > 3, "lines");
    assert.ok(t.counts.words > 20, "words");
    assert.equal(t.counts.cut, 0);
    assert.equal(t.counts.out, 0);
    for (const w of words(t)) {
      assert.equal(w[4], "in");
      assert.equal(typeof w[5], "number", `${w[1]} plays`);
    }
    // In order, and each word's edit time is its footage time here (nothing is cut yet; the edit starts at the footage's start).
    const ats = words(t).map((w) => w[5]!);
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
    assert.ok(Math.abs(words(t)[3][5]! - words(t)[3][2]) < 0.01);
  });

  it("Apply cuts the words picked: one new version by the user; the preview watched keeps its own times", async () => {
    const t0 = (await app<AppTranscript>("app_get_transcript", { projectId })).data;
    const ws = words(t0);
    const pick = ws.slice(4, 7).map((w) => w[0]);
    const { data: r, text } = await app<AppTranscriptChange>("app_cut_words", { projectId, cut: pick, renderId: previewV1 });
    console.log(text);
    assert.equal(r.changed, true);
    assert.equal(r.version, 2);
    assert.equal(r.cut, 3);
    assert.match(r.summary, /3 words/);
    const v = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v: 2 } } });
    assert.equal(v?.createdBy, "user", "made by the user, as a cut in the editor");
    // The edit now: the three words are cut and nothing else is.
    assert.equal(r.transcript.version, 2);
    assert.equal(r.transcript.counts.cut, 3);
    const now = byId(r.transcript);
    for (const id of pick) assert.equal(now.get(id)![4], "cut");
    // The times are preview v1's (the render watched): the cut words still play there, at their old times.
    assert.deepEqual(r.transcript.timesOf, { version: 1, renderId: previewV1 });
    for (const id of pick) assert.equal(now.get(id)![5], byId(t0).get(id)![5]);
    // The app's view of the edit is v2, its preview still v1 (a render shows the cut).
    assert.equal(r.view.project.version, 2);
    assert.equal(r.view.preview?.version, 1);
    // The edit's own times: the cut words do not play, and the words after them play earlier.
    const t2 = (await app<AppTranscript>("app_get_transcript", { projectId })).data;
    assert.deepEqual(t2.timesOf, { version: 2, renderId: null });
    const after = byId(t2);
    for (const id of pick) assert.equal(after.get(id)![5], null);
    const next = ws[8][0];
    assert.ok(after.get(next)![5]! < byId(t0).get(next)![5]! - 0.2, "later words play earlier");
  });

  it("bringing words back undoes the cut, in a version of its own", async () => {
    const t = (await app<AppTranscript>("app_get_transcript", { projectId })).data;
    const cut = words(t).filter((w) => w[4] === "cut").map((w) => w[0]);
    assert.equal(cut.length, 3);
    const { data: r } = await app<AppTranscriptChange>("app_cut_words", { projectId, restore: cut });
    assert.equal(r.version, 3);
    assert.equal(r.restored, 3);
    assert.equal(r.transcript.counts.cut, 0);
    for (const w of words(r.transcript)) assert.equal(w[4], "in");
  });

  it("a range the AI cut shows its words out of the edit; bringing them back puts the footage back", async () => {
    await tool("apply_edits", { projectId, edits: [{ op: "cut_words", from: 6, to: 8 }] });
    const t = (await app<AppTranscript>("app_get_transcript", { projectId })).data;
    const out = words(t).filter((w) => w[4] === "out");
    assert.ok(out.length >= 2, `words out of the edit (${out.length})`);
    for (const w of out) { assert.ok(w[2] >= 6 - 0.01 && w[3] <= 8 + 0.01, `${w[1]} in the range`); assert.equal(w[5], null); }
    const { data: r } = await app<AppTranscriptChange>("app_cut_words", { projectId, restore: out.map((w) => w[0]) });
    assert.equal(r.changed, true);
    assert.match(r.summary, /put back/);
    const back = byId(r.transcript);
    for (const w of out) assert.equal(back.get(w[0])![4], "in");
  });

  it("cuts and brings back in one Apply (a word in both is brought back)", async () => {
    const t = (await app<AppTranscript>("app_get_transcript", { projectId })).data;
    const ws = words(t);
    const { data: r1 } = await app<AppTranscriptChange>("app_cut_words", { projectId, cut: [ws[1][0], ws[2][0]] });
    const { data: r2 } = await app<AppTranscriptChange>("app_cut_words", { projectId, cut: [ws[10][0], ws[2][0]], restore: [ws[1][0], ws[2][0]] });
    assert.equal(r2.version, r1.version + 1, "one version for both");
    const now = byId(r2.transcript);
    assert.equal(now.get(ws[1][0])![4], "in");
    assert.equal(now.get(ws[2][0])![4], "in");
    assert.equal(now.get(ws[10][0])![4], "cut");
  });

  it("nothing picked, unknown words and someone else's edit are refused", async () => {
    await assert.rejects(app("app_cut_words", { projectId }), /Pick words/);
    await assert.rejects(app("app_cut_words", { projectId, cut: ["nope-1", "nope-2"] }), /not in this edit's transcript/);
    // Unknown words beside known ones are left out (the transcript changed under the card): the rest is applied.
    const t = (await app<AppTranscript>("app_get_transcript", { projectId })).data;
    const w = words(t).find((x) => x[4] === "cut")!;
    const { data: r } = await app<AppTranscriptChange>("app_cut_words", { projectId, cut: ["nope-3"], restore: [w[0]] });
    assert.equal(r.changed, true);
    assert.equal(r.cut, 0);
    assert.equal(r.restored, 1);
    await assert.rejects(app("app_get_transcript", { projectId }, otherId), /could not find/i);
    await assert.rejects(app("app_cut_words", { projectId, cut: ["w1"] }, otherId), /could not find/i);
  });

  it("footage still being transcribed shows a note, not an error", async () => {
    const v = await prisma.video.create({ data: { userId, name: `New ${run}`, seconds: 10, width: 1080, height: 1920, source: "drive", status: "ready", proxyKey: `proxies/${run}-b.mp4`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(10) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } });
    const pid = (await createProject(userId, { videoId: v.id, name: `Fresh ${run}` })).id;
    await prisma.footageAnalysis.delete({ where: { videoId: v.id } });
    const { data: t } = await app<AppTranscript>("app_get_transcript", { projectId: pid });
    assert.equal(t.lines.length, 0);
    assert.match(t.note ?? "", /still being transcribed/);
  });
});
