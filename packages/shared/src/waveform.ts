// Engine Part 6: the timeline's waveform, drawn from the sound's 10 ms peaks (min and max of each 10 ms, as the deep
// measurements store them for every video, or worked out in the browser from a music or effect file). Pure functions:
// the editor draws only the columns on screen, at any zoom.
import { srcAt } from "./sequence";

/** 10 ms frames: the lowest and highest sample of each, as int8 of full scale. */
export type Peaks = { n: number; min: Int8Array; max: Int8Array };
/** A stretch of the edit playing a stretch of a sound (a dialogue part, or a music or effect clip from its start). */
export type WavePart = { start: number; end: number; srcIn: number; srcOut: number; rate?: number; key: string; muted?: boolean };

/** 10 ms peaks of decoded samples (one channel, -1..1). */
export function peaksFromSamples(x: Float32Array, sampleRate: number): Peaks {
  const per = Math.max(1, Math.round(sampleRate / 100)), n = Math.ceil(x.length / per);
  const min = new Int8Array(n), max = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    for (let k = i * per, e = Math.min(x.length, k + per); k < e; k++) { const v = x[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[i] = Math.max(-128, Math.round(lo * 127)); max[i] = Math.min(127, Math.round(hi * 127));
  }
  return { n, min, max };
}

/**
 * The sound's lowest and highest value (-1..1) in each of n columns dt seconds wide from edit time t0: NaN where nothing
 * plays; muted where a muted part plays. A column covers every 10 ms frame its time span plays (sped-up parts more).
 */
export function waveColumns(parts: WavePart[], peaks: (key: string) => Peaks | undefined, t0: number, dt: number, n: number) {
  const lo = new Float32Array(n).fill(NaN), hi = new Float32Array(n).fill(NaN), muted = new Uint8Array(n);
  const ps = [...parts].sort((a, b) => a.start - b.start);
  let j = 0;
  for (let c = 0; c < n; c++) {
    const t = t0 + c * dt;
    while (j < ps.length && ps[j].end <= t) j++;
    // The part at t (parts may overlap: J/L cuts; the first that covers t).
    let p: WavePart | undefined;
    for (let k = j; k < ps.length && ps[k].start <= t + dt; k++) if (t + dt > ps[k].start && t < ps[k].end) { p = ps[k]; break; }
    if (!p) continue;
    const pk = peaks(p.key);
    if (!pk) continue;
    const a = srcAt(p, Math.max(t, p.start)), b = srcAt(p, Math.min(t + dt, p.end));
    const i0 = Math.max(0, Math.floor(Math.min(a, b) * 100)), i1 = Math.min(pk.n, Math.max(i0 + 1, Math.ceil(Math.max(a, b) * 100)));
    if (i0 >= pk.n) continue;
    let mn = 127, mx = -128;
    for (let i = i0; i < i1; i++) { if (pk.min[i] < mn) mn = pk.min[i]; if (pk.max[i] > mx) mx = pk.max[i]; }
    lo[c] = mn / 127; hi[c] = mx / 127; muted[c] = p.muted ? 1 : 0;
  }
  return { lo, hi, muted };
}
