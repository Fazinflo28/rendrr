// The edit's sound, as numbers both the render and the live player use: where music ducks under speech, how deep,
// the fades, each dialogue clip's gain, and the fixed cleanup chains. The FFmpeg expressions are built from the same
// curves the player evaluates, so the two agree (tested).
import { z } from "zod";
import { editOf, type Range, type SequenceView } from "./sequence";
import type { Cleanup } from "./timeline";
import type { Word } from "./transcript";

/** Music goes down this long before speech, and comes back up this long after it (seconds). */
export const DUCK_ATTACK = 0.2;
export const DUCK_RELEASE = 0.5;
/** Speech closer together than this is one stretch: the music stays down in between instead of pumping. */
export const DUCK_JOIN = 1.0;
/** Fade at every cut in the dialogue (seconds), so no cut clicks: 20 ms, inside the 15-30 ms the plan asks for. */
export const DECLICK = 0.02;

/**
 * The dialogue cleanup as numbers. A preset fills them all; set_audio can change the main ones by hand (highpass,
 * denoise, presence, deess, compress). Compression evens the voice out; the loudness step afterwards sets the level,
 * so no make-up gain here.
 */
export type CleanupParams = {
  /** High-pass cut-off in Hz (0 = off): removes rumble. Low-pass in Hz (0 = off): phone and radio voices. */
  highpass: number; lowpass: number;
  /** Noise reduction in dB (0 = off), and the noise floor it assumes (dBFS). */
  denoise: number; noiseFloor: number;
  /** A soft gate between words (noisy rooms, roomy voices). */
  gate: boolean;
  /** dB at 180 Hz (warmth), at 250 Hz (mud), at presenceHz (presence, the 1.5-5 kHz lift; default 3.5 kHz) and a high
   *  shelf from 10 kHz (air). */
  warmth: number; mud: number; presence: number; presenceHz: number; air: number;
  /** De-esser intensity 0-1 (0 = off). */
  deess: number;
  /** Compression ratio (1 = off), threshold (dBFS), attack and release (ms). */
  compress: number; threshold: number; attack: number; release: number;
};
const OFF: CleanupParams = { highpass: 0, lowpass: 0, denoise: 0, noiseFloor: -40, gate: false, warmth: 0, mud: 0, presence: 0, presenceHz: 3500, air: 0, deess: 0, compress: 1, threshold: -18, attack: 8, release: 120 };
/** Each preset as numbers. The voice presets follow Premiere's Essential Sound ones (Balanced Voice, Podcast Voice,
 *  Dry Up a Roomy Voice, Phone Call, Radio Announcer, ...) with FFmpeg's filters. */
export const CLEANUP_PRESETS: Record<Cleanup, CleanupParams> = {
  none: OFF,
  light: { ...OFF, highpass: 80, compress: 2, threshold: -20, attack: 10, release: 150 },
  voice: { ...OFF, highpass: 80, denoise: 10, noiseFloor: -40, mud: -2, presence: 3, deess: 0.4, compress: 3, threshold: -18, attack: 8, release: 120 },
  noisy: { ...OFF, highpass: 100, denoise: 20, noiseFloor: -35, gate: true, presence: 3, deess: 0.5, compress: 4, threshold: -18, attack: 5, release: 100 },
  balanced: { ...OFF, highpass: 80, mud: -2, presence: 3, presenceHz: 3000, air: 2, deess: 0.3, compress: 3, threshold: -20, attack: 8, release: 120 },
  podcast: { ...OFF, highpass: 90, denoise: 8, noiseFloor: -42, mud: -3, presence: 5, presenceHz: 4000, air: 3, deess: 0.5, compress: 4, threshold: -22, attack: 5, release: 100 },
  roomy: { ...OFF, highpass: 100, denoise: 14, noiseFloor: -38, gate: true, mud: -6, presence: 2, deess: 0.3, compress: 2.5, threshold: -20, attack: 8, release: 120 },
  warm: { ...OFF, highpass: 70, warmth: 3, presence: 1.5, air: -2, deess: 0.3, compress: 3, threshold: -20, attack: 10, release: 150 },
  bright: { ...OFF, highpass: 90, mud: -2, presence: 4, air: 5, deess: 0.5, compress: 3, threshold: -20, attack: 8, release: 120 },
  radio: { ...OFF, highpass: 150, mud: -4, presence: 6, presenceHz: 2500, air: -4, deess: 0.5, compress: 6, threshold: -24, attack: 4, release: 90 },
  phone: { ...OFF, highpass: 400, lowpass: 3400, presence: 6, presenceHz: 1500, compress: 4, threshold: -20, attack: 5, release: 100 },
  soft: { ...OFF, highpass: 80, presence: -4, presenceHz: 3200, air: -2, deess: 0.6, compress: 2, threshold: -20, attack: 10, release: 150 },
  punchy: { ...OFF, highpass: 90, mud: -2, presence: 4, air: 2, deess: 0.4, compress: 6, threshold: -26, attack: 3, release: 80 },
};
/** The presets as the editor and the AI see them: a name and what it does. */
export const VOICE_PRESETS: { id: Cleanup; name: string; what: string }[] = [
  { id: "none", name: "Off", what: "the voice as recorded" },
  { id: "light", name: "Light touch", what: "rumble out, gentle compression" },
  { id: "balanced", name: "Balanced voice", what: "even and clear: less mud, a little presence and air" },
  { id: "podcast", name: "Podcast voice", what: "close and present: light denoise, presence lift, air, de-esser, firm compression" },
  { id: "voice", name: "Clean voice", what: "light denoise, de-esser, presence, compression" },
  { id: "noisy", name: "Clean up noisy dialogue", what: "strong denoise and a gate between words" },
  { id: "roomy", name: "Dry up a roomy voice", what: "less room: denoise, a gate between words, mud cut" },
  { id: "warm", name: "Warm voice", what: "fuller lows, softer highs" },
  { id: "bright", name: "Bright and crisp", what: "more presence and air, de-essed" },
  { id: "soft", name: "Soften a harsh voice", what: "harsh 3 kHz down, strong de-esser" },
  { id: "punchy", name: "Loud and punchy", what: "heavy compression for social video" },
  { id: "radio", name: "Radio announcer", what: "thin lows, forward mids, heavy compression" },
  { id: "phone", name: "Phone call", what: "a voice through a phone (300-3400 Hz)" },
];
/** The values set_audio can change by hand, on top of the preset. */
export const CLEANUP_KNOBS = ["highpass", "denoise", "presence", "deess", "compress"] as const;
export type CleanupKnob = (typeof CLEANUP_KNOBS)[number];

/** The cleanup's numbers: the preset's, with the hand-set values on top. */
export function cleanupParams(a: { cleanup: Cleanup } & Partial<Record<CleanupKnob, number | undefined>>): CleanupParams {
  const p = { ...CLEANUP_PRESETS[a.cleanup] };
  for (const k of CLEANUP_KNOBS) if (a[k] != null) (p as Record<string, unknown>)[k] = a[k];
  return p;
}
/** The FFmpeg chain for the cleanup's numbers ("" = nothing to do). */
export function cleanupChain(p: CleanupParams): string {
  const f: string[] = [];
  if (p.highpass > 0) f.push(`highpass=f=${p.highpass}`);
  if (p.lowpass > 0) f.push(`lowpass=f=${p.lowpass}`);
  if (p.denoise > 0) f.push(`afftdn=nr=${p.denoise}:nf=${p.noiseFloor}:tn=1`);
  if (p.gate) f.push("agate=threshold=0.01:ratio=2:attack=5:release=200");
  if (p.warmth) f.push(`equalizer=f=180:t=q:w=0.9:g=${p.warmth}`);
  if (p.mud) f.push(`equalizer=f=250:t=q:w=1:g=${p.mud}`);
  if (p.presence) f.push(`equalizer=f=${p.presenceHz}:t=q:w=1:g=${p.presence}`);
  if (p.air) f.push(`treble=g=${p.air}:f=10000:t=q:w=0.7`);
  if (p.deess > 0) f.push(`deesser=i=${p.deess}`);
  if (p.compress > 1) f.push(`acompressor=threshold=${p.threshold}dB:ratio=${p.compress}:attack=${p.attack}:release=${p.release}`);
  return f.join(",");
}
/** The preset chains (what each preset alone does). */
export const CLEANUP_CHAINS: Record<Cleanup, string> = Object.fromEntries(Object.entries(CLEANUP_PRESETS).map(([k, p]) => [k, cleanupChain(p)])) as Record<Cleanup, string>;
export const CLEANUP_TEXT: Record<Cleanup, string> = Object.fromEntries(VOICE_PRESETS.map((v) => [v.id, v.id === "none" ? "none" : `${v.id} (${v.what})`])) as Record<Cleanup, string>;

/** "voice (high-pass, ...)" or, with hand-set values, "voice, denoise 15 dB, presence +4 dB"; "none" when nothing runs. */
export function cleanupText(a: { cleanup: Cleanup } & Partial<Record<CleanupKnob, number | undefined>>): string {
  const hand = CLEANUP_KNOBS.filter((k) => a[k] != null);
  if (!hand.length) return a.cleanup === "none" ? "none" : CLEANUP_TEXT[a.cleanup].split(" (")[0];
  const p = cleanupParams(a);
  const say: Record<CleanupKnob, string> = { highpass: p.highpass ? `high-pass ${p.highpass} Hz` : "no high-pass", denoise: p.denoise ? `denoise ${p.denoise} dB` : "no denoise", presence: p.presence ? `presence +${p.presence} dB` : "no presence lift", deess: p.deess ? `de-ess ${p.deess}` : "no de-esser", compress: p.compress > 1 ? `compression ${p.compress}:1` : "no compression" };
  return `${a.cleanup}, ${hand.map((k) => say[k]).join(", ")}`;
}

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
// player plays the volume keys (pan, EQ and reverb are heard in the rendered preview, as cleanup is).
// ---------------------------------------------------------------------------------------------
export const AudioKeySchema = z.object({ t: z.number().min(0).max(24 * 3600), gainDb: z.number().min(-60).max(20) });
export type AudioKey = z.infer<typeof AudioKeySchema>;
const band = z.number().min(-20).max(20).optional();
/** low: a shelf at 120 Hz, mid: a bell at 1 kHz (1.5 octaves wide), high: a shelf at 6 kHz; dB each. */
export const EqSchema = z.object({ low: band, mid: band, high: band });
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
  return [eq.low ? `bass=g=${eq.low}:f=120:w=0.7` : "", eq.mid ? `equalizer=f=1000:t=o:w=1.5:g=${eq.mid}` : "", eq.high ? `treble=g=${eq.high}:f=6000:w=0.7` : ""].filter(Boolean).join(",");
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
  const e = fx.eq ? (["low", "mid", "high"] as const).filter((k) => fx.eq![k]).map((k) => `${k} ${sg(fx.eq![k]!)}`) : [];
  if (e.length) out.push(`EQ ${e.join(" ")} dB`);
  if (fx.reverb?.amount) out.push(`reverb ${fx.reverb.amount} (${reverbSeconds(fx.reverb.size).toFixed(1)} s room)`);
  if (fx.keys?.length) out.push(`${fx.keys.length} volume ${fx.keys.length === 1 ? "key" : "keys"}`);
  return out.join(", ");
}
