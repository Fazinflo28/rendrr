// The AI's export goes to the user's Mac when the Rendrr Mac app is open: the app pings, render_final queues the final
// for it and says so, and the app takes it (once) when it is done, with a link that saves the file. With the app
// closed (or to: drive), render_final says it is switching to Rendrr's cloud server and to ask which Google Drive
// folder. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("export to the Mac app, else the cloud and Drive", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { queue, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "";
  const clerkId = `mac_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `mac-${run}@test.rendrr.dev`, name: "Mac" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
  });
  after(async () => {
    for (const j of await queue("render").getJobs(["waiting", "delayed", "prioritized"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await redis().del(`mac:on:${userId}`, `mac:exports:${userId}`).catch(() => {});
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("with the Mac app closed: switches to the cloud server and asks which Drive folder", async () => {
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Mac app is not open/);
    assert.match(r.text, /Switching to Rendrr's cloud server/);
    assert.match(r.text, /ask which Google Drive folder/);
    assert.equal(Object.keys(await redis().hgetall(`mac:exports:${userId}`)).length, 0, "nothing queued for the Mac");
    await prisma.render.updateMany({ where: { userId }, data: { status: "done", outputKey: `renders/test-${run}/a.mp4` } });
  });

  it("with the Mac app open: exports to the Mac, which takes the final once it is done", async () => {
    const ping = await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.1.7" } });
    assert.equal(ping.statusCode, 200, ping.body);
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Exporting to the user's Mac/);
    const renderId = (r.data as { renderId?: string })?.renderId ?? (await prisma.render.findFirstOrThrow({ where: { userId, status: { in: ["queued", "running"] } } })).id;
    let list = (await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json();
    assert.equal(list.length, 1); assert.equal(list[0].renderId, renderId);
    assert.ok(!list[0].url, "no link while it renders");
    await prisma.render.update({ where: { id: renderId }, data: { status: "done", outputKey: `renders/test-${run}/b.mp4` } });
    list = (await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json();
    assert.ok(list[0].url && /\.mp4$/.test(list[0].fileName), "done: a link that saves the file, with its name");
    const first = (await app.inject({ method: "POST", url: `/desktop/exports/${renderId}/claim`, headers: headers() })).json();
    const second = (await app.inject({ method: "POST", url: `/desktop/exports/${renderId}/claim`, headers: headers() })).json();
    assert.equal(first.claimed, true); assert.equal(second.claimed, false, "only one window saves it");
    assert.equal((await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json().length, 0);
  });

  it("to: drive goes to the cloud even with the Mac app open", async () => {
    await prisma.render.updateMany({ where: { userId, status: { in: ["queued", "running"] } }, data: { status: "done", outputKey: `renders/test-${run}/c.mp4` } });
    const r = await TOOL_HANDLERS.render_final(c(), { projectId, to: "drive" });
    assert.match(r.text, /Switching to Rendrr's cloud server/);
    assert.doesNotMatch(r.text, /Exporting to the user's Mac/);
  });
});
