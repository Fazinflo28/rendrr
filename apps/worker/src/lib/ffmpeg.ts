import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMeasureLog, type FileMeasure } from "@rendrr/shared";

export class JobError extends Error {
  friendly = true;
  constructor(message: string, public code?: string, public retry = true) { super(message); }
}

export type RunOpts = { signal?: AbortSignal; onProgress?: (seconds: number) => void; cwd?: string; stdin?: "ignore" };

/** Runs a command; kills it when the job's signal aborts. Never logs file contents. */
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new JobError("Stopped."));
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const kill = () => { try { p.kill("SIGKILL"); } catch { /* gone */ } };
    opts.signal?.addEventListener("abort", kill, { once: true });
    p.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (opts.onProgress) {
        for (const m of s.matchAll(/out_time_(?:us|ms)=(\d+)/g)) opts.onProgress(Number(m[1]) / 1e6);
      } else if (stdout.length < 2_000_000) stdout += s;
    });
    p.stderr.on("data", (d: Buffer) => { if (stderr.length < 200_000) stderr += d.toString(); });
    p.on("error", (e) => { opts.signal?.removeEventListener("abort", kill); reject(e); });
    p.on("close", (code) => {
      opts.signal?.removeEventListener("abort", kill);
      if (opts.signal?.aborted) return reject(new JobError("Stopped."));
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} exited with ${code}: ${stderr.slice(-800)}`), { stderr }));
    });
  });
}

export type Probe = { seconds: number; width: number; height: number; fps: number; hasVideo: boolean; hasAudio: boolean; rotation: number; hdr: boolean; transfer?: "pq" | "hlg"; sizeBytes: number };

/** ffprobe with optional HTTP headers (Drive). Width and height are as displayed (rotation applied). */
export async function probe(input: string, opts: { headers?: string; signal?: AbortSignal } = {}): Promise<Probe> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...(opts.headers ? ["-headers", opts.headers] : []), input];
  const { stdout } = await run("ffprobe", args, { signal: opts.signal });
  const j = JSON.parse(stdout) as { format?: { duration?: string; size?: string }; streams?: Record<string, any>[] };
  const v = (j.streams || []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list || []).find((x: Record<string, unknown>) => x.rotation != null);
    rotation = Math.abs(Number(sd?.rotation ?? v.tags?.rotate ?? 0)) % 360;
  }
  const rate = (r?: string) => { if (!r) return 0; const [n, d] = r.split("/").map(Number); return d ? n / d : n; };
  const w = Number(v?.width || 0), h = Number(v?.height || 0);
  const swap = rotation === 90 || rotation === 270;
  return {
    seconds: Number(j.format?.duration || v?.duration || a?.duration || 0),
    width: swap ? h : w, height: swap ? w : h,
    fps: Math.round((rate(v?.avg_frame_rate) || rate(v?.r_frame_rate) || 30) * 100) / 100,
    hasVideo: !!v, hasAudio: !!a, rotation,
    hdr: !!v && ["smpte2084", "arib-std-b67"].includes(String(v.color_transfer || "")),
    ...(v && ["smpte2084", "arib-std-b67"].includes(String(v.color_transfer || "")) ? { transfer: v.color_transfer === "smpte2084" ? "pq" as const : "hlg" as const } : {}),
    sizeBytes: Number(j.format?.size || 0),
  };
}

/** Silence ranges from FFmpeg silencedetect (-35 dB, at least 0.4 s). */
export async function silences(input: string, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
  const { stderr } = await runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-i", input, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"], signal);
  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: ([\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) cur = Number(s[1]);
    if (e && cur != null) { out.push({ start: Math.round(cur * 100) / 100, end: Math.round(Number(e[1]) * 100) / 100 }); cur = null; }
  }
  return out;
}

/**
 * Measures a rendered file in one decoding pass: each stream's length, black picture and silence from 0.15 s,
 * integrated loudness and true peak. The after-render check compares this with the edit. Times out after
 * `timeoutMs` and then throws, so a stuck measurement never holds the render.
 */
export async function measureFile(input: string, o: { signal?: AbortSignal; timeoutMs: number; picture?: boolean }): Promise<Omit<FileMeasure, "graphics">> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", "stream=codec_type,duration:format=duration", input], { signal: o.signal });
  const j = JSON.parse(stdout) as { streams?: { codec_type?: string; duration?: string }[]; format?: { duration?: string } };
  const len = (type: string) => { const st = (j.streams || []).find((x) => x.codec_type === type); const n = Number(st?.duration ?? (st ? j.format?.duration : NaN)); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null; };
  const videoSeconds = len("video"), audioSeconds = len("audio");
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, o.timeoutMs);
  try {
    const { stderr } = await runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-i", input,
      ...(videoSeconds != null && o.picture !== false ? ["-vf", "blackdetect=d=0.15:pix_th=0.10"] : ["-vn"]),
      ...(audioSeconds != null ? ["-af", "silencedetect=noise=-45dB:d=0.15,ebur128=peak=true"] : ["-an"]),
      "-f", "null", "-"], ac.signal);
    return { videoSeconds, audioSeconds, ...parseMeasureLog(stderr, audioSeconds ?? videoSeconds ?? 0) };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    throw new Error(ac.signal.aborted ? `measuring the file took longer than ${Math.round(o.timeoutMs / 1000)}s` : `measuring the file failed: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", stop);
  }
}

/** How much of the frame a graphic file covers at time t (average alpha, 0-100). Opaque files count as 100. */
export async function graphicCover(input: string, t: number, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stderr } = await runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-c:v", "libvpx-vp9", "-ss", Math.max(0, t).toFixed(3), "-i", input, "-frames:v", "1",
      "-vf", "alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"], signal);
    const m = /signalstats\.YAVG=([\d.]+)/.exec(stderr);
    return m ? Math.round((Number(m[1]) / 255) * 1000) / 10 : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    // No alpha plane: the graphic is opaque and covers its whole box.
    return /alpha|Requested planes not available|Invalid argument/i.test((e as Error).message) ? 100 : null;
  }
}

/** Like run(), but keeps the whole stderr (silencedetect writes its findings there). */
function runCapture(cmd: string, args: string[], signal?: AbortSignal): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const kill = () => { try { p.kill("SIGKILL"); } catch { /* gone */ } };
    signal?.addEventListener("abort", kill, { once: true });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 20_000_000) stderr = stderr.slice(-10_000_000); });
    p.on("error", reject);
    p.on("close", (code) => { signal?.removeEventListener("abort", kill); code === 0 ? resolve({ stderr }) : reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-500)}`)); });
  });
}

export async function frameAt(input: string, t: number, out: string, width = 640, signal?: AbortSignal, hdr = false) {
  // An HDR file's frame is tone-mapped like the preview copies, so the picture looks as it should on any screen.
  const tone = hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "";
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `${tone}scale=${width}:-2`, "-q:v", "4", out], { signal });
}

/**
 * Phase 6: frames of a stretch of a video as RGB bytes, turned and fitted to w x h like the editor shows them
 * (cover, `fitY` down), `n` of them spread over [from, to]. For shot matching.
 */
export async function rgbFrames(input: string, from: number, to: number, o: { w: number; h: number; rotate: number; fitY: number; n: number; dir: string; signal?: AbortSignal }): Promise<Buffer> {
  const turn = o.rotate === 90 ? "transpose=1," : o.rotate === 270 ? "transpose=2," : o.rotate === 180 ? "hflip,vflip," : "";
  const parts: Buffer[] = [];
  for (let k = 0; k < o.n; k++) {
    const t = from + ((k + 0.5) / o.n) * Math.max(0, to - from);
    const out = join(o.dir, `rgb-${Math.random().toString(36).slice(2)}.raw`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `${turn}scale=${o.w}:${o.h}:force_original_aspect_ratio=increase,crop=${o.w}:${o.h}:(iw-ow)/2:(ih-oh)*${o.fitY},format=rgb24`, "-f", "rawvideo", out], { signal: o.signal });
    const b = await readFile(out).catch(() => null);
    if (b && b.length === o.w * o.h * 3) parts.push(b);
  }
  return Buffer.concat(parts);
}
