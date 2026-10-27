// Engine Part 6, the server's side: the marks the timeline draws (where they play in the edit, the AI's with them,
// hidden ones left out), the links to each video's 10 ms peaks for the waveform, and no tool names for the screens.
// Needs a database and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("the timeline's marks and waveform", { skip: !ready && "needs a database and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { createProject, projectFull } = await import("../src/services/projects");
  const { editorMarks } = await import("../src/services/marks");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { activityOut } = await import("../src/serialize");
  const core = await import("@rendrr/core");
  let userId = "", videoId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `tui_${run}` });
  // Two lines with a 2 s pause between them (a silence mark), and an "um".
  const transcript = [
    { id: "l0", start: 0, end: 2, gapBefore: 0, words: [{ id: "w0", text: "So", t: 0, end: 0.4 }, { id: "w1", text: "um", t: 0.5, end: 0.9, filler: true }, { id: "w2", text: "hello", t: 1, end: 2 }] },
    { id: "l1", start: 4, end: 6, gapBefore: 2, words: [{ id: "w3", text: "there", t: 4, end: 5 }, { id: "w4", text: "friend", t: 5, end: 6 }] },
  ];
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `tui_${run}`, email: `tui-${run}@test.rendrr.dev`, name: "T" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "T's Workspace" } });
    await core.putObject(`deep/${run}/audio.bin`, Buffer.alloc(800 * 4), "application/octet-stream");
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 8, width: 1280, height: 720, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`,
      analysis: { create: { transcriber: "stub", transcript: transcript as never, silences: [{ start: 2, end: 4, length: 2 }] as never, sceneCuts: [], keyFrames: [], audio: { key: `deep/${run}/audio.bin`, speech: [[0, 2], [4, 6]], onsets: [], breaths: [], clicks: [], clipping: [], v: 5, frameMs: 10, frames: 800, seconds: 8, layout: "mono", peakDb: -6, noiseFloorDb: -62, roomDb: -60, speechDb: -24, speechShare: 0.5, rms100: Buffer.from(Int8Array.from({ length: 80 }, (_, k) => (k < 20 || (k >= 40 && k < 60) ? -24 : -62))).toString("base64") } as never } } } })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await core.deletePrefix(`deep/${run}/`).catch(() => {});
  });

  it("marks where they play in the edit: Rendrr's and the AI's; a cut one and a hidden one are left out", async () => {
    const p = await createProject(userId, { videoId });
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "add_marks", marks: [{ kind: "custom", start: 5, label: "Hook ends", note: "short version" }] }, { op: "cut_words", from: 0, to: 0.45 }] });
    const m = await editorMarks(userId, p.id);
    const sil = m.find((x) => x.kind === "silence");
    assert.ok(sil && Math.abs(sil.start - 1.55) < 0.06 && Math.abs(sil.end - 3.55) < 0.06, JSON.stringify(m));
    const ai = m.find((x) => x.source === "ai");
    assert.deepEqual({ ...ai, id: "" }, { id: "", kind: "custom", source: "ai", label: "Hook ends", note: "short version", start: ai!.start, end: ai!.end });
    assert.ok(Math.abs(ai!.start - 4.55) < 0.06);
    // Hide Rendrr's silence in this edit: it is gone from the timeline.
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "update_mark", id: sil!.id, hidden: true }] });
    assert.equal((await editorMarks(userId, p.id)).some((x) => x.id === sil!.id), false);
  });

  it("the editor gets a link to each video's 10 ms peaks, and no tool names", async () => {
    const p = await createProject(userId, { videoId });
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "add_zoom", start: 1, end: 2, scale: 1.2 }] });
    const full = await projectFull(userId, p.id);
    assert.deepEqual(Object.keys(full.peaks), [videoId]);
    assert.match(full.peaks[videoId], /audio\.bin/);
    assert.ok(full.activity.length > 0);
    for (const a of full.activity) assert.equal("toolName" in a, false);
    const row = await prisma.aiAction.findFirstOrThrow({ where: { projectId: p.id } });
    assert.equal(row.toolName, "apply_edits", "kept on the server (activity log), not sent to the screens");
    assert.equal("toolName" in activityOut(row), false);
  });
});
