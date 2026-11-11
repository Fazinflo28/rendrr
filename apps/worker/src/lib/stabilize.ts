// Phase 7: Warp Stabilizer's first pass. Each stabilized part's footage is read exactly as the render reads it (on the
// plan's frame grid, from its first frame to its last) and vidstabdetect writes how the camera moved, frame by frame;
// the render's vidstabtransform then smooths that over the part's own frames. At the footage's own size: the moves are in
// its pixels.
import type { StabilizeOp } from "@rendrr/shared/renderPlan";
import { run } from "./ffmpeg";

/** The shake measurement's FFmpeg arguments (a final whose original stays on the user's Mac measures it there). */
export function detectShakeArgs(src: string, op: StabilizeOp, rate: string, out: string): string[] {
  // Read from a second before: the frame grid is anchored at 0, so the frames from srcIn are the render's frames.
  const ss = Math.max(0, op.srcIn - 1);
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...(ss > 0 ? ["-ss", ss.toFixed(3)] : []), "-t", (op.srcOut - ss + 1).toFixed(3), "-i", src,
    "-vf", `setpts=PTS+${ss.toFixed(6)}/TB,fps=${rate},trim=start=${op.srcIn.toFixed(6)}:end=${op.srcOut.toFixed(6)},setpts=PTS-STARTPTS,vidstabdetect=shakiness=8:accuracy=10:stepsize=6:result=${out}`,
    "-an", "-f", "null", "-"];
}
export async function detectShake(src: string, op: StabilizeOp, rate: string, out: string, signal?: AbortSignal): Promise<void> {
  await run("ffmpeg", detectShakeArgs(src, op, rate, out), { signal });
}

/**
 * Phase 21: the stabilized copy of a clip's footage (b-roll, or a V1 clip at another speed): the same frames as the
 * shake was measured on (the plan's grid, srcIn to srcOut), smoothed and zoomed in just enough to hide the edges, as
 * the render does for clips at normal speed. Its frame k is footage frame srcIn x fps + k. Nearly lossless (it is cut
 * and encoded again by the render). vid.stab transforms 8-bit pictures only: 10-bit footage (HDR) is smoothed at 8 bits
 * (FFmpeg dithers it down) and the copy is kept lossless from there (FFV1), so nothing more is lost; the plan says so.
 */
/** The stabilized copy's FFmpeg arguments (made on the user's Mac too, for a final whose original stays there). */
export function stableCopyArgs(src: string, op: StabilizeOp, rate: string, trf: string, out: string, deep = false): string[] {
  const ss = Math.max(0, op.srcIn - 1);
  const enc = deep ? ["-c:v", "ffv1", "-level", "3"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p"];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...(ss > 0 ? ["-ss", ss.toFixed(3)] : []), "-t", (op.srcOut - ss + 1).toFixed(3), "-i", src,
    "-vf", `setpts=PTS+${ss.toFixed(6)}/TB,fps=${rate},trim=start=${op.srcIn.toFixed(6)}:end=${op.srcOut.toFixed(6)},setpts=PTS-STARTPTS,vidstabtransform=input=${trf.replace(/([\\':])/g, "\\$1")}:smoothing=${op.smoothing}:optzoom=1:interpol=bicubic`,
    "-an", "-r", rate, ...enc, out];
}
export async function makeStableCopy(src: string, op: StabilizeOp, rate: string, trf: string, out: string, opts: { deep?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  await run("ffmpeg", stableCopyArgs(src, op, rate, trf, out, opts.deep), { signal: opts.signal });
}
