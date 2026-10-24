// The edit's sound, as numbers both the render and the live player use: where music ducks under speech, how deep,
// the fades, each dialogue clip's gain, and the fixed cleanup chains. The FFmpeg expressions are built from the same
// curves the player evaluates, so the two agree (tested).
import type { Range, SequenceView } from "./sequence";
import type { Cleanup } from "./timeline";
import type { Word } from "./transcript";

/** Music goes down this long before speech, and comes back up this long after it (seconds). */
export const DUCK_ATTACK = 0.2;
export const DUCK_RELEASE = 0.5;
/** Speech closer together than this is one stretch: the music stays down in between instead of pumping. */
export const DUCK_JOIN = 1.0;
/** Fade at every cut in the dialogue when a cleanup preset is on (no clicks). */
export const DECLICK = 0.004;

/**
 * Fixed dialogue chains (FFmpeg). Compression evens the voice out; the loudness step afterwards sets the level, so
 * no make-up gain here.
 */
export const CLEANUP_CHAINS: Record<Cleanup, string> = {
  none: "",
  light: "highpass=f=80,acompressor=threshold=-20dB:ratio=2:attack=10:release=150",
  voice: "highpass=f=80,afftdn=nr=10:nf=-40:tn=1,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1:g=3,deesser=i=0.4,acompressor=threshold=-18dB:ratio=3:attack=8:release=120",
  noisy: "highpass=f=100,afftdn=nr=20:nf=-35:tn=1,agate=threshold=0.01:ratio=2:attack=5:release=200,equalizer=f=3500:t=q:w=1:g=3,deesser=i=0.5,acompressor=threshold=-18dB:ratio=4:attack=5:release=100",
};
export const CLEANUP_TEXT: Record<Cleanup, string> = {
  none: "none",
  light: "light (high-pass, gentle compression)",
  voice: "voice (high-pass, light denoise, de-esser, presence, compression)",
  noisy: "noisy room (high-pass, strong denoise, gate, de-esser, compression)",
};

/** A dialogue clip's sound in the edit with its own gain and fades (edit seconds). */
export type DialogueSpan = { start: number; end: number; gainDb: number; fadeIn: number; fadeOut: number };

/**
 * Where people speak in the edit (edit seconds): the words of every stretch of dialogue that is heard, joined when
 * closer than DUCK_JOIN. A video Rendrr has no transcript for counts as speech wherever it is heard.
 */
export function speechRanges(view: SequenceView, wordsOf: (videoId: string) => Word[] | null, cut: Set<string>): Range[] {
  const out: Range[] = [];
  for (const s of view.sound) {
    if (s.muted) continue;
    const ws = wordsOf(s.videoId);
    if (!ws) { out.push({ start: s.start, end: s.end }); continue; }
    for (const w of ws) {
      if (cut.has(w.id) || w.t < s.srcIn || w.t >= s.srcOut) continue;
      out.push({ start: s.start + (w.t - s.srcIn), end: s.start + (Math.min(w.end, s.srcOut) - s.srcIn) });
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
  for (const s of spans) if (t >= s.start && t < s.end) return Math.pow(10, s.gainDb / 20) * fadeFactor(t, s.start, s.end, s.fadeIn, s.fadeOut);
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
    return `gte(t,${n4(s.start)})*lt(t,${n4(s.end)})*(${parts.join("*")}-1)`;
  });
  return `1+${terms.join("+")}`;
}
/** Music's own fades when a clip sets none (as before Phase 3): in over a quarter of it up to 0.6 s, out up to 1.2 s. */
export const autoMusicFades = (length: number) => ({ fadeIn: Math.min(0.6, length / 4), fadeOut: Math.min(1.2, length / 4) });
export const dbToLin = (db: number) => Math.pow(10, db / 20);
