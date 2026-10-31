import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobError, run } from "./ffmpeg";

// Object tracking: a box the user drew followed through a clip, on its frames turned and fitted as the render shows
// them (python/track.py: feature points by optical flow, checked both ways, a similarity fit, template matching
// against drift). It measures; the edit decides what follows the object.
const here = dirname(fileURLToPath(import.meta.url));
const TRACK_PY = join(here, "../../python/track.py");
const PYTHON = process.env.PYTHON_BIN || "python3";

/** [footage second, x0, y0, x1, y1, confidence 0-1]: the box in shares of the fitted frame. */
export type TrackRow = [number, number, number, number, number, number];
export type TrackOpts = { from: number; to: number; at: number; box: { x: number; y: number; w: number; h: number }; w: number; h: number; rotate: number; fitY: number; focus?: { x: number; y: number }; fps?: number; dir: string; signal?: AbortSignal };

export async function trackObject(input: string, o0: TrackOpts): Promise<TrackRow[]> {
  // Nothing before the file's start (a multicam angle that starts later): its frames are read from 0.
  const o = o0.from < 0 ? { ...o0, from: 0, at: Math.max(0, o0.at) } : o0;
  const fps = o.fps ?? 10;
  const turn = o.rotate === 90 ? "transpose=1," : o.rotate === 270 ? "transpose=2," : o.rotate === 180 ? "hflip,vflip," : "";
  const cut = o.focus ? `x='clip(${o.focus.x}*iw-ow/2,0,iw-ow)':y='clip(${o.focus.y}*ih-oh*0.4,0,ih-oh)'` : `(iw-ow)/2:(ih-oh)*${o.fitY}`;
  const raw = join(o.dir, `track-${Math.random().toString(36).slice(2)}.gray`);
  const len = Math.max(0.1, o.to - o.from);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", o.from.toFixed(3), "-t", len.toFixed(3), "-i", input,
    "-vf", `fps=${fps},${turn}scale=${o.w}:${o.h}:force_original_aspect_ratio=increase,crop=${o.w}:${o.h}:${cut},format=gray`, "-an", "-f", "rawvideo", raw], { signal: o.signal });
  try { return await follow(raw, o, fps); } finally { await rm(raw, { force: true }); }
}

async function follow(raw: string, o: TrackOpts, fps: number): Promise<TrackRow[]> {
  const n = Math.floor((await stat(raw)).size / (o.w * o.h));
  if (n < 1) throw new JobError("Could not read the clip's frames to track the object.", "track", false);
  const k0 = Math.min(n - 1, Math.max(0, Math.round((o.at - o.from) * fps)));
  const px = [o.box.x * o.w, o.box.y * o.h, o.box.w * o.w, o.box.h * o.h].map((v) => v.toFixed(2));
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(PYTHON, [TRACK_PY, raw, String(o.w), String(o.h), String(n), String(k0), ...px], { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", (d: Buffer) => { so += d; });
    p.stderr.on("data", (d: Buffer) => { se = (se + d).slice(-2000); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    const kill = () => p.kill("SIGKILL");
    o.signal?.addEventListener("abort", kill, { once: true });
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", kill);
      if (code === 0) resolve(so);
      else reject(new JobError(`Tracking the object failed: ${se.trim().split("\n").pop() || `exit ${code}`}`, "track", false));
    });
  });
  const rows = JSON.parse(out) as [number, number, number, number, number][];
  return rows.map((r, k) => [Math.round((o.from + k / fps) * 1000) / 1000, r[0], r[1], r[2], r[3], r[4]] as TrackRow);
}
