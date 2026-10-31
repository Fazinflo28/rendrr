// Phase 10: multicam. Two cameras of the same take are synced by their sound: each video's loudness every 10 ms (the
// deep measurements' dBFS frames) is turned into its rhythm (the loudness less its own 1 s average, so a quieter or
// noisier camera still matches), and the two rhythms are slid past each other (cross-correlation, by FFT) to the lag
// where they agree best. Pure functions: the API runs them on the stored frames, the tests on rendered files.
import type { Angle, Multicam, Timeline } from "./timeline";

const FRAME = 0.01; // seconds per loudness frame

/** In-place radix-2 FFT of (re, im), length a power of two; inverse when `inv` (scaled by 1/n). */
export function fft(re: Float64Array, im: Float64Array, inv = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * A video's sound rhythm from its loudness every 10 ms (dBFS; below -70 counts as -70): the loudness less its own
 * average over the second round it, scaled to mean 0 and spread 1. Silence and steady noise go to 0; syllables,
 * claps and laughs stand out the same on a near and a far microphone.
 */
export function syncEnvelope(db: ArrayLike<number>): Float32Array {
  const n = db.length, x = new Float64Array(n), out = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.max(-70, Math.min(0, db[i]));
  const W = 50; // half a second each side
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  let mean = 0;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - W), b = Math.min(n, i + W + 1); out[i] = x[i] - (pre[b] - pre[a]) / (b - a); mean += out[i]; }
  mean /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) { out[i] -= mean; v += out[i] * out[i]; }
  const sd = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

export type SyncResult = {
  /** The angle's second at the main video's second 0: angle time = main time + offset. */
  offset: number;
  /** How well the rhythms agree at that lag (a correlation, 0-1). */
  score: number;
  /** How far the best lag stands above the next best one a second or more away (1 = no better than it). */
  margin: number;
  /** Seconds of sound the two have in common at that lag. */
  overlap: number;
  /** Sure enough to use: score and margin both high enough. */
  sure: boolean;
};

/**
 * The lag between two rhythms (syncEnvelope of each), in seconds, to a fraction of the 10 ms frame (the peak's
 * parabola). Lags where they share under `minOverlap` seconds (or a third of the shorter) are not considered;
 * `maxLag` limits the search when the cameras are known to have started close together.
 */
export function syncOffset(main: Float32Array, angle: Float32Array, opts: { maxLag?: number; minOverlap?: number } = {}): SyncResult {
  const la = main.length, lb = angle.length;
  let n = 1;
  while (n < la + lb) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(main); br.set(angle);
  fft(ar, ai); fft(br, bi);
  // conj(A) * B: its inverse at k is sum_i a[i] * b[i + k] (b's frame k after a's lines up with it).
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ar[i] * bi[i] - ai[i] * br[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  const minOv = Math.max(1, Math.round(Math.min(opts.minOverlap ?? 20, Math.min(la, lb) * FRAME / 3) / FRAME));
  const maxK = opts.maxLag != null ? Math.round(opts.maxLag / FRAME) : Infinity;
  const corrAt = (k: number) => ar[(k + n) % n];
  const overlapAt = (k: number) => Math.max(0, Math.min(la, lb - k) - Math.max(0, -k));
  // Lags k from -(la-1) to lb-1: angle frame i+k matches main frame i. Picked by the correlation's strength against
  // chance (sum / sqrt(overlap)): a short overlap that happens to agree does not beat a long one that truly does.
  let best = -Infinity, bk = 0;
  const score = (k: number) => { const ov = overlapAt(k); return ov >= minOv ? corrAt(k) / Math.sqrt(ov) : -Infinity; };
  for (let k = -(la - 1); k <= lb - 1; k++) {
    if (Math.abs(k) > maxK) continue;
    const s = score(k);
    if (s > best) { best = s; bk = k; }
  }
  if (!Number.isFinite(best)) return { offset: 0, score: 0, margin: 1, overlap: 0, sure: false };
  let second = 0;
  for (let k = -(la - 1); k <= lb - 1; k++) {
    if (Math.abs(k) > maxK || Math.abs(k - bk) < 100) continue;
    const s = score(k);
    if (s > second) second = s;
  }
  // The peak to a fraction of a frame: the parabola through it and its neighbours.
  const y0 = score(bk - 1), y1 = best, y2 = score(bk + 1);
  const d = Number.isFinite(y0) && Number.isFinite(y2) && y0 - 2 * y1 + y2 < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2))) : 0;
  const margin = second > 0 ? best / second : best > 0 ? 99 : 1;
  const sc = Math.max(0, Math.min(1, corrAt(bk) / overlapAt(bk)));
  return { offset: Math.round((bk + d) * FRAME * 10000) / 10000, score: Math.round(sc * 1000) / 1000, margin: Math.round(margin * 100) / 100, overlap: Math.round(overlapAt(bk) * FRAME * 10) / 10, sure: sc >= 0.3 && margin >= 1.5 };
}

/** The angle a V1 clip shows, if the edit's multicam has it. */
export function angleOf(tl: Pick<Timeline, "multicam">, angle: string | undefined): Angle | undefined {
  return angle ? tl.multicam?.angles.find((a) => a.videoId === angle) : undefined;
}

const signed = (x: number) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(3)}s`;
/** "2 angles: Cam B (+1.370s, sync 0.82), Cam C (-0.215s, set by hand); sound: the main video's". */
export function multicamText(m: Multicam, nameOf?: (videoId: string) => string | undefined): string {
  const list = m.angles.map((a) => `${a.name || nameOf?.(a.videoId) || a.videoId} (${signed(a.offset)}${a.score != null ? `, sync ${a.score.toFixed(2)}` : ", set by hand"}${a.rotate ? `, turned ${a.rotate}°` : ""})`);
  return `${m.angles.length} ${m.angles.length === 1 ? "angle" : "angles"}: ${list.join(", ")}; sound: ${m.audio === "follow" ? "each angle's own" : "the main video's"}`;
}
