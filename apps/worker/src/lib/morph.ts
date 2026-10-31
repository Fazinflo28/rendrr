import { srcAt } from "@rendrr/shared";
import type { MorphFace, PlanFiles, RenderPlan, Seg } from "@rendrr/shared/renderPlan";
import { execFile, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ALIGN_PY = join(here, "../../python/morph_align.py");
const MODEL = join(here, "../../models/yunet/face_detection_yunet_2023mar.onnx");
const PYTHON = process.env.PYTHON_BIN || "python3";
type Found = { a: [number, number][]; b: [number, number][]; aBox: number[]; bBox: number[]; fit: "features" | "points" } | null;

/** The face either side of each pair (A, B frames, w x h RGB): python/morph_align.py. */
async function alignFaces(rgb: Buffer, w: number, h: number, pairs: number, dir: string, signal?: AbortSignal): Promise<Found[]> {
  const file = join(dir, `morph-${Math.random().toString(36).slice(2)}.rgb`);
  await writeFile(file, rgb);
  try {
    return await new Promise<Found[]>((resolve, reject) => {
      const p = spawn(PYTHON, [ALIGN_PY, MODEL, file, String(w), String(h), String(pairs)], { stdio: ["ignore", "pipe", "pipe"] });
      let so = "", se = "";
      p.stdout.on("data", (d: Buffer) => { so += d; });
      p.stderr.on("data", (d: Buffer) => { se = (se + d).slice(-2000); });
      const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
      const kill = () => p.kill("SIGKILL");
      signal?.addEventListener("abort", kill, { once: true });
      p.on("error", reject);
      p.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", kill); if (code === 0) { try { resolve(JSON.parse(so)); } catch (e) { reject(e); } } else reject(new Error(se.trim().split("\n").pop() || `exit ${code}`)); });
    });
  } finally { await rm(file, { force: true }); }
}

// Face-aware Morph Cut: the face in A's frame at each morph's start and in B's at its end, found on those frames as
// the render draws them (turned, fitted, framed). The render slides the head from one to the other; a cut whose face
// is not found in both (or where the plan says face: false) keeps the plain morph. It measures; it decides nothing.

/** A frame of a part, turned and fitted as the render shows it, w x h raw RGB (null if it cannot be read). */
async function frameOf(file: string, s: Seg, t: number, w: number, h: number, signal?: AbortSignal): Promise<Buffer | null> {
  const turn = s.rotate === 90 ? "transpose=1," : s.rotate === 270 ? "transpose=2," : s.rotate === 180 ? "hflip,vflip," : "";
  const focus = s.framing?.focus;
  const cut = focus ? `x='clip(${focus.x}*iw-ow/2,0,iw-ow)':y='clip(${focus.y}*ih-oh*0.4,0,ih-oh)'` : "(iw-ow)/2:(ih-oh)*0.4";
  try {
    const r = await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1",
      "-vf", `${turn}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:${cut},format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26, signal });
    const buf = r.stdout as Buffer;
    return buf.length >= w * h * 3 ? buf.subarray(0, w * h * 3) : null;
  } catch { return null; }
}

/** The faces either side of each face-aware morph in the plan, by the transition's clip id. */
export async function morphFaces(plan: RenderPlan, files: PlanFiles, dir: string, signal?: AbortSignal): Promise<Record<string, MorphFace>> {
  const fps = plan.fps || 30, W = plan.width, H = plan.height;
  const k = Math.min(1, 360 / Math.min(W, H)), even = (n: number) => Math.max(2, Math.round(n / 2) * 2), w = even(W * k), h = even(H * k);
  const fileOf = (s: Seg) => (s.videoId.startsWith("copy:") ? null : s.videoId === plan.sources[0] ? files.source : files.videos?.[s.videoId] ?? null);
  const jobs: { id: string; a: Seg; b: Seg; fa: Buffer; fb: Buffer }[] = [];
  for (const t of plan.transitions ?? []) {
    if (t.type !== "morph" || t.face === false || !t.a.length || !t.b.length || t.end - t.start < 1 / fps) continue;
    // A's first frame of the window and B's last (the frames the morph runs between).
    const a = t.a[0], b = t.b[t.b.length - 1], af = fileOf(a), bf = fileOf(b);
    if (!af || !bf) continue;
    // A side drawn from a stabilized copy (shifted and zoomed frame by frame) or moved by keyframes is not the picture
    // read here: the face would be placed off target. Those cuts keep the plain morph.
    if ([a.clipId, b.clipId].some((id) => plan.stabilized?.[id] || plan.clipMotion?.[id])) continue;
    const fa = await frameOf(af, a, srcAt(a, a.start), w, h, signal), fb = await frameOf(bf, b, srcAt(b, Math.max(b.start, b.end - 1 / fps)), w, h, signal);
    if (fa && fb) jobs.push({ id: t.clipId, a, b, fa, fb });
  }
  if (!jobs.length) return {};
  const found = await alignFaces(Buffer.concat(jobs.flatMap((j) => [j.fa, j.fb])), w, h, jobs.length, dir, signal);
  const out: Record<string, MorphFace> = {};
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  jobs.forEach((j, n) => {
    const f = found[n];
    if (!f) return;
    // Shares of the fitted frame, then where the part's framing (scale about the middle, then offset) puts them.
    const on = (s: Seg) => { const f = s.framing && (s.framing.scale !== 1 || s.framing.x || s.framing.y) ? s.framing : null; return (x: number, y: number): [number, number] => (f ? [r4(0.5 + (x / w - 0.5) * f.scale + f.x), r4(0.5 + (y / h - 0.5) * f.scale + f.y)] : [r4(x / w), r4(y / h)]); };
    const pa = on(j.a), pb = on(j.b);
    const box = (b: number[], p: (x: number, y: number) => [number, number]): [number, number, number, number] => { const [x0, y0] = p(b[0], b[1]), [x1, y1] = p(b[0] + b[2], b[1] + b[3]); return [x0, y0, r4(x1 - x0), r4(y1 - y0)]; };
    out[j.id] = { a: f.a.map(([x, y]) => pa(x, y)), b: f.b.map(([x, y]) => pb(x, y)), aBox: box(f.aBox, pa), bBox: box(f.bBox, pb) };
  });
  return out;
}
