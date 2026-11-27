// Footage work on the user's computer, end to end with the real pieces: footage kept in Rendrr's storage is given its
// preview copy by the worker's proxy job, which hands the run to the user's "Mac" (desktop/render.js, the app's own
// code) while its app is open: the Mac fetches the original, makes the proxy, the sound and the key frames, uploads them
// and the video is recorded as made on that computer. An app without a speech model is not handed the transcript; with
// no app open the cloud makes the preview copy.
// Needs a database, Redis and storage.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
process.env.MAC_CLAIM_MS = "1500";
process.env.MAC_QUIET_MS = "15000"; // roomy: other suites run FFmpeg at the same time
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const sh = promisify(execFile);

describe("footage made ready on the user's computer", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const core = await import("@rendrr/core");
  const { prisma } = await import("@rendrr/db");
  const { PREFIX } = await import("@rendrr/shared");
  const { proxyJob } = await import("../../worker/src/jobs/proxy");
  const { transcriptOnComputer } = await import("../../worker/src/lib/onComputer");
  const { buildServer } = await import("../src/server");
  const mac = (await import("../../../desktop/render.js")) as unknown as { runTask: (t: unknown, o: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }> };
  let app: Awaited<ReturnType<typeof buildServer>>, api = "", dir = "", work = "";
  let userId = "", lonelyId = "";
  const keys: string[] = [];
  const DEVICE = "dev-" + run;
  const able = (have: string[]) => ({ protocol: 1, ready: true, enabled: true, busy: false, cpus: 8, have, ffmpeg: "7.1", why: null });

  before(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    dir = await mkdtemp(join(tmpdir(), "foc-")); work = await mkdtemp(join(tmpdir(), "foc-work-"));
    userId = (await prisma.user.create({ data: { clerkId: `foc_${run}`, email: `foc-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    lonelyId = (await prisma.user.create({ data: { clerkId: `foc2_${run}`, email: `foc2-${run}@test.rendrr.dev`, name: "Bo" } })).id;
    // A vertical 4 s clip with sound, kept in storage as footage brought in from the chat is.
    await sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=60:d=4", "-f", "lavfi", "-i", "sine=f=330:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4", join(dir, "clip.mp4")]);
  });
  after(async () => {
    await core.deleteObjects(keys).catch(() => {});
    await prisma.video.deleteMany({ where: { userId: { in: [userId, lonelyId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [userId, lonelyId] } } }).catch(() => {});
    for (const d of [dir, work]) await rm(d, { recursive: true, force: true });
    await app.close(); await core.redis().quit().catch(() => {});
  });

  const footage = async (owner: string, name: string) => {
    const v = await prisma.video.create({ data: { userId: owner, name, source: "upload", status: "linking", sizeBytes: BigInt(1) } });
    const key = `${PREFIX.uploads}${owner}/${v.id}/source.mp4`;
    const size = await core.uploadFile(key, join(dir, "clip.mp4"), "video/mp4");
    keys.push(key, `${PREFIX.proxies}${owner}/${v.id}.mp4`, `${PREFIX.audio}${owner}/${v.id}.m4a`, ...[0, 1, 2, 3, 4].map((i) => `${PREFIX.frames}${owner}/${v.id}/kf${i}.jpg`));
    return prisma.video.update({ where: { id: v.id }, data: { sourceKey: key, sizeBytes: BigInt(size) } });
  };
  const ctxFor = (videoId: string) => ({ signal: new AbortController().signal, dir, job: { data: { videoId } } as never, isLastAttempt: true, extend: () => {} });
  // The Mac app (as the web app in it does): take this computer's next task, run it with the app's own code.
  const macTakes = async (o: Record<string, unknown> = {}) => {
    for (let i = 0; i < 60; i++) {
      const t = (await core.listMacTasks(userId, DEVICE))[0];
      if (t) {
        const got = await core.claimMacTask(userId, t.id, "Test Mac", "mac", DEVICE);
        assert.ok(got, "claimed");
        return { kind: t.kind, res: await mac.runTask(await core.macManifest(got!.task, got!.token, api), { ffmpeg: "ffmpeg", cacheDir: join(work, "cache"), workDir: work, allowHttp: true, ...o }) };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no task appeared");
  };

  it("the preview copy is made on the computer while its app is open, and the video says so", async () => {
    await core.noteMacDevice(userId, { id: DEVICE, name: "Test Mac", platform: "mac", version: "0.1.30", render: able(["libx264", "ass", "zscale", "tonemap", "whisper"]) });
    const v = await footage(userId, `Clip ${run}`);
    const [, m] = await Promise.all([proxyJob(ctxFor(v.id)), macTakes()]);
    assert.equal(m.kind, "footage_preview");
    assert.equal(m.res.ok, true, m.res.error);
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.status, "processing");
    assert.equal(after.proxyKey, `${PREFIX.proxies}${userId}/${v.id}.mp4`);
    assert.ok(Number(after.previewSizeBytes) > 10_000);
    const made = after.madeOn as { preview?: { on: string; device?: string; by?: string } };
    assert.equal(made.preview?.on, "computer");
    assert.equal(made.preview?.device, "Test Mac");
    assert.equal(made.preview?.by, "app");
    // The proxy is what the cloud makes: 720 wide for a vertical clip, 30 fps, with sound; and the 16 kHz sound.
    await core.downloadFile(after.proxyKey!, join(work, "p.mp4"));
    await core.downloadFile(after.audioKey!, join(work, "a.m4a"));
    const probe = async (f: string) => (await sh("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,sample_rate,channels", "-of", "compact", f])).stdout;
    assert.match(await probe(join(work, "p.mp4")), /width=720\|height=1280/);
    assert.match(await probe(join(work, "a.m4a")), /sample_rate=16000\|channels=1/);
    const an = await prisma.footageAnalysis.findUniqueOrThrow({ where: { videoId: v.id } });
    assert.equal((an.keyFrames as unknown[]).length, 5, "five key frames");
    assert.ok(after.thumbKey);
  });

  it("an app without a speech model is not asked for a transcript", async () => {
    await core.noteMacDevice(userId, { id: DEVICE, name: "Test Mac", platform: "mac", version: "0.1.20", render: able(["libx264"]) });
    const v = await prisma.video.findFirstOrThrow({ where: { userId, name: `Clip ${run}` } });
    const t0 = Date.now();
    const r = await transcriptOnComputer({ userId, videoId: v.id, signal: new AbortController().signal, dir, audioKey: v.audioKey!, seconds: v.seconds, language: "en", onProgress: () => {} });
    assert.equal(r.words, null);
    assert.match((r as { why: string }).why, /lacks whisper/);
    assert.ok(Date.now() - t0 < 1000, "at once, with no task to wait on");
  });

  it("with no app open the cloud makes the preview copy, with nothing to say about why", async () => {
    const v = await footage(lonelyId, `Lonely ${run}`);
    await proxyJob(ctxFor(v.id));
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.status, "processing");
    assert.ok(after.proxyKey);
    const made = after.madeOn as { preview?: { on: string; why?: string | null; by?: string } };
    assert.equal(made.preview?.on, "cloud");
    assert.equal(made.preview?.by, "ffmpeg");
    assert.equal(made.preview?.why ?? null, null);
  });
});
