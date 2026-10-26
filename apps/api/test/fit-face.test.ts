// set_framing fitFaceTo through the connector: apply_edits has the worker find the face in each clip it frames (the
// clips named, else every clip of the main footage) on frames fitted to the edit's shape, and frames each clip from
// what it found; a clip with no face is left as it was and named. The worker's real frames job runs here, on footage
// with a face (NASA's public-domain portrait, worker/test/fixtures) in its first 6 s only.
// Needs a database, Redis, storage, ffmpeg and Python with OpenCV (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const cv = (() => { try { execFileSync(process.env.PYTHON_BIN || "python3", ["-c", "import cv2; cv2.FaceDetectorYN"]); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("fitFaceTo through apply_edits", { skip: (!ready || !cv) && "needs a database, Redis, storage and Python with OpenCV" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, QUEUES } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { deletePrefix, newRedis, redis, uploadFile } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { framesJob } = await import("../../worker/src/jobs/frames");

  let userId = "", videoId = "";
  const dir = mkdtempSync(join(tmpdir(), "fit-face-"));
  let worker: InstanceType<typeof Worker> | null = null;
  const c = () => ({ userId, ai: "claude" as const, clerkId: `fit_${run}` });
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `fit_${run}`, email: `fit-${run}@test.rendrr.dev`, name: "Fit" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Fit's Workspace" } });
    // 20 s of 16:9 footage: the portrait low on the left for the first 6 s, then an empty grey frame.
    const proxy = join(dir, "talk.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0x505860:s=1280x720:r=30:d=20", "-i", join(here, "../../worker/test/fixtures/astronaut.jpg"),
      "-filter_complex", "[0:v][1:v]overlay=80:330:enable='lt(t,6)',format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-t", "20", proxy]);
    const proxyKey = `proxies/${userId}/talk.mp4`;
    await uploadFile(proxyKey, proxy, "video/mp4");
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1280, height: 720, source: "drive", status: "ready", proxyKey, analysis } })).id;
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

  it("measures the clips it frames and frames each from its face; a clip with no face is named and left as it was", async () => {
    const p = await createProject(userId, { videoId });
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 9, end: 14, label: "" }] }] });
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "set_framing", fitFaceTo: { x: 0.5, y: 0.4, r: 0.15 } }] });
    assert.match(r.text, /put the face at 0\.5, 0\.4 \(radius 0\.15 of the frame\) in 1 clip \(scale [\d.]+.*no face found in b: left as it was/);
    const v1 = ((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).timeline as { tracks: { v1: { id: string; framing?: { scale: number; x: number; y: number } }[] } }).tracks.v1;
    // The portrait's face is at about (0.17, 0.56) of the frame, 0.047 tall by half: about 3.2x bigger, moved right and up.
    const f = v1.find((x) => x.id === "a")!.framing!;
    assert.ok(f.scale > 2.8 && f.scale < 3.6 && f.x > 0.5 && f.y < 0, JSON.stringify(f));
    assert.equal(v1.find((x) => x.id === "b")!.framing, undefined);
  });

  it("names the clip ids an edit makes", async () => {
    const p = await createProject(userId, { videoId });
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "add_zoom", start: 2, end: 3, scale: 1.2 }, { op: "add_text", text: "Hi", start: 4, end: 5 }] });
    assert.match(r.text, /added zoom at 0:02 \(clip \w+\)/);
    assert.match(r.text, /added text "Hi" at 0:04 \(clip \w+;/);
  });
});
