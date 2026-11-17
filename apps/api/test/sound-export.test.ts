// Claude exports the sound only (render_final format "audio" / "wav"): the final is a sound file made for this export
// only (the edit's own export settings and versions stay as they are), it is named .m4a everywhere (the Mac or PC's
// Downloads, Google Drive), a video final and a sound-only one of the same version are two renders, save_to_drive
// format finds the sound-only one, and a review link never tries to play it. Needs a database, Redis and storage.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("sound-only exports", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject, latestRender, isWatchableKey } = await import("../src/services/projects");
  const { startRender, renderResult } = await import("../src/services/render");
  const { latestFinal } = await import("../src/services/driveSave");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "", soundId = "", videoFinalId = "";
  const clerkId = `snd_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `snd-${run}@test.rendrr.dev`, name: "Sound" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Podcast ${run}` })).id;
  });
  after(async () => {
    await redis().del(`mac:exports:${userId}`, `mac:devices:${userId}`, `mac:choice:${userId}`).catch(() => {});
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("render_final offers sound only, and save_to_drive finds it", () => {
    const rf = MCP_TOOLS.find((t) => t.name === "render_final")!, sd = MCP_TOOLS.find((t) => t.name === "save_to_drive")!;
    assert.match(rf.description, /Sound only \(the user wants just the audio\): format "audio" \(\.m4a\) or "wav"/);
    assert.ok(rf.input.safeParse({ projectId: "p", format: "audio" }).success && rf.input.safeParse({ projectId: "p", format: "wav" }).success);
    assert.ok(sd.input.safeParse({ projectId: "p", format: "audio" }).success);
  });

  it("Claude exports the sound only: a sound file for this export, the edit unchanged", async () => {
    const before = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const versions = await prisma.projectVersion.count({ where: { projectId } });
    const r = await TOOL_HANDLERS.render_final(c(), { projectId, format: "audio" });
    const row = await prisma.render.findFirstOrThrow({ where: { projectId, kind: "final" }, orderBy: { createdAt: "desc" } });
    soundId = row.id;
    assert.equal(row.format, "audio");
    assert.equal(row.quality, "Sound only (.m4a)");
    assert.match(r.text, /Sound only \(\.m4a\)/, "the answer says what is being made");
    const now = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.equal(now.currentVersion, before.currentVersion, "no new version");
    assert.equal(await prisma.projectVersion.count({ where: { projectId } }), versions);
    assert.equal((now.timeline as { export?: { format?: string } }).export?.format, undefined, "the edit's own export setting stays a video");
    assert.equal((await renderResult(row)).fileName, `Podcast ${run} final v${row.version}.m4a`);
  });

  it("a video final and a sound-only final of the same version are two renders; the same kind asked again joins", async () => {
    const video = await startRender(userId, projectId, "final", { by: "claude" });
    videoFinalId = video.id;
    assert.notEqual(video.id, soundId);
    assert.equal(video.format, "mp4");
    assert.equal((await startRender(userId, projectId, "final", { by: "claude", format: "audio" })).id, soundId, "joins the sound-only render");
    assert.equal((await startRender(userId, projectId, "final", { by: "claude" })).id, video.id, "joins the video render");
    const wav = await startRender(userId, projectId, "final", { by: "claude", format: "wav", best: true });
    assert.equal(wav.format, "wav");
    assert.equal(wav.quality, "Sound only (WAV)", "best means nothing for sound: never a 4K or best export");
    await prisma.render.update({ where: { id: wav.id }, data: { status: "failed" } });
  });

  it("with the Rendrr app open it goes to that computer's Downloads as an .m4a", async () => {
    const ping = await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.1.7", device: "Studio-Mac.local" } });
    assert.equal(ping.statusCode, 200, ping.body);
    const r = await TOOL_HANDLERS.render_final(c(), { projectId, format: "audio" });
    assert.match(r.text, /Exporting to the user's Mac/);
    const queued = Object.values(await redis().hgetall(`mac:exports:${userId}`)).map((x) => JSON.parse(x) as { fileName: string });
    assert.ok(queued.length >= 1 && queued.every((q) => q.fileName.endsWith(".m4a")), `named .m4a for the Downloads folder (${queued.map((q) => q.fileName).join(", ")})`);
    await prisma.render.update({ where: { id: soundId }, data: { status: "done", outputKey: `renders/test-${run}/sound.m4a`, sizeBytes: BigInt(320_000), seconds: 20, finishedAt: new Date() } });
    const list = (await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json() as { renderId: string; fileName: string; url?: string }[];
    const mine = list.find((x) => x.renderId === soundId)!;
    assert.ok(mine?.url, "the app gets the link once it is done");
    assert.match(mine.fileName, /\.m4a$/);
  });

  it("the finished file is said as sound only, with its name", async () => {
    const r = await TOOL_HANDLERS.get_render(c(), { renderId: soundId });
    assert.match(r.text, new RegExp(`^Sound-only final v\\d+ ready: Podcast ${run} final v\\d+\\.m4a \\(no picture\\)`));
  });

  it("save_to_drive format audio finds the sound-only final, even after a newer video final", async () => {
    await prisma.render.update({ where: { id: videoFinalId }, data: { status: "done", outputKey: `renders/test-${run}/video.mp4`, finishedAt: new Date() } });
    assert.equal((await latestFinal(userId, projectId))!.id, videoFinalId, "no format: the newest final");
    assert.equal((await latestFinal(userId, projectId, undefined, "audio"))!.id, soundId);
    assert.equal((await latestFinal(userId, projectId, undefined, "mp4"))!.id, videoFinalId);
    // A sound-only final from before the file type was kept is told by its file.
    const old = await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "done", outputKey: `renders/test-${run}/old.wav`, createdAt: new Date(Date.now() - 86400_000) } });
    assert.equal((await latestFinal(userId, projectId, undefined, "wav"))!.id, old.id);
  });

  it("a review link plays the video, never the sound-only file", async () => {
    await prisma.render.update({ where: { id: soundId }, data: { createdAt: new Date(Date.now() + 60_000) } }); // the newest
    const v = (await prisma.render.findUniqueOrThrow({ where: { id: soundId } })).version;
    assert.equal((await latestRender(projectId, "final", v))!.id, soundId);
    assert.equal((await latestRender(projectId, "final", v, true))!.id, videoFinalId, "watchable: the video");
    assert.ok(isWatchableKey("a/b.mp4") && !isWatchableKey("a/b.m4a") && !isWatchableKey("a/b.wav") && !isWatchableKey("a/b.gif") && !isWatchableKey(null));
    const { appProject } = await import("../src/services/claudeApp");
    const card = await appProject(userId, projectId);
    assert.ok(card.versions.every((x) => x.renderId !== soundId), "the Claude card's version list has no sound-only final");
    const share = await TOOL_HANDLERS.create_review_link(c(), { projectId });
    const token = (share.data as { token?: string } | undefined)?.token ?? share.text.match(/\/review\/([\w-]+)/)?.[1];
    assert.ok(token, share.text);
    const page = (await app.inject({ method: "GET", url: `/public/reviews/${token}` })).json() as Record<string, unknown>;
    assert.ok(!JSON.stringify(page).includes("sound.m4a"), "the sound-only file is not on the review page");
    assert.ok(JSON.stringify(page).includes("video.mp4"), "the video is");
  });
});
