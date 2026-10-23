import { spawn } from "node:child_process";

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

export type Probe = { seconds: number; width: number; height: number; fps: number; hasVideo: boolean; hasAudio: boolean; rotation: number; hdr: boolean; sizeBytes: number };

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

/** Loudness of a finished file (EBU R128): integrated LUFS and true peak in dB. Nulls when it cannot be measured. */
export async function loudnessOf(input: string, signal?: AbortSignal): Promise<{ lufs: number | null; peakDb: number | null }> {
  const { stderr } = await runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-i", input, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], signal);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => { const m = re.exec(summary); const n = m ? Number(m[1]) : NaN; return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), peakDb: num(/Peak:\s+(-?[\d.]+) dBFS/) };
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

export async function frameAt(input: string, t: number, out: string, width = 640, signal?: AbortSignal) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out], { signal });
}
