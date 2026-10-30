import { uploadFile, type CanvasJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { DEEP_VERSION, PREFIX } from "@rendrr/shared";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { JobError, run } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

/**
 * The blank canvas of an edit made from scratch (no footage: graphics, text and music on top): a solid colour with a
 * silent sound track, 30 fps, at the edit's shape with a 1080 px short side. Two seconds are encoded and looped with
 * stream copy, so an hour takes seconds. The same file is the preview copy and the original, kept for good (no expiry).
 */
export async function canvasJob(ctx: Ctx): Promise<{ key: string; bytes: number }> {
  const d = ctx.job.data as CanvasJob;
  if (!/^#[0-9a-fA-F]{6}$/.test(d.color)) throw new JobError("The canvas colour is #RRGGBB.", "bad-color", false);
  if (d.width < 16 || d.height < 16 || d.width > 4096 || d.height > 4096 || !(d.seconds > 0)) throw new JobError("That canvas size or length is not possible.", "bad-size", false);
  const seg = join(ctx.dir, "seg.mp4"), out = join(ctx.dir, "canvas.mp4");
  const ff = (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { signal: ctx.signal });
  // BT.709, limited range, as the render and the editor read footage (the colour lands exactly as asked).
  await ff(["-f", "lavfi", "-i", `color=c=0x${d.color.slice(1)}:s=${d.width}x${d.height}:r=30:d=2,format=gbrp,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-g", "60", "-bf", "0", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", seg]);
  // The picture looped as it is (exact 30 fps timestamps); the silence encoded fresh (looped AAC would drift).
  await ff(["-stream_loop", "-1", "-i", seg, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", d.seconds.toFixed(3), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", out]);
  const key = `${PREFIX.canvas}${d.videoId}.mp4`;
  const bytes = (await stat(out)).size;
  await uploadFile(key, out, "video/mp4");
  await prisma.video.update({
    where: { id: d.videoId },
    data: {
      status: "ready", step: null, progress: null, error: null, proxyKey: key, sourceKey: key, sizeBytes: BigInt(bytes), originalSize: BigInt(bytes), previewSizeBytes: BigInt(bytes),
      previewExpiresAt: null, width: d.width, height: d.height, fps: 30, hasAudio: true, seconds: d.seconds,
      // Nothing to read in a blank canvas: no words, pauses or cuts; marked measured so no deeper pass is queued.
      analysis: { create: { transcriber: "none", transcript: [], silences: [], sceneCuts: [], keyFrames: [], deepVersion: DEEP_VERSION } },
    },
  });
  return { key, bytes };
}
