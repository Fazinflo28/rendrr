// Usage & billing: where each render ran (the user's own computer or Rendrr's cloud), previews and exports apart, and
// every render under its video with its length, quality and the minutes it counted. Read from the same usage rows the
// bill is made from. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("usage: where renders ran", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { recordUsage, redis } = await import("@rendrr/core");
  const { billingOverview } = await import("../src/services/billing");
  let userId = "", projectId = "";
  const ids: string[] = [];

  before(async () => {
    const now = new Date();
    userId = (await prisma.user.create({ data: { clerkId: `where_${run}`, email: `where-${run}@test.rendrr.dev`, name: "Where", plan: "comp", billingStatus: "active", periodStart: new Date(now.getTime() - 86_400_000), periodEnd: new Date(now.getTime() + 29 * 86_400_000) } })).id;
    const folderId = (await prisma.folder.create({ data: { userId, name: "Client W", workspace: "W" } })).id;
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 90, width: 1080, height: 1920, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4` } })).id;
    projectId = (await prisma.project.create({ data: { userId, folderId, videoId, name: "Knee pain ad", timeline: {} } })).id;
    const make = async (kind: string, version: number, quality: string, made: object | null) =>
      (await prisma.render.create({ data: { projectId, userId, kind, version, quality, status: "done", seconds: 60, ...(made ? { made } : {}) } })).id;
    // A preview on the Mac, a preview on the cloud (the app was closed), a 4K export on a PC, an old export with no record of where.
    ids.push(await make("preview", 1, "540p", { on: "mac", device: "Studio MacBook", why: null, platform: "mac" }));
    ids.push(await make("preview", 2, "540p", { on: "cloud", device: null, why: "your Mac app was not open" }));
    ids.push(await make("final", 3, "4k", { on: "mac", device: "Edit PC", why: null, platform: "windows" }));
    ids.push(await make("final", 4, "1080p", null));
    await recordUsage({ userId, metric: "preview", quantity: 1, billable: 0, refId: ids[0], meta: { projectId, on: "mac" } });
    await recordUsage({ userId, metric: "preview", quantity: 1, billable: 1, refId: ids[1], meta: { projectId, on: "cloud" } });
    await recordUsage({ userId, metric: "export", quantity: 1.5, billable: 0, refId: ids[2], meta: { projectId, on: "mac", fourK: true, quality: "4k" } });
    await recordUsage({ userId, metric: "export", quantity: 0.5, billable: 0.5, refId: ids[3], meta: { projectId } }); // from before "on" was kept
    await recordUsage({ userId, metric: "footage", quantity: 3, refId: videoId });
    const upId = (await prisma.video.create({ data: { userId, name: `Phone clip ${run}`, seconds: 60, width: 1080, height: 1920, source: "upload", status: "ready" } })).id;
    await recordUsage({ userId, metric: "footage", quantity: 1, billable: 0, refId: upId });
    // What the cloud preview's job used on the servers (measured), and the Mac preview's small planning job.
    const cost = { queue: "render", ok: true, costCompute: 0.001, costMemory: 0.001, costTotal: 0.002 };
    await prisma.jobCost.create({ data: { ...cost, userId, jobId: `j1_${run}`, kind: "render_preview", refId: ids[1], wallMs: 30_000, cpuSeconds: 24, memGbSeconds: 45 } });
    await prisma.jobCost.create({ data: { ...cost, userId, jobId: `j0_${run}`, kind: "render_preview", refId: ids[0], wallMs: 6_000, cpuSeconds: 1.8, memGbSeconds: 3 } });
    await prisma.render.update({ where: { id: ids[1] }, data: { startedAt: new Date(now.getTime() - 30_000), finishedAt: now } });
  });

  after(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await redis().quit().catch(() => {});
  });

  it("splits minutes by where they ran and by preview or export, and counts what the plan counted", async () => {
    const r = (await billingOverview(userId)).renders;
    assert.deepEqual(r.total, { minutes: 4, counted: 1.5, renders: 4 });
    assert.deepEqual(r.minutes, { computer: 2.5, cloud: 1.5 });
    assert.deepEqual(r.count, { computer: 2, cloud: 2 });
    assert.deepEqual(r.preview, { computer: 1, cloud: 1 });
    assert.deepEqual(r.export, { computer: 1.5, cloud: 0.5 });
    assert.deepEqual(r.counted, { computer: 0, cloud: 1.5 });
  });

  it("lists every render under its video, newest first, with where, the machine, why the cloud, quality and minutes counted", async () => {
    const r = (await billingOverview(userId)).renders;
    assert.equal(r.videos.length, 1);
    const v = r.videos[0];
    assert.deepEqual([v.id, v.name, v.folder, v.minutes, v.computer, v.cloud, v.counted], [projectId, "Knee pain ad", "Client W", 4, 2.5, 1.5, 1.5]);
    const by = Object.fromEntries((v.renders as { id: string }[]).map((x) => [x.id, x])) as Record<string, Record<string, unknown>>;
    assert.deepEqual([by[ids[0]].where, by[ids[0]].platform, by[ids[0]].device, by[ids[0]].kind, by[ids[0]].counted], ["computer", "mac", "Studio MacBook", "preview", 0]);
    assert.deepEqual([by[ids[1]].where, by[ids[1]].why, by[ids[1]].counted], ["cloud", "your Mac app was not open", 1]);
    assert.deepEqual([by[ids[2]].where, by[ids[2]].platform, by[ids[2]].kind, by[ids[2]].quality, by[ids[2]].fourK, by[ids[2]].version], ["computer", "windows", "export", "4k", true, 3]);
    assert.deepEqual([by[ids[3]].where, by[ids[3]].platform], ["cloud", null]);
    assert.deepEqual(by[ids[1]].server, { cpuSeconds: 24, avgMemoryGB: 1.5, seconds: 30 });
    assert.equal(by[ids[1]].runSeconds, 30);
    assert.equal(by[ids[3]].server, null);
  });

  it("real meters: measured server CPU and memory, time rendering on each side, no GPU, and never a cost", async () => {
    const b = await billingOverview(userId);
    const c = b.renders.compute;
    assert.deepEqual([c.serverCpuMinutes, c.serverMemoryGbMinutes, c.avgMemoryGB, c.measuredRenders, c.gpu], [0.43, 0.8, 1.33, 2, false]);
    assert.equal(c.runMinutes.cloud, 0.5);
    assert.ok(!JSON.stringify(b.renders).toLowerCase().includes("cost"), "no costs in the meters");
  });

  it("footage by where it came from: the user's computer or cloud storage", async () => {
    const f = (await billingOverview(userId)).footage;
    assert.deepEqual([f.minutes.computer, f.minutes.cloud, f.counted.computer, f.counted.cloud, f.total], [1, 3, 0, 3, 4]);
    assert.deepEqual(f.videos.map((v) => [v.from, v.source]).sort(), [["cloud", "drive"], ["computer", "upload"]]);
  });
});
