// remove_background end to end with the real model: a person (the astronaut fixture, a public-domain NASA portrait) in
// a 14 s video in storage; the render makes the matte's two blocks with python/matte.py (MediaPipe's selfie segmenter)
// and keeps them; the person stays, a corner of the room becomes the edit's background; a second render reads the kept
// blocks instead of making them again. Needs ffmpeg, a database and storage (as in .env), Python with MediaPipe
// (PYTHON_BIN) and the model (MATTE_MODEL).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, matteJobId, matteKey, type EditContext, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "astronaut.jpg");
const SECONDS = 14, W = 1280, H = 720;
const ready = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET && !!process.env.MATTE_MODEL && existsSync(process.env.MATTE_MODEL);
const run_ = Math.random().toString(36).slice(2, 8);

describe("remove_background with the model", { skip: !ready && "needs a database, storage, PYTHON_BIN with MediaPipe and MATTE_MODEL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { deleteObjects, deletePrefix, enqueue, headObject, queue, uploadFile, redis } = await import("@rendrr/core");
  const { run } = await import("../src/lib/ffmpeg");
  const { ensureMattes } = await import("../src/lib/matte");
  let dir = "", main = "", userId = "", videoId = "";
  const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "subject-matte-"));
    main = join(dir, "person.mp4");
    // The portrait (640 x 640) in the middle of a 1280 x 720 room: a warm wall, slowly moving so frames differ.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", FIXTURE, "-f", "lavfi", "-i", `color=c=0xC8A070:s=${W}x${H}:r=30:d=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", `[0:v]scale=640:640[p];[1:v][p]overlay=x='320+20*sin(t)':y=80:shortest=1,format=yuv420p[v]`, "-map", "[v]", "-map", "2:a", "-t", String(SECONDS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", main]);
    userId = (await prisma.user.create({ data: { clerkId: `sm_${run_}`, email: `sm-${run_}@test.rendrr.dev`, name: "Matte" } })).id;
    const proxyKey = `proxies/test-${run_}.mp4`;
    await uploadFile(proxyKey, main, "video/mp4");
    videoId = (await prisma.video.create({ data: { userId, name: `Person ${run_}`, kind: "footage", seconds: SECONDS, width: W, height: H, source: "drive", status: "ready", proxyKey } })).id;
  });
  after(async () => {
    await deletePrefix(`frames/${userId}/`).catch(() => {});
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { clerkId: `sm_${run_}` } });
    await redis().quit().catch(() => {});
    if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true });
  });

  const ctx = (): EditContext => ({ videoId, transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined });
  const snap = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], videoId), name: "s", aspect: "16:9", styleId: "s2" },
    { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_background", color: "#00FF00" }, { op: "remove_background" }] as never }, ctx()).snap;

  it("makes the matte, keeps the person, shows the background around them, and keeps the blocks", async () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: [], source, videoId });
    const t0 = Date.now();
    const mattes = await ensureMattes(plan, userId, dir);
    const made = Date.now() - t0;
    console.log(`matte made in ${(made / 1000).toFixed(1)} s for ${SECONDS} s of footage`);
    assert.ok(await headObject(matteKey(userId, videoId, 0, 0)) && await headObject(matteKey(userId, videoId, 0, 1)), "both blocks are kept in storage");
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, n); await writeFile(p, lookFileData(spec, plan)); looks[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, "out.mp4"), looks, mattes };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, "graph.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "graph.txt") : a)));
    // A frame at 11 s (the second block), as RGB at 640 x 360.
    const w = 640, h = 360;
    const px = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "11", "-i", files.output, "-frames:v", "1", "-vf", `scale=${w}:${h},format=rgb24`, "-f", "rawvideo", "pipe:1"]);
    const at = (x: number, y: number) => { const i = (y * w + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
    // The room's corners: the edit's green. The face (the portrait's upper middle, at its place at 11 s): not green.
    for (const [x, y] of [[20, 20], [w - 20, 20], [20, h - 20], [w - 20, h - 20]]) { const c = at(x, y); assert.ok(c[1] > 200 && c[0] < 60 && c[2] < 60, `corner ${x},${y} should be the background, got ${c}`); }
    const cx = Math.round((320 + 20 * Math.sin(11) + 320) / 2);
    const face = at(cx, 110);
    assert.ok(!(face[1] > 200 && face[0] < 60), `the face should stay, got ${face}`);
    // Again: the kept blocks are read, not made.
    const t1 = Date.now();
    await ensureMattes(plan, userId, await mkdtemp(join(tmpdir(), "subject-matte-2-")));
    console.log(`second time: ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    assert.ok(Date.now() - t1 < made / 2, "the second render reads the kept blocks");
  });

  it("a block still queued behind other matte jobs is made by the render, not waited for", async () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: [], source, videoId });
    const key = matteKey(userId, videoId, 0, 1), jobId = matteJobId(videoId, 0, 1);
    await deleteObjects([key]);
    // No matte worker runs here: the job stays waiting, as one behind others would.
    await enqueue("matte", { videoId, userId, k: 1, turn: 0 }, { jobId, removeOnComplete: true, removeOnFail: true });
    assert.equal(await (await queue("matte").getJob(jobId))!.getState(), "waiting");
    const t0 = Date.now();
    await ensureMattes(plan, userId, await mkdtemp(join(tmpdir(), "subject-matte-3-")));
    console.log(`made by the render in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    assert.ok(await headObject(key), "the block is made and kept");
    assert.equal(await queue("matte").getJob(jobId), undefined, "the queued job is taken off the queue");
    assert.ok(Date.now() - t0 < 4 * 60_000);
  });
});
