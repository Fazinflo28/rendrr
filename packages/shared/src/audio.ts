// The edit's sound, as numbers both the render and the live player use: where music ducks under speech, how deep,
// the fades, each dialogue clip's gain, and the fixed cleanup chains. The FFmpeg expressions are built from the same
// curves the player evaluates, so the two agree (tested).
import { z } from "zod";
import { editOf, type Range, type SequenceView } from "./sequence";
import type { Cleanup } from "./timeline";
import type { Word } from "./transcript";
// The cleanup presets and the studio voice's blocks: a module of their own (no imports that come back here), so the
// render's limits (look.ts) can read them.
export * from "./cleanup";

/** Music goes down this long before speech, and comes back up this long after it (seconds). */
export const DUCK_ATTACK = 0.2;
export const DUCK_RELEASE = 0.5;
/** Speech closer together than this is one stretch: the music stays down in between instead of pumping. */
export const DUCK_JOIN = 1.0;
/** Fade at every cut in the dialogue (seconds), so no cut clicks: 20 ms, inside the 15-30 ms the plan asks for. */
export const DECLICK = 0.02;

/** A dialogue clip's sound in the edit with its own gain and fades (edit seconds). */
/** keys (Phase 6): volume keys in edit seconds, on top of gainDb. */
export type DialogueSpan = { start: number; end: number; gainDb: number; fadeIn: number; fadeOut: number; keys?: AudioKey[] };

/**
 * Where people speak in the edit (edit seconds): the words of every stretch of dialogue that is heard, joined when
 * closer than DUCK_JOIN. A video Rendrr has no transcript for counts as speech wherever it is heard.
 */
export function speechRanges(view: SequenceView, wordsOf: (videoId: string) => Word[] | null, cut: Set<string>): Range[] {
  const out: Range[] = [];
  for (const s of view.sound) {
    if (s.muted || s.silent) continue;
    const ws = wordsOf(s.videoId);
    if (!ws) { out.push({ start: s.start, end: s.end }); continue; }
    for (const w of ws) {
      if (cut.has(w.id) || w.t < s.srcIn || w.t >= s.srcOut) continue;
      out.push({ start: editOf(s, w.t), end: editOf(s, Math.min(w.end, s.srcOut)) });
    }
  }
  out.sort((a, b) => a.start - b.start);
  const joined: Range[] = [];
  for (const r of out) {
    const last = joined[joined.length - 1];
    if (last && r.start - last.end < DUCK_JOIN) last.end = Math.max(last.end, r.end);
    else joined.push({ ...r });
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return joined.map((r) => ({ start: r3(r.start), end: r3(r.end) }));
}

const clip01 = (x: number) => Math.min(1, Math.max(0, x));
/** 1 under speech, 0 away from it, ramping over DUCK_ATTACK before and DUCK_RELEASE after. */
export function duckFactor(ranges: Range[], t: number): number {
  let s = 0;
  for (const r of ranges) s += clip01(Math.min((t - (r.start - DUCK_ATTACK)) / DUCK_ATTACK, (r.end + DUCK_RELEASE - t) / DUCK_RELEASE));
  return Math.min(1, s);
}
/** Linear fade in from `start` and out to `end` (1 in between, 0 outside). */
export function fadeFactor(t: number, start: number, end: number, fadeIn: number, fadeOut: number): number {
  if (t < start || t >= end) return 0;
  let g = 1;
  if (fadeIn > 0) g = Math.min(g, (t - start) / fadeIn);
  if (fadeOut > 0) g = Math.min(g, (end - t) / fadeOut);
  return clip01(g);
}
/** The dialogue's gain at edit time t (linear): its clip's gain and fades; 1 outside the clips that have any. */
export function dialogueGain(spans: DialogueSpan[], t: number): number {
  for (const s of spans) if (t >= s.start && t < s.end) return Math.pow(10, (s.gainDb + (s.keys?.length ? keyGainDb(s.keys, t) : 0)) / 20) * fadeFactor(t, s.start, s.end, s.fadeIn, s.fadeOut);
  return 1;
}

const n4 = (x: number) => x.toFixed(4);
/** FFmpeg expression of duckFactor for the ranges that touch [from, to) (empty: "0"). */
export function duckExpr(ranges: Range[], from = -Infinity, to = Infinity): string {
  const near = ranges.filter((r) => r.end + DUCK_RELEASE > from && r.start - DUCK_ATTACK < to);
  if (!near.length) return "0";
  const terms = near.map((r) => `clip(min((t-${n4(r.start - DUCK_ATTACK)})/${n4(DUCK_ATTACK)},(${n4(r.end + DUCK_RELEASE)}-t)/${n4(DUCK_RELEASE)}),0,1)`);
  return `min(1,${terms.join("+")})`;
}
/** FFmpeg expression of dialogueGain (empty: null, nothing to do). */
export function dialogueExpr(spans: DialogueSpan[]): string | null {
  if (!spans.length) return null;
  const terms = spans.map((s) => {
    const parts = [`${Math.pow(10, s.gainDb / 20).toFixed(6)}`];
    if (s.fadeIn > 0) parts.push(`clip((t-${n4(s.start)})/${n4(s.fadeIn)},0,1)`);
    if (s.fadeOut > 0) parts.push(`clip((${n4(s.end)}-t)/${n4(s.fadeOut)},0,1)`);
    if (s.keys?.length) parts.push(`pow(10,(${keyExpr(s.keys)})/20)`);
    return `gte(t,${n4(s.start)})*lt(t,${n4(s.end)})*(${parts.join("*")}-1)`;
  });
  return `1+${terms.join("+")}`;
}
/** Music's own fades when a clip sets none (as before Phase 3): in over a quarter of it up to 0.6 s, out up to 1.2 s. */
export const autoMusicFades = (length: number) => ({ fadeIn: Math.min(0.6, length / 4), fadeOut: Math.min(1.2, length / 4) });
export const dbToLin = (db: number) => Math.pow(10, db / 20);

// ---------------------------------------------------------------------------------------------
// Phase 6: a clip's own sound: volume keys, pan, a three-band EQ and reverb. The render applies them per clip; the live
// player plays them too (Phase 15: a WebAudio chain with the same filters and room; cleanup is heard in the preview).
// ---------------------------------------------------------------------------------------------
export const AudioKeySchema = z.object({ t: z.number().min(0).max(24 * 3600), gainDb: z.number().min(-60).max(20) });
export type AudioKey = z.infer<typeof AudioKeySchema>;
const band = z.number().min(-20).max(20).optional();
/** Phase 15: a parametric band: a bell at f Hz, gain dB, q (width: 0.7 broad, 1 musical, 4+ narrow, a notch). */
export const EqBandSchema = z.object({ f: z.number().min(20).max(20000), gain: z.number().min(-20).max(20), q: z.number().min(0.1).max(18).optional() });
export type EqBand = z.infer<typeof EqBandSchema>;
/** low: a shelf at 120 Hz, mid: a bell at 1 kHz (1.5 octaves wide), high: a shelf at 6 kHz (RBJ, Q 0.7071); dB each; bands: up to 4
 *  parametric bells (the list replaces them). */
export const EqSchema = z.object({ low: band, mid: band, high: band, bands: z.array(EqBandSchema).max(4).optional() });
export type Eq = z.infer<typeof EqSchema>;
/** amount 0-100 (how much of the room is heard), size 0-100 (how long it rings: 0.3 s to 2.5 s). */
export const ReverbSchema = z.object({ amount: z.number().min(0).max(100), size: z.number().min(0).max(100).optional() });
export type Reverb = z.infer<typeof ReverbSchema>;

/** The volume keys' gain (dB) at t: a straight line between keys, the first's before it, the last's after it. */
export function keyGainDb(keys: AudioKey[], t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0].t) return keys[0].gainDb;
  for (let i = 1; i < keys.length; i++) if (t < keys[i].t) { const a = keys[i - 1], b = keys[i]; return a.gainDb + ((b.gainDb - a.gainDb) * (t - a.t)) / (b.t - a.t || 1); }
  return keys[keys.length - 1].gainDb;
}
/** FFmpeg expression of keyGainDb in t (dB): the first key's gain plus each step's change, eased in over its span. */
export function keyExpr(keys: AudioKey[]): string {
  if (!keys.length) return "0";
  const steps = keys.slice(1).map((b, i) => { const a = keys[i], d = b.t - a.t; return d > 1e-6 ? `${(b.gainDb - a.gainDb).toFixed(3)}*clip((t-${n4(a.t)})/${n4(d)},0,1)` : `${(b.gainDb - a.gainDb).toFixed(3)}*gte(t,${n4(b.t)})`; });
  return [keys[0].gainDb.toFixed(3), ...steps].join("+");
}
/** Pan -1 (left) to 1 (right) as a balance: the far side goes down, the near side stays (the middle is as it was). */
export const panGains = (p: number): [number, number] => [Math.min(1, 1 - p), Math.min(1, 1 + p)];
/** The EQ as FFmpeg filters (bands at 0 left out); "" for none. */
export function eqChain(eq: Eq | undefined): string {
  if (!eq) return "";
  // Phase 15: the same RBJ shelves and bells Web Audio's biquads are (lowshelf/highshelf at Q 0.7071, the 1 kHz bell at
  // Q 0.9198: 1.5 octaves), so the editor's live sound and the render's are one EQ (measured: within 0.1 dB).
  return [eq.low ? `lowshelf=g=${eq.low}:f=120:t=q:w=0.7071` : "", eq.mid ? `equalizer=f=1000:t=q:w=0.9198:g=${eq.mid}` : "", eq.high ? `highshelf=g=${eq.high}:f=6000:t=q:w=0.7071` : "",
    ...(eq.bands ?? []).filter((b) => b.gain).map((b) => `equalizer=f=${Math.round(b.f)}:t=q:w=${(b.q ?? 1).toFixed(3)}:g=${b.gain}`)].filter(Boolean).join(",");
}
/** Pan and EQ as one FFmpeg chain ("" for none). */
export function clipFxChain(fx: { pan?: number; eq?: Eq }): string {
  const [l, r] = panGains(fx.pan ?? 0);
  return [eqChain(fx.eq), fx.pan ? `pan=stereo|c0=${l.toFixed(4)}*c0|c1=${r.toFixed(4)}*c1` : ""].filter(Boolean).join(",");
}
export const reverbSeconds = (size = 40) => 0.3 + (2.2 * size) / 100;
/** How loud the room is against the dry sound (1 = as loud). */
export const reverbWet = (amount: number) => (amount / 100) * 0.6;
/**
 * A room's impulse response: 10 ms of nothing, then noise dying away by 60 dB over reverbSeconds(size), each side its own
 * noise (seeded: the same size gives the same room, in the render and the player), scaled so a steady sound comes out
 * as loud as it went in.
 */
export function reverbIr(size = 40, rate = 48000): [Float32Array, Float32Array] {
  const rt = reverbSeconds(size), n = Math.round(rt * rate), pre = Math.round(0.01 * rate);
  const side = (seed: number) => {
    let a = seed >>> 0;
    const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const h = new Float32Array(n + pre);
    let e = 0;
    for (let i = 0; i < n; i++) { const v = (rnd() * 2 - 1) * Math.exp((-6.9078 * i) / n); h[pre + i] = v; e += v * v; }
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < h.length; i++) h[i] *= k;
    return h;
  };
  return [side(1 + Math.round(size * 7)), side(1000 + Math.round(size * 13))];
}
/** Two channels as a 32-bit float WAV file. */
export function wavStereo(l: Float32Array, r: Float32Array, rate = 48000): Uint8Array {
  const n = Math.min(l.length, r.length), data = n * 8, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 8, true); v.setUint16(32, 8, true); v.setUint16(34, 32, true); str(36, "data"); v.setUint32(40, data, true);
  for (let i = 0; i < n; i++) { v.setFloat32(44 + i * 8, l[i], true); v.setFloat32(48 + i * 8, r[i], true); }
  return new Uint8Array(buf);
}
/** A clip's own sound in words: "pan L 30%, EQ low +3 high -2, reverb 30 (2.1 s), 3 volume keys". */
export function clipFxText(fx: { pan?: number; eq?: Eq; reverb?: Reverb; keys?: AudioKey[] }): string {
  const sg = (x: number) => (x > 0 ? "+" : "") + x;
  const out: string[] = [];
  if (fx.pan) out.push(`pan ${fx.pan < 0 ? "L" : "R"} ${Math.round(Math.abs(fx.pan) * 100)}%`);
  const hz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);
  const e = fx.eq ? [...(["low", "mid", "high"] as const).filter((k) => fx.eq![k]).map((k) => `${k} ${sg(fx.eq![k]!)}`), ...(fx.eq.bands ?? []).filter((b) => b.gain).map((b) => `${hz(b.f)} ${sg(b.gain)} Q${+(b.q ?? 1).toFixed(1)}`)] : [];
  if (e.length) out.push(`EQ ${e.join(" ")} dB`);
  if (fx.reverb?.amount) out.push(`reverb ${fx.reverb.amount} (${reverbSeconds(fx.reverb.size).toFixed(1)} s room)`);
  if (fx.keys?.length) out.push(`${fx.keys.length} volume ${fx.keys.length === 1 ? "key" : "keys"}`);
  return out.join(", ");
}

/** Phase 15: the EQ as Web Audio biquads, the same RBJ filters FFmpeg's bass, equalizer and treble use: the shelves at
 *  Q 0.707 (Web Audio's shelves are that slope), the 1 kHz bell 1.5 octaves wide (Q 0.92), each band at its own Q. */
export function eqBiquads(eq: Eq | undefined): { type: "lowshelf" | "peaking" | "highshelf"; f: number; gain: number; q: number }[] {
  const out: { type: "lowshelf" | "peaking" | "highshelf"; f: number; gain: number; q: number }[] = [];
  if (!eq) return out;
  const octQ = (n: number) => Math.sqrt(Math.pow(2, n)) / (Math.pow(2, n) - 1);
  if (eq.low) out.push({ type: "lowshelf", f: 120, gain: eq.low, q: 0.7071 });
  if (eq.mid) out.push({ type: "peaking", f: 1000, gain: eq.mid, q: +octQ(1.5).toFixed(4) });
  if (eq.high) out.push({ type: "highshelf", f: 6000, gain: eq.high, q: 0.7071 });
  for (const b of eq.bands ?? []) if (b.gain) out.push({ type: "peaking", f: b.f, gain: b.gain, q: b.q ?? 1 });
  return out;
}
