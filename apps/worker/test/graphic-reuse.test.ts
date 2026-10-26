// One custom graphic recorded once and placed four times at different offsets (add_graphic from), the last with its
// own params (window.params). The render shows each placement's part of the recording, the placement with its own
// params plays its own recording, which is kept and reused by the next render; prewarming queues it once.
// Needs ffmpeg, Chromium, a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type { Job } from "bullmq";
import { applyOp, buildInitialTimeline, customParamsSchema, graphicDefaults, PREFIX, type EditContext, type Op, type Snapshot, type V3Clip } from "@rendrr/shared";
import { ffmpegArgs, planRender, type SourceInfo } from "@rendrr/shared/renderPlan";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const execFileP = promisify(execFile);
const run = Math.random().toString(36).slice(2, 8);
const W = 640, H = 360, SEC = 20;

// A 20 s canvas graphic at 320x180: a bar 10 + 14t px wide on rows 40-140, in window.params.color.
const code = `<canvas id="c" width="320" height="180"></canvas><style>body{margin:0}</style><script>
window.renderFramePure = true;
const g = document.getElementById("c").getContext("2d");
window.renderFrame = (t) => { g.clearRect(0, 0, 320, 180); g.fillStyle = window.params.color; g.fillRect(0, 40, 10 + t * 14, 100); };
</script>`;

describe("one graphic, placed many times", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { deletePrefix, graphicVariant, headObject, prewarmGraphics, queue } = await import("@rendrr/core");
  const { graphicJob } = await import("../src/jobs/graphic");
  const { renderGraphicClip } = await import("../src/lib/graphics");
  const { run: ff } = await import("../src/lib/ffmpeg");

  let dir = "", userId = "", graphicId = "";
  const ctxFor = (data: object) => ({ signal: new AbortController().signal, dir, job: { data } as unknown as Job, isLastAttempt: true });
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "graphic-reuse-"));
    userId = (await prisma.user.create({ data: { clerkId: `greuse_${run}`, email: `greuse-${run}@test.rendrr.dev`, name: "Reuse" } })).id;
    graphicId = (await prisma.graphic.create({ data: { ownerId: userId, name: "Bar", kind: "custom", code, paramsSchema: customParamsSchema({ color: "#ff0000" }), durationSec: SEC, width: 320, height: 180, transparent: true, status: "queued" } })).id;
  });
  after(async () => {
    await deletePrefix(`${PREFIX.graphics}${userId}/`).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true });
  });

  it("records once; four placements at different offsets each show their part, the last in its own colour", async () => {
    await graphicJob(ctxFor({ graphicId }));
    const g = await prisma.graphic.findUniqueOrThrow({ where: { id: graphicId } });
    assert.equal(g.status, "ready");
    // The edit: 30 s of footage, the graphic at 1, 5, 9 and 13 s for 3 s each, from 0, 5, 10 and 15 s of it.
    const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: () => undefined, getGraphic: (id: string) => (id === graphicId ? { id, name: "Bar", durationSec: SEC, custom: true, params: graphicDefaults(g.paramsSchema) } : undefined) } as unknown as EditContext;
    let s: Snapshot = { timeline: buildInitialTimeline([], 30, "clean", [], "v"), name: "g", aspect: "16:9", styleId: "s2" };
    const places = [[1, 0], [5, 5], [9, 10], [13, 15]] as const;
    s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null },
      ...places.map(([at, from], i) => ({ op: "add_graphic", graphicId, start: at, end: at + 3, from, ...(i === 3 ? { params: { color: "#00ff00" } } : {}) }))] as Op[] as never }, ctx).snap;
    const clips = (s.timeline.tracks.v3 as V3Clip[]).filter((c) => c.kind === "graphic");
    assert.equal(clips.length, 4);

    // Prewarming queues one recording: the placement with its own params (the others play the graphic's own).
    const v = graphicVariant(g, clips[3].params)!;
    assert.equal(await prewarmGraphics(userId, s.timeline), 1);
    await (await queue("graphic").getJob(v.jobId))?.remove(); // no worker here: the render records it

    const footage = join(dir, "black.mp4");
    await ff("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x202020:s=${W}x${H}:r=30:d=30`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", footage]);
    const source: SourceInfo = { width: W, height: H, fps: 30, seconds: 30, hasAudio: true };
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    assert.deepEqual(plan.graphics.map((x) => x.sourceStart), [0, 5, 10, 15]);
    const files = { source: footage, output: join(dir, "out.mp4"), graphics: {} as Record<string, string>, graphicSeconds: {} as Record<string, number> };
    const took: number[] = [];
    for (const c of clips) {
      const t0 = Date.now();
      const got = (await renderGraphicClip(c, { width: plan.width, height: plan.height, dir, userId }))!;
      took.push(Date.now() - t0);
      files.graphics[c.id] = got.path; files.graphicSeconds[c.id] = got.seconds;
    }
    console.log(`placements ready in ${took.map((x) => (x / 1000).toFixed(1) + " s").join(", ")} (the last recorded its own params)`);
    assert.ok(await headObject(v.key), "the placement's own recording is kept");
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, "g.txt"), filterGraph);
    await ff("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));

    // 1.5 s into each placement the bar is as wide as at from + 1.5 s of the graphic (scaled to the output's width).
    const OW = plan.width, k = OW / 320;
    const bar = async (t: number, isColour: (r: number, g: number, b: number) => boolean) => {
      const px = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", files.output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 64 << 20 })).stdout as Buffer;
      let n = 0;
      for (let x = 0; x < OW; x++) { const i = (Math.round(90 * k) * OW + x) * 3; if (isColour(px[i], px[i + 1], px[i + 2])) n++; }
      return n;
    };
    const red = (r: number, g: number, b: number) => r > 170 && g < 90 && b < 90, green = (r: number, g: number, b: number) => g > 170 && r < 90 && b < 90;
    for (const [i, [at, from]] of places.entries()) {
      const want = Math.round(k * (10 + 14 * (from + 1.5)));
      const got = await bar(at + 1.5, i === 3 ? green : red), other = await bar(at + 1.5, i === 3 ? red : green);
      console.log(`placement ${i + 1} (from ${from} s): bar ${got}px, expected ${want}px`);
      assert.ok(Math.abs(got - want) <= 2 * k + 2, `placement ${i + 1}: bar ${got}px, expected ${want}px`);
      assert.equal(other, 0, `placement ${i + 1} shows the other colour`);
    }

    // The next render takes the placement's own recording from storage, and nothing is queued again.
    const t1 = Date.now();
    await renderGraphicClip(clips[3], { width: plan.width, height: plan.height, dir, userId });
    assert.ok(Date.now() - t1 < took[3] / 2 && Date.now() - t1 < 3000, `second time ${Date.now() - t1} ms`);
    assert.equal(await prewarmGraphics(userId, s.timeline), 0);
  });

  it("a prewarm job records a placement's params once, and the render then only downloads it", async () => {
    const g = await prisma.graphic.findUniqueOrThrow({ where: { id: graphicId } });
    const params = { color: "#0000ff" };
    const v = graphicVariant(g, params)!;
    await graphicJob(ctxFor({ graphicId, params: v.params }));
    assert.ok(await headObject(v.key));
    const clip = { id: "gx", start: 0, end: 3, label: "", kind: "graphic", graphicId, params } as V3Clip;
    const t0 = Date.now();
    const got = (await renderGraphicClip(clip, { width: W, height: H, dir, userId }))!;
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    assert.equal(got.seconds, SEC);
    // A variant that fails leaves the graphic as it is.
    const { graphicFailed } = await import("../src/jobs/graphic");
    await graphicFailed({ graphicId, params: { color: "#123456" } }, "boom");
    assert.equal((await prisma.graphic.findUniqueOrThrow({ where: { id: graphicId } })).status, "ready");
  });
});
