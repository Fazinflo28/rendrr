// Remove the background through the connector: apply_edits remove_background cuts the person out of every V1 clip,
// queues the matte of each 10 s block of footage the clips use (one job per block, the turn the footage was measured
// with), get_project says so, a block already kept is not queued again, and the editor's matte route gives each block's
// link once it is kept (null while it is being made). Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("remove background through the connector", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { putObject, deletePrefix, queue, matteBlockUrls, redis } = await import("@rendrr/core");
  const { stubTranscript, MCP_TOOLS, matteJobId, matteKey } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  let userId = "", projectId = "", videoId = "", turnedId = "", turnedProject = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  type Clip = { id: string; subject?: { edge: number; soft: number; invert?: boolean } };
  const v1Of = async (id: string) => ((await prisma.project.findUniqueOrThrow({ where: { id } })).timeline as unknown as { tracks: { v1: Clip[] } }).tracks.v1;
  const ids = (vid: string, turn: number) => [0, 1, 2].map((k) => matteJobId(vid, turn, k));
  const queued = async (jobIds: string[]) => (await Promise.all(jobIds.map((j) => queue("matte").getJob(j)))).filter(Boolean).map((j) => j!.id);
  const video = (name: string, turned: number) => prisma.video.create({ data: { userId, name: `${name} ${run}`, kind: "footage", seconds: 30, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}-${name}.mp4`,
    analysis: { create: { transcriber: "stub", transcript: stubTranscript(30) as never, silences: [] as never, sceneCuts: [], keyFrames: [], vision: { v: 1, fps: 10, metricsEvery: 0.5, size: [640, 360], frames: 300, landmarks: false,
      faces: { present: 1, tracks: 1, lost: [], offCamera: [], turns: [], mouthOpenShare: 0.4, medianShare: 0.02 }, sharpness: { median: 100, soft: [] }, shake: { median: 0, shaky: [] }, light: { median: 0.5, dark: [], blown: [], skinMedian: 0.6 },
      motion: { median: 0.01 }, safeArea: null, turned } as never } } } });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `bg_${run}`, email: `bg-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    videoId = (await video("Talk", 0)).id;
    projectId = (await createProject(userId, { videoId, name: `Background ${run}` })).id;
    // Footage filmed on its side (measured: turned 90 to make the person upright): its matte is made turned.
    turnedId = (await video("Side", 90)).id;
    turnedProject = (await createProject(userId, { videoId: turnedId, name: `Side ${run}` })).id;
  });
  after(async () => {
    for (const j of [...ids(videoId, 0), ...ids(turnedId, 90)]) await queue("matte").remove(j).catch(() => {});
    await deletePrefix(`frames/${userId}/`).catch(() => {});
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { clerkId: `bg_${run}` } });
    await redis().quit().catch(() => {});
  });

  it("cuts the person out, queues each block's matte, and get_project says so", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "remove_background" }, { op: "set_background", color: "#00FF00" }] });
    assert.match(out.text, /background removed/);
    const [c] = await v1Of(projectId);
    assert.deepEqual(c.subject, { edge: 0, soft: 20 });
    // 30 s of footage: three 10 s blocks, one job each.
    assert.deepEqual(await queued(ids(videoId, 0)), ids(videoId, 0));
    const job = await queue("matte").getJob(matteJobId(videoId, 0, 1));
    assert.deepEqual(job!.data, { videoId, userId, k: 1, turn: 0 });
    const p = await tool("get_project", { projectId });
    assert.match(p.text, /look: no background/);
    assert.match(p.text, /background removed/);
  });

  it("a block already kept is not queued again", async () => {
    for (const j of ids(videoId, 0)) await queue("matte").remove(j);
    await putObject(matteKey(userId, videoId, 0, 0), Buffer.from("matte"), "video/mp4");
    await tool("apply_edits", { projectId, edits: [{ op: "remove_background", edge: 3 }] });
    assert.deepEqual(await queued(ids(videoId, 0)), ids(videoId, 0).slice(1));
    assert.equal((await v1Of(projectId))[0].subject!.edge, 3);
  });

  it("footage measured on its side: the matte is made turned", async () => {
    await tool("apply_edits", { projectId: turnedProject, edits: [{ op: "remove_background" }] });
    assert.deepEqual(await queued(ids(turnedId, 90)), ids(turnedId, 90));
    assert.equal((await queue("matte").getJob(matteJobId(turnedId, 90, 0)))!.data.turn, 90);
  });

  it("the editor's route: a link for each kept block, null while one is being made", async () => {
    const m = await matteBlockUrls(userId, videoId, 0, 25);
    assert.equal(m!.turn, 0);
    assert.equal(m!.block, 10);
    assert.deepEqual(Object.keys(m!.blocks), ["0", "1", "2"]);
    assert.match(m!.blocks[0]!, /matte-v2-t0-0\.mp4/);
    assert.equal(m!.blocks[1], null);
    assert.equal(m!.blocks[2], null);
    assert.equal(await matteBlockUrls(userId, "not-a-video", 0, 5), null);
  });

  it("off puts the background back and queues nothing more", async () => {
    for (const j of ids(videoId, 0)) await queue("matte").remove(j);
    await tool("apply_edits", { projectId, edits: [{ op: "remove_background", off: true }] });
    assert.equal((await v1Of(projectId))[0].subject, undefined);
    assert.deepEqual(await queued(ids(videoId, 0)), []);
  });
});
