// "Stop export": a waiting render leaves the queue; a running one is told to stop on the worker (Redis message
// "render:<id>"). Either way it ends at once as failed with code "stopped", the app hears it on the render's live
// channel, and the edit goes back to the status its finished renders give it. An ended render is left alone.
// Needs a database and Redis (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("stop export", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { stopRender, STOP_CHANNEL } = await import("../src/services/render");
  const { newRedis, queue, redis, renderChannel } = await import("@rendrr/core");

  let userId = "", projectId = "";
  const sub = newRedis();
  const heard: { ch: string; msg: string }[] = [];
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `stop_${run}`, email: `stop-${run}@test.rendrr.dev`, name: "Stop" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Stop's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1080, height: 1920, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Reel ${run}` })).id;
    await sub.subscribe(STOP_CHANNEL);
    sub.on("message", (ch, msg) => heard.push({ ch, msg }));
  });
  after(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    sub.disconnect();
    await queue("render").close();
    redis().disconnect();
    await prisma.$disconnect();
  });

  it("a running final stops: failed with code stopped, the worker told, the app told, the edit back to its status", async () => {
    await prisma.render.create({ data: { projectId, userId, kind: "preview", version: 1, status: "done", outputKey: `p/${run}.mp4`, steps: [] } });
    await prisma.project.update({ where: { id: projectId }, data: { status: "Rendering" } });
    const r = await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "running", steps: ["Reading timeline", "Encoding 1080p"], step: 1, progress: 60 } });
    const live = newRedis(); const events: string[] = [];
    await live.subscribe(renderChannel(r.id)); live.on("message", (_c, m) => events.push(m));
    const out = await stopRender(r);
    assert.deepEqual(out, { stopped: true, status: "failed" });
    const after1 = await prisma.render.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(after1.status, "failed");
    assert.equal(after1.errorCode, "stopped");
    assert.match(after1.error || "", /stopped this export/);
    assert.ok(after1.finishedAt);
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(heard.some((h) => h.msg === `render:${r.id}`), "the worker was told");
    assert.ok(events.some((m) => /"code":"stopped"/.test(m) && /"status":"failed"/.test(m)), "the app's live channel heard it: " + events.join(" | "));
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status, "Preview ready", "back to what its renders give");
    live.disconnect();
  });

  it("a waiting render leaves the queue", async () => {
    const r = await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "queued", steps: [] } });
    await queue("render").add("render", { renderId: r.id }, { jobId: r.id, delay: 60_000 });
    assert.ok(await queue("render").getJob(r.id), "queued");
    await stopRender(r);
    assert.equal(await queue("render").getJob(r.id), undefined, "taken out of the queue");
    assert.equal((await prisma.render.findUniqueOrThrow({ where: { id: r.id } })).errorCode, "stopped");
  });

  it("a render that already ended is left as it is", async () => {
    const r = await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "done", outputKey: `f/${run}.mp4`, steps: [] } });
    const before = heard.length;
    assert.deepEqual(await stopRender(r), { stopped: false, status: "done" });
    assert.equal((await prisma.render.findUniqueOrThrow({ where: { id: r.id } })).status, "done");
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(heard.length, before, "nobody told");
  });
});
