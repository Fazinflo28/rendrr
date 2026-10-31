// What the editor's live player shows at a moment of the edit, read from the same plan the renderer uses
// (planRender), so the player and the rendered file agree: which video and footage moment plays, which sound plays
// (it can come from another clip: J/L cuts), the caption on screen, the zoom, the b-roll and graphics on top, and
// whether the dialogue is muted. Times are edit seconds.
import type { BlendMode } from "./blend";
import type { Effect, Grade } from "./look";
import { editOf, rateOf, srcAt, type PicturePart, type Range, type SoundPart } from "./sequence";
import type { RenderPlan, Seg, TransitionOp, ZoomOp } from "./renderPlan";
import { dbToLin, dialogueGain, duckFactor, fadeFactor, keyGainDb } from "./audio";
import { activeWord, textAnimAt, textLookAt, type TextLayer } from "./captions";
import { keyTracks, motionAt, transitionAt, type Key, type KeyTracks, type Motion, type TransitionLook } from "./motion";

/** The zoom at edit time t: the same curve as zoomExpr() draws in the render (punch ramps, slow push). */
export function zoomAt(zooms: ZoomOp[], t: number): number {
  let sum = 0;
  for (const z of zooms) {
    if (t < z.start || t > z.end) continue;
    const s = z.scale - 1;
    if (z.mode === "through") { const p = (t - z.start) / Math.max(0.01, z.end - z.start); sum += s * (p < 0.5 ? (2 * p) ** 2 : (2 - 2 * p) ** 2); }
    else if (z.mode === "push") sum += (s * (t - z.start)) / Math.max(0.1, z.end - z.start);
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
  const at = (x: PicturePart | SoundPart, t: number) => Math.min(x.srcOut, Math.max(x.srcIn, srcAt(x, Math.min(Math.max(t, x.start), x.end))));
  return {
    parts, sound, total: plan.outputSeconds,
    /** The picture part playing at edit time t (the last one at the very end). */
    partAt: (t: number) => find(parts, t),
    /** src: the moment to show, inside the frame the render shows (a reversed part shows the frame before its moment). */
    picture(t: number): { i: number; videoId: string; src: number; rate: number } | null { const i = find(parts, t); return i < 0 ? null : { i, videoId: parts[i].videoId, src: showAt(parts[i], t), rate: rateOf(parts[i]) }; },
    soundAt(t: number): { i: number; videoId: string; src: number; muted: boolean; rate: number } | null { const i = find(sound, t); return i < 0 ? null : { i, videoId: sound[i].videoId, src: at(sound[i], t), muted: sound[i].muted || !!sound[i].silent, rate: rateOf(sound[i]) }; },
    /** Edit time of a footage moment in picture part i. */
    toEdit: (i: number, src: number) => (parts[i] ? editOf(parts[i], src) : 0),
  };
}
export type SequenceClock = ReturnType<typeof sequenceClock>;

/**
 * The footage moment a player shows at edit time t of a part or a transition side: inside the frame the render draws
 * there. At normal speed that is the footage moment itself. Off normal speed the render gives output frame n the
 * source frame floor(|rate| x n) counted from the part's first frame in play order (its last frame when reversed); a
 * frozen part holds its one frame.
 */
export function showAt(x: { srcIn: number; srcOut: number; start: number; end?: number; rate?: number }, t: number): number {
  const r = rateOf(x), F = 1 / 30;
  if (r === 1) return srcAt(x, t);
  if (r === 0) return x.srcIn + F / 4;
  const n = Math.max(0, Math.floor((t - x.start) * 30 + 1e-6));
  const j = Math.floor(Math.abs(r) * n + 1e-6);
  return r > 0 ? Math.min(x.srcOut, x.srcIn + (j + 0.5) * F) : Math.max(x.srcIn, x.srcOut - (j + 0.5) * F);
}

// Keyframe tables, made once per plan (the render writes the same tables as FFmpeg expressions).
const tableCache = new WeakMap<object, Map<string, KeyTracks | null>>();
function tracksOf(plan: RenderPlan, id: string, keys: Key[] | undefined): KeyTracks | null {
  let m = tableCache.get(plan);
  if (!m) { m = new Map(); tableCache.set(plan, m); }
  if (!m.has(id)) m.set(id, keyTracks(keys));
  return m.get(id)!;
}
/** A V1 clip's keyframe motion at edit time t (null: it has none). */
export function clipMotionAt(plan: RenderPlan, clipId: string | undefined, t: number): Motion | null {
  const cm = clipId ? plan.clipMotion?.[clipId] : undefined;
  return cm ? motionAt(tracksOf(plan, "v1:" + clipId, cm.keys), t - cm.start) : null;
}
export type SideNow = { videoId: string; src: number; rate: number; rotate: number; framing: Seg["framing"]; motion: Motion | null };
export type TransitionNow = { op: TransitionOp; p: number; look: TransitionLook; a: SideNow | null; b: SideNow | null };
/** The transition drawn at edit time t, with what each side shows then. */
export function transitionNow(plan: RenderPlan, t: number): TransitionNow | null {
  const op = (plan.transitions ?? []).find((x) => x.end - x.start >= 1 / 30 - 1e-9 && t >= x.start && t < x.end);
  if (!op) return null;
  const side = (segs: Seg[]): SideNow | null => {
    const s = segs.find((x) => t >= x.start - 1e-9 && t < x.end) ?? segs[segs.length - 1];
    return s ? { videoId: s.videoId, src: showAt(s, t), rate: s.rate, rotate: s.rotate, framing: s.framing, motion: clipMotionAt(plan, s.clipId, t) } : null;
  };
  // A dip that starts the edit (fade in from the colour) is the second half of a dip centred on 0.
  const D = op.end - op.start;
  const p = op.at <= op.start + 1e-9 && op.type.startsWith("dip") ? 0.5 + (t - op.start) / (2 * D) : (t - op.start) / D;
  return { op, p, look: transitionAt(op, p, plan.width, plan.height), a: side(op.a), b: side(op.b) };
}

export type LiveFrame = {
  t: number;                   // the edit time asked
  videoId: string | null;      // the video whose picture plays
  src: number;                 // the footage moment that plays (seconds in that video)
  part: number;                // the picture part (the player jumps from part to part)
  /** The dialogue that plays: its video and moment (another clip's sound during a J/L cut). */
  sound: { videoId: string; src: number; muted: boolean } | null;
  caption: string | null;
  /** The caption's lines as the render draws them, and which word is being spoken (when the style highlights it). */
  captionLines: { text: string; active: boolean }[][] | null;
  /** Text layers on screen, bottom first, with their animation at t (opacity, scale, px down); look: a keyframed
   *  layer's anchor (px), scale, turn and opacity, its animation included. */
  texts: { layer: TextLayer; opacity: number; scale: number; dy: number; look?: { x: number; y: number; scale: number; rotation: number; opacity: number } }[];
  zoom: number;
  muted: boolean;              // the dialogue is silent here
  /** blend, opacity (Phase 4): how it lies over the picture (CSS mix-blend-mode and opacity in the player). */
  /** Phase 11: flip (mirrored), anchor (the point keys turn and scale about: CSS transform-origin), shadow (a b-roll
   *  card's drop shadow). */
  broll: { clipId: string; videoId: string; src: number; motion: Motion | null; blend?: BlendMode; opacity?: number; flip?: "h" | "v" | "both"; anchor?: { x: number; y: number }; shadow?: { color: string; opacity: number; blur: number; x: number; y: number } } | null;
  graphics: { clipId: string; graphicId: string; t: number; start: number; end: number; motion: Motion | null; behind: boolean; blend?: BlendMode; opacity?: number; anchor?: { x: number; y: number } }[];
  /** Phase 9: adjustment layers on now (the player previews their grade and blur with CSS backdrop filters). */
  adjust?: { clipId: string; grade?: Grade; effects?: Effect[] }[];
  /** Phase 5: the picture's rate (1 normal, below 0 reversed, 0 frozen), its V1 keyframe motion, the transition on. */
  rate: number;
  motion: Motion | null;
  /** Phase 11: the V1 clip's anchor (its keys turn and scale about it). */
  motionAnchor?: { x: number; y: number };
  transition: TransitionNow | null;
  /** Phase 6: the clip whose look (plan.looks) the picture shows, and the b-roll behind V1 at t (bottom first). */
  lookId: string | null;
  under: { clipId: string; videoId: string; src: number; motion: Motion | null; flip?: "h" | "v" | "both"; anchor?: { x: number; y: number } }[];
};

const inside = (t: number, r: { start: number; end: number }) => t >= r.start && t < r.end;

export function liveFrame(plan: RenderPlan, t0: number, clock = sequenceClock(plan)): LiveFrame {
  // Every curve (transitions, keyframes, zooms, text animations, captions) at the start of the frame showing, as the
  // render draws it; the footage moment itself stays exact (the video shows the frame it falls in).
  const t = Math.floor(t0 * 30 + 1e-6) / 30;
  const cap = plan.captions.find((c) => inside(t, c));
  const sc = plan.styledCaptions?.find((c) => inside(t, c)) ?? null;
  const act = sc && plan.captionStyle?.highlight ? activeWord(sc, t) : null;
  // The last b-roll overlay drawn wins, as in the render (each one is laid over the ones before).
  const br = [...plan.broll].reverse().find((b) => inside(t, b) && b.videoId);
  const pic = clock.picture(t0), snd = clock.soundAt(t0);
  const part = pic ? plan.parts[pic.i] : null;
  const ov = (x: { clipId: string; keys?: Key[]; start: number }, kind: string) => (x.keys?.length ? motionAt(tracksOf(plan, kind + x.clipId, x.keys), t - x.start) : null);
  return {
    /** The edit time asked (Phase 2: the person layer checks its windows with it). */
    t: t0,
    videoId: pic ? pic.videoId : null,
    src: pic ? pic.src : 0,
    part: pic ? pic.i : 0,
    sound: snd ? { videoId: snd.videoId, src: snd.src, muted: snd.muted } : null,
    caption: cap ? cap.text : null,
    captionLines: sc ? sc.lines.map((l, i) => l.map((w, j) => ({ text: w.text, active: !!act && act[0] === i && act[1] === j }))) : null,
    texts: (plan.texts ?? []).filter((x) => inside(t, x)).map((x) => ({ layer: x, ...textAnimAt(x.anim, t - x.start, x.end - x.start, plan.height), ...(x.keys?.length ? { look: textLookAt(x, t - x.start, plan.width, plan.height) } : {}) })),
    zoom: zoomAt(plan.zooms, t),
    muted: plan.dialogueMutes.some((m) => inside(t, m)),
    broll: br ? { clipId: br.clipId, videoId: br.videoId!, src: br.sourceStart + (t - br.start), motion: ov(br, "v2:"), ...(br.blend ? { blend: br.blend } : {}), ...(br.opacity != null ? { opacity: br.opacity } : {}), ...(br.flip ? { flip: br.flip } : {}), ...(br.anchor ? { anchor: br.anchor } : {}), ...(br.shadow ? { shadow: br.shadow } : {}) } : null,
    adjust: (plan.adjust ?? []).filter((a) => inside(t, a)).map((a) => ({ clipId: a.clipId, ...(a.grade ? { grade: a.grade } : {}), ...(a.effects ? { effects: a.effects } : {}) })),
    graphics: plan.graphics.filter((g) => inside(t, g) && g.graphicId).map((g) => ({ clipId: g.clipId, graphicId: g.graphicId!, t: t - g.start + g.sourceStart, start: g.start, end: g.end, motion: ov(g, "v3:"), behind: !!g.behind, ...(g.blend ? { blend: g.blend } : {}), ...(g.opacity != null ? { opacity: g.opacity } : {}), ...(g.anchor ? { anchor: g.anchor } : {}) })),
    rate: pic ? pic.rate : 1,
    motion: part && part.clipIds.length === 1 ? clipMotionAt(plan, part.clipIds[0], t) : null,
    ...(part && part.clipIds.length === 1 && plan.clipMotion?.[part.clipIds[0]]?.anchor ? { motionAnchor: plan.clipMotion[part.clipIds[0]].anchor } : {}),
    transition: transitionNow(plan, t),
    lookId: part && plan.looks?.[part.clipIds[0]] ? part.clipIds[0] : null,
    under: (plan.under ?? []).filter((u) => inside(t, u) && u.videoId).map((u) => ({ clipId: u.clipId, videoId: u.videoId!, src: u.sourceStart + (t - u.start), motion: ov(u, "v2:"), ...(u.flip ? { flip: u.flip } : {}), ...(u.anchor ? { anchor: u.anchor } : {}) })),
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
  // The user's own voice file in place of the clips' sound (set_voice): the footage is silent all through; the file
  // plays like a sound effect (once, at its own level, not ducked).
  const voiced = plan.audio.some((a) => a.kind === "voice");
  const dialogue = voiced ? 0 : (mix ? dialogueGain(mix.dialogue, t) : 1) * mixFade;
  const music: { clipId: string; assetKey: string; src: number; gain: number }[] = [];
  const sfx: { clipId: string; assetKey: string; src: number; gain: number }[] = [];
  for (const a of plan.audio) {
    if (t < a.start || t >= a.end) continue;
    const fades = fadeFactor(t, a.start, a.end, a.fadeIn ?? 0, a.fadeOut ?? 0);
    const duck = a.kind === "music" && mix && mix.duck > 0 ? duckFactor(mix.speech, t) * mix.duck : 0;
    const x = { clipId: a.clipId, assetKey: a.assetKey, src: t - a.start, gain: dbToLin(a.gainDb - duck + (a.keys?.length ? keyGainDb(a.keys, t - a.start) : 0)) * fades * mixFade };
    (a.kind === "music" ? music : sfx).push(x);
  }
  return { dialogue, music, sfx };
}
