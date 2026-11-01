// Footage the user gives Claude in the chat: add_footage upload gives a link, the file sent to it (as curl -T does) is
// kept by Rendrr as the raw and put in the library and the edit's Media panel; the real worker jobs make its preview.
// A picture becomes a still clip (STILL_SECONDS) that apply_edits places as b-roll; a short video is footage like any
// other. A used link, an empty file and a picture type not taken say why; deleting it deletes the kept raw.
// Needs a database, Redis, storage and FFmpeg (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
// The speech service cannot reach the local test storage: the sample transcript stands in (as with no key).
delete process.env.ASSEMBLYAI_API_KEY;
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("add_footage: a video or a picture from the chat", { skip: (!ready || !ff) && "needs a database, Redis, storage and FFmpeg" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { MCP_TOOLS, QUEUES, STILL_SECONDS, stubTranscript } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { createProject } = await import("../src/services/projects");
  const { buildServer } = await import("../src/server");
  const { deletePrefix, headObject, newRedis, redis } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { proxyJob } = await import("../../worker/src/jobs/proxy");
  const { analyzeJob } = await import("../../worker/src/jobs/analyze");

  let userId = "", projectId = "";
  const workers: InstanceType<typeof Worker>[] = [];
  let app: Awaited<ReturnType<typeof buildServer>>;
  const dir = mkdtempSync(join(tmpdir(), "add-footage-"));
  const clerkId = `fte_${run}`;
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const linkOf = (text: string) => /(https?:\/\/\S+\/footage\/upload\/[\w-]+)/.exec(text)![1];
  const send = (link: string, body: Buffer, q = "") => app.inject({ method: "PUT", url: new URL(link).pathname + q, payload: body, headers: { "content-type": "application/octet-stream" } });
  const mediaOf = async () => ((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { media?: string[] }).media ?? [];

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `fte-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
    const ctx = (job: unknown) => ({ job, dir, signal: new AbortController().signal, isLastAttempt: true }) as never;
    workers.push(new Worker(QUEUES.proxy.name, async (job) => proxyJob(ctx(job)), { connection: newRedis() as never }));
    workers.push(new Worker(QUEUES.analyze.name, async (job) => analyzeJob(ctx(job)), { connection: newRedis() as never }));
    // A product shot (a PNG, 1000x700) and a 3 s phone clip (with sound).
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1000x700:d=1", "-frames:v", "1", join(dir, "product.png")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3", "-f", "lavfi", "-i", "sine=f=330:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(dir, "clip.mp4")]);
  });
  after(async () => {
    for (const w of workers) await w.close();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.libraryFolder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    for (const p of ["uploads/", "proxies/", "audio/", "frames/"]) await deletePrefix(`${p}${userId}/`).catch(() => {});
    await app.close();
    await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("a picture: the link takes it, it becomes a still clip in the library and the edit's Media panel, and apply_edits places it as b-roll", async () => {
    const out = await tool("add_footage", { upload: true, projectId, name: "Product shot", libraryFolder: "Brand/Products" });
    assert.match(out.text, /^Upload link for one video or picture, for 30 minutes: \S+\/footage\/upload\/[\w-]+\n/);
    assert.match(out.text, /curl -sS -T "<file>" "\S+\?filename=<its file name>"/);
    const r = await send(linkOf(out.text), readFileSync(join(dir, "product.png")), "?filename=product.png");
    assert.equal(r.statusCode, 200, r.body);
    const j = JSON.parse(r.body) as { videoId: string; status: string; still: boolean; text: string };
    assert.equal(j.still, true);
    assert.equal(j.status, "ready", j.text);
    assert.match(j.text, /^In the library and this edit's Media panel: the picture "Product shot" \w+ 1000x700, ready\. Place it with apply_edits add_broll\{videoId: "\w+", start, end\}/);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: j.videoId } });
    assert.deepEqual([v.source, v.still, v.kind, v.seconds, v.width, v.height, v.hasAudio], ["upload", true, "footage", STILL_SECONDS, 1000, 700, false]);
    assert.equal(v.sourceKey, `uploads/${userId}/${v.id}/source.mp4`, "kept as a still clip; the picture itself is not kept twice");
    assert.ok(await headObject(v.sourceKey!), "the raw is in storage");
    const folder = await prisma.libraryFolder.findUniqueOrThrow({ where: { id: v.libraryFolderId! } });
    assert.equal(folder.name, "Products", "in the library folder asked for (made)");
    assert.deepEqual(await mediaOf(), [v.id]);
    // Placed over the talk for 3 s.
    const placed = await tool("apply_edits", { projectId, edits: [{ op: "add_broll", videoId: v.id, start: 2, end: 5, edit: true }] });
    assert.match(placed.text, /^Done \(v\d/);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.ok(((p.timeline as { tracks: { v2: { videoId?: string }[] } }).tracks.v2).some((x) => x.videoId === v.id));
    // The library lists it as a picture whose raw Rendrr keeps.
    assert.match((await tool("list_footage", {})).text, new RegExp(`${v.id} \\| Product shot \\| picture \\| 1:00 \\| Landscape 1000x700 \\| ready \\| rendrr`));
    // The link works once.
    const again = await send(linkOf(out.text), readFileSync(join(dir, "product.png")));
    assert.equal(again.statusCode, 404);
    assert.match(again.body, /expired or was used already/);
  });

  it("a short video: footage like any other (its own length and sound), ready for the edit; videoId waits and adds it to an edit", async () => {
    const out = await tool("add_footage", { upload: true });
    const r = await send(linkOf(out.text), readFileSync(join(dir, "clip.mp4")), "?filename=Phone%20clip.mp4");
    assert.equal(r.statusCode, 200, r.body);
    const j = JSON.parse(r.body) as { videoId: string; status: string; still: boolean; text: string };
    assert.equal(j.still, false);
    const done = await tool("add_footage", { videoId: j.videoId, wait_seconds: 90, projectId });
    assert.match(done.text, /^In the library and this edit's Media panel: the video "Phone clip" \w+ 640x360, 3\.\d\d s, ready\. Place it with apply_edits add_broll/);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: j.videoId } });
    assert.deepEqual([v.source, v.still, v.hasAudio, v.originalName], ["upload", false, true, "Phone clip.mp4"]);
    assert.equal(v.sourceKey, `uploads/${userId}/${v.id}/source.mp4`);
    assert.ok((await mediaOf()).includes(v.id));
    // Deleting it deletes the raw Rendrr kept.
    const del = await app.inject({ method: "DELETE", url: `/videos/${v.id}`, headers: { "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId } });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(await headObject(v.sourceKey!).catch(() => null), null);
  });

  it("says why: an empty file, a picture type not taken, a link that is not a file, nothing to bring in", async () => {
    const empty = await tool("add_footage", { upload: true });
    const e = await send(linkOf(empty.text), Buffer.alloc(0));
    assert.equal(e.statusCode, 400);
    assert.match(e.body, /Nothing came with the upload/);
    const heic = await tool("add_footage", { upload: true });
    const h = await send(linkOf(heic.text), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(64)]));
    assert.equal(h.statusCode, 400);
    assert.match(h.body, /HEIC and AVIF pictures are not taken yet/);
    assert.match((await tool("add_footage", {})).text, /^Send one of: upload: true/);
    await assert.rejects(tool("add_footage", { upload: true, projectId: "cnotanedit00000000000000" }), /That edit is not there/);
  });
});
