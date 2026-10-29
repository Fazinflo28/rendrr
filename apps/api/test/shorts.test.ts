// Claude's new edits and projects: create_folder, create_project from stretches or as a copy of an edit (another
// shape, reframed), and create_shorts (one edit per short: cut, shaped, reframed on the speaker from the faces measured
// at 10 fps, captioned; from an edit, with its look). Needs a database and storage (as in .env).
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("shorts, copies and folders", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { putObject, redis } = await import("@rendrr/core");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  let userId = "", videoId = "", longId = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  type V1 = { id: string; sourceIn: number; sourceOut: number; framing?: { scale: number; x: number; y: number; focus?: { x: number; y: number } }; grade?: { exposure?: number } };
  const v1Of = async (id: string) => ((await prisma.project.findUniqueOrThrow({ where: { id } })).timeline as unknown as { tracks: { v1: V1[] } }).tracks.v1;

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `sh_${run}`, email: `sh-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    // A 16:9 talk whose speaker sits left of centre (face centre 0.3 across, 0.45 down), measured at 10 fps.
    const frames = Array.from({ length: 600 }, (_, i) => [i / 10, [[1, 0.25, 0.35, 0.1, 0.2, 0.95, i % 3 ? 0.5 : 0.1, 0, 0, 0]]]);
    const key = `test/${run}/vision.json.gz`;
    await putObject(key, gzipSync(JSON.stringify({ v: 1, fps: 10, size: [640, 360], faceFields: "", frames, metricFields: "", metrics: [] })), "application/gzip");
    const v = await prisma.video.create({ data: { userId, name: `Long talk ${run}`, kind: "footage", seconds: 60, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`,
      analysis: { create: { transcriber: "stub", transcript: stubTranscript(60) as never, silences: [] as never, sceneCuts: [], keyFrames: [], vision: { v: 1, key, turned: 0 } as never } } } });
    videoId = v.id;
    longId = (await createProject(userId, { videoId, name: `Long edit ${run}` })).id;
    // The long edit: graded and captioned, with a title (text hangs on its clips).
    await tool("apply_edits", { projectId: longId, edits: [{ op: "set_grade", all: true, exposure: 0.4 }, { op: "set_captions", on: true, look: "outline" }, { op: "add_text", text: "Title", start: 1, end: 3 }] });
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { clerkId: `sh_${run}` } });
    await redis().quit().catch(() => {});
  });

  it("create_folder makes a project folder", async () => {
    const out = await tool("create_folder", { name: `Client ${run}` });
    const id = (out.data as { folderId: string }).folderId;
    assert.match(out.text, new RegExp(`^Created folder "Client ${run}" \\(${id}\\)`));
    assert.equal((await prisma.folder.findUniqueOrThrow({ where: { id } })).userId, userId);
  });

  it("create_shorts makes one 9:16 edit per short: the stretches in order, reframed on the speaker, captioned, in a new folder", async () => {
    const out = await tool("create_shorts", { videoId, folderName: `Shorts ${run}`, shorts: [{ name: "Hook first", clips: [{ from: 30, to: 34 }, { from: 10, to: 22 }] }, { clips: [{ from: 40, to: 55 }] }] });
    const { projectIds, folderId } = out.data as { projectIds: string[]; folderId: string };
    assert.equal(projectIds.length, 2);
    assert.match(out.text, new RegExp(`^Made 2 of 2 shorts, 9:16, reframed on the speaker, in folder "Shorts ${run}" \\(new\\):`));
    assert.match(out.text, /1\. "Hook first" \(\w+\): 16\.0s from 0:30-0:34, 0:10-0:22, reframed on the speaker in 2 of 2 clips\./);
    assert.match(out.text, new RegExp(`2\\. "Long talk ${run} short 2"`));
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectIds[0] } });
    assert.equal(p.aspect, "9:16");
    assert.equal(p.folderId, folderId);
    const v1 = await v1Of(p.id);
    assert.deepEqual(v1.map((c) => [c.sourceIn, c.sourceOut]), [[30, 34], [10, 22]]);
    for (const c of v1) assert.deepEqual(c.framing, { scale: 1, x: 0, y: 0, focus: { x: 0.3, y: 0.45 } });
    assert.equal((p.timeline as { captionsOn?: boolean }).captionsOn, true);
    assert.equal((p.timeline as { captionLook?: string }).captionLook, "bold");
  });

  it("checks every stretch before making anything", async () => {
    const before = await prisma.project.count({ where: { userId, deletedAt: null } });
    await assert.rejects(tool("create_shorts", { videoId, shorts: [{ clips: [{ from: 5, to: 10 }] }, { clips: [{ from: 50, to: 70 }] }] }), /Short 2, stretch 1 \(0:50-1:10\) runs past the end of the footage \(1:00\)/);
    await assert.rejects(tool("create_shorts", { videoId, shorts: [{ clips: [{ from: 9, to: 5 }] }] }), /ends before it starts/);
    await assert.rejects(tool("create_shorts", { videoId, fromProjectId: longId, shorts: [{ clips: [{ from: 1, to: 5 }] }] }), /one of them/);
    assert.equal(await prisma.project.count({ where: { userId, deletedAt: null } }), before);
  });

  it("shorts from an edit take its look (grade, captions) and leave its text with it", async () => {
    const out = await tool("create_shorts", { fromProjectId: longId, aspect: "4:5", shorts: [{ clips: [{ from: 12, to: 20 }] }] });
    const [id] = (out.data as { projectIds: string[] }).projectIds;
    assert.match(out.text, new RegExp(`4:5, reframed on the speaker, with the look of "Long edit ${run}"`));
    const p = await prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal(p.aspect, "4:5");
    const tl = p.timeline as unknown as { captionsOn: boolean; captionLook: string; tracks: { v1: V1[]; v3: { kind?: string }[] } };
    assert.equal(tl.captionsOn, true);
    assert.equal(tl.captionLook, "outline");
    assert.equal(tl.tracks.v1[0].grade?.exposure, 0.4);
    assert.deepEqual(tl.tracks.v1[0].framing?.focus, { x: 0.3, y: 0.45 });
    assert.equal(tl.tracks.v3.filter((c) => c.kind === "text").length, 0);
    // The long edit is untouched.
    assert.ok((await v1Of(longId)).every((c) => !c.framing));
  });

  it("create_project copies an edit into another shape, reframed, and leaves the first as it is", async () => {
    const before = (await prisma.project.findUniqueOrThrow({ where: { id: longId } })).currentVersion;
    const out = await tool("create_project", { fromProjectId: longId, aspect: "9:16", reframe: true, name: `Vertical ${run}` });
    const id = (out.data as { projectId: string }).projectId;
    const n = (await v1Of(longId)).length;
    assert.match(out.text, new RegExp(`^Created edit "Vertical ${run}" \\(${id}\\): a copy of "Long edit ${run}" v${before}, every change kept\\. Done \\(v2, [\\d.]+s of 60\\.0s\\): changed shape to 9:16; reframed ${n} clips on the speaker's face \\(${n} of ${n}\\)\\.`));
    const p = await prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal(p.aspect, "9:16");
    const tl = p.timeline as unknown as { tracks: { v1: V1[]; v3: { kind?: string }[] } };
    for (const c of tl.tracks.v1) assert.deepEqual(c.framing?.focus, { x: 0.3, y: 0.45 });
    assert.equal(tl.tracks.v1[0].grade?.exposure, 0.4);
    assert.equal(tl.tracks.v3.filter((c) => c.kind === "text").length, 1); // a full copy keeps the title
    const first = await prisma.project.findUniqueOrThrow({ where: { id: longId } });
    assert.equal(first.currentVersion, before);
    assert.equal(first.aspect, "16:9");
  });

  it("create_project from stretches of footage, and set_framing focus face through apply_edits", async () => {
    const out = await tool("create_project", { videoId, aspect: "1:1", clips: [{ from: 2, to: 6 }, { from: 20, to: 25 }] });
    const id = (out.data as { projectId: string }).projectId;
    assert.match(out.text, /, 1:1, made of 2 stretches of footage \(9\.0s\)\./);
    const v1 = await v1Of(id);
    assert.deepEqual(v1.map((c) => [c.sourceIn, c.sourceOut]), [[2, 6], [20, 25]]);
    assert.equal(v1[0].framing, undefined); // reframe was not asked
    const r = await tool("apply_edits", { projectId: id, edits: [{ op: "set_framing", focus: "face" }] });
    assert.match(r.text, /reframed the footage on the speaker's face \(2 of 2\)/);
    for (const c of await v1Of(id)) assert.deepEqual(c.framing?.focus, { x: 0.3, y: 0.45 });
  });
});
