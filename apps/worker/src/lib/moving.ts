// Phase 3: a moving mask or area (its keys, or a face it follows) as a grey video in footage time, which the render
// puts through the clip's own trim and speed as it does the picture. Frames from movingFrames (shared), written by
// FFmpeg as lossless FFV1 (the edge's softness kept exactly).
import { spawn } from "node:child_process";
import { movingFrames, type LookFile } from "@rendrr/shared/renderPlan";

export async function writeMoving(spec: Extract<LookFile, { kind: "moving" }>, plan: { width: number; height: number; fps?: number; rate?: string }, out: string, signal?: AbortSignal): Promise<void> {
  const m = movingFrames(spec, plan);
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${m.w}x${m.h}`, "-r", plan.rate || String(m.fps), "-i", "-",
    "-c:v", "ffv1", "-pix_fmt", "gray", "-threads", "1", out], { stdio: ["pipe", "ignore", "pipe"], signal });
  let err = "";
  ff.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  const done = new Promise<void>((ok, no) => { ff.on("error", no); ff.on("close", (code) => (code === 0 ? ok() : no(new Error(`ffmpeg could not write a moving mask: ${err.trim().slice(0, 300)}`)))); });
  for (let i = 0; i < m.count; i++) {
    if (!ff.stdin.write(m.frame(i))) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await done;
}
