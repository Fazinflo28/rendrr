// Phase 7: Warp Stabilizer's first pass. Each stabilized part's footage is read exactly as the render reads it (on the
// plan's frame grid, from its first frame to its last) and vidstabdetect writes how the camera moved, frame by frame;
// the render's vidstabtransform then smooths that over the part's own frames. At the footage's own size: the moves are in
// its pixels.
import type { StabilizeOp } from "@rendrr/shared/renderPlan";
import { run } from "./ffmpeg";

export async function detectShake(src: string, op: StabilizeOp, rate: string, out: string, signal?: AbortSignal): Promise<void> {
  // Read from a second before: the frame grid is anchored at 0, so the frames from srcIn are the render's frames.
  const ss = Math.max(0, op.srcIn - 1);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...(ss > 0 ? ["-ss", ss.toFixed(3)] : []), "-t", (op.srcOut - ss + 1).toFixed(3), "-i", src,
    "-vf", `setpts=PTS+${ss.toFixed(6)}/TB,fps=${rate},trim=start=${op.srcIn.toFixed(6)}:end=${op.srcOut.toFixed(6)},setpts=PTS-STARTPTS,vidstabdetect=shakiness=8:accuracy=10:stepsize=6:result=${out}`,
    "-an", "-f", "null", "-"], { signal });
}
