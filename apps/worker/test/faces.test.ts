// set_framing fitFaceTo, measured and rendered: footage with a face off to one side (NASA's public-domain portrait of
// Eileen Collins, test/fixtures), the frames job finds the face (YuNet) on frames fitted as the render draws them, the
// op frames the clip, and in the rendered file the face is where it was asked and as big. Needs ffmpeg, Python with
// OpenCV, and for the frames job a database and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type SourceInfo } from "@rendrr/shared/renderPlan";
import { rgbFrames, run } from "../src/lib/ffmpeg";
import { detectFaces, faceOf } from "../src/lib/faces";

const here = dirname(fileURLToPath(import.meta.url));
const cv = (() => { try { execFileSync(process.env.PYTHON_BIN || "python3", ["-c", "import cv2; cv2.FaceDetectorYN"]); return true; } catch { return false; } })();
const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET;
const run6 = Math.random().toString(36).slice(2, 8);
const W = 1280, H = 720, SEC = 2;

describe("faces for set_framing fitFaceTo", { skip: !cv && "needs Python with OpenCV" }, () => {
  let dir = "", footage = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "faces-"));
    footage = join(dir, "talk.mp4");
    // A grey 16:9 frame with the 320x320 portrait low on the left.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x505860:s=${W}x${H}:r=30:d=${SEC}`, "-i", join(here, "fixtures/astronaut.jpg"),
      "-filter_complex", "[0:v][1:v]overlay=80:330,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-t", String(SEC), footage]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  // Where the face is in the portrait (YuNet on the fixture alone), moved to where the footage puts it.
  const expected = async () => {
    const one = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", join(here, "fixtures/astronaut.jpg"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 8 << 20 });
    const [b] = await detectFaces(one, 320, 320, dir);
    return { u: (80 + b!.x + b!.w / 2) / W, v: (330 + b!.y + b!.h / 2) / H, r: b!.h / 2 / H };
  };

  it("finds the face on frames fitted as the render draws them", async () => {
    const want = await expected();
    const rgb = await rgbFrames(footage, 0, SEC, { w: 640, h: 360, rotate: 0, fitY: 0.4, n: 3, dir });
    const f = faceOf(await detectFaces(rgb, 640, 360, dir), 640, 360)!;
    console.log(`face at u ${f.u}, v ${f.v}, r ${f.r} (found on ${f.found} of ${f.of} frames); expected u ${want.u.toFixed(3)}, v ${want.v.toFixed(3)}, r ${want.r.toFixed(3)}`);
    assert.equal(f.found, 3);
    assert.ok(Math.abs(f.u - want.u) < 0.01 && Math.abs(f.v - want.v) < 0.015 && Math.abs(f.r - want.r) < 0.006, JSON.stringify(f));
    // A frame with no face says so (null), rather than a guess.
    const grey = Buffer.alloc(480 * 270 * 3, 90);
    assert.equal(faceOf(await detectFaces(grey, 480, 270, dir), 480, 270), null);
  });

  it("the frames job measures each clip, and the render puts the face where fitFaceTo asked", { skip: !db && "needs a database and storage" }, async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, uploadFile } = await import("@rendrr/core");
    const { framesJob } = await import("../src/jobs/frames");
    const userId = (await prisma.user.create({ data: { clerkId: `faces_${run6}`, email: `faces-${run6}@test.rendrr.dev`, name: "Faces" } })).id;
    try {
      const proxyKey = `proxies/${userId}/talk.mp4`;
      await uploadFile(proxyKey, footage, "video/mp4");
      const videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds: SEC, width: W, height: H, source: "local", status: "ready", proxyKey } })).id;
      const faces = (await framesJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { times: [], faces: { w: 640, h: 360, clips: [{ id: "a", videoId, srcIn: 0, srcOut: SEC, rotate: 0, fitY: 0.4 }] } } } as unknown as Job })) as Record<string, { u: number; v: number; r: number } | null>;
      assert.ok(faces.a, "the face is found");

      // The edit: fitFaceTo with the measured face, as apply_edits sends it.
      const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined, getVideo: () => undefined } as unknown as EditContext;
      let s: Snapshot = { timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "f", aspect: "16:9", styleId: "s2" };
      s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] as Op[] as never }, ctx).snap;
      const clip = s.timeline.tracks.v1[0].id;
      const to = { x: 0.5, y: 0.4, r: 0.12 };
      const r = applyOp(s, { op: "set_framing", fitFaceTo: to, faces: { [clip]: faces.a } } as Op, ctx);
      console.log(r.summary);
      const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SEC, hasAudio: false };
      const plan = planRender({ kind: "preview", snapshot: r.snap, transcript: [], source, videoId: "v" });
      const out = join(dir, "out.mp4");
      const { args, filterGraph } = ffmpegArgs(plan, { source: footage, output: out }, source, { loudnessGainDb: 0 });
      await writeFile(join(dir, "g.txt"), filterGraph);
      await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));

      // The face in the rendered frame.
      const ow = plan.width, oh = plan.height;
      const frame = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 << 20 });
      const got = faceOf(await detectFaces(frame, ow, oh, dir), ow, oh)!;
      console.log(`rendered ${ow}x${oh}: face at ${got.u}, ${got.v}, radius ${got.r}; asked ${to.x}, ${to.y}, ${to.r}`);
      assert.ok(Math.abs(got.u - to.x) < 0.02 && Math.abs(got.v - to.y) < 0.02, `face at ${got.u}, ${got.v}`);
      assert.ok(Math.abs(got.r - to.r) < 0.012, `radius ${got.r}`);
    } finally {
      await deletePrefix(`proxies/${userId}/`).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
