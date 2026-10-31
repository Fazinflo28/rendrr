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
  const list = m.angles.map((a) => `${a.name || nameOf?.(a.videoId) || a.videoId} (${signed(a.offset)}${a.sync === "timecode" ? ", by timecode" : ""}${a.score != null ? `, ${a.sync === "timecode" ? "sound check" : "sync"} ${a.score.toFixed(2)}` : a.sync === "timecode" ? "" : ", set by hand"}${a.rotate ? `, turned ${a.rotate}°` : ""})`);
  return `${m.angles.length} ${m.angles.length === 1 ? "angle" : "angles"}: ${list.join(", ")}; sound: ${m.audio === "follow" ? "each angle's own" : "the main video's"}`;
}

// ---------------- Phase 22: sync by timecode ----------------
/**
 * A file's start timecode ("HH:MM:SS:FF", ";" before the frames for drop-frame) as seconds of the day. Frames count at
 * the timecode's nominal rate (30 for 29.97, 24 for 23.976), drop-frame leaves out the frame numbers it skips (2 a
 * minute at 29.97, 4 at 59.94, but not every tenth minute), and the count is turned into seconds at the file's real
 * frame rate. null: not a timecode.
 */
export function timecodeSeconds(tc: string | null | undefined, fps: number): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})[:.](\d{2})([:;.,])(\d{2,3})\s*$/.exec(tc ?? "");
  if (!m || !(fps > 0)) return null;
  const [hh, mm, ss, ff] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5])];
  if (mm > 59 || ss > 59) return null;
  const nominal = Math.round(fps), drop = m[4] === ";" || m[4] === ",";
  if (ff >= nominal) return null;
  let frames = (hh * 3600 + mm * 60 + ss) * nominal + ff;
  if (drop && (nominal === 30 || nominal === 60)) {
    const per = nominal === 30 ? 2 : 4, minutes = hh * 60 + mm;
    frames -= per * (minutes - Math.floor(minutes / 10));
  }
  // Frames turned into seconds at the frames real rate (non-drop timecode on 29.97 footage runs 0.1% slow of the clock).
  return frames / (Math.abs(fps - nominal) < 0.01 ? nominal : drop ? nominal * 1000 / 1001 : fps);
}

/** The angle's second at the main video's second 0, from both files' start timecodes (angle time = main time + offset):
 *  two recordings that started at 10:00:00 and 10:00:05 are 5 s apart. A take over midnight wraps. null without both. */
export function timecodeOffset(main: { timecode?: string | null; fps: number }, angle: { timecode?: string | null; fps: number }): number | null {
  const a = timecodeSeconds(main.timecode, main.fps), b = timecodeSeconds(angle.timecode, angle.fps);
  if (a == null || b == null) return null;
  let d = a - b;
  if (d > 43200) d -= 86400; else if (d < -43200) d += 86400;
  return Math.round(d * 10000) / 10000;
}

/** How an angle was lined up: timecode first; the sound checks it, and is used when timecode is missing or disagrees. */
export type PickedSync = { offset: number; by: "timecode" | "sound"; score?: number; note: string };
/** Sound sure enough to overrule timecode that disagrees: a clear best lag. */
export const soundIsSure = (s: SyncResult) => s.score >= 0.5 && s.margin >= 1.3;
export function pickSync(tc: number | null, sound: SyncResult | null, agree = 0.1): PickedSync | null {
  if (tc != null) {
    if (!sound) return { offset: tc, by: "timecode", note: "by timecode (no sound to check it)" };
    const diff = Math.abs(sound.offset - tc);
    if (diff <= agree) return { offset: tc, by: "timecode", score: sound.score, note: `by timecode; the sound agrees (within ${Math.round(diff * 1000)} ms)` };
    if (soundIsSure(sound)) return { offset: sound.offset, by: "sound", score: sound.score, note: `by the sound: the timecode is ${diff.toFixed(2)} s off it (a camera's clock not jammed?)` };
    return { offset: tc, by: "timecode", score: sound.score, note: `by timecode; the sound does not match clearly enough to check it` };
  }
  if (!sound) return null;
  return { offset: sound.offset, by: "sound", score: sound.score, note: "by the sound (no timecode in both files)" };
}

// ---------------- Phase 13: cut to whoever speaks ----------------
/** A stretch of the main video's footage and the camera it shows ("main", or an angle's videoId). */
export type AnglePlanPart = { start: number; end: number; angle: string };
/** A camera's sound: its loudness every 10 ms (dBFS, its own time) and its offset (its time = main time + offset). */
export type SpeakerSource = { angle: string; db: ArrayLike<number>; offset: number };
export type SpeakerPlanOpts = { from: number; to: number; minShot?: number; margin?: number; wide?: string; lead?: number; step?: number };

/**
 * Who speaks when, from each camera's own sound: in a two-camera podcast each person is loudest on the camera (or
 * mic) nearest them. Every `step` (0.1 s), each camera's level over the last half second is compared with its own room
 * noise (its 20th percentile); a camera 6 dB over its noise and `margin` dB (default 3) louder than every other one
 * leads. Both speaking at once: the wide camera if one is given, else the shot stays. Silence: the shot stays. Shots
 * shorter than `minShot` (default 2 s) go into the one before; each cut comes `lead` (0.2 s) before the voice, as an
 * editor cuts. Returns the stretches over from..to, in main-footage seconds.
 */
export function speakerPlan(sources: SpeakerSource[], o: SpeakerPlanOpts): AnglePlanPart[] {
  const step = o.step ?? 0.1, minShot = o.minShot ?? 2, margin = o.margin ?? 3, lead = o.lead ?? 0.2;
  const from = Math.max(0, o.from), to = Math.max(from, o.to);
  const n = Math.max(1, Math.round((to - from) / step));
  if (!sources.length) return [{ start: from, end: to, angle: "main" }];
  const half = 40; // 0.4 s of 10 ms frames behind each moment (the voice so far), 0.05 s ahead
  const levels = sources.map((s) => {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const i = Math.round((from + k * step + s.offset) / 0.01);
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - half); j <= i + 5 && j < s.db.length; j++) { if (j >= 0) { sum += Math.pow(10, s.db[j] / 10); cnt++; } }
      out[k] = cnt ? 10 * Math.log10(sum / cnt + 1e-12) : -Infinity;
    }
    const finite = Array.from(out).filter(Number.isFinite).sort((a, b) => a - b);
    const floor = finite.length ? finite[Math.floor(finite.length * 0.2)] : 0;
    return out.map((v) => (Number.isFinite(v) ? v - floor : -Infinity));
  });
  // Who leads each step: one voice clearly over the others, both at once (the wide camera, if any), or nobody.
  const raw: (string | null)[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const order = sources.map((s, i) => ({ a: s.angle, v: levels[i][k] })).sort((x, y) => y.v - x.v);
    const best = order[0], second = order[1];
    raw[k] = best.v >= 6 && (!second || best.v - second.v >= margin) ? best.a : best.v >= 6 && second && second.v >= 6 && o.wide ? o.wide : null;
  }
  // A new camera only once it has led for `hold` (0.4 s) with nobody else leading in between: a syllable over the
  // other person, or a laugh, does not flip the shot. The cut goes where it started leading.
  const hold = Math.max(1, Math.round(0.4 / step));
  const pick: string[] = new Array(n);
  let cur = "";
  for (let k = 0; k < n; k++) {
    const c = raw[k];
    if (c && c !== cur) {
      let led = 0, other = false;
      for (let j = k; j < n && j < k + hold * 3 && led < hold; j++) { if (raw[j] === c) led++; else if (raw[j] && raw[j] !== c) { other = true; break; } }
      if (led >= hold && !other) cur = c;
      else if (!cur) cur = c;
    }
    pick[k] = cur;
  }
  const first = pick.find(Boolean) || (o.wide ?? sources[0].angle);
  for (let k = 0; k < n && !pick[k]; k++) pick[k] = first;
  let parts: AnglePlanPart[] = [];
  for (let k = 0; k < n; k++) {
    const t = from + k * step;
    const last = parts[parts.length - 1];
    if (last && last.angle === pick[k]) last.end = Math.min(to, t + step);
    else parts.push({ start: t, end: Math.min(to, t + step), angle: pick[k] });
  }
  // Too-short shots go into the one before (the first into the one after), until none is left.
  for (let changed = true; changed && parts.length > 1;) {
    changed = false;
    const i = parts.findIndex((p) => p.end - p.start < minShot - 1e-9);
    if (i < 0) break;
    if (i === 0) parts[1].start = parts[0].start; else parts[i - 1].end = parts[i].end;
    parts.splice(i, 1);
    parts = parts.reduce<AnglePlanPart[]>((acc, p) => { const l = acc[acc.length - 1]; if (l && l.angle === p.angle) l.end = p.end; else acc.push({ ...p }); return acc; }, []);
    changed = true;
  }
  // Cut a little before the voice.
  for (let i = 1; i < parts.length; i++) { const t = Math.max(parts[i - 1].start + 0.5, parts[i].start - lead); parts[i - 1].end = t; parts[i].start = t; }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return parts.map((p) => ({ start: r3(p.start), end: r3(p.end), angle: p.angle }));
}

/** "4 cuts: Cam B 46%, main 38%, Wide 16%" */
export function planText(plan: AnglePlanPart[], nameOf: (angle: string) => string): string {
  const total = plan.reduce((a, p) => a + (p.end - p.start), 0) || 1;
  const share = new Map<string, number>();
  for (const p of plan) share.set(p.angle, (share.get(p.angle) ?? 0) + (p.end - p.start));
  return `${Math.max(0, plan.length - 1)} ${plan.length - 1 === 1 ? "cut" : "cuts"}: ${Array.from(share).sort((a, b) => b[1] - a[1]).map(([a, s]) => `${nameOf(a)} ${Math.round((s / total) * 100)}%`).join(", ")}`;
}
