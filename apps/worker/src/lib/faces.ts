import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobError } from "./ffmpeg";

// Where faces are, for set_framing fitFaceTo: YuNet (OpenCV's face detector, MIT; models/yunet) on frames of a clip
// turned and fitted as the render shows them. It measures; it decides nothing.
const here = dirname(fileURLToPath(import.meta.url));
const FACES_PY = join(here, "../../python/faces.py");
const MODEL = join(here, "../../models/yunet/face_detection_yunet_2023mar.onnx");
const PYTHON = process.env.PYTHON_BIN || "python3";

export type FaceBox = { x: number; y: number; w: number; h: number; score: number };
/** A face in the fitted frame: its centre (u across, v down, 0-1) and half its height as a share of the frame's. */
export type FaceAt = { u: number; v: number; r: number; found: number; of: number };

/** The largest face in each of n frames (raw RGB, w x h each), or null where there is none. 60 s at most. */
export async function detectFaces(rgb: Buffer, w: number, h: number, dir: string, signal?: AbortSignal): Promise<(FaceBox | null)[]> {
  const n = Math.floor(rgb.length / (w * h * 3));
  if (!n) return [];
  const file = join(dir, `faces-${Math.random().toString(36).slice(2)}.rgb`);
  await writeFile(file, rgb);
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(PYTHON, [FACES_PY, MODEL, file, String(w), String(h), String(n)], { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", (d: Buffer) => { so += d; });
    p.stderr.on("data", (d: Buffer) => { se = (se + d).slice(-2000); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
    const kill = () => p.kill("SIGKILL");
    signal?.addEventListener("abort", kill, { once: true });
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve(so);
      else reject(new JobError(`Finding faces failed: ${se.trim().split("\n").filter((l) => !/WARN/.test(l)).pop() || `exit ${code}`}`, "faces", false));
    });
  });
  return JSON.parse(out) as (FaceBox | null)[];
}

/** One clip's face from its frames: the median centre and size of the frames where one was found (null: none). */
export function faceOf(boxes: (FaceBox | null)[], w: number, h: number): FaceAt | null {
  const got = boxes.filter((b): b is FaceBox => !!b);
  if (!got.length) return null;
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { u: r3(med(got.map((b) => (b.x + b.w / 2) / w))), v: r3(med(got.map((b) => (b.y + b.h / 2) / h))), r: r3(med(got.map((b) => b.h / 2 / h))), found: got.length, of: boxes.length };
}
