// Engine Part 3 through the connector: get_render's check carries the gaps in the file's sound placed at the joins,
// the words a cut goes through (from the alignment), clicks at joins and the heard transcript's state; get_preview_frames
// gives the transcript as it plays from the preview's sound transcribed again (and queues that for an older preview).
// Needs a database, Redis and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Alignment, FileMeasure, HeardTranscript, Line, Transcript, Word } from "@rendrr/shared";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

let wn = 0;
function line(id: string, start: number, text: string): Line {
  const words: Word[] = text.split(" ").map((w, i) => ({ id: `w${wn++}`, text: w, t: +(start + i * 0.4).toFixed(3), end: +(start + i * 0.4 + 0.3).toFixed(3), filler: false }));
  return { id, start, end: words[words.length - 1].end, gapBefore: 0, words };
}
// 10 s: two lines with a pause between them.
const tr: Transcript = [line("l0", 1, "Hello there my friend."), line("l1", 5, "This is the second line.")];
const words = tr.flatMap((l) => l.words);

describe("the preview check through the connector", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { newRedis, queue, redis } = await import("@rendrr/core");
  const { QUEUES } = await import("@rendrr/shared");
  const { Worker } = await import("bullmq");

  let userId = "", videoId = "", projectId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `pcheck_${run}` });
  // No worker runs here: frames come back as none at once.
  const frames = new Worker(QUEUES.frames.name, async () => [], { connection: newRedis() });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `pcheck_${run}`, email: `pcheck-${run}@test.rendrr.dev`, name: "Check" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Check's Workspace" } });
    // "friend." ends 60 ms later in the sound than the transcriber says.
    const alignment: Alignment = { v: 1, model: "wav2vec2-base-960h", error: null, words: words.map((w) => [w.id, w.t, w.text === "friend." ? w.end + 0.06 : w.end, 0.9] as [string, number, number, number]), unaligned: [] };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 10, width: 1280, height: 720, fps: 30, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`,
      analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [], alignment: alignment as never } } } })).id;
    projectId = (await createProject(userId, { videoId })).id;
    // Two clips: "Hello there my friend." ends at 2.5 (cutting 60 ms off "friend.", whose sound ends at 2.56), then
    // the second line from 5.
    await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 0.8, end: 2.5, label: "" }, { id: "b", start: 5, end: 7.2, label: "" }] }] });
  });
  after(async () => {
    for (const j of await queue("heard").getJobs(["waiting", "prioritized", "delayed"])) if (String(j?.id ?? "").startsWith("heard-")) await j.remove().catch(() => {});
    await frames.close();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await queue("heard").close();
    await redis().quit().catch(() => {});
  });

  // A finished preview of the edit as the render job leaves it: the file measured, its sound too.
  const preview = async (heard?: HeardTranscript) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const measured: FileMeasure = { videoSeconds: 3.9, audioSeconds: 3.9, black: [], silences: [], lufs: -14, peakDb: -1.5, graphics: [],
      // Speech from 0.2; a 0.3 s gap from 1.5 across the join at 1.7 (0.2 s at the end of a, 0.1 s at the start of b).
      sound: { speech: [[0.2, 1.5], [1.8, 3.9]], roomDb: -62, speechDb: -20, breaths: [], joinClicks: [[1.701, 31.2]] } };
    return (await prisma.render.create({ data: { projectId, userId, kind: "preview", version: p.currentVersion, status: "done", outputKey: `previews/${run}/x.mp4`, seconds: 3.9, quality: "540p", startedAt: new Date(), finishedAt: new Date(),
      plan: { measured, outputSeconds: 3.9, operations: [], ...(heard ? { heard } : {}) } as never } })).id;
  };

  it("get_render's check: gaps placed at the join, the clipped word in ms, the click at the join, the heard transcript on its way", async () => {
    const renderId = await preview({ status: "transcribing", startedAt: new Date().toISOString(), seconds: 3.9 });
    const r = await TOOL_HANDLERS.get_render(c(), { renderId });
    assert.match(r.text, /\nGaps in speech from 0\.15s \(measured in the file's sound; edit time, length, where; footage seconds\): 1 at joins: 0:01\.50 0\.30s at the join a\|b: end of a 0\.20s \(footage 2\.300-2\.500\) \+ start of b 0\.10s \(footage 5\.000-5\.100\) \| 1 inside clips/);
    assert.match(r.text, /\nClicks at joins: 1: 0:01\.70 31\.2dB at the join a\|b\n/);
    assert.match(r.text, /\nClipped words \(a cut goes through the word's sound\): 1: "friend" end of a at 0:01\.70 \(footage 2\.500\): 60ms cut off, 300ms plays\n/);
    assert.match(r.text, /\nHeard vs the edit's words: the preview's sound is being transcribed again/);
    assert.match(r.text, /Flags: .*1 click at joins; 1 word cut through \(see Clipped words\)/);
    assert.doesNotMatch(r.text, /\nPauses over/);
  });

  it("get_preview_frames: what is heard once it is transcribed again, with where it differs from the edit's words", async () => {
    const busy = await preview({ status: "transcribing", startedAt: new Date().toISOString(), seconds: 3.9 });
    const b = await TOOL_HANDLERS.get_preview_frames(c(), { projectId });
    assert.match(b.text, /\nTranscript as it plays: the preview's sound is being transcribed again \(transcribing, about \d+ s left\)\. Ask again then/);
    // Heard: "my" came out as "by".
    const heard: HeardTranscript = { status: "done", seconds: 3.9, words: [["Hello", 0.2, 0.5], ["there", 0.6, 0.9], ["by", 1.0, 1.3], ["friend.", 1.4, 1.7], ["This", 1.8, 2.1], ["is", 2.2, 2.5], ["the", 2.6, 2.9], ["second", 3.0, 3.3], ["line.", 3.4, 3.7]], sentences: [[0.2, "Hello there by friend."], [1.8, "This is the second line."]] };
    await prisma.render.update({ where: { id: busy }, data: { plan: { ...((await prisma.render.findUniqueOrThrow({ where: { id: busy } })).plan as object), heard } as never } });
    const d = await TOOL_HANDLERS.get_preview_frames(c(), { projectId });
    assert.match(d.text, /\nTranscript as it plays \(the preview's sound transcribed again; output times\):\n\[0:00\.2\] Hello there by friend\.\n\[0:01\.8\] This is the second line\.\nHeard vs the edit's words: 1 place differs .*: 0:01\.00 heard "by" for "my"$/);
    // The check reads it too.
    assert.match((await TOOL_HANDLERS.get_render(c(), { renderId: busy })).text, /\nHeard vs the edit's words: 1 place differs/);
  });

  it("an older preview (no heard transcript yet) is transcribed now; without a transcriber the footage's word times stand in, said so", async () => {
    const old = await preview();
    const r = await TOOL_HANDLERS.get_preview_frames(c(), { projectId });
    assert.match(r.text, /\nTranscript as it plays: the preview's sound is being transcribed again \(waiting its turn/);
    assert.ok(await queue("heard").getJob(`heard-${old}`), "queued once");
    assert.equal(((await prisma.render.findUniqueOrThrow({ where: { id: old } })).plan as { heard: HeardTranscript }).heard.status, "queued");
    await prisma.render.update({ where: { id: old }, data: { plan: { ...((await prisma.render.findUniqueOrThrow({ where: { id: old } })).plan as object), heard: { status: "off" } } as never } });
    const off = await TOOL_HANDLERS.get_preview_frames(c(), { projectId });
    assert.match(off.text, /\nTranscript as it plays: the preview's sound is not transcribed again \(no transcriber is set up\)\. The edit's words from the footage's word times instead \(not heard; output times\):\n\[0:00\] Hello there my friend\.\n\[0:01\] This is the second line\.$/);
  });
});
