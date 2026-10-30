import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parseMeasureLog, type FileMeasure } from "@rendrr/shared";

export class JobError extends Error {
  friendly = true;
  constructor(message: string, public code?: string, public retry = true) { super(message); }
}

/** CPUs this container may use: its cgroup quota when there is one (the host can have many more than we get). */
export function cpuBudget() {
  try {
    const [q, p] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (q !== "max" && Number(q) > 0 && Number(p) > 0) return Math.max(1, Math.floor(Number(q) / Number(p)));
  } catch { /* no cgroup v2 quota */ }
  return availableParallelism();
}

/**
 * Filter graph threads for renders: FFMPEG_FILTER_THREADS, else by the graph. Every scaler in it starts this many
 * threads, so a heavy graph (each part drawn on its own: scalers by the hundred) stays at 4; a light one (one video
 * fitted once, one look) uses every CPU the container has (up to 16): the look scales almost linearly with threads.
 */
export function filterThreads(graph?: string): number {
  const set = Math.floor(Number(process.env.FFMPEG_FILTER_THREADS || 0));
  if (set > 0) return set;
  const cpus = Math.min(16, cpuBudget());
  const scalers = graph == null ? Infinity : (graph.match(/\bz?scale=/g) || []).length;
  return Math.max(1, scalers <= 12 ? cpus : Math.min(4, cpus));
}

/** FFmpeg failed because the container could not start another thread. */
export const outOfThreads = (e: unknown) => /Resource temporarily unavailable/.test(String((e as { stderr?: string })?.stderr ?? ""));

/** onLine: each line the command writes to stderr (a Python script's "PROGRESS n"). */
export type RunOpts = { signal?: AbortSignal; onProgress?: (seconds: number) => void; onLine?: (line: string) => void; cwd?: string; stdin?: "ignore" };

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
    let partial = "";
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      if (opts.onLine) {
        const parts = (partial + s).split("\n");
        partial = parts.pop() ?? "";
        for (const line of parts) opts.onLine(line);
        // Progress lines are not kept: the error text keeps what explains a failure.
        if (stderr.length < 200_000) stderr += parts.filter((l) => !l.startsWith("PROGRESS ")).join("\n") + (parts.length ? "\n" : "");
      } else if (stderr.length < 200_000) stderr += s;
    });
    p.on("error", (e) => { opts.signal?.removeEventListener("abort", kill); reject(e); });
    p.on("close", (code) => {
      opts.signal?.removeEventListener("abort", kill);
      if (opts.signal?.aborted) return reject(new JobError("Stopped."));
      if (code === 0) resolve({ stdout, stderr });
      // The cause is usually at the start (the filter that failed) and the consequences at the end: keep both.
      else reject(Object.assign(new Error(`${cmd} exited with ${code}: ${stderr.length > 2400 ? `${stderr.slice(0, 1600)} … ${stderr.slice(-800)}` : stderr}`), { stderr }));
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

/** How much of the frame a graphic covers (average alpha, 0-100) at `samples` moments (default 8) across the part on
 *  screen: from `from` for `shown` seconds of the file. The file is put on the 30 fps grid first (a still stretch is
 *  one picture, which a seek would skip). visible: the moments that show any of it (a pixel over 1% opaque); at: each
 *  moment (file seconds); maps: each moment's alpha at COVER_SIZE x COVER_SIZE (null: opaque, it covers its whole
 *  box). Opaque files count as 100; null when the file cannot be read. */
export const COVER_SIZE = 64;
export async function graphicCover(input: string, from: number, shown: number, signal?: AbortSignal, samples = 8): Promise<{ min: number; avg: number; max: number; samples: number; visible: number; at: number[]; maps: Uint8Array[] | null } | null> {
  const N = Math.max(1, samples), S = COVER_SIZE; // moments; each is shrunk to S x S (an area average keeps the mean)
  const frames = Array.from(new Set(Array.from({ length: N }, (_, k) => Math.round((Math.max(0, from) + ((k + 0.5) * Math.max(0, shown)) / N) * 30))));
  const at = frames.map((n) => n / 30);
  // Decoding goes as far as the last moment: a limit that grows with it (a stuck read gives no measurement).
  const limit = AbortSignal.timeout(30_000 + Math.round((from + shown) * 100));
  try {
    const raw = await runOut("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-c:v", "libvpx-vp9", "-i", input,
      // Past the file's last picture it holds that picture, as the render does.
      "-vf", `fps=30,tpad=stop_mode=clone:stop=-1,select='${frames.map((n) => `eq(n,${n})`).join("+")}',alphaextract,scale=${S}:${S}:flags=area,format=gray`, "-frames:v", String(frames.length), "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"], signal ? AbortSignal.any([signal, limit]) : limit);
    const got = Math.floor(raw.length / (S * S));
    if (!got) return null;
    const maps = Array.from({ length: got }, (_, i) => new Uint8Array(raw.subarray(i * S * S, (i + 1) * S * S)));
    const pct = maps.map((m) => { let t = 0; for (const v of m) t += v; return (t / (S * S) / 255) * 100; });
    const r = (x: number) => Math.round(x * 10) / 10;
    return { min: r(Math.min(...pct)), avg: r(pct.reduce((a, b) => a + b, 0) / got), max: r(Math.max(...pct)), samples: got, visible: maps.filter((m) => m.some((v) => v >= 3)).length, at: at.slice(0, got), maps };
  } catch (e) {
    if (signal?.aborted) throw e;
    // No alpha plane: the graphic is opaque and covers its whole box.
    return /Requested planes not available/i.test((e as Error & { stderr?: string }).stderr ?? "") ? { min: 100, avg: 100, max: 100, samples: frames.length, visible: frames.length, at, maps: null } : null;
  }
}

/** A command's stdout as bytes (stderr kept for the error message). */
function runOut(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    const kill = () => p.kill("SIGKILL");
    signal?.addEventListener("abort", kill, { once: true });
    p.on("error", reject);
    p.on("close", (code) => { signal?.removeEventListener("abort", kill); if (code === 0) resolve(Buffer.concat(out)); else reject(Object.assign(new Error(`${cmd} exited with ${code}: ${err.trim().slice(-500)}`), { stderr: err })); });
  });
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

/** stamp: text burned into the frame's bottom left (get_frames writes the time and frame number there). */
export async function frameAt(input: string, t: number, out: string, width = 640, signal?: AbortSignal, hdr = false, stamp?: string) {
  // An HDR file's frame is tone-mapped like the preview copies, so the picture looks as it should on any screen.
  const tone = hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "";
  const text = stamp ? `,drawtext=fontfile=${STAMP_FONT}:text='${stamp.replace(/[\\':%]/g, (c) => "\\" + c)}':x=12:y=h-th-12:fontsize=h/20:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8` : "";
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `${tone}scale=${width}:-2${text}`, "-q:v", "4", out], { signal });
}
const STAMP_FONT = process.env.STAMP_FONT || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/** A clear PNG (a drawing on a comment) laid over a frame, stretched to the frame's size (read first: scale2ref
 *  left the PNG at its own size in FFmpeg 7). */
export async function overlayPng(frame: string, png: string, out: string, signal?: AbortSignal) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", frame], { signal });
  const [w, h] = String(stdout).trim().split(",").map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`could not read the frame's size (${String(stdout).trim()})`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", frame, "-i", png, "-filter_complex", `[1:v]scale=${w}:${h}[o];[0:v][o]overlay=0:0:format=auto`, "-frames:v", "1", "-q:v", "3", out], { signal });
}

/**
 * Phase 6: frames of a stretch of a video as RGB bytes, turned and fitted to w x h like the editor shows them
 * (cover, `fitY` down, or around a reframed clip's focus), `n` of them spread over [from, to]. For shot matching.
 */
export async function rgbFrames(input: string, from: number, to: number, o: { w: number; h: number; rotate: number; fitY: number; focus?: { x: number; y: number }; n: number; dir: string; signal?: AbortSignal }): Promise<Buffer> {
  const turn = o.rotate === 90 ? "transpose=1," : o.rotate === 270 ? "transpose=2," : o.rotate === 180 ? "hflip,vflip," : "";
  // Reframed: the fit cuts around the focus, as the render does (fitCrop).
  const cut = o.focus ? `x='clip(${o.focus.x}*iw-ow/2,0,iw-ow)':y='clip(${o.focus.y}*ih-oh*0.4,0,ih-oh)'` : `(iw-ow)/2:(ih-oh)*${o.fitY}`;
  const parts: Buffer[] = [];
  for (let k = 0; k < o.n; k++) {
    const t = from + ((k + 0.5) / o.n) * Math.max(0, to - from);
    const out = join(o.dir, `rgb-${Math.random().toString(36).slice(2)}.raw`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `${turn}scale=${o.w}:${o.h}:force_original_aspect_ratio=increase,crop=${o.w}:${o.h}:${cut},format=rgb24`, "-f", "rawvideo", out], { signal: o.signal });
    const b = await readFile(out).catch(() => null);
    if (b && b.length === o.w * o.h * 3) parts.push(b);
  }
  return Buffer.concat(parts);
}
