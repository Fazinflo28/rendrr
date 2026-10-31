// Object tracking through the connector: apply_edits sends track_object to the worker (the real frames job runs here),
// which follows the box drawn round an object through the clip; then a blur follows it and a text layer is pinned to
// it. The footage: a textured square sliding from the left to the right over a plain grey frame.
// Needs a database, Redis, storage, ffmpeg and Python with OpenCV (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const cv = (() => { try { execFileSync(process.env.PYTHON_BIN || "python3", ["-c", "import cv2"]); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("track_object through apply_edits", { skip: (!ready || !cv) && "needs a database, Redis, storage and Python with OpenCV" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, QUEUES } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { deletePrefix, newRedis, redis, uploadFile } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { framesJob } = await import("../../worker/src/jobs/frames");

  let userId = "", videoId = "";
  const dir = mkdtempSync(join(tmpdir(), "track-api-"));
  let worker: InstanceType<typeof Worker> | null = null;
  const c = () => ({ userId, ai: "claude" as const, clerkId: `trk_${run}` });
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `trk_${run}`, email: `trk-${run}@test.rendrr.dev`, name: "Track" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Track's Workspace" } });
    // 10 s of 16:9: a 160 px noise square from x 100 to 1000 px (1280 wide), y 280 px.
    const proxy = join(dir, "slide.mp4"), tex = join(dir, "tex.png");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=160x160:d=1,format=gray,geq=lum='255*random(1)',gblur=sigma=1.5,eq=contrast=3", "-frames:v", "1", tex]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0x707070:s=1280x720:r=30:d=10", "-loop", "1", "-i", tex,
      "-filter_complex", "[0:v][1:v]overlay=x='100+90*t':y=280:shortest=1,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-t", "10", proxy]);
    const proxyKey = `proxies/${userId}/slide.mp4`;
    await uploadFile(proxyKey, proxy, "video/mp4");
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(10) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Slide ${run}`, seconds: 10, width: 1280, height: 720, source: "drive", status: "ready", proxyKey, analysis } })).id;
    worker = new Worker(QUEUES.frames.name, async (job) => framesJob({ job, dir, signal: new AbortController().signal, isLastAttempt: true } as never), { connection: newRedis() as never });
  });
  after(async () => {
    await worker?.close();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await deletePrefix(`proxies/${userId}/`).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("follows the square, a blur follows it, and a text layer pinned to it moves with it", async () => {
    const p = await createProject(userId, { videoId });
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 9, label: "" }] }] });
    // At footage 2 s the square is at x 280-440 px, y 280-440 px.
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [
      { op: "track_object", clipId: "a", at: 2, box: { x: 280 / 1280, y: 280 / 720, w: 160 / 1280, h: 160 / 720 }, label: "square" },
      { op: "set_effects", clipId: "a", effects: [{ type: "blur", amount: 70, area: { shape: "rect", follow: "object", object: "o1" } }] },
      { op: "add_text", text: "SQUARE", start: 1, end: 6, edit: true, x: 0.3, y: 0.3, anim: "none" },
    ] });
    assert.match(r.text, /object o1 "square" tracked over 1-9s/);
    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).timeline as { tracks: { v1: { id: string; objects?: { track: number[][] }[]; effects?: { area?: { keys?: { at: number; x: number; w: number }[] } }[] }[]; v3: { id: string; kind?: string; keys?: { t: number; x?: number }[]; pin?: unknown }[] } };
    const a = tl.tracks.v1.find((x) => x.id === "a")!;
    const tr = a.objects![0].track;
    // Where it is at footage 6 s: x 640-800 px.
    const at6 = tr.find((q) => Math.abs(q[0] - 6) < 0.051)!;
    assert.ok(Math.abs(at6[1] - 640 / 1280) < 0.02 && Math.abs(at6[3] - 800 / 1280) < 0.02, JSON.stringify(at6));
    assert.ok(a.effects![0].area!.keys!.length >= 2);
    const text = tl.tracks.v3.find((x) => x.kind === "text")!;
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "pin_layer", clipId: text.id, to: { clipId: "a", object: "o1" } }] });
    const v3 = ((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).timeline as typeof tl).tracks.v3.find((x) => x.id === text.id)!;
    assert.deepEqual(v3.pin, { clipId: "a", object: "o1" });
    // From edit 1 s (footage 2 s) to edit 5 s (footage 6 s) the square moves 360 px: 0.28 of the width.
    const last = v3.keys!.find((k) => Math.abs(k.t - 4) < 0.15)!;
    assert.ok(Math.abs(last.x! - 360 / 1280) < 0.02, JSON.stringify(v3.keys));
  });
});
