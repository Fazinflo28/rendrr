// The original of local footage must face the way its preview copy does: the edit (turns, framing, the face boxes)
// was made looking at the preview copy. A different copy of the same video (the camera file instead of a compressed
// one, a re-export) can be stored another way up, or tagged differently; rendered as it is, the final comes out
// upside down or sideways while the editor looked right. Small grey frames of both, at the same times, are compared
// in each of the 8 ways a picture can face; when another way clearly matches better than the file as it plays, the
// file's orientation tag is rewritten (a copy of its streams, no new encode) and checked again.
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { probe, run } from "./ffmpeg";

const N = 48; // side of the compared frames (each squeezed to a square; turning commutes with that)

export type Facing = { id: string; say: string; display: string[]; swaps: boolean; from: (x: number, y: number, n: number) => [number, number] };
/** The 8 ways the stored frames can be shown, the FFmpeg display options that show them so, and where each output
 *  pixel comes from in the stored frame. */
export const FACINGS: Facing[] = [
  { id: "stored", say: "as stored", display: ["-display_rotation:v:0", "0"], swaps: false, from: (x, y) => [x, y] },
  { id: "mirror", say: "mirrored", display: ["-display_rotation:v:0", "0", "-display_hflip:v:0"], swaps: false, from: (x, y, n) => [n - 1 - x, y] },
  { id: "flip", say: "flipped upside down", display: ["-display_rotation:v:0", "0", "-display_vflip:v:0"], swaps: false, from: (x, y, n) => [x, n - 1 - y] },
  { id: "180", say: "turned 180°", display: ["-display_rotation:v:0", "180"], swaps: false, from: (x, y, n) => [n - 1 - x, n - 1 - y] },
  { id: "cw", say: "turned 90° clockwise", display: ["-display_rotation:v:0", "270"], swaps: true, from: (x, y, n) => [y, n - 1 - x] },
  { id: "ccw", say: "turned 90° anticlockwise", display: ["-display_rotation:v:0", "90"], swaps: true, from: (x, y, n) => [n - 1 - y, x] },
  { id: "transpose", say: "turned and mirrored", display: ["-display_rotation:v:0", "270", "-display_hflip:v:0"], swaps: true, from: (x, y) => [y, x] },
  { id: "transverse", say: "turned and mirrored", display: ["-display_rotation:v:0", "90", "-display_hflip:v:0"], swaps: true, from: (x, y, n) => [n - 1 - y, n - 1 - x] },
];

export function face(img: Uint8Array, f: Facing, n = N): Uint8Array {
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const [sx, sy] = f.from(x, y, n); out[y * n + x] = img[sy * n + sx]; }
  return out;
}

/** How alike two sets of frames are: their correlation (1 the same picture, about 0 unrelated), so a different
 *  brightness, grade or HDR tone does not matter. */
export function likeness(a: Uint8Array, b: Uint8Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

async function grab(file: string, t: number, dir: string, raw: boolean, signal?: AbortSignal): Promise<Uint8Array> {
  const out = join(dir, `face-${Math.random().toString(36).slice(2, 8)}.gray`);
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", t.toFixed(3), ...(raw ? ["-noautorotate"] : []), "-i", file, "-frames:v", "1", "-vf", `scale=${N}:${N}:flags=area,format=gray`, "-f", "rawvideo", out], { signal });
    const b = await readFile(out);
    if (b.length !== N * N) throw new Error(`frame of ${b.length} bytes`);
    return new Uint8Array(b);
  } finally { await rm(out, { force: true }); }
}
const joinAll = (xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };

export type FacingResult = { changed: Facing | null; before: number; after: number; best: { id: string; likeness: number } };

/** Makes `file` face the way `proxy` does (rewriting its orientation tag in place) when it clearly does not. */
export async function matchFacing(file: string, proxy: string, dir: string, signal?: AbortSignal): Promise<FacingResult> {
  const [fi, pi] = await Promise.all([probe(file, { signal }), probe(proxy, { signal })]);
  const seconds = Math.min(fi.seconds || 0, pi.seconds || 0);
  if (!(seconds > 0.5) || !fi.width || !pi.width) return { changed: null, before: 1, after: 1, best: { id: "stored", likeness: 1 } };
  const times = [0.2, 0.4, 0.6, 0.8].map((f) => f * seconds);
  const want = joinAll(await Promise.all(times.map((t) => grab(proxy, t, dir, false, signal))));
  const plays = joinAll(await Promise.all(times.map((t) => grab(file, t, dir, false, signal))));
  const stored = await Promise.all(times.map((t) => grab(file, t, dir, true, signal)));
  const before = likeness(plays, want);
  // The stored frame's own shape (probe gives it as shown), so a facing that would give the wrong shape is not taken.
  const turned = fi.rotation === 90 || fi.rotation === 270;
  const sw = turned ? fi.height : fi.width, sh = turned ? fi.width : fi.height;
  const proxyAspect = pi.width / pi.height;
  const scored = FACINGS.map((f) => {
    const aspect = f.swaps ? sh / sw : sw / sh;
    const fits = Math.abs(aspect / proxyAspect - 1) < 0.04;
    return { f, fits, likeness: fits ? likeness(joinAll(stored.map((s) => face(s, f))), want) : -1 };
  });
  const best = scored.reduce((a, b) => (b.likeness > a.likeness ? b : a));
  const result: FacingResult = { changed: null, before, after: before, best: { id: best.f.id, likeness: best.likeness } };
  // Only a clear win: the file as it plays matches poorly, another facing well.
  if (!(best.likeness > 0.6 && best.likeness - before > 0.3)) return result;
  const out = join(dir, `faced-${Math.random().toString(36).slice(2, 8)}.mov`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...best.f.display, "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mov", out], { signal });
  const after = likeness(joinAll(await Promise.all(times.map((t) => grab(out, t, dir, false, signal)))), want);
  if (after < best.likeness - 0.1) { await rm(out, { force: true }); return result; }
  await rename(out, file);
  return { ...result, changed: best.f, after };
}
