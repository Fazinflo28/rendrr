// What the editor's live player shows at a moment of the edit, read from the same plan the renderer uses
// (planRender), so the player and the rendered file agree: which video and footage moment plays, which sound plays
// (it can come from another clip: J/L cuts), the caption on screen, the zoom, the b-roll and graphics on top, and
// whether the dialogue is muted. Times are edit seconds.
import type { PicturePart, Range, SoundPart } from "./sequence";
import type { RenderPlan, ZoomOp } from "./renderPlan";
import { dbToLin, dialogueGain, duckFactor, fadeFactor } from "./audio";
import { activeWord, textAnimAt, type TextLayer } from "./captions";

/** The zoom at edit time t: the same curve as zoomExpr() draws in the render (punch ramps, slow push). */
export function zoomAt(zooms: ZoomOp[], t: number): number {
  let sum = 0;
  for (const z of zooms) {
    if (t < z.start || t > z.end) continue;
    const s = z.scale - 1;
    if (z.mode === "push") sum += (s * (t - z.start)) / Math.max(0.1, z.end - z.start);
    else {
      const ramp = Math.min(0.12, (z.end - z.start) / 3);
      sum += s * Math.min(1, (t - z.start) / ramp) * Math.min(1, (z.end - t) / ramp);
    }
  }
  return Math.min(2, 1 + sum);
}

/** Edit time <-> footage time over the kept parts, with the part index (the player jumps from part to part). */
export function keptClock(kept: Range[]) {
  const offsets: number[] = [];
  let acc = 0;
  for (const k of kept) { offsets.push(acc); acc += k.end - k.start; }
  const total = acc;
  /** The part that plays at edit time t (the last part at the very end). */
  const partAt = (t: number) => {
    for (let i = 0; i < kept.length; i++) if (t < offsets[i] + (kept[i].end - kept[i].start)) return i;
    return kept.length - 1;
  };
  const toSource = (t: number) => { if (!kept.length) return 0; const i = partAt(Math.max(0, t)); return Math.min(kept[i].end, kept[i].start + Math.max(0, t - offsets[i])); };
  const toOutput = (src: number, i = -1) => {
    if (i >= 0 && i < kept.length) return offsets[i] + Math.min(kept[i].end - kept[i].start, Math.max(0, src - kept[i].start));
    for (let k = 0; k < kept.length; k++) { if (src < kept[k].start) return offsets[k]; if (src <= kept[k].end) return offsets[k] + (src - kept[k].start); }
    return total;
  };
  return { kept, offsets, total, partAt, toSource, toOutput };
}

/** Edit time <-> video and footage time over the plan's picture and sound parts. */
export function sequenceClock(plan: Pick<RenderPlan, "parts" | "sound" | "outputSeconds">) {
  const parts = plan.parts, sound = plan.sound;
  const find = <T extends { start: number; end: number }>(xs: T[], t: number) => {
    if (!xs.length) return -1;
    let lo = 0, hi = xs.length - 1;
    if (t >= xs[hi].start) return hi;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (xs[mid].start <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const at = (x: PicturePart | SoundPart, t: number) => Math.min(x.srcOut, x.srcIn + Math.max(0, t - x.start));
  return {
    parts, sound, total: plan.outputSeconds,
    /** The picture part playing at edit time t (the last one at the very end). */
    partAt: (t: number) => find(parts, t),
    picture(t: number): { i: number; videoId: string; src: number } | null { const i = find(parts, t); return i < 0 ? null : { i, videoId: parts[i].videoId, src: at(parts[i], t) }; },
    soundAt(t: number): { i: number; videoId: string; src: number; muted: boolean } | null { const i = find(sound, t); return i < 0 ? null : { i, videoId: sound[i].videoId, src: at(sound[i], t), muted: sound[i].muted }; },
    /** Edit time of a footage moment in picture part i. */
    toEdit: (i: number, src: number) => (parts[i] ? parts[i].start + Math.min(parts[i].end - parts[i].start, Math.max(0, src - parts[i].srcIn)) : 0),
  };
}
export type SequenceClock = ReturnType<typeof sequenceClock>;

export type LiveFrame = {
  videoId: string | null;      // the video whose picture plays
  src: number;                 // the footage moment that plays (seconds in that video)
  part: number;                // the picture part (the player jumps from part to part)
  /** The dialogue that plays: its video and moment (another clip's sound during a J/L cut). */
  sound: { videoId: string; src: number; muted: boolean } | null;
  caption: string | null;
  /** The caption's lines as the render draws them, and which word is being spoken (when the style highlights it). */
  captionLines: { text: string; active: boolean }[][] | null;
  /** Text layers on screen, bottom first, with their animation at t (opacity, scale, px down). */
  texts: { layer: TextLayer; opacity: number; scale: number; dy: number }[];
  zoom: number;
  muted: boolean;              // the dialogue is silent here
  broll: { clipId: string; videoId: string; src: number } | null;
  graphics: { clipId: string; graphicId: string; t: number; start: number; end: number }[];
};

const inside = (t: number, r: { start: number; end: number }) => t >= r.start && t < r.end;

export function liveFrame(plan: RenderPlan, t: number, clock = sequenceClock(plan)): LiveFrame {
  const cap = plan.captions.find((c) => inside(t, c));
  const sc = plan.styledCaptions?.find((c) => inside(t, c)) ?? null;
  const act = sc && plan.captionStyle?.highlight ? activeWord(sc, t) : null;
  // The last b-roll overlay drawn wins, as in the render (each one is laid over the ones before).
  const br = [...plan.broll].reverse().find((b) => inside(t, b) && b.videoId);
  const pic = clock.picture(t), snd = clock.soundAt(t);
  return {
    videoId: pic ? pic.videoId : null,
    src: pic ? pic.src : 0,
    part: pic ? pic.i : 0,
    sound: snd ? { videoId: snd.videoId, src: snd.src, muted: snd.muted } : null,
    caption: cap ? cap.text : null,
    captionLines: sc ? sc.lines.map((l, i) => l.map((w, j) => ({ text: w.text, active: !!act && act[0] === i && act[1] === j }))) : null,
    texts: (plan.texts ?? []).filter((x) => inside(t, x)).map((x) => ({ layer: x, ...textAnimAt(x.anim, t - x.start, x.end - x.start, plan.height) })),
    zoom: zoomAt(plan.zooms, t),
    muted: plan.dialogueMutes.some((m) => inside(t, m)),
    broll: br ? { clipId: br.clipId, videoId: br.videoId!, src: br.sourceStart + (t - br.start) } : null,
    graphics: plan.graphics.filter((g) => inside(t, g) && g.graphicId).map((g) => ({ clipId: g.clipId, graphicId: g.graphicId!, t: t - g.start, start: g.start, end: g.end })),
  };
}

/**
 * Every sound's level at edit time t (linear), as the render mixes it before its loudness step: the dialogue (its
 * clip's gain and fades), each music clip (its gain and fades, ducked under speech) and each sound effect, all
 * under the mix's fades. `src` is the moment inside the music or effect file. The live player plays these levels;
 * the loudness step itself (one gain for everything) and the cleanup are heard in the rendered preview.
 */
export function audioAt(plan: RenderPlan, t: number): { dialogue: number; music: { clipId: string; assetKey: string; src: number; gain: number }[]; sfx: { clipId: string; assetKey: string; src: number; gain: number }[] } {
  const mix = plan.audioMix;
  const T = plan.outputSeconds;
  const mixFade = mix ? fadeFactor(t, 0, T + 1e-9, mix.fadeIn, mix.fadeOut > 0 ? mix.fadeOut : 0) : 1;
  const dialogue = (mix ? dialogueGain(mix.dialogue, t) : 1) * mixFade;
  const music: { clipId: string; assetKey: string; src: number; gain: number }[] = [];
  const sfx: { clipId: string; assetKey: string; src: number; gain: number }[] = [];
  for (const a of plan.audio) {
    if (t < a.start || t >= a.end) continue;
    const fades = fadeFactor(t, a.start, a.end, a.fadeIn ?? 0, a.fadeOut ?? 0);
    const duck = a.kind === "music" && mix && mix.duck > 0 ? duckFactor(mix.speech, t) * mix.duck : 0;
    const x = { clipId: a.clipId, assetKey: a.assetKey, src: t - a.start, gain: dbToLin(a.gainDb - duck) * fades * mixFade };
    (a.kind === "music" ? music : sfx).push(x);
  }
  return { dialogue, music, sfx };
}
