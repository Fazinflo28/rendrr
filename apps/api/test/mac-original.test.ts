// Originals that stay on the user's Mac: footage added in the Rendrr Mac app tells Rendrr what its original is (the app
// keeps the file, nothing is uploaded). A final then starts with no original sent, while that Mac's app is open and can
// render (the final is made there); with the app closed, or on another Mac, the original is asked for once, as before,
// and the AI is told where the original is. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("originals kept on the Mac", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { queue, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "", videoId = "";
  const clerkId = `macorig_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const render = { protocol: 1, ready: true, enabled: true, busy: false, cpus: 8, have: ["libx264", "ass"], ffmpeg: "9.0.2" };
  const ping = (device: string, r: unknown = render) => app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.2.0", device, render: r } });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `macorig-${run}@test.rendrr.dev`, name: "Mac" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1280, height: 720, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`, originalName: "talk.mov", analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
  });
  after(async () => {
    for (const j of await queue("render").getJobs(["waiting", "delayed", "prioritized"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await redis().del(`mac:on:${userId}`, `mac:devices:${userId}`, `mac:choice:${userId}`, `mac:exports:${userId}`).catch(() => {});
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("without the original anywhere, a final asks for it once", async () => {
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Full quality needs the original file once/);
  });

  it("the Mac app says what the original is; a final then starts with nothing uploaded while that Mac renders", async () => {
    const bad = await app.inject({ method: "POST", url: `/videos/${videoId}/mac-original`, headers: headers(), payload: { size: 0 } });
    assert.equal(bad.statusCode, 400, "a description that is not a video is refused");
    const kept = await app.inject({ method: "POST", url: `/videos/${videoId}/mac-original`, headers: headers(), payload: { device: "Studio-Mac.local", size: 812_345_678, name: "talk.mov", width: 3840, height: 2160, fps: 29.97, seconds: 20.02, hasAudio: true, transfer: "hlg", path: "/Users/x/talk.mov" } });
    assert.deepEqual(kept.json(), { kept: true });
    const mo = (await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).macOriginal as Record<string, unknown>;
    assert.deepEqual([mo.device, mo.size, mo.width, mo.height, mo.transfer], ["Studio Mac", 812_345_678, 3840, 2160, "hlg"]);
    assert.ok(!("path" in mo), "where the file sits on the Mac is never kept by Rendrr");
    await ping("Studio-Mac.local");
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.doesNotMatch(r.text, /needs the original/);
    const made = await prisma.render.findFirst({ where: { userId, kind: "final" } });
    assert.ok(made && ["queued", "running"].includes(made.status), "the final is waiting for the worker (which hands it to that Mac)");
    await prisma.render.updateMany({ where: { userId }, data: { status: "done", outputKey: `renders/test-${run}/f.mp4` } });
  });

  it("the Mac app closed, or another Mac open: the original is asked for once, and the AI is told where it is", async () => {
    await redis().del(`mac:on:${userId}`, `mac:devices:${userId}`);
    const closed = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(closed.text, /The original of this footage stays on the user's Mac \("Studio Mac"\)/);
    await ping("Office-iMac.local");
    const other = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(other.text, /stays on the user's Mac \("Studio Mac"\)/, "only the Mac that has the file can make it");
    // Rendering turned off on that Mac: asked for too.
    await ping("Studio-Mac.local", { ...render, enabled: false });
    assert.match((await TOOL_HANDLERS.render_final(c(), { projectId })).text, /stays on the user's Mac/);
  });

  it("only local footage keeps its original on a Mac", async () => {
    const drive = await prisma.video.create({ data: { userId, name: "Drive one", seconds: 10, source: "drive", status: "ready" } });
    const r = await app.inject({ method: "POST", url: `/videos/${drive.id}/mac-original`, headers: headers(), payload: { size: 10, width: 10, height: 10 } });
    assert.deepEqual(r.json(), { kept: false });
  });
});
