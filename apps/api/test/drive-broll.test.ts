// A clip in the user's Google Drive placed as b-roll straight from apply_edits (an AI whose tool list is older than
// add_footage does exactly this): add_broll with the Drive file's id, or its share link, as videoId. Rendrr links it
// into the library, the real worker makes its preview from "Drive" (a local stand-in for Google's API, which the Drive
// code is pointed at), and the edit runs with the library id; the clip is in the edit's Media panel too. A picture sent
// to an audio upload link with ?kind=footage goes into the library as footage. Needs a database, Redis, storage and
// FFmpeg (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client";
process.env.GOOGLE_CLIENT_SECRET ||= "test-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
delete process.env.ASSEMBLYAI_API_KEY; // the speech service cannot reach local storage: the sample transcript stands in
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);
const DRIVE_ID = `1AbCdEfGhIjKlMnOpQrStUv${run}`;

describe("a Drive clip placed as b-roll from apply_edits", { skip: (!ready || !ff) && "needs a database, Redis, storage and FFmpeg" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-broll-"));
  const clip = join(dir, "swing.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=f=330:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-movflags", "+faststart", clip]);
  const bytes = readFileSync(clip);
  // Google's API, as far as Rendrr uses it: a token, a file's details, its bytes (with ranges, as FFmpeg asks).
  const google: Server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    if (u.pathname === "/token") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 })); return; }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (!m || decodeURIComponent(m[1]) !== DRIVE_ID) { res.statusCode = 404; res.end("{}"); return; }
    if (u.searchParams.get("alt") === "media") {
      const r = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ""));
      const a = r ? Number(r[1]) : 0, b = r && r[2] ? Number(r[2]) : bytes.length - 1;
      res.statusCode = r ? 206 : 200;
      res.setHeader("content-type", "video/mp4"); res.setHeader("accept-ranges", "bytes"); res.setHeader("content-length", String(b - a + 1));
      if (r) res.setHeader("content-range", `bytes ${a}-${b}/${bytes.length}`);
      res.end(bytes.subarray(a, b + 1)); return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: DRIVE_ID, name: "Golf swing.mp4", mimeType: "video/mp4", parents: ["root"], size: String(statSync(clip).size), modifiedTime: "2026-10-01T10:00:00.000Z", videoMediaMetadata: { durationMillis: "4000", width: 640, height: 360 } }));
  });
  await new Promise<void>((ok) => google.listen(0, "127.0.0.1", () => ok()));
  const port = (google.address() as { port: number }).port;
  process.env.GOOGLE_API_URL = `http://127.0.0.1:${port}`;
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${port}/token`;

  const { prisma } = await import("@rendrr/db");
  const { MCP_TOOLS, QUEUES, stubTranscript } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { createProject } = await import("../src/services/projects");
  const { buildServer } = await import("../src/server");
  const { deletePrefix, encrypt, newRedis, redis } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { proxyJob } = await import("../../worker/src/jobs/proxy");
  const { analyzeJob } = await import("../../worker/src/jobs/analyze");

  let userId = "", projectId = "";
  const workers: InstanceType<typeof Worker>[] = [];
  let app: Awaited<ReturnType<typeof buildServer>>;
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const timeline = async () => (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { media?: string[]; tracks: { v2: { videoId?: string; kind?: string }[] } };

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId: `dbr_${run}`, email: `dbr-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Ana's Workspace" } });
    await prisma.driveConnection.create({ data: { userId, googleEmail: "dbr@test.rendrr.dev", refreshToken: encrypt("refresh"), scopes: "drive.readonly", stub: false } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Video 3 ${run}` })).id;
    const ctx = (job: unknown) => ({ job, dir, signal: new AbortController().signal, isLastAttempt: true }) as never;
    workers.push(new Worker(QUEUES.proxy.name, async (job) => proxyJob(ctx(job)), { connection: newRedis() as never }));
    workers.push(new Worker(QUEUES.analyze.name, async (job) => analyzeJob(ctx(job)), { connection: newRedis() as never }));
  });
  after(async () => {
    for (const w of workers) await w.close();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    for (const p of ["uploads/", "proxies/", "audio/", "frames/"]) await deletePrefix(`${p}${userId}/`).catch(() => {});
    await app.close();
    google.close();
    await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("add_broll with the Drive file's id: linked into the library, its preview made, placed, and in the Media panel", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "add_broll", videoId: DRIVE_ID, start: 2, end: 4, edit: true, label: "Golf swing" }] });
    assert.match(out.text, /^Done \(v2/, out.text);
    const v = await prisma.video.findFirstOrThrow({ where: { userId, driveFileId: DRIVE_ID } });
    assert.deepEqual([v.source, v.name, v.seconds], ["drive", "Golf swing", 4]);
    assert.ok(v.proxyKey, "its preview was made from Drive");
    const tl = await timeline();
    assert.ok(tl.tracks.v2.some((x) => x.kind === "broll" && x.videoId === v.id), "placed as b-roll with the library id");
    assert.deepEqual(tl.media, [v.id]);
  });

  it("its share link works the same and does not link it twice", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "add_broll", videoId: `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`, start: 6, end: 7, edit: true }] });
    assert.match(out.text, /^Done \(v2/, out.text);
    assert.equal(await prisma.video.count({ where: { userId, driveFileId: DRIVE_ID } }), 1);
    assert.equal((await timeline()).tracks.v2.filter((x) => x.kind === "broll").length, 2);
  });

  it("a file Rendrr cannot reach says what to send; nothing changes", async () => {
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "add_broll", videoId: "1NotInDriveNotInDriveNotIn", start: 8, end: 9, edit: true }] }), /is not in your library: send a library videoId \(list_footage\), a Google Drive file's id or link/);
  });

  it("a picture sent to an audio upload link with ?kind=footage goes into the library as footage", async () => {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x600:d=1", "-frames:v", "1", join(dir, "logo.png")]);
    const link = /(https?:\/\/\S+\/audio\/upload\/[\w-]+)/.exec((await tool("add_audio", { upload: true })).text)![1];
    assert.match((await tool("add_audio", { upload: true })).text, /The link takes a video or a picture too/);
    const r = await app.inject({ method: "PUT", url: new URL(link).pathname + "?kind=footage&filename=logo.png", payload: readFileSync(join(dir, "logo.png")), headers: { "content-type": "application/octet-stream" } });
    assert.equal(r.statusCode, 200, r.body);
    const j = JSON.parse(r.body) as { videoId: string; still: boolean; status: string; text: string };
    assert.equal(j.still, true);
    assert.equal(j.status, "ready", j.text);
    assert.match(j.text, /the picture "logo" \w+ 800x600, ready/);
  });
});
