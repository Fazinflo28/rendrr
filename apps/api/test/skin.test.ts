// Skin retouch through the connector: apply_edits retouch_skin with no values puts a natural retouch on each clip's face
// (the area Rendrr builds from the faces it measured at 10 fps: forehead to neck, where the render fits the clip),
// get_project says so, values change it, a video with no faces measured gets the whole picture and says why, and the
// editor's skin-areas route gives the same areas. Needs a database and storage (as in .env).
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("skin retouch through the connector", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { putObject, redis } = await import("@rendrr/core");
  const { stubTranscript, MCP_TOOLS, FACE_AREA } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { skinFaceAreas } = await import("../src/services/color");
  const { TOOL_HANDLERS } = await import("../src/tools");
  let userId = "", projectId = "", bare = "", videoId = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  type Clip = { id: string; sourceIn: number; sourceOut: number; skin?: { smooth: number; blemishes: number; even: number; brighten: number; area?: { shape: string; x: number; y: number; w: number; h: number }; face?: boolean } };
  const v1Of = async (id: string) => ((await prisma.project.findUniqueOrThrow({ where: { id } })).timeline as unknown as { tracks: { v1: Clip[] } }).tracks.v1;

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `sk_${run}`, email: `sk-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    // A 16:9 talk: the speaker's face box 0.25-0.35 across, 0.35-0.55 down (shares of the picture), at 10 fps.
    const frames = Array.from({ length: 300 }, (_, i) => [i / 10, [[1, 0.25, 0.35, 0.1, 0.2, 0.95, i % 3 ? 0.5 : 0.1, 0, 0, 0]]]);
    const key = `test/${run}/vision.json.gz`;
    await putObject(key, gzipSync(JSON.stringify({ v: 1, fps: 10, size: [640, 360], faceFields: "", frames, metricFields: "", metrics: [] })), "application/gzip");
    const v = await prisma.video.create({ data: { userId, name: `Talk ${run}`, kind: "footage", seconds: 30, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`,
      analysis: { create: { transcriber: "stub", transcript: stubTranscript(30) as never, silences: [] as never, sceneCuts: [], keyFrames: [], vision: { v: 1, fps: 10, metricsEvery: 0.5, size: [640, 360], frames: 300, landmarks: true,
        faces: { present: 1, tracks: 1, lost: [], offCamera: [], turns: [], mouthOpenShare: 0.4, medianShare: 0.02 }, sharpness: { median: 100, soft: [] }, shake: { median: 0, shaky: [] }, light: { median: 0.5, dark: [], blown: [], skinMedian: 0.6 },
        motion: { median: 0.01 }, safeArea: null, key, turned: 0 } as never } } } });
    videoId = v.id;
    projectId = (await createProject(userId, { videoId, name: `Skin ${run}` })).id;
    // A second video with no faces measured yet.
    const w = await prisma.video.create({ data: { userId, name: `No faces ${run}`, kind: "footage", seconds: 30, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}b.mp4`,
      analysis: { create: { transcriber: "stub", transcript: stubTranscript(30) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } });
    bare = (await createProject(userId, { videoId: w.id, name: `Bare ${run}` })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { clerkId: `sk_${run}` } });
    await redis().quit().catch(() => {});
  });

  it("no values: a natural retouch on the speaker's face, forehead to neck; get_project says so", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "retouch_skin" }] });
    assert.match(out.text, /skin retouch: smooth 35, blemishes 40, even 35, brighten 0, on the face/);
    const [c] = await v1Of(projectId);
    assert.deepEqual({ ...c.skin, area: undefined }, { smooth: 35, blemishes: 40, even: 35, brighten: 0, face: true, area: undefined });
    const a = c.skin!.area!;
    // The face box (0.25-0.35, 0.35-0.55) widened 1.6 times, made 1.9 times as tall and moved a fifth of a face down.
    assert.equal(a.shape, "ellipse");
    assert.ok(Math.abs(a.x + a.w / 2 - 0.3) < 0.01 && Math.abs(a.w - 0.1 * FACE_AREA.w) < 0.01, `across ${a.x}, ${a.w}`);
    assert.ok(Math.abs(a.h - 0.2 * FACE_AREA.h) < 0.01 && Math.abs(a.y + a.h / 2 - (0.45 + 0.2 * FACE_AREA.down)) < 0.01, `down ${a.y}, ${a.h}`);
    const p = await tool("get_project", { projectId });
    assert.match(p.text, /look: skin/);
    assert.match(p.text, /Looks: skin retouch: smooth 35, blemishes 40, even 35, brighten 0, on the face on /);
  });

  it("values change it and keep the face; off removes it", async () => {
    await tool("apply_edits", { projectId, edits: [{ op: "retouch_skin", smooth: 60, brighten: 20 }] });
    const [c] = await v1Of(projectId);
    assert.equal(c.skin!.smooth, 60); assert.equal(c.skin!.brighten, 20); assert.equal(c.skin!.blemishes, 40); assert.equal(c.skin!.face, true);
    await tool("apply_edits", { projectId, edits: [{ op: "retouch_skin", off: true }] });
    assert.equal((await v1Of(projectId))[0].skin, undefined);
  });

  it("a video with no faces measured: the whole picture, and it says why", async () => {
    const out = await tool("apply_edits", { projectId: bare, edits: [{ op: "retouch_skin" }] });
    assert.match(out.text, /no face measured on them: the skin is found over the whole picture there/);
    const [c] = await v1Of(bare);
    assert.equal(c.skin!.area, undefined);
  });

  it("the editor's areas are the connector's", async () => {
    const [c] = await v1Of(projectId);
    const areas = await skinFaceAreas([{ id: c.id, sourceVideoId: videoId, sourceIn: c.sourceIn, sourceOut: c.sourceOut }], videoId, "16:9");
    await tool("apply_edits", { projectId, edits: [{ op: "retouch_skin" }] });
    assert.deepEqual((await v1Of(projectId))[0].skin!.area, areas[c.id]);
  });
});
