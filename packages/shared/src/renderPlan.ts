// Timeline -> FFmpeg. The one place that decides what a render looks like.
// planRender() is pure: it turns a snapshot + transcript into an ordered plan in OUTPUT time.
// ffmpegArgs() turns a plan + local file paths into one FFmpeg command (a single pass: fast and lossless between steps).
// Sequences (model B) are planned here; timelines stored in model A go to the unchanged A planner (renderPlanA.ts).
import { catalogMusic, catalogSfx, findTemplate } from "./catalog";
import { aspectSize, type Aspect, type CaptionLook } from "./constants";
import { cutRegions, editOf, fmtClock, isSequence, mainVideoOf, mergeRanges, normalSpeed, rateOf, sequenceView, srcAt, subtractRanges, type Attached, type PicturePart, type Range, type SeqClip, type SequenceView, type SoundPart } from "./sequence";
import { dirVec, keyTracks, motionExpr, scaleRange, smoothExpr, USES_HANDLES, WHIP_BLUR, xfadeOf, ZOOM_PEAK, type Dir, type Key, type TransitionType } from "./motion";
import type { Snapshot, V2Clip, V3Clip, A2Clip, A3Clip, Framing, Resolution, Codec } from "./timeline";
import { allWords, type Transcript, type Word } from "./transcript";
import { ffmpegArgsA, planRenderA } from "./renderPlanA";
import { autoMusicFades, cleanupChain, cleanupParams, cleanupText, clipFxChain, clipFxText, dialogueExpr, duckExpr, keyExpr, reverbWet, speechRanges, type AudioKey, type DialogueSpan, type Eq, type Reverb } from "./audio";
import { audioSettings, sourceVideoIds, type AudioMixSettings, type ExportFormat } from "./timeline";
import { chapterProblems, GIF_MAX_SECONDS, gifSpec, type Chapter } from "./deliverables";
import { blendFilter, blendText, type BlendMode } from "./blend";
import { buildStyledAss, captionStyleOf, isMatted, layoutCaptions, styleText, textMatteAss, textPreset, type Card, type CaptionStyle, type StyledCaption, type TextAnim, type TextLayer, type TextStyle } from "./captions";
import { backgroundScale, backgroundSigma, backgroundText, cardBorderPicture, cardLookText, cardShadowPicture, gradientPicture, hasCard, masksWithCard, patternPicture, ppm, SHADOW_DEFAULTS, type CardLook, type Pattern } from "./cardLook";
import { adjustText, areaAt, areaPicture, firstKeyAt, buildLut, lutSizeFor, VIGNETTE_AREA, matteBlocks, moving, MATTE_BLOCK, skinActive, skinChromaExpr, skinParams, skinText, SKIN_TONE, subjectText, type Skin, type SkinParams, type Subject, chromaKeyText, cubeText, effectPx, effectsText, gradeFn, gradeIsActive, gradeText, hashOf, hdrLut, hexRgb, maskPicture, masksText, pgm, sdrToHdr, sharpenKernel, spillType, type Area, type ChromaKey, type ClipLook, type Effect, type Grade, type HdrTransfer, type Lut, type Mask } from "./look";

export type RenderKind = "preview" | "final";
export type SourceInfo = { width: number; height: number; fps: number; seconds: number; hasAudio: boolean; hdr?: boolean; transfer?: HdrTransfer };
export type CaptionRules = { wordsAtOnce: number; upper: boolean; maxLines: number };

export type PlanInput = {
  kind: RenderKind;
  snapshot: Snapshot;
  transcript: Transcript;
  source: SourceInfo;
  captionRules?: Partial<CaptionRules>;
  /** Footage length of each b-roll video, by video id. Clips whose footage is unknown are skipped. */
  brollSeconds?: Record<string, number>;
  /** Which graphic clips have a rendered file ready, by v3 clip id. */
  graphicsReady?: Record<string, boolean>;
  /** The project's footage id (the sequence's main video). */
  videoId?: string;
  /** The other videos on V1, by id. */
  sources?: Record<string, SourceInfo>;
  /** Their transcripts (captions of their speech), by id. */
  transcripts?: Record<string, Transcript>;
  /** Imported LUTs the grades use, by id (Phase 6). A grade whose LUT is missing renders without it (and says so). */
  luts?: Record<string, Lut>;
  /** Videos whose original is HDR, by id (a preview plays SDR copies, so it learns this here for its check line). */
  hdrFootage?: Record<string, HdrTransfer>;
  /** Cuts on frames as model A rendered them; only to check a conversion from model A (sequenceView cutsOnFrames). */
  cutsOnFrames?: boolean;
  /** The user's own audio files the edit uses (add_audio), by id: own music on A2 and the voice (set_voice). One that
   *  is missing is left out (and said so). */
  sounds?: Record<string, { key: string; seconds: number; name: string }>;
};

/** through: the zoom transition (in to the cut, out after it). */
export type ZoomOp = { start: number; end: number; scale: number; mode: "punch" | "push" | "through" };
/** keys: keyframes in seconds from the overlay's start (a b-roll clip with keys is a picture-in-picture). */
/** blend, opacity (Phase 4): how the layer lies over the picture (normal at full opacity when left out). */
export type OverlayOp = { clipId: string; start: number; end: number; sourceStart: number; videoId?: string; graphicId?: string; keys?: Key[]; behind?: boolean; blend?: BlendMode; opacity?: number;
  /** Phase 11: mirrored (b-roll); the anchor its keys turn about; motion blur (0-100); a drop shadow (b-roll cards). */
  flip?: "h" | "v" | "both"; anchor?: { x: number; y: number }; motionBlur?: number; shadow?: { color: string; opacity: number; blur: number; x: number; y: number };
  /** Phase 17: a b-roll card's border: its colour where the picture (a ring just inside the card's edge) says. */
  border?: { file: string; color: string } };
/**
 * Phase 2b: a text layer drawn from a mask, on its side of the person (behind: before the person is laid back), after
 * that side's graphics and before its other text layers. mask: an ASS file drawn white on black from the layer's start
 * (its letters, or its card with the letters cut out); decor: an ASS file drawn on the picture in edit time (the card,
 * stroke, shadow, box round a video in the letters). inside: the library video in the letters (looped from `from`);
 * cut: the card's colour (the picture under it shows through the letters).
 */
export type TextMatteOp = { clipId: string; start: number; end: number; behind: boolean; mask: string; decor: string | null; inside?: { videoId: string; from: number; seconds: number }; cut?: string };
/** Phase 17: a keyframed text layer with motion blur, drawn on its own: its ASS (timed from the layer's start) on a
 *  clear frame at four times the frame rate, the last frames of each frame's shutter averaged (as motionChain). */
export type TextBlurOp = { clipId: string; start: number; end: number; behind: boolean; blur: number; ass: string };
/**
 * Phase 2: graphics and text layers behind the person. windows: when the person is laid back over them (output
 * seconds; not where b-roll or a transition plays). parts: the matte each picture part reads (by its index in
 * plan.parts); left: V1 clips under them whose person cannot be drawn (framed smaller, moved, reversed), and why.
 */
export type PersonOp = { windows: Range[]; parts: Record<number, string>; left: { clipId: string; why: string }[] };
/** A stretch of one video drawn over an edit window: the same steps as a picture part (speed, turn, fit, framing, the
 *  clip's keyframes). Footage past a part's ends continues at its rate (handles). */
export type Seg = { videoId: string; srcIn: number; srcOut: number; rate: number; start: number; end: number; rotate: 0 | 90 | 180 | 270; framing: Framing | null; clipId: string };
/** A transition on the cut at `at`, over [start, end). a / b: what each side shows over the whole window (dissolve,
 *  slide, whip; dips and zoom draw on the picture itself). asked: the duration the edit asked for. */
export type TransitionOp = { clipId: string; type: Exclude<TransitionType, "cut">; dir?: Dir; at: number; start: number; end: number; asked: number; a: Seg[]; b: Seg[]; note?: string };
/** voice: the user's own file in place of every clip's sound (set_voice); soundId: a user's file (not the library's). */
/** Phase 6: a clip's own sound: pan, EQ, reverb (ir: the impulse response's file in plan.irs) and volume keys (seconds
 *  from the clip's start). */
export type ClipSoundFx = { pan?: number; eq?: Eq; reverb?: { amount: number; size: number; ir: string }; keys?: AudioKey[] };
export type AudioOp = { clipId: string; start: number; end: number; gainDb: number; assetKey: string; kind: "music" | "sfx" | "voice"; fadeIn?: number; fadeOut?: number; soundId?: string } & ClipSoundFx;
/** The sequence's sound settings and the numbers the mix is made from (edit seconds). */
export type AudioMix = AudioMixSettings & {
  /** Where people speak: music ducks under these. */
  speech: Range[];
  /** Dialogue clips with their own gain or fades. */
  dialogue: DialogueSpan[];
  /** Phase 6: V1 clips with their own pan, EQ or reverb (by clip id), applied to their sound before the joins. */
  clipFx?: Record<string, Omit<ClipSoundFx, "keys">>;
  /** Phase 6: the reverb rooms to write (impulse responses, by file name): their size. */
  irs?: Record<string, number>;
};
/** Phase 7: a V1 part stabilized: its footage (on the plan's frame grid, as the render reads it), analysed first by the
 *  worker into `file` (vidstabdetect), then smoothed over `smoothing` frames in the render (vidstabtransform). */
export type StabilizeOp = { videoId: string; srcIn: number; srcOut: number; smoothing: number; file: string };
export const stabilizeKey = (p: { clipIds: string[]; srcIn: number }) => `${p.clipIds[0]}@${p.srcIn.toFixed(3)}`;
/**
 * Phase 21: a stabilized copy of a clip's footage, for b-roll and for a V1 clip played at another speed (a ramp's steps,
 * reversed, a freeze). The worker measures the shake over [srcIn, srcOut) (on the frame grid, a second either side of
 * what the clip shows, so transition sides are in it) and writes the footage stabilized; every part of the clip reads
 * that copy (its frame k is footage frame srcIn x fps + k), so the whole clip is smoothed as one, through its speed
 * changes. Keyed by clip id.
 */
export type StableCopyOp = { clipId: string; videoId: string; srcIn: number; srcOut: number; smoothing: number; file: string; copy: string; broll?: boolean };
/** Phase 9: an adjustment layer over start..end (edit seconds): its look is plan.looks[clipId]; grade and effects for
 *  the player's preview. */
export type AdjustOp = { clipId: string; start: number; end: number; grade?: Grade; effects?: Effect[]; masks?: Mask[]; opacity?: number; fadeIn?: number; fadeOut?: number };
export type CaptionEvent = { start: number; end: number; text: string };
/**
 * A clip's colour and compositing (Phase 6), with the files the render reads: lut = the grade as a .cube (lutHdr: the
 * grade, then SDR into the HDR output), mask = the masks' picture (.pgm), each effect's area picture. px: blur sigma or
 * block size in pixels at the plan's size. alpha: parts of the clip are transparent (key or masks).
 */
/** skin: the retouch's values, its numbers at the plan's size, and its area as a picture (file). */
export type SkinOp = { skin: Skin; p: SkinParams; file?: string };
/** subject: remove_background's values and the matte it reads (plan.mattes[matte]: the footage's blocks). */
export type SubjectOp = Subject & { matte: string };
export type LookOp = { grade?: Grade; lut?: string; lutHdr?: string; key?: ChromaKey; masks?: Mask[]; mask?: string; effects?: (Effect & { px: number; file?: string })[]; skin?: SkinOp; subject?: SubjectOp; alpha: boolean };
/** A subject matte: blocks of MATTE_BLOCK seconds of one video's matte (made once per video, kept), joined. */
export type MatteOp = { videoId: string; blocks: number[] };
/** What a look file holds; lookFileData() writes it. shadow and border: a card's, in its framed place; gradient: what
 *  is behind V1 (a colour is a gradient from it to itself). */
/** moving (Phase 3): masks or an area with keys, drawn over footage from..to of the clip as a grey video in footage time
 *  (the worker writes it: movingFrames), put through the clip's own trim and speed in the graph as the picture is. */
export type LookFile = { kind: "lut"; grade: Grade; hdr?: HdrTransfer } | { kind: "hdr"; hdr: HdrTransfer } | { kind: "mask"; masks: Mask[] } | { kind: "area"; area: Area }
  | { kind: "moving"; masks?: Mask[]; area?: Area; from: number; to: number }
  | { kind: "shadow"; card: CardLook; framing: Framing | null } | { kind: "border"; card: CardLook; framing: Framing | null } | { kind: "gradient"; gradient: { from: string; to: string; angle?: number } } | { kind: "pattern"; pattern: Pattern };
/** A V1 clip drawn as a card: its shadow under it and its border over it (crop and corners are in its mask). */
export type CardOp = { shadow?: { file: string; color: string }; border?: { file: string; color: string } };
/** What is behind V1: a picture file (colour, gradient or pattern), a library video (looped from the edit's start), or the
 *  clip's own picture blurred (sigma in pixels). */
export type BackgroundOp = { file?: string; videoId?: string; seconds?: number; blur?: number; scale?: number; text: string };

export type RenderPlan = {
  /** "B" = planned from a sequence; "A" = from a timeline stored in model A (renderPlanA.ts). */
  model: "A" | "B";
  kind: RenderKind;
  width: number; height: number; fps: number;
  /** Phase 7: the output's exact frame rate for FFmpeg (e.g. "30000/1001"; missing = 30) and its codec. */
  rate?: string;
  codec?: Codec;
  aspect: Aspect;
  /** Footage ranges of the picture parts, in edit order (each part's video is in `parts`). */
  kept: Range[];
  /** The picture: parts in edit order, each a stretch of one video with its turn and framing. */
  parts: PicturePart[];
  /** Phase 7: stabilized parts (by stabilizeKey). */
  stabilize?: Record<string, StabilizeOp>;
  /** Phase 21: stabilized copies of b-roll and of V1 clips at other speeds (by clip id). */
  stabilized?: Record<string, StableCopyOp>;
  /** Phase 12 (final): what the file is (left out: mp4), its video bitrate in Mbit/s (left out: constant quality),
   *  and the edit's chapters (chapter marks, in edit seconds). */
  format?: ExportFormat;
  bitrate?: number;
  chapters?: Chapter[];
  /** Phase 12: the words as subtitle cues in edit seconds (the captions, or the words when captions are off). */
  subtitles?: CaptionEvent[];
  /** Phase 9: adjustment layers. */
  adjust?: AdjustOp[];
  /** The dialogue: parts in edit order covering the whole edit (muted = silent). */
  sound: SoundPart[];
  /** The videos it plays, main footage first. */
  sources: string[];
  /** Per video: has a sound track, HDR (tone-mapped like the preview copy in SDR output) and its transfer. */
  videos?: Record<string, { hasAudio: boolean; hdr: boolean; transfer?: HdrTransfer; seconds?: number }>;
  /** Sequences only: cleanup, loudness target, ducking, fades. */
  audioMix?: AudioMix;
  outputSeconds: number;
  rotate: 0 | 90 | 180 | 270; // clockwise turn of the footage before it is fitted
  framing: { scale: number; x: number; y: number } | null; // the footage's position and scale in the frame, after the fit
  zooms: ZoomOp[];
  broll: OverlayOp[];
  graphics: OverlayOp[];
  audio: AudioOp[];
  dialogueMutes: Range[];
  captions: CaptionEvent[];
  captionLook: CaptionLook;
  /** Phase 5: transitions in edit order, and the keyframes of V1 clips (seconds from the clip's start in the edit). */
  transitions?: TransitionOp[];
  clipMotion?: Record<string, { start: number; end: number; keys: Key[]; anchor?: { x: number; y: number }; motionBlur?: number }>;
  /** Phase 6: each V1 and b-roll clip's look (by clip id), the files they need (by file name), b-roll drawn behind V1,
   *  and the HDR output (null: SDR). hdr.lut converts SDR pictures (footage, b-roll, graphics) into it. */
  looks?: Record<string, LookOp>;
  lookFiles?: Record<string, LookFile>;
  under?: OverlayOp[];
  hdr?: { transfer: HdrTransfer; lut: string } | null;
  /** V1 clips drawn as cards (by clip id) and what is behind V1 (null: black). */
  cards?: Record<string, CardOp>;
  /** remove_background: the matte blocks each subject reads, by name (LookOp.subject.matte). */
  mattes?: Record<string, MatteOp>;
  background?: BackgroundOp | null;
  /** Sequences: the caption style, the captions with their lines and word times, the text layers (Phase 4). */
  captionStyle?: CaptionStyle;
  styledCaptions?: StyledCaption[];
  texts?: TextLayer[];
  ass: string | null;
  /** Phase 2: the text layers behind the person, drawn before the person is laid back over them. */
  assBehind?: string | null;
  person?: PersonOp;
  /** Phase 2b: text layers with a video inside their letters or cut out of their card, each drawn from its mask. */
  textMattes?: TextMatteOp[];
  /** Phase 17: keyframed text layers with motion blur. */
  textBlurs?: TextBlurOp[];
  /** Samples: only edit seconds [from, to) are drawn (windowPlan); the sound is the whole mix, trimmed to them. */
  window?: { from: number; to: number };
  operations: string[];
};

export class RenderPlanError extends Error {
  friendly = true;
  constructor(message: string) { super(message); }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const sameFraming = (a: Framing | null, b: Framing | null) => (!a && !b) || (!!a && !!b && a.scale === b.scale && a.x === b.x && a.y === b.y && a.focus?.x === b.focus?.x && a.focus?.y === b.focus?.y);
/** Phase 7: the standard frame rates a final snaps to (within 0.5%), as FFmpeg fractions. */
const STANDARD_RATES: [number, string][] = [[24000 / 1001, "24000/1001"], [24, "24"], [25, "25"], [30000 / 1001, "30000/1001"], [30, "30"], [48, "48"], [50, "50"], [60000 / 1001, "60000/1001"], [60, "60"]];
/**
 * The frame rate a final plays at: the footage's own (snapped to a standard rate within 0.5%; above 60, 60). A rate
 * off the list keeps three decimals. Previews are always 30 (the preview copy is 30 fps).
 */
export function outputRate(kind: RenderKind, sourceFps: number | null | undefined): { fps: number; rate: string; capped: boolean } {
  const f = Number(sourceFps) || 30;
  if (kind === "preview") return { fps: 30, rate: "30", capped: false };
  if (f > 60.5) return { fps: 60, rate: "60", capped: true };
  const hit = [...STANDARD_RATES].sort((a, b) => Math.abs(f - a[0]) - Math.abs(f - b[0]))[0];
  if (Math.abs(f - hit[0]) / hit[0] <= 0.005) return { fps: hit[0], rate: hit[1], capped: false };
  const k = Math.max(1, Math.round(f * 1000));
  return { fps: k / 1000, rate: k % 1000 === 0 ? String(k / 1000) : `${k}/1000`, capped: false };
}
/** FFmpeg's time base for a rate: 1/30, 1001/30000. */
export const timeBase = (rate: string) => { const [n, d] = rate.split("/"); return d ? `${d}/${n}` : `1/${n}`; };
/** A rate for people: 29.97, 23.976, 25. */
export const rateText = (fps: number) => (Math.abs(fps - Math.round(fps)) < 1e-6 ? String(Math.round(fps)) : (Math.round(fps * 1000) / 1000).toString());
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** A video's footage further on than this past what its decoder has given is read from a new, seeked input. */
const WINDOW_GAP = 10;

export function outputSize(aspect: Aspect, kind: RenderKind, resolution?: Resolution | null) {
  // Phase 7: a final's short side follows its export resolution (720, 1080 or 2160); previews stay 540.
  const short = kind === "preview" ? 540 : resolution === "4k" ? 2160 : resolution === "720p" ? 720 : 1080;
  return aspectSize(aspect, short);
}

export const DEFAULT_CAPTION_RULES: Record<CaptionLook, CaptionRules> = {
  clean: { wordsAtOnce: 7, upper: false, maxLines: 2 },
  bold: { wordsAtOnce: 3, upper: true, maxLines: 1 },
  outline: { wordsAtOnce: 5, upper: false, maxLines: 1 },
};

// ---------------------------------------------------------------------------------------------
// Captions: timed by the server from transcript words, never by the AI.
// ---------------------------------------------------------------------------------------------
type TimedToken = { text: string; t: number; end: number };

export function captionTokens(lineWords: Word[], text: string, cut: Set<string>, inKept: (t: number) => boolean): TimedToken[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !lineWords.length) return [];
  if (tokens.length === lineWords.length) {
    // Same number of words: keep each word's own timing (typo fixes, punctuation, casing).
    return lineWords.map((w, i) => ({ text: tokens[i], t: w.t, end: w.end })).filter((_, i) => !cut.has(lineWords[i].id) && inKept(lineWords[i].t));
  }
  // Rewritten line: spread the new words evenly over the words that are still in the video. A position p in
  // "kept word" units maps to a time inside that word, so more new words than old ones still get distinct times.
  const kept = lineWords.filter((w) => !cut.has(w.id) && inKept(w.t));
  if (!kept.length) return [];
  const n = kept.length, m = tokens.length;
  const at = (p: number) => {
    if (p >= n) return kept[n - 1].end;
    const k = kept[Math.floor(p)], f = p - Math.floor(p);
    return k.t + f * Math.max(0, k.end - k.t);
  };
  return tokens.map((tok, i) => {
    const t = at((i * n) / m);
    const p2 = ((i + 1) * n) / m;
    const end = Number.isInteger(p2) ? kept[Math.min(n, p2) - 1].end : at(p2);
    return { text: tok, t, end: Math.max(end, t + 0.05) };
  });
}

/**
 * Caption events for transcript lines whose words play in one stretch of footage that moves forward (a "run"):
 * inKept says whether a footage moment plays, toOutput maps it to the edit.
 */
function lineEvents(lines: Transcript, captionText: Record<string, string>, cut: Set<string>, visible: Set<string> | null, inKept: (t: number) => boolean, toOutput: (s: number) => number, total: number, rules: CaptionRules, look: CaptionLook): CaptionEvent[] {
  const events: CaptionEvent[] = [];
  for (const line of lines) {
    if (visible && !visible.has(line.id)) continue;
    const text = captionText[line.id] ?? line.words.map((w) => w.text).join(" ");
    const toks = captionTokens(line.words, text, cut, inKept);
    if (!toks.length) continue;
    // A rewritten line with many more words than time shows them in bigger groups (each group on screen for at
    // least 0.3 s) instead of flashing some and dropping others.
    const perWord = Math.max(0.001, toOutput(toks[toks.length - 1].end) - toOutput(toks[0].t)) / toks.length;
    const step = Math.max(rules.wordsAtOnce, Math.ceil(0.3 / perWord));
    for (let i = 0; i < toks.length; i += step) {
      const chunk = toks.slice(i, i + step);
      const next = toks[i + step];
      const start = toOutput(chunk[0].t);
      let end = next ? toOutput(next.t) : toOutput(chunk[chunk.length - 1].end) + 0.25;
      end = Math.min(end, total);
      if (end - start < 0.08) continue;
      // Bold and outline looks drop trailing commas and full stops, like most social captions.
      const tidy = (w: string) => (look === "clean" ? w : w.replace(/[,.;:]+$/, ""));
      const words = chunk.map((x) => tidy(x.text)).join(" ");
      events.push({ start: r3(start), end: r3(end), text: rules.upper ? words.toUpperCase() : words });
    }
  }
  return events;
}

/** Dialogue split into runs: one video, footage moving forward. Sound silent at its speed (reversed, frozen, too slow or
 *  fast) is in no run: nothing is heard there, so nothing is captioned. */
function soundRuns(view: SequenceView): SoundPart[][] {
  const runs: SoundPart[][] = [];
  let gap = true;
  for (const s of view.sound) {
    if (s.silent) { gap = true; continue; }
    const run = runs[runs.length - 1], prev = run?.[run.length - 1];
    if (!gap && prev && prev.videoId === s.videoId && s.srcIn >= prev.srcOut - 1e-6) run.push(s);
    else runs.push([s]);
    gap = false;
  }
  return runs;
}

/** No overlaps: a caption ends when the next one starts. */
function tidyEvents(events: CaptionEvent[]): CaptionEvent[] {
  events.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < events.length; i++) if (events[i].end > events[i + 1].start) events[i].end = events[i + 1].start;
  return events.filter((e) => e.end - e.start >= 0.05);
}

/**
 * Captions of a sequence: they follow the dialogue. The dialogue is split into runs (one video, footage moving
 * forward); each run captions the lines spoken in it, so a line that plays twice is captioned twice. Main footage
 * lines use the edit's caption text and caption clips; other videos show their own words.
 */
/** The words each caption group shows, timed in edit seconds: one group per transcript line where it plays (as
 *  sequenceCaptions decides what plays). Phase 4 lays them out with a caption style (layoutCaptions). */
export function sequenceCaptionGroups(input: PlanInput, view: SequenceView): { text: string; start: number; end: number }[][] {
  const tl = input.snapshot.timeline;
  if (!tl.captionsOn) return [];
  const main = view.mainVideoId;
  const cut = new Set(tl.cut);
  const capClips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "caption" || (!c.kind && c.lineId));
  const visible = capClips.length ? new Set(capClips.map((c) => c.lineId).filter(Boolean) as string[]) : null;
  const runs = soundRuns(view);
  const groups: { text: string; start: number; end: number }[][] = [];
  for (const run of runs) {
    const vid = run[0].videoId;
    const lines = vid === main ? input.transcript : input.transcripts?.[vid];
    if (!lines?.length) continue;
    const inKept = (t: number) => run.some((s) => t >= s.srcIn && t < s.srcOut);
    const toOutput = (src: number) => {
      for (const s of run) { if (src < s.srcIn) return r3(s.start); if (src <= s.srcOut) return r3(editOf(s, src)); }
      return r3(run[run.length - 1].end);
    };
    for (const line of lines) {
      if (vid === main && visible && !visible.has(line.id)) continue;
      const text = (vid === main ? tl.captionText[line.id] : undefined) ?? line.words.map((w) => w.text).join(" ");
      const toks = captionTokens(line.words, text, vid === main ? cut : new Set(), inKept);
      if (toks.length) groups.push(toks.map((x) => ({ text: x.text, start: toOutput(x.t), end: toOutput(x.end) })));
    }
  }
  return groups.sort((a, b) => a[0].start - b[0].start);
}

export function sequenceCaptions(input: PlanInput, view: SequenceView, total: number, rules: CaptionRules): CaptionEvent[] {
  const tl = input.snapshot.timeline;
  if (!tl.captionsOn) return [];
  const main = view.mainVideoId;
  const cut = new Set(tl.cut);
  const capClips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "caption" || (!c.kind && c.lineId));
  const visible = capClips.length ? new Set(capClips.map((c) => c.lineId).filter(Boolean) as string[]) : null;
  const runs = soundRuns(view);
  const events: CaptionEvent[] = [];
  for (const run of runs) {
    const vid = run[0].videoId;
    const lines = vid === main ? input.transcript : input.transcripts?.[vid];
    if (!lines?.length) continue;
    const inKept = (t: number) => run.some((s) => t >= s.srcIn && t < s.srcOut);
    const toOutput = (src: number) => {
      for (const s of run) { if (src < s.srcIn) return r3(s.start); if (src <= s.srcOut) return r3(editOf(s, src)); }
      return r3(run[run.length - 1].end);
    };
    events.push(...lineEvents(lines, vid === main ? tl.captionText : {}, vid === main ? cut : new Set(), vid === main ? visible : null, inKept, toOutput, total, rules, tl.captionLook));
  }
  return tidyEvents(events);
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};
// libass's own escapes, so the text shows as typed with any font: "\{" "\}" for braces, and a word joiner after a
// backslash so it can never start an override code. Very long words (links) are broken up so they wrap.
const assEscape = (s: string) => s
  .split(/\s+/).map((w) => (w.length > 22 ? w.match(/.{1,18}/g)!.join(" ") : w)).join(" ")
  .replace(/\\/g, "\\\u2060").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, "\\N");

/** ASS subtitles with the UI's three caption looks: clean (dark box), bold (white pill, black caps), outline. */
export function buildAss(events: CaptionEvent[], look: CaptionLook, width: number, height: number): string {
  // Sized by shape: vertical video gets bigger captions relative to its width, like the UI's previews.
  const portrait = height > width * 1.2, square = !portrait && height > width * 0.8;
  const factor = { bold: portrait ? 0.085 : square ? 0.075 : 0.062, outline: portrait ? 0.074 : square ? 0.066 : 0.056, clean: portrait ? 0.058 : square ? 0.054 : 0.046 }[look];
  const size = Math.round(Math.min(width, height) * factor);
  const marginV = Math.round(height * 0.13);
  const marginLR = Math.round(width * 0.08);
  // ASS colours are &HAABBGGRR, alpha 00 = solid.
  const styles: Record<CaptionLook, string> = {
    clean: `Style: Cap,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H73000000,&H00000000,0,0,0,0,100,100,0,0,3,${Math.round(size * 0.28)},0,2,${marginLR},${marginLR},${marginV},1`,
    bold: `Style: Cap,Inter,${size},&H000C0A0A,&H000C0A0A,&H00FFFDFC,&H00000000,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.3)},0,2,${marginLR},${marginLR},${marginV},1`,
    outline: `Style: Cap,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},0,2,${marginLR},${marginLR},${marginV},1`,
  };
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styles[look], "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Cap,,0,0,0,,${assEscape(e.text)}`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// planRender
// ---------------------------------------------------------------------------------------------
/** Phase 4: a layer's blend mode and opacity for the plan (nothing when it is plain). */
const layerBlend = (c: { blend?: BlendMode; opacity?: number }) => ({ ...(c.blend && c.blend !== "normal" ? { blend: c.blend } : {}), ...(c.opacity != null && c.opacity < 1 ? { opacity: c.opacity } : {}) });

/** Phase 12: what the final is made as. */
function deliverableLine(ex: NonNullable<Snapshot["timeline"]["export"]>, W: number, H: number, hdr: boolean, seconds = 0): string {
  const f = ex.format ?? "mp4";
  const gs = gifSpec(seconds, W, H);
  const what = f === "gif" ? `GIF ${gs.width} px wide, ${gs.fps} fps (from the ${W}x${H} render${seconds > 60.5 ? `; over a minute: fewer frames and smaller, so the file stays a size people can open` : ""})` : f === "audio" ? "sound only, AAC 256 kbit/s (.m4a)" : f === "wav" ? "sound only, WAV 48 kHz 16-bit" : f === "overlay" ? "the graphics, text and captions on transparency (ProRes 4444 .mov with alpha; footage, b-roll and zooms left out)" : "MP4";
  return `Deliverable: ${what}${ex.bitrate && (f === "mp4" || f === "overlay") ? hdr ? "; bitrate left to quality (HDR)" : `, ${ex.bitrate} Mbit/s` : ""}${ex.fps ? `, ${ex.fps} fps` : ""}`;
}

/** Phase 11: a keyed clip's anchor and motion blur, as the render and the player take them. */
const moveExtras = (c: { keys?: unknown[]; anchor?: { x: number; y: number }; motionBlur?: number }) => (c.keys?.length ? { ...(c.anchor && (c.anchor.x !== 0.5 || c.anchor.y !== 0.5) ? { anchor: c.anchor } : {}), ...(c.motionBlur ? { motionBlur: c.motionBlur } : {}) } : {});
/** Phase 11: a mirror as FFmpeg filters (with a trailing comma, or nothing). */
export const flipFilter = (f?: "h" | "v" | "both") => (f === "h" ? "hflip," : f === "v" ? "vflip," : f === "both" ? "hflip,vflip," : "");

/** Phase 11: mirrored clips, slow motion's in-between frames, anchors and motion blur, b-roll cards. */
function extrasLines(parts: PicturePart[], clipMotion: Record<string, { anchor?: unknown; motionBlur?: number }>, broll: OverlayOp[], graphics: OverlayOp[], v2: (V2Clip & { cardLook?: CardLook })[], texts: TextLayer[] = []): string[] {
  const out: string[] = [];
  const ids = (xs: string[]) => Array.from(new Set(xs)).slice(0, 6).join(", ");
  const flipped = [...parts.filter((p) => p.flip).flatMap((p) => p.clipIds), ...broll.filter((b) => b.flip).map((b) => b.clipId)];
  if (flipped.length) out.push(`Mirrored: ${ids(flipped)}`);
  const smooth = parts.filter((p) => p.interp);
  if (smooth.length) out.push(`Slow motion: ${smooth.map((p) => `${p.clipIds[0]} ${p.interp === "flow" ? "optical flow" : "frame blending"} at ${Math.round(rateOf(p) * 100)}%`).slice(0, 4).join(", ")} (the in-between frames are made in the render; the player holds frames)`);
  const moved = [...Object.entries(clipMotion).map(([id, m]) => ({ id, ...m })), ...[...broll, ...graphics, ...texts].map((x) => ({ id: x.clipId, anchor: x.anchor, motionBlur: x.motionBlur }))];
  const blur = moved.filter((m) => m.motionBlur), anch = moved.filter((m) => m.anchor);
  if (blur.length) out.push(`Motion blur: ${blur.slice(0, 6).map((m) => `${m.id} ${m.motionBlur}`).join(", ")} (in the render)`);
  if (anch.length) out.push(`Anchor points: ${ids(anch.map((m) => m.id))}`);
  const cards = broll.filter((b) => hasCard(v2.find((c) => c.id === b.clipId)?.cardLook));
  if (cards.length) out.push(`B-roll cards: ${cards.slice(0, 4).map((b) => `${b.clipId} ${cardLookText(v2.find((c) => c.id === b.clipId)!.cardLook!)}`).join("; ")}`);
  return out;
}

/** Phase 10: how much of the edit each camera shows, and whose sound plays. */
function multicamLine(m: NonNullable<Snapshot["timeline"]["multicam"]>, view: SequenceView, main: string, total: number): string {
  const on = new Map<string, number>();
  for (const p of view.picture) on.set(p.videoId, (on.get(p.videoId) ?? 0) + (p.end - p.start));
  const share = (id: string) => `${Math.round(((on.get(id) ?? 0) / Math.max(total, 1e-6)) * 100)}%`;
  return `Multicam: main camera ${share(main)}, ${m.angles.map((a) => `${a.name ?? a.videoId} ${share(a.videoId)} (offset ${a.offset >= 0 ? "+" : ""}${a.offset.toFixed(3)}s)`).join(", ")}; sound: ${m.audio === "follow" ? "each angle's own" : "the main video's"}`;
}

export function planRender(input: PlanInput): RenderPlan {
  // A timeline stored in model A (an old version, or a project the migration left on A) renders exactly as before.
  if (!isSequence(input.snapshot.timeline)) return planRenderA(input);
  const { snapshot, transcript, kind } = input;
  const tl = snapshot.timeline;
  const words = allWords(transcript);
  const main = mainVideoOf(tl);
  const infoOf = (vid: string) => (vid === main ? input.source : input.sources?.[vid]);
  const used = Array.from(new Set([main, ...sourceVideoIds(tl)]));
  const missing = used.filter((v) => !infoOf(v));
  const angleIds = new Set((tl.multicam?.angles ?? []).map((a) => a.videoId));
  if (missing.some((v) => angleIds.has(v))) throw new RenderPlanError(`A multicam angle is no longer in your library or not ready (${missing.filter((v) => angleIds.has(v)).join(", ")}). Remove it (multicam remove), then render again.`);
  if (missing.length) throw new RenderPlanError(`A clip on V1 plays a video that is no longer in your library (${missing.join(", ")}). Remove that clip, then render again.`);
  // Every part starts and ends on a frame of the output (30 fps; a final at its footage's rate, Phase 7), so each part
  // is a whole number of frames and picture and sound stay together however many cuts there are. Footage beyond a
  // file's real length is left out.
  // Phase 12: a final at the frame rate the export asks for (else its footage's).
  const out = kind === "final" && tl.export?.fps ? { fps: tl.export.fps, rate: String(tl.export.fps), capped: false } : outputRate(kind, input.source.fps);
  const onFrame = (t: number) => Math.round(t * out.fps) / out.fps;
  const view = sequenceView(tl, words, { align: out.fps, seconds: Object.fromEntries(used.map((v) => [v, infoOf(v)!.seconds])), cutsOnFrames: input.cutsOnFrames });
  if (!view.picture.length) throw new RenderPlanError("Nothing is left to render. Every part of the video is cut. Restore some words or clips, then try again.");
  const total = r3(view.total);
  const { width, height } = outputSize(snapshot.aspect, kind, tl.export?.resolution);
  // A clip on another track hangs on its V1 clip and keeps its length.
  const placed = (c: Attached): { start: number; end: number } | null => {
    let s: number, e: number;
    if (c.fill) { s = 0; e = total; }
    else if (c.anchorId && view.clip(c.anchorId)) { s = view.editAt(c.anchorId, Number(c.anchorAt ?? 0))!; e = s + Number(c.length ?? c.end - c.start); }
    else return null;
    s = r3(Math.max(0, s)); e = r3(Math.min(total, e));
    return e - s >= 0.05 ? { start: s, end: e } : null;
  };

  // Phase 5: V1 keyframes (stored at footage seconds; a freeze: sourceIn + seconds into it) in seconds from the clip's
  // start in the edit, and the transitions on the cuts.
  const v1 = tl.tracks.v1 as SeqClip[];
  const clipById = new Map(v1.map((c) => [c.id, c]));
  const clipMotion: Record<string, { start: number; end: number; keys: Key[]; anchor?: { x: number; y: number }; motionBlur?: number }> = {};
  for (const c of v1) {
    const p = view.clip(c.id);
    if (!c.keys?.length || !p || !p.pieces.length) continue;
    const at = (k: Key) => (c.freeze ? Math.min(p.end - p.start, Math.max(0, k.t - c.sourceIn)) : (view.editAt(c.id, k.t) ?? p.start) - p.start);
    clipMotion[c.id] = { start: r3(p.start), end: r3(p.end), keys: c.keys.map((k) => ({ ...k, t: r3(at(k)) })).sort((a, b) => a.t - b.t), ...moveExtras(c) };
  }
  const transitions = planTransitions(view, clipById, (vid) => infoOf(vid)?.seconds, out.fps);

  const zooms: ZoomOp[] = [];
  for (const t of transitions) if (t.type === "zoom" && t.end > t.start) zooms.push({ start: t.start, end: t.end, scale: ZOOM_PEAK, mode: "through" });
  const broll: OverlayOp[] = [], under: OverlayOp[] = [];
  for (const c of tl.tracks.v2 as (V2Clip & Attached)[]) {
    const sp = placed(c);
    if (!sp) continue;
    const x = c as V2Clip & { mode?: string };
    if (c.kind === "zoom" || (c.zoom && !c.videoId)) {
      zooms.push({ ...sp, scale: Math.min(2, Math.max(1, c.zoom ?? 1.15)), mode: x.mode === "push" || sp.end - sp.start > 4 ? "push" : "punch" });
    } else if (c.videoId && input.brollSeconds?.[c.videoId] != null) {
      const len = input.brollSeconds[c.videoId];
      const ss = Math.min(c.sourceStart ?? 0, Math.max(0, len - 0.1));
      const end = Math.min(sp.end, sp.start + (len - ss));
      // On whole frames, so the render and the player show it on exactly the same frames.
      const fs = onFrame(sp.start), fe = onFrame(end);
      const sh = c.cardLook?.shadow;
      if (fe - fs >= 0.05) ((c as { under?: boolean }).under ? under : broll).push({ clipId: c.id, start: fs, end: fe, sourceStart: ss, videoId: c.videoId, ...(c.keys?.length ? { keys: c.keys } : {}), ...(!c.under ? layerBlend(c) : {}), ...(c.flip ? { flip: c.flip } : {}), ...moveExtras(c),
        ...(sh ? { shadow: { color: sh.color ?? SHADOW_DEFAULTS.color, opacity: sh.opacity ?? SHADOW_DEFAULTS.opacity, blur: sh.blur ?? SHADOW_DEFAULTS.blur, x: sh.x ?? SHADOW_DEFAULTS.x, y: sh.y ?? SHADOW_DEFAULTS.y } } : {}) });
    }
  }
  const graphics: OverlayOp[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached)[]) {
    if (c.kind !== "graphic" || !c.graphicId || (input.graphicsReady && !input.graphicsReady[c.id])) continue;
    const sp = placed(c);
    // A custom graphic can start part way into its recording (add_graphic from); a template is drawn for each clip.
    const from = !findTemplate(c.graphicId) && c.sourceStart ? c.sourceStart : 0;
    if (sp && onFrame(sp.end) - onFrame(sp.start) >= 0.05) graphics.push({ clipId: c.id, start: onFrame(sp.start), end: onFrame(sp.end), sourceStart: from, graphicId: c.graphicId, ...(c.keys?.length ? { keys: c.keys } : {}), ...(c.behind ? { behind: true } : {}), ...layerBlend(c), ...moveExtras(c) });
  }
  const audio: AudioOp[] = [];
  // Keys come from the catalog only (see catalogMusic), whatever the stored clip says; the user's own files from the
  // sounds the server found for this user (input.sounds).
  // Phase 6: a clip's own pan, EQ, reverb (each room size one impulse response file) and volume keys.
  const irs: Record<string, number> = {};
  const soundFx = (c: Record<string, unknown>, kind: "a" | "v1"): ClipSoundFx => {
    const k = kind === "v1" ? { pan: "audioPan", eq: "audioEq", reverb: "audioReverb", keys: "audioKeys" } : { pan: "pan", eq: "eq", reverb: "reverb", keys: "gainKeys" };
    const pan = c[k.pan] as number | undefined, eq = c[k.eq] as Eq | undefined, rv = c[k.reverb] as Reverb | undefined, keys = c[k.keys] as AudioKey[] | undefined;
    const out: ClipSoundFx = {};
    if (pan) out.pan = pan;
    if (eq && Object.values(eq).some(Boolean)) out.eq = eq;
    if (rv?.amount) { const size = rv.size ?? 40, ir = `ir_${size}.wav`; irs[ir] = size; out.reverb = { amount: rv.amount, size, ir }; }
    if (keys?.length) out.keys = keys;
    return out;
  };
  const soundNotes: string[] = [];
  for (const c of tl.tracks.a2 as (A2Clip & Attached)[]) {
    const own = c.soundId ? input.sounds?.[c.soundId] : undefined;
    if (c.soundId && !own) { soundNotes.push(`Music ${c.id} left out: its audio file is not in Rendrr`); continue; }
    const track = own ? null : catalogMusic(c);
    if (!own && !track) continue;
    const sp = placed(c);
    if (!sp) continue;
    // A music clip without fades of its own fades in and out by itself (as before Phase 3).
    const x = c as A2Clip & { fadeIn?: number; fadeOut?: number }, auto = autoMusicFades(sp.end - sp.start);
    audio.push({ clipId: c.id, ...sp, gainDb: c.gainDb ?? -18, assetKey: own ? own.key : track!.key, kind: "music", fadeIn: r3(x.fadeIn ?? auto.fadeIn), fadeOut: r3(x.fadeOut ?? auto.fadeOut), ...(own ? { soundId: c.soundId } : {}), ...soundFx(c as never, "a") });
  }
  for (const c of tl.tracks.a3 as (A3Clip & Attached)[]) {
    const sfx = catalogSfx(c);
    if (!sfx || !c.anchorId || !view.clip(c.anchorId)) continue;
    const start = r3(view.editAt(c.anchorId, Number(c.anchorAt ?? 0))!);
    if (start >= total) continue;
    const x = c as A3Clip & { fadeIn?: number; fadeOut?: number };
    audio.push({ clipId: c.id, start, end: r3(Math.min(total, start + Math.max(0.1, Number(c.length ?? c.end - c.start)))), gainDb: c.gainDb ?? -6, assetKey: sfx.key, kind: "sfx", fadeIn: x.fadeIn ?? 0, fadeOut: x.fadeOut ?? 0, ...soundFx(c as never, "a") });
  }
  // The edit's whole sound replaced by the user's own file (set_voice): it plays from its start in place of every
  // clip's sound, at its own level (not ducked), to the edit's end at most.
  const vo = tl.voice ?? null, voFile = vo ? input.sounds?.[vo.soundId] : undefined;
  if (vo && !voFile) soundNotes.push("Voice left out: its audio file is not in Rendrr (the clips' own sound plays)");
  if (vo && voFile && vo.start < total) audio.push({ clipId: "voice", start: r3(vo.start), end: r3(Math.min(total, vo.start + voFile.seconds)), gainDb: vo.gainDb ?? 0, assetKey: voFile.key, kind: "voice", fadeIn: 0, fadeOut: 0, soundId: vo.soundId });
  // The sound: settings, where music ducks (speech), and dialogue clips with their own gain or fades.
  const settings = audioSettings(tl);
  const cutSet = new Set(tl.cut);
  const speech = speechRanges(view, (vid) => (vid === main ? words : input.transcripts?.[vid] ? allWords(input.transcripts[vid]) : null), cutSet);
  const dialogue: DialogueSpan[] = [];
  const clipFx: Record<string, Omit<ClipSoundFx, "keys">> = {};
  for (const p of view.clips) {
    const c = (tl.tracks.v1 as unknown as { id: string; audioGain?: number; audioFadeIn?: number; audioFadeOut?: number; audioMuted?: boolean }[]).find((x) => x.id === p.id);
    if (!c || c.audioMuted || !p.pieces.length || p.soundEnd - p.soundStart < 0.01) continue;
    const fx = soundFx(c as never, "v1"), { keys, ...rest } = fx;
    if (Object.keys(rest).length) clipFx[c.id] = rest;
    if (!c.audioGain && !c.audioFadeIn && !c.audioFadeOut && !keys) continue;
    // Volume keys are seconds from the clip's start: in edit seconds here.
    dialogue.push({ start: r3(p.soundStart), end: r3(p.soundEnd), gainDb: c.audioGain ?? 0, fadeIn: c.audioFadeIn ?? 0, fadeOut: c.audioFadeOut ?? 0, ...(keys ? { keys: keys.map((k) => ({ t: r3(p.soundStart + k.t), gainDb: k.gainDb })) } : {}) });
  }
  const audioMix: AudioMix = { ...settings, fadeIn: Math.min(settings.fadeIn, total / 2), fadeOut: Math.min(settings.fadeOut, total / 2), speech, dialogue, ...(Object.keys(clipFx).length ? { clipFx } : {}), ...(Object.keys(irs).length ? { irs } : {}) };
  // Muted clips, and clips silent at their speed: their dialogue is silent.
  const dialogueMutes = mergeRanges(view.sound.filter((x) => x.muted || x.silent).map((x) => ({ start: r3(x.start), end: r3(x.end) })).filter((g) => g.end > g.start));

  const look = tl.captionLook;
  // Captions and text layers (Phase 4): laid out once here, drawn by libass and by the editor from the same layout.
  const captionStyle = captionStyleOf(tl as { captionLook: CaptionLook; captionStyle?: CaptionStyle }, snapshot.aspect, input.captionRules);
  const styledCaptions = layoutCaptions(sequenceCaptionGroups(input, view), captionStyle, width, height, total);
  const captions: CaptionEvent[] = styledCaptions.map((c) => ({ start: c.start, end: c.end, text: c.lines.map((l) => l.map((w) => w.text).join(" ")).join(" ") })); // lines: styledCaptions
  // Phase 12: the edit's words as subtitle cues (SRT, WebVTT), whether or not captions are drawn on the picture.
  // The words' own case (a style's capitals are for the picture).
  const subtitles: CaptionEvent[] = layoutCaptions(sequenceCaptionGroups({ ...input, snapshot: { ...snapshot, timeline: { ...tl, captionsOn: true } } }, view), { ...captionStyle, case: "none" }, width, height, total).map((c) => ({ start: c.start, end: c.end, text: c.lines.map((l) => l.map((w) => w.text).join(" ")).join(" ") }));
  const texts: TextLayer[] = [];
  const insideMissing: string[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached & { text?: string; style?: TextStyle; card?: Card | null; anim?: TextAnim })[]) {
    if (c.kind !== "text" || !c.text?.trim()) continue;
    const sp = placed(c);
    if (!sp) continue;
    const def = textPreset("plain");
    // Phase 2b: a video inside the letters needs its length (a library video the render can read).
    const insideLen = c.inside ? input.brollSeconds?.[c.inside.videoId] : undefined;
    if (c.inside && !insideLen) insideMissing.push(c.id);
    texts.push({ clipId: c.id, start: Math.round(sp.start * 100) / 100, end: Math.round(sp.end * 100) / 100, lines: c.text.split("\n"), style: c.style ?? def.style, card: c.card ?? null, anim: c.anim ?? def.anim, ...(c.keys?.length ? { keys: c.keys } : {}), ...(c.behind ? { behind: true } : {}),
      ...(c.inside && insideLen ? { inside: { videoId: c.inside.videoId, from: c.inside.from ?? 0, seconds: insideLen } } : {}), ...(c.cutout && c.card ? { cutout: true } : {}),
      // Phase 17: the anchor its keys turn and scale about, and motion blur on its keyed movement.
      ...(c.keys?.length && c.anchor ? { anchor: c.anchor } : {}), ...(c.keys?.length && c.motionBlur ? { motionBlur: c.motionBlur } : {}) });
  }
  // Phase 2: text layers behind the person are drawn in a pass of their own, before the person is laid back over them.
  // Phase 2b: layers drawn from a mask are drawn one by one, before the other text layers of their side.
  // Phase 17: keyframed layers with motion blur are drawn on their own too (blurred over their movement).
  const blurs = (t: TextLayer) => !isMatted(t) && !!t.keys?.length && !!t.motionBlur;
  const plain = texts.filter((t) => !isMatted(t) && !blurs(t));
  const textBlurs: TextBlurOp[] = texts.filter(blurs).map((t) => ({ clipId: t.clipId, start: t.start, end: t.end, behind: !!t.behind, blur: t.motionBlur!,
    ass: buildStyledAss({ captions: [], captionStyle: null, texts: [{ ...t, start: 0, end: Math.round((t.end - t.start) * 100) / 100 }], width, height })! }));
  const ass = buildStyledAss({ captions: styledCaptions, captionStyle, texts: plain.filter((t) => !t.behind), width, height });
  const assBehind = plain.some((t) => t.behind) ? buildStyledAss({ captions: [], captionStyle, texts: plain.filter((t) => t.behind), width, height }) : null;
  const textMattes: TextMatteOp[] = texts.filter(isMatted).map((t) => ({ clipId: t.clipId, start: t.start, end: t.end, behind: !!t.behind, ...textMatteAss(t, width, height),
    ...(t.inside ? { inside: t.inside } : { cut: t.card!.color }) }));

  const parts = view.picture.map((p) => ({ ...p, start: r3(p.start), end: r3(p.end) }));
  // Phase 7: stabilized V1 clips at normal speed, part by part. Phase 21: a clip with any part at another speed (a
  // ramp, reversed, a freeze) and stabilized b-roll read a stabilized copy of their footage instead, smoothed as one.
  const stabilize: Record<string, StabilizeOp> = {}, unstabilized = new Set<string>(), stabilized: Record<string, StableCopyOp> = {};
  const smoothingOf = (smooth: number) => Math.max(1, Math.round(smooth * 0.3));
  /** The copy's footage: a second either side of what the clip shows, on the frame grid, inside the video. */
  const copyOf = (clipId: string, videoId: string, lo: number, hi: number, smooth: number, seconds: number | undefined, broll?: boolean) => {
    const a = Math.max(0, Math.floor((lo - 1) * out.fps + 1e-6) / out.fps), b = Math.min(seconds ?? hi + 1, Math.ceil((hi + 1) * out.fps - 1e-6) / out.fps);
    if (b - a < 0.2) { unstabilized.add(clipId); return; }
    const op = { clipId, videoId, srcIn: r3(a), srcOut: r3(b), smoothing: smoothingOf(smooth) };
    const h = hashOf(op);
    stabilized[clipId] = { ...op, file: `stab_${h}.trf`, copy: `stable_${h}.mkv`, ...(broll ? { broll: true } : {}) };
  };
  const byClip = new Map<string, PicturePart[]>();
  for (const p of parts) {
    const st = (clipById.get(p.clipIds[0]) as { stabilize?: { smooth: number } } | undefined)?.stabilize;
    if (!st || p.clipIds.length !== 1) continue;
    byClip.set(p.clipIds[0], [...(byClip.get(p.clipIds[0]) ?? []), p]);
  }
  for (const [clipId, ps] of byClip) {
    const smooth = (clipById.get(clipId) as unknown as { stabilize: { smooth: number } }).stabilize.smooth;
    if (ps.every((p) => (p.rate ?? 1) === 1)) {
      for (const p of ps) {
        if (p.srcOut - p.srcIn < 0.2) { unstabilized.add(clipId); continue; }
        const op = { videoId: p.videoId, srcIn: r3(p.srcIn), srcOut: r3(p.srcOut), smoothing: smoothingOf(smooth) };
        stabilize[stabilizeKey(p)] = { ...op, file: `stab_${hashOf(op)}.trf` };
      }
    } else copyOf(clipId, ps[0].videoId, Math.min(...ps.map((p) => p.srcIn)), Math.max(...ps.map((p) => (rateOf(p) === 0 ? p.srcIn + 1 / out.fps : p.srcOut))), smooth, infoOf(ps[0].videoId)?.seconds);
  }
  for (const o of [...broll, ...under]) {
    const c = (tl.tracks.v2 as (V2Clip & { stabilize?: { smooth: number } })[]).find((x) => x.id === o.clipId);
    if (c?.stabilize && o.videoId) copyOf(o.clipId, o.videoId, o.sourceStart, o.sourceStart + (o.end - o.start), c.stabilize.smooth, input.brollSeconds?.[o.videoId], true);
  }

  // Phase 6: HDR stays HDR in a final (unless the edit asks for SDR): the main footage's transfer, else the first HDR
  // video's. Previews are made from the SDR preview copies.
  const hdrSrc = [main, ...parts.map((p) => p.videoId)].map((v) => infoOf(v)).find((x) => x?.hdr);
  const hdrVideos = new Set(parts.map((p) => p.videoId).filter((v) => infoOf(v)?.hdr || input.hdrFootage?.[v]));
  const hdrT: HdrTransfer | null = kind === "final" && (tl.export?.hdr ?? "keep") === "keep" && hdrSrc ? hdrSrc.transfer ?? "pq" : null;
  const lookFiles: Record<string, LookFile> = {};
  const file = (spec: LookFile) => { const name = `${spec.kind}_${hashOf(spec)}.${spec.kind === "mask" || spec.kind === "area" || spec.kind === "shadow" || spec.kind === "border" ? "pgm" : spec.kind === "gradient" || spec.kind === "pattern" ? "ppm" : spec.kind === "moving" ? "mkv" : "cube"}`; lookFiles[name] = spec; return name; };
  const hdr = hdrT ? { transfer: hdrT, lut: file({ kind: "hdr", hdr: hdrT }) } : null;
  // Phase 7: a final's codec (HDR kept is always HEVC 10-bit); previews are H.264.
  const codec: Codec = kind === "final" && (hdr || tl.export?.codec === "hevc") ? "hevc" : "h264";
  const looks: Record<string, LookOp> = {};
  const mattes: Record<string, MatteOp> = {};
  const stillMoving = new Set<string>();
  const missingLuts = new Set<string>();
  // The person's matte: the blocks of footage the clip plays, with 2 s each side for transitions.
  const matteFor = (c: { sourceVideoId: string; sourceIn: number; sourceOut: number }) => {
    const blocks = matteBlocks(c.sourceIn, c.sourceOut, infoOf(c.sourceVideoId)?.seconds);
    const name = `matte_${c.sourceVideoId}_${blocks[0]}_${blocks[blocks.length - 1]}`;
    mattes[name] = { videoId: c.sourceVideoId, blocks };
    return name;
  };
  const lookFor = (c: ClipLook & { id: string; cardLook?: CardLook; sourceVideoId?: string; sourceIn?: number; sourceOut?: number; reverse?: boolean }, range?: { from: number; to: number }) => {
    const grade = c.grade && gradeIsActive(c.grade) ? { ...c.grade } : undefined;
    if (grade?.lut && !input.luts?.[grade.lut.id]) { missingLuts.add(grade.lut.id); delete grade.lut; }
    const g = grade && gradeIsActive(grade) ? grade : undefined;
    // Phase 3: moving masks and areas follow the clip's footage time; a reversed clip keeps them where they are at its
    // first footage second (said in the plan).
    const span = range ?? (c.sourceIn != null && c.sourceOut != null ? { from: c.sourceIn, to: c.sourceOut } : null);
    const still = !span || !!c.reverse;
    if (still && [...(c.masks ?? []), ...(c.effects ?? []).map((e) => e.area), c.skin?.area].some((a) => moving(a))) stillMoving.add(c.id);
    const fix = <A extends Area>(a: A): A => (still && moving(a) ? areaAt(a, span?.from ?? firstKeyAt(a)) : a);
    const picOf = (spec: { masks: Mask[] } | { area: Area }): string => {
      const mv = "masks" in spec ? spec.masks.some((m) => moving(m)) : moving(spec.area);
      return mv && span && !still ? file({ kind: "moving", ...spec, from: r3(span.from), to: r3(span.to) }) : file("masks" in spec ? { kind: "mask", masks: spec.masks.map(fix) } : { kind: "area", area: fix(spec.area) });
    };
    // A card's crop and corners are one more mask (drawn as masks are, in the render and the player).
    const masks = masksWithCard(c.masks, c.cardLook);
    const skin = skinActive(c.skin) ? c.skin! : undefined;
    // Phase 18: b-roll too: its own video's matte over the stretch it plays (range).
    const mv = c.sourceVideoId ?? (c as { videoId?: string }).videoId;
    const mspan = c.sourceVideoId && c.sourceIn != null && c.sourceOut != null ? { sourceIn: c.sourceIn, sourceOut: c.sourceOut } : range ? { sourceIn: range.from, sourceOut: range.to } : null;
    const subject = c.subject && mv && mspan ? { ...c.subject, matte: matteFor({ sourceVideoId: mv, ...mspan }) } : undefined;
    if (!g && !c.key && !masks?.length && !c.effects?.length && !skin && !subject) return;
    looks[c.id] = {
      ...(g ? { grade: g, lut: file({ kind: "lut", grade: g }), ...(hdr ? { lutHdr: file({ kind: "lut", grade: g, hdr: hdr.transfer }) } : {}) } : {}),
      ...(c.key ? { key: c.key } : {}),
      ...(masks?.length ? { masks, mask: picOf({ masks }) } : {}),
      // Phase 5: a vignette without its own area darkens outside the default soft ellipse.
      ...(c.effects?.length ? { effects: c.effects.map((e0) => { const e = !e0.area && e0.type === "vignette" ? { ...e0, area: VIGNETTE_AREA } : e0; return { ...e, px: effectPx(e, width, height), ...(e.area ? { file: picOf({ area: e.area }) } : {}) }; }) } : {}),
      ...(skin ? { skin: { skin, p: skinParams(skin, width, height), ...(skin.area ? { file: picOf({ area: skin.area }) } : {}) } } : {}),
      ...(subject ? { subject } : {}),
      alpha: !!c.key || !!masks?.length || !!subject || !!c.effects?.some((e) => e.type === "pin"),
    };
  };
  for (const c of v1) lookFor(c);
  // Phase 2: behind the person. The person is laid back over what is behind them where they are on screen as the
  // footage shows them: not over b-roll or a transition, and not for a part framed smaller, moved or reversed (its matte
  // would not line up; it says so).
  const behindAt = mergeRanges([...graphics.filter((x) => x.behind), ...texts.filter((x) => x.behind)].map((x) => ({ start: r3(x.start), end: r3(x.end) })));
  let person: PersonOp | undefined;
  if (behindAt.length) {
    const blocked = mergeRanges([...broll, ...(transitions as { start: number; end: number }[])].map((x) => ({ start: r3(x.start), end: r3(x.end) })));
    const pparts: Record<number, string> = {}, left: PersonOp["left"] = [];
    parts.forEach((p, i) => {
      if (!behindAt.some((w) => w.start < p.end - 1e-6 && w.end > p.start + 1e-6)) return;
      const id = p.clipIds[0], c = clipById.get(id) as (SeqClip & { cardLook?: CardLook }) | undefined;
      const moved = !!p.framing && (p.framing.scale !== 1 || !!p.framing.x || !!p.framing.y);
      const why = moved ? "framed smaller or moved" : clipMotion[id] ? "keyframed" : hasCard(c?.cardLook) ? "drawn as a card" : "";
      if (why) { if (!left.some((x) => x.clipId === id)) left.push({ clipId: id, why }); return; }
      pparts[i] = matteFor({ sourceVideoId: p.videoId, sourceIn: p.srcIn, sourceOut: p.srcOut });
    });
    const windows = subtractRanges(behindAt, blocked).filter((w) => w.end - w.start >= 0.5 / out.fps);
    person = { windows, parts: pparts, left };
  }
  // Cards: the shadow and border pictures at the output size, where the framing puts the clip.
  const cards: Record<string, CardOp> = {};
  for (const c of v1 as (SeqClip & { cardLook?: CardLook })[]) {
    const cl = c.cardLook;
    if (!hasCard(cl) || (!cl.shadow && !cl.border)) continue;
    const fr = c.framing && (c.framing.scale !== 1 || c.framing.x || c.framing.y) ? c.framing : null;
    cards[c.id] = {
      ...(cl.shadow ? { shadow: { file: file({ kind: "shadow", card: cl, framing: fr }), color: cl.shadow.color ?? SHADOW_DEFAULTS.color } } : {}),
      ...(cl.border ? { border: { file: file({ kind: "border", card: cl, framing: fr }), color: cl.border.color } } : {}),
    };
  }
  // What is behind V1: a colour is a gradient from it to itself; a library video needs its length.
  const bgIn = tl.background;
  const background: BackgroundOp | null = !bgIn ? null
    : bgIn.color || bgIn.gradient ? { file: file({ kind: "gradient", gradient: bgIn.gradient ?? { from: bgIn.color!, to: bgIn.color! } }), text: backgroundText(bgIn) }
    : bgIn.pattern ? { file: file({ kind: "pattern", pattern: bgIn.pattern }), text: backgroundText(bgIn) }
    : bgIn.videoId ? (input.brollSeconds?.[bgIn.videoId] ? { videoId: bgIn.videoId, seconds: input.brollSeconds[bgIn.videoId], text: backgroundText(bgIn) } : null)
    : (() => { const sg = backgroundSigma(bgIn.blur!, width, height); return { blur: sg, scale: backgroundScale(sg, width, height), text: backgroundText(bgIn) }; })();
  for (const b of [...broll, ...under]) {
    const c = (tl.tracks.v2 as (V2Clip & ClipLook & { cardLook?: CardLook })[]).find((x) => x.id === b.clipId)!;
    lookFor(c, { from: b.sourceStart, to: b.sourceStart + (b.end - b.start) });
    // Phase 17: a b-roll card's border, a ring just inside its edge on its own frame (drawn before its keys move it).
    if (c.cardLook?.border) b.border = { file: file({ kind: "border", card: c.cardLook, framing: null }), color: c.cardLook.border.color };
  }
  // Phase 9: adjustment layers on V3, placed as graphics are; their grade and effects as a look of their own.
  const adjust: AdjustOp[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached)[]) {
    if (c.kind !== "adjust" || (!c.grade && !c.effects?.length)) continue;
    const sp = placed(c);
    if (!sp || onFrame(sp.end) - onFrame(sp.start) < 0.05) continue;
    // Phase 16: its masks (and its effects' areas) move with keys at seconds from the layer's start.
    const start = onFrame(sp.start), end = onFrame(sp.end);
    lookFor({ id: c.id, grade: c.grade, effects: c.effects, masks: c.masks }, { from: 0, to: r3(end - start) });
    adjust.push({ clipId: c.id, start, end, ...(c.grade ? { grade: c.grade } : {}), ...(c.effects?.length ? { effects: c.effects } : {}), ...(c.masks?.length ? { masks: c.masks } : {}), ...(c.opacity != null && c.opacity < 1 ? { opacity: c.opacity } : {}), ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}) });
  }
  // Phase 12: chapters from chapter marks, where their footage plays in the edit.
  const chapters: Chapter[] = [];
  for (const m of tl.marks ?? []) {
    if (m.kind !== "chapter") continue;
    const at = view.videoToEdit(m.videoId ?? main, m.start);
    if (at == null || at >= view.total - 0.5 || chapters.some((c) => Math.abs(c.at - at) < 0.5)) continue;
    chapters.push({ at: r3(at), title: (m.label || m.note || "Chapter").slice(0, 100) });
  }
  chapters.sort((a, b) => a.at - b.at);
  if (kind === "final" && tl.export?.format === "gif" && view.total > GIF_MAX_SECONDS + 0.5) throw new RenderPlanError(`A GIF can be up to ${GIF_MAX_SECONDS / 60} minutes; this edit is ${fmtClock(view.total)}. Export it as MP4, or cut it shorter.`);
  const sound = view.sound.map((x) => ({ ...x, start: r3(x.start), end: r3(x.end) }));
  const sources = Array.from(new Set([main, ...parts.map((p) => p.videoId), ...sound.map((x) => x.videoId)])).filter((v) => parts.some((p) => p.videoId === v) || sound.some((x) => x.videoId === v));
  const videos = Object.fromEntries(sources.map((v) => [v, { hasAudio: infoOf(v)!.hasAudio, hdr: !!infoOf(v)!.hdr, ...(infoOf(v)!.hdr ? { transfer: infoOf(v)!.transfer ?? "pq" } : {}), seconds: infoOf(v)!.seconds }]));
  const cutCount = cutRegions(words, new Set(tl.cut)).length;
  const live = view.clips.filter((c) => c.pieces.length);
  const jl = { j: live.filter((c, i) => i > 0 && c.soundStart < c.start - 1e-6).length, l: live.filter((c, i) => i > 0 && c.soundStart > c.start + 1e-6).length, muted: (tl.tracks.v1 as unknown as { audioMuted?: boolean }[]).filter((c) => c.audioMuted).length };
  const turned = new Set(parts.map((p) => p.rotate)), framings = parts.filter((p) => p.framing);
  const lookText = parts.every((p) => p.rotate === parts[0].rotate && sameFraming(p.framing, parts[0].framing))
    ? `${parts[0].rotate ? `Turn the footage ${parts[0].rotate}° clockwise, then fit` : "Fit"} to ${snapshot.aspect} at ${width}x${height}, ${rateText(out.fps)} fps${parts[0].framing?.focus ? `, reframed on ${parts[0].framing.focus.x}, ${parts[0].framing.focus.y} of the footage` : ""}${parts[0].framing && (parts[0].framing.scale !== 1 || parts[0].framing.x || parts[0].framing.y) ? `; frame it: scale ${parts[0].framing.scale}, offset ${parts[0].framing.x}, ${parts[0].framing.y}` : ""}`
    : `Fit each part to ${snapshot.aspect} at ${width}x${height}, ${rateText(out.fps)} fps (turned ${Array.from(turned).join("/")}°, ${framings.length} framed parts)`;
  const operations = [
    `Play ${parts.length} ${parts.length === 1 ? "part" : "parts"} from ${sources.length} ${sources.length === 1 ? "video" : "videos"} (${live.length} clips, ${cutCount} word cuts): ${total.toFixed(2)}s`,
    lookText,
    zooms.length ? `Zoom: ${zooms.length} (${zooms.filter((z) => z.mode === "punch").length} punch, ${zooms.filter((z) => z.mode === "push").length} slow push)` : "Zoom: none",
    broll.length ? `B-roll overlays: ${broll.length}` : "B-roll overlays: none",
    graphics.length ? `Graphics overlays: ${graphics.length}` : "Graphics overlays: none",
    ...(tl.multicam?.angles.length ? [multicamLine(tl.multicam, view, main, total)] : []),
    ...extrasLines(parts, clipMotion, broll, graphics, (tl.tracks.v2 as (V2Clip & { cardLook?: CardLook })[]), texts),
    ...(chapters.length ? [`Chapters: ${chapters.length} (${chapters.slice(0, 5).map((c) => `${fmtClock(c.at)} ${c.title}`).join(", ")})${chapterProblems(chapters, view.total).length ? `; YouTube shows none until there are: ${chapterProblems(chapters, view.total).join("; ")}` : ""}`] : []),
    ...(kind === "final" && tl.export && (tl.export.format && tl.export.format !== "mp4" || tl.export.bitrate || tl.export.fps) ? [deliverableLine(tl.export, width, height, !!hdr, view.total)] : []),
    captions.length ? `Captions: ${captions.length} word-timed events, ${tl.captionStyle ? "own style" : `look ${look}`}: ${styleText(captionStyle)}` : "Captions: off",
    texts.length ? `Text layers: ${texts.length}` : "Text layers: none",
    ...(textMattes.length || insideMissing.length ? [`Inside the letters: ${[...textMattes.map((m) => `${m.clipId} ${m.inside ? `video ${m.inside.videoId} from ${r3(m.inside.from)}s${m.inside.seconds - m.inside.from < m.end - m.start - 0.05 ? " (looped)" : ""}` : `cut out of its card ${m.cut} (the picture shows through)`}`), ...insideMissing.map((id) => `${id}: its video is not in the library or not ready: plain letters instead`)].join("; ")}`] : []),
    ...(adjust.length ? [`Adjustment layers: ${adjust.slice(0, 4).map((a) => `${fmtClock(a.start)}-${fmtClock(a.end)} ${[a.grade ? `grade ${gradeText(a.grade)}` : "", a.effects?.length ? effectsText(a.effects) : "", adjustText(a)].filter(Boolean).join(", ")}`).join("; ")} (over the picture, b-roll and graphics; text and captions on top as they are)${hdr && adjust.some((a) => a.grade) ? "; this output keeps HDR: their grades are left out there (their effects apply)" : ""}`] : []),
    ...(Object.keys(stabilize).length || Object.keys(stabilized).length || unstabilized.size ? [`Stabilized (Warp Stabilizer, zoomed in to hide the edges): ${[...new Set(Object.keys(stabilize).map((k) => k.split("@")[0])), ...Object.keys(stabilized).map((id) => `${id} (${stabilized[id].broll ? "b-roll" : "at its speeds"}, from a stabilized copy)`)].slice(0, 8).join(", ") || "none"}${unstabilized.size ? `; as filmed, too short to stabilize: ${Array.from(unstabilized).slice(0, 4).join(", ")}` : ""}`] : []),
    ...([...broll, ...graphics].some((x) => x.blend || x.opacity != null) ? [`Blend: ${[...broll, ...graphics].filter((x) => x.blend || x.opacity != null).slice(0, 6).map((x) => `${x.videoId ? "b-roll" : "graphic"} ${x.clipId} ${blendText(x.blend, x.opacity)}`).join(", ")}`] : []),
    ...(person ? [`Behind the person: ${[graphics.filter((x) => x.behind).length ? `${graphics.filter((x) => x.behind).length} graphics` : "", texts.filter((x) => x.behind).length ? `${texts.filter((x) => x.behind).length} text layers` : ""].filter(Boolean).join(", ")} (the person laid back over them from an AI matte${person.windows.length ? `, ${person.windows.map((w) => `${fmtClock(w.start)}-${fmtClock(w.end)}`).slice(0, 6).join(", ")}` : ", nowhere: b-roll or transitions cover them"})${person.left.length ? `; in front instead on ${person.left.slice(0, 4).map((x) => `${x.clipId} (${x.why})`).join(", ")}` : ""}`] : []),
    ...speedLines(v1, view, transitions, clipMotion, broll, graphics, texts),
    ...colorLines(looks, under, missingLuts, hdr, Array.from(new Set(parts.filter((p) => hdrVideos.has(p.videoId)).map((p) => p.clipIds[0]))), kind, hdrVideos.size > 0, tl.export?.hdr === "sdr", background?.text, new Set(broll.map((b) => b.clipId))),
    ...(stillMoving.size ? [`Moving masks: held where they are at the clip's start on ${Array.from(stillMoving).slice(0, 4).join(", ")} (reversed)`] : []),
    ...(Object.keys(cards).length || v1.some((c) => hasCard((c as { cardLook?: CardLook }).cardLook)) ? [`Cards: ${(v1 as (SeqClip & { cardLook?: CardLook })[]).filter((c) => hasCard(c.cardLook)).slice(0, 4).map((c) => `${c.id} ${cardLookText(c.cardLook!)}`).join("; ")}`] : []),
    ...(background ? [`Behind V1: ${background.text}`] : bgIn?.videoId ? ["Behind V1: the background video is not in the library or not ready: black instead"] : []),
    ...(audio.some((a) => a.kind === "voice") ? [`Voice: "${voFile!.name}" plays in place of every clip's own sound, from ${r3(vo!.start)}s (${r3(voFile!.seconds)}s file, edit ${r3(total)}s${Math.abs(vo!.start + voFile!.seconds - total) > 0.05 ? `: ${vo!.start + voFile!.seconds > total ? "the file runs past the edit's end" : "the file ends before the edit"}` : ""}${vo!.editSeconds != null && Math.abs(vo!.editSeconds - total) > 0.05 ? `; the edit was ${r3(vo!.editSeconds)}s when the voice was set: a cut since then is not in the file, so it is out of sync after it` : ""})`] : []),
    ...soundNotes,
    `Audio: dialogue${jl.j || jl.l ? ` (${jl.j} J cuts, ${jl.l} L cuts)` : ""}${jl.muted ? ` (${jl.muted} muted clips)` : ""}${dialogue.length ? ` (${dialogue.length} clips with their own gain or fades)` : ""}${cleanupText(settings) !== "none" ? `, cleanup ${cleanupText(settings)}` : ""}${settings.crossfade ? `, ${Math.round(settings.crossfade * 1000)} ms crossfade at cuts` : settings.declick ? `, ${Math.round(settings.declick * 1000)} ms fade at every cut` : ""}${Object.keys(clipFx).length || audio.some((a) => a.pan || a.eq || a.reverb || a.keys) ? `; clips with their own sound: ${[...Object.entries(clipFx).map(([id, f]) => `${id} ${clipFxText(f)}`), ...audio.filter((a) => a.pan || a.eq || a.reverb || a.keys).map((a) => `${a.clipId} ${clipFxText(a)}`)].slice(0, 4).join("; ")}` : ""}${audio.some((a) => a.kind === "music") ? ` + music${settings.duck ? `, ${settings.duck} dB down under speech` : ""}` : ""}${audio.some((a) => a.kind === "sfx") ? ` + ${audio.filter((a) => a.kind === "sfx").length} sound effects` : ""}${settings.fadeIn || settings.fadeOut ? `; mix fades in ${settings.fadeIn}s, out ${settings.fadeOut}s` : ""}`,
    settings.loudness != null ? `Loudness: measured first, then set to ${settings.loudness} LUFS with a ${settings.peak} dBTP true-peak ceiling` : "Loudness: not normalized (limiter only)",
    kind === "preview" ? `Encode preview: H.264 ultrafast, ${width}x${height}` : hdr ? `Encode final: HEVC 10-bit HDR (${hdr.transfer === "pq" ? "PQ" : "HLG"}, BT.2020), ${width}x${height}, ${rateText(out.fps)} fps` : `Encode final: ${codec === "hevc" ? "HEVC" : "H.264"}, ${width}x${height}, ${rateText(out.fps)} fps`,
    // Phase 7: what the final keeps and what it cannot (the check repeats these).
    ...(kind === "final" ? exportNotes(out, width, height, input.source, tl.export?.fps) : []),
  ];
  return {
    model: "B", kind, width, height, fps: out.fps, rate: out.rate, codec, aspect: snapshot.aspect, kept: parts.map((p) => ({ start: p.srcIn, end: p.srcOut })), parts, sound, sources, videos,
    outputSeconds: total, rotate: parts[0].rotate, framing: parts[0].framing, zooms, broll, graphics, audio, dialogueMutes, captions, captionLook: look, captionStyle, styledCaptions, texts, ass, operations, audioMix,
    transitions, clipMotion,
    looks, lookFiles, under, hdr, ...(hdr && ass ? { ass: hdrAss(ass, hdr.transfer) } : {}),
    ...(assBehind ? { assBehind: hdr ? hdrAss(assBehind, hdr.transfer) : assBehind } : {}), ...(person ? { person } : {}),
    ...(textMattes.length ? { textMattes: hdr ? textMattes.map((m) => (m.decor ? { ...m, decor: hdrAss(m.decor, hdr.transfer) } : m)) : textMattes } : {}),
    ...(textBlurs.length ? { textBlurs } : {}),
    ...(Object.keys(cards).length ? { cards } : {}), ...(background ? { background } : {}), ...(Object.keys(mattes).length ? { mattes } : {}),
    ...(Object.keys(stabilize).length ? { stabilize } : {}), ...(Object.keys(stabilized).length ? { stabilized } : {}), ...(adjust.length ? { adjust } : {}),
    ...(kind === "final" && tl.export?.format && tl.export.format !== "mp4" ? { format: tl.export.format } : {}),
    ...(kind === "final" && tl.export?.bitrate && !hdr ? { bitrate: tl.export.bitrate } : {}),
    ...(chapters.length ? { chapters } : {}), ...(subtitles.length ? { subtitles } : {}),
  };
}

/** Footage facts the export line needs (from the Video row): frame rate, size, HDR. */
export type FootageInfo = { fps?: number | null; width?: number | null; height?: number | null; hdr?: boolean };
/**
 * Phase 7: the final's settings as one line, for get_project and the check: "Export (final): 1080p 1920x1080 16:9,
 * H.264, 29.97 fps (the footage's)", plus a note when it is scaled up or capped.
 */
export function exportText(snap: Snapshot, footage?: FootageInfo): string {
  const ex = snap.timeline.export ?? {};
  const { width, height } = outputSize(snap.aspect, "final", ex.resolution);
  const codec = footage?.hdr && (ex.hdr ?? "keep") === "keep" ? "HEVC 10-bit HDR" : ex.codec === "hevc" ? "HEVC" : "H.264";
  const r = footage?.fps ? outputRate("final", footage.fps) : null;
  const rate = ex.fps ? `${ex.fps} fps (set)` : !r ? "the footage's frame rate" : r.capped ? `60 fps (the footage is ${rateText(footage!.fps!)}; finals go up to 60)` : `${rateText(r.fps)} fps (the footage's)`;
  const fw = footage?.width ?? 0, fh = footage?.height ?? 0;
  const up = fw && fh && Math.min(width, height) > Math.min(fw, fh) * 1.05 ? `, scaled up from the footage's ${fw}x${fh}` : "";
  const res = ex.resolution === "4k" ? "4K" : ex.resolution ?? "1080p";
  const fmt = ex.format === "gif" ? "; as a GIF (up to 10 min: 15 fps to a minute, then fewer frames and smaller)" : ex.format === "audio" ? "; sound only (.m4a)" : ex.format === "wav" ? "; sound only (WAV)" : ex.format === "overlay" ? "; the graphics, text and captions on transparency (ProRes 4444)" : "";
  return `Export (final): ${res} ${width}x${height} ${snap.aspect}, ${codec}${ex.bitrate ? ` ${ex.bitrate} Mbit/s` : ""}, ${rate}${up}${fmt}`;
}

/** Phase 7: a final's frame rate (kept, or capped at 60) and whether its size is above the footage's (scaled up). */
function exportNotes(out: { fps: number; capped: boolean }, width: number, height: number, src: SourceInfo, set?: number): string[] {
  const lines = [set ? `Frame rate: ${set} fps, as the export asks (the footage is ${rateText(src.fps)} fps)` : out.capped ? `Frame rate: 60 fps (the footage is ${rateText(src.fps)} fps; finals go up to 60)` : `Frame rate: ${rateText(out.fps)} fps, the footage's`];
  const srcShort = Math.min(src.width, src.height), outShort = Math.min(width, height);
  if (srcShort > 0 && outShort > srcShort * 1.05) lines.push(`Size: scaled up from the footage's ${src.width}x${src.height} to ${width}x${height}`);
  return lines;
}

/** The render plan's Phase 6 lines: colour, key, masks, blur, under layers, HDR. */
function colorLines(looks: Record<string, LookOp>, under: OverlayOp[], missingLuts: Set<string>, hdr: RenderPlan["hdr"], hdrClips: string[], kind: RenderKind, hdrFootage: boolean, toSdr: boolean, behind?: string, brollIds: Set<string> = new Set()): string[] {
  const all = Object.entries(looks);
  const list = <T,>(xs: [string, T][], f: (x: T) => string) => xs.slice(0, 4).map(([id, x]) => `${id} ${f(x)}`).join("; ") + (xs.length > 4 ? `; +${xs.length - 4} more` : "");
  const graded = all.filter(([, l]) => l.grade).map(([id, l]) => [id, l.grade!] as [string, Grade]);
  const keyed = all.filter(([, l]) => l.key).map(([id, l]) => [id, l.key!] as [string, ChromaKey]);
  const masked = all.filter(([, l]) => l.masks).map(([id, l]) => [id, l.masks!] as [string, Mask[]]);
  const fx = all.filter(([, l]) => l.effects).map(([id, l]) => [id, l.effects!] as [string, Effect[]]);
  // Lines only for what the edit uses.
  const out: string[] = graded.length ? [`Color: ${graded.length} ${graded.length === 1 ? "clip" : "clips"} graded (${list(graded, (g) => gradeText(g))})`] : [];
  if (missingLuts.size) out.push(`Color: LUT ${Array.from(missingLuts).join(", ")} is not in your LUTs any more: left out`);
  if (keyed.length) out.push(`Key: ${list(keyed, chromaKeyText)}`);
  if (masked.length) out.push(`Masks: ${list(masked, masksText)}`);
  if (fx.length) out.push(`Effects: ${list(fx, effectsText)}`);
  const skins = all.filter(([, l]) => l.skin).map(([id, l]) => [id, l.skin!.skin] as [string, Skin]);
  if (skins.length) out.push(`Skin: ${list(skins, (k) => skinText(k).replace(/^skin retouch: /, ""))}`);
  const cutout = all.filter(([id, l]) => l.subject && !brollIds.has(id)).map(([id, l]) => [id, l.subject!] as [string, SubjectOp]);
  const say = (x: SubjectOp) => subjectText(x).replace(/^background removed/, "removed").replace(/^removed$/, "removed");
  if (cutout.length) out.push(`Background: ${list(cutout, say)} (the person cut out by an AI matte); behind: ${under.length ? "b-roll laid under V1" : behind ?? "black (no set_background)"}`);
  // Phase 18: b-roll cut out: the picture under it shows around the person.
  const brollCut = all.filter(([id, l]) => l.subject && brollIds.has(id)).map(([id, l]) => [id, l.subject!] as [string, SubjectOp]);
  if (brollCut.length) out.push(`Background: b-roll ${list(brollCut, say)} (the person in the b-roll cut out by an AI matte; the picture under it shows around them)`);
  if (under.length) out.push(`Under V1: ${under.length} b-roll ${under.length === 1 ? "clip" : "clips"} (${under.slice(0, 4).map((u) => u.clipId).join(", ")})`);
  const sdrGraded = hdrClips.filter((id) => looks[id]?.grade || looks[id]?.key || looks[id]?.skin);
  const gradedNote = sdrGraded.length ? `; ${sdrGraded.slice(0, 6).join(", ")} graded, keyed or retouched in SDR (as the editor shows them): no highlights above SDR white there` : "";
  if (hdr) out.push(`HDR: kept (${hdr.transfer === "pq" ? "PQ" : "HLG"}, BT.2020, 10-bit); SDR clips, b-roll, graphics and captions at SDR white (203 nits)${gradedNote}`);
  else if (hdrFootage) out.push(kind === "preview" ? `HDR: footage is HDR; this preview and the editor show it tone-mapped to SDR; ${toSdr ? "the final converts it to SDR (as the edit asks)" : `the final keeps HDR${gradedNote}`}` : "HDR: converted to SDR (tone-mapped), as the edit asks");
  return out;
}

/** ASS colours (&HAABBGGRR, &HBBGGRR) as the same light in an HDR picture (SDR white at 203 nits). */
export function hdrAss(ass: string, t: HdrTransfer): string {
  const map = (bgr: string) => {
    const b = parseInt(bgr.slice(0, 2), 16) / 255, g = parseInt(bgr.slice(2, 4), 16) / 255, r = parseInt(bgr.slice(4, 6), 16) / 255;
    const h = sdrToHdr(r, g, b, t).map((v) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase());
    return h[2] + h[1] + h[0];
  };
  return ass.replace(/&H([0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})(&?)/g, (_m, a: string | undefined, bgr: string, amp: string) => `&H${a ?? ""}${map(bgr)}${amp}`);
}

/** The bytes of a look file at the plan's size: a .cube LUT or a .pgm picture. */
export function lookFileData(spec: LookFile, plan: { width: number; height: number }, luts: Record<string, Lut> = {}): string | Uint8Array {
  const W = plan.width, H = plan.height;
  if (spec.kind === "mask") return pgm(maskPicture(spec.masks, W, H), W, H);
  if (spec.kind === "area") return pgm(areaPicture(spec.area, W, H)!, W, H);
  if (spec.kind === "shadow") return pgm(cardShadowPicture(spec.card, spec.framing, W, H), W, H);
  if (spec.kind === "border") return pgm(cardBorderPicture(spec.card, spec.framing, W, H), W, H);
  if (spec.kind === "gradient") return ppm(gradientPicture(spec.gradient, W, H), W, H);
  if (spec.kind === "pattern") return ppm(patternPicture(spec.pattern, W, H), W, H);
  if (spec.kind === "hdr") return cubeText(hdrLut(spec.hdr), undefined, "SDR into HDR");
  if (spec.kind === "moving") throw new Error("A moving mask is a video: write it with movingFrames.");
  const lut = spec.grade.lut ? luts[spec.grade.lut.id] : null;
  if (spec.hdr) return cubeText(hdrLut(spec.hdr, gradeFn(spec.grade, lut)));
  const n = lutSizeFor(spec.grade);
  return cubeText(buildLut(spec.grade, lut, n), n);
}

/**
 * Phase 3: a moving look file as frames of grey (8-bit, row by row): its masks or its area where they are at each output
 * frame's footage time, from `from` to just past `to`. At a working size (at most 480 wide; the render scales it up to
 * the frame: a soft edge does not need every pixel). A frame like the one before it is the same array.
 */
export function movingFrames(spec: Extract<LookFile, { kind: "moving" }>, plan: { width: number; height: number; fps?: number }): { w: number; h: number; count: number; fps: number; frame: (i: number) => Uint8Array } {
  const fps = plan.fps || 30, w = Math.max(2, Math.round(Math.min(plan.width, 480) / 2) * 2), h = Math.max(2, Math.round((plan.height * w) / plan.width / 2) * 2);
  const count = Math.ceil((spec.to - spec.from) * fps) + 3;
  let last = "", px: Uint8Array = new Uint8Array(w * h);
  const frame = (i: number) => {
    const t = spec.from + i / fps;
    const now = spec.masks ? { masks: spec.masks.map((m) => areaAt(m, t)) } : { area: areaAt(spec.area!, t) };
    const key = JSON.stringify(now);
    if (key !== last) { px = now.masks ? maskPicture(now.masks, w, h) : areaPicture(now.area, w, h)!; last = key; }
    return px;
  };
  return { w, h, count, fps, frame };
}

/**
 * Samples: the plan cut down to edit seconds [from, to) (on the frame grid), drawn exactly as the whole render draws
 * them: only the picture parts the window shows are read and drawn (clipped at its ends, their footage moved to
 * match), and the joined picture keeps its edit times, so transitions, zooms, overlays and captions land on the same
 * frames as in the full render (graph: plan.window). Overlays, zooms, transitions and adjustment layers outside the
 * window are left out; the sound is the whole mix, trimmed. A part the window cuts is not stabilized (its smoothing
 * was worked out over the whole part); the person's matte is made only for the blocks the window needs.
 */
export function windowPlan(plan: RenderPlan, from: number, to: number): RenderPlan {
  if (plan.model === "A") throw new RenderPlanError("Samples need the edit's timeline in the current format: open the edit in Rendrr once, then ask again.");
  const FPS = plan.fps || 30, onGrid = (t: number) => Math.round(t * FPS) / FPS;
  const a = Math.max(0, onGrid(from)), b = Math.min(onGrid(plan.outputSeconds), Math.max(onGrid(to), a + 1 / FPS));
  if (!(b - a >= 1 / FPS - 1e-9)) throw new RenderPlanError(`That moment (${fmtClock(from)}) is past the end of the edit (${fmtClock(plan.outputSeconds)}).`);
  const hit = (x: { start: number; end: number }) => x.end > a + 1e-9 && x.start < b - 1e-9;
  // Every video is put on the 1/FPS grid before its parts are cut (openWindows: fps first), and trim rounds its times
  // to that grid: a part's first frame is its footage start rounded to the nearest frame (the time as written, in
  // microseconds). The sample's cuts are written on whole frames, so they round to exactly the frame meant.
  const frameOf = (t: number) => Math.round(Math.round(t * 1e6) * FPS / 1e6);
  // Played backwards, a part is read in pieces from its footage end, each from the first frame at or after its seek.
  const firstAfter = (t: number) => Math.ceil(t * FPS - 1e-3);
  const kept: number[] = [];
  const parts = plan.parts.flatMap((p, i) => {
    if (!hit(p)) return [];
    kept.push(i);
    // A stabilized part is drawn whole (its smoothing and its transforms run over the whole part).
    if (plan.stabilize?.[stabilizeKey(p)]) return [p];
    const r = rateOf(p), ar = Math.abs(r);
    // The start: output frame n of a part at another speed shows frame floor(|rate| x n) of its stretch, so the part may
    // start only where |rate| x n is a whole frame (else every other frame of a half-speed clip is a frame off): the
    // last such frame at or before the window. The frames before the window are trimmed off the end result.
    let m = p.start < a - 1e-9 ? Math.floor((a - p.start) * FPS + 1e-6) : 0;
    if (r !== 0) { while (m > 0 && Math.abs(ar * m - Math.round(ar * m)) > 1e-6) m--; }
    const K = Math.round(ar * m), s = m ? p.start + m / FPS : p.start;
    const endCut = p.end > b + 1e-9, e = endCut ? b : p.end, count = Math.round((e - s) * FPS);
    if (!m && !endCut) return [p];
    let srcIn = p.srcIn, srcOut = p.srcOut;
    if (r > 0) {
      const F = frameOf(p.srcIn) + K;
      if (m) srcIn = F / FPS;
      if (endCut) srcOut = (F + Math.ceil(ar * count - 1e-6)) / FPS;
    } else if (r < 0) {
      // Played backwards from its footage's end: the window's start moves the end back, its end moves the start up.
      const top = firstAfter(p.srcOut) - 1 - K;
      if (m) srcOut = (top + 1) / FPS;
      if (endCut) srcIn = (top + 1 - Math.ceil(ar * count - 1e-6)) / FPS;
    }
    return [{ ...p, start: s, end: e, srcIn, srcOut }];
  });
  if (!parts.length) throw new RenderPlanError(`Nothing plays at ${fmtClock(from)}.`);
  const stabilize = plan.stabilize ? Object.fromEntries(Object.entries(plan.stabilize).filter(([k]) => parts.some((p) => stabilizeKey(p) === k))) : undefined;
  const broll0 = plan.broll.filter(hit), under0 = plan.under?.filter(hit) ?? [];
  const shown = new Set([...parts.flatMap((p) => p.clipIds), ...broll0.map((o) => o.clipId), ...under0.map((o) => o.clipId), ...(plan.transitions ?? []).filter(hit).flatMap((t) => [...t.a, ...t.b].map((x) => x.clipId))]);
  const stabilized = plan.stabilized ? Object.fromEntries(Object.entries(plan.stabilized).filter(([id]) => shown.has(id))) : undefined;
  const person = plan.person ? { ...plan.person, parts: Object.fromEntries(kept.flatMap((old, j) => (plan.person!.parts[old] ? [[j, plan.person!.parts[old]]] : []))) } : undefined;
  const broll = plan.broll.filter(hit), under = plan.under?.filter(hit);
  // The matte blocks the window reads: its parts' footage (a look's subject or the person behind text) and its b-roll.
  let mattes: RenderPlan["mattes"];
  if (plan.mattes) {
    const need = new Map<string, [number, number]>();
    const add = (name: string | undefined, x: number, y: number) => { if (!name) return; const n = need.get(name); need.set(name, n ? [Math.min(n[0], x), Math.max(n[1], y)] : [x, y]); };
    parts.forEach((p, j) => { add(plan.looks?.[p.clipIds[0]]?.subject?.matte, p.srcIn, p.srcOut); add(person?.parts[j], p.srcIn, p.srcOut); });
    for (const o of [...broll, ...(under ?? [])]) add(plan.looks?.[o.clipId]?.subject?.matte, o.sourceStart, o.sourceStart + (o.end - o.start));
    mattes = {};
    for (const [name, m] of Object.entries(plan.mattes)) {
      const n = need.get(name);
      if (!n) continue;
      const want = new Set(matteBlocks(n[0], n[1], plan.videos?.[m.videoId]?.seconds));
      const blocks = m.blocks.filter((k) => want.has(k));
      if (blocks.length) mattes[name] = { ...m, blocks };
    }
  }
  return {
    ...plan, window: { from: a, to: b }, parts, kept: parts.map((p) => ({ start: p.srcIn, end: p.srcOut })),
    ...(stabilize ? { stabilize } : {}), ...(stabilized && Object.keys(stabilized).length ? { stabilized } : { stabilized: undefined }), ...(person ? { person } : {}), ...(mattes ? { mattes } : {}),
    zooms: plan.zooms.filter(hit), broll, graphics: plan.graphics.filter(hit), ...(under ? { under } : {}),
    ...(plan.transitions ? { transitions: plan.transitions.filter(hit) } : {}), ...(plan.adjust ? { adjust: plan.adjust.filter(hit) } : {}),
    ...(plan.textMattes ? { textMattes: plan.textMattes.filter(hit) } : {}), ...(plan.textBlurs ? { textBlurs: plan.textBlurs.filter(hit) } : {}),
    operations: [...plan.operations, `Sample: edit ${fmtClock(a)}-${fmtClock(b)} only, drawn as the whole render draws it`],
  };
}

/**
 * Transitions on the cuts (Phase 5). Each is centred on its cut and whole frames long on each side. It gets shorter
 * when a clip next to it is short (a clip with transitions at both ends gives each half of itself) or, for those that
 * show both sides at once, when a side has less footage past the cut than half the transition.
 */
export function planTransitions(view: SequenceView, clipById: Map<string, SeqClip>, secondsOf: (videoId: string) => number | undefined, FPS = 30): TransitionOp[] {
  const out: TransitionOp[] = [];
  const live = view.clips.filter((c) => c.pieces.length);
  const pic = view.picture;
  const f = (x: number) => Math.floor(x * FPS + 1e-6) / FPS;
  const has = (id?: string) => { const t = id ? clipById.get(id)?.transition : undefined; return !!t && t.type !== "cut"; };
  const seg = (p: PicturePart, s: number, e: number, clipId: string): Seg => {
    const r = rateOf(p), a = srcAt(p, s), b = srcAt(p, e);
    return { videoId: p.videoId, srcIn: r === 0 ? p.srcIn : Math.min(a, b), srcOut: r === 0 ? p.srcOut : Math.max(a, b), rate: r, start: r3(s), end: r3(e), rotate: p.rotate, framing: p.framing, clipId };
  };
  // Footage a part has past its end (after) or before its start, in its play direction, as edit seconds.
  const room = (p: PicturePart, after: boolean) => {
    const r = rateOf(p);
    if (r === 0) return Infinity;
    const len = secondsOf(p.videoId) ?? Infinity;
    return Math.max(0, after === r > 0 ? len - p.srcOut : p.srcIn) / Math.abs(r);
  };
  live.forEach((pl, k) => {
    const tr = clipById.get(pl.id)!.transition;
    if (!tr || tr.type === "cut") return;
    const at = pl.start;
    const base = { clipId: pl.id, ...(tr.dir ? { dir: tr.dir } : {}), at: r3(at), asked: tr.duration, a: [] as Seg[], b: [] as Seg[] };
    let half = Math.min(f(tr.duration / 2), f((pl.end - pl.start) / (has(live[k + 1]?.id) ? 2 : 1)));
    if (k === 0) {
      // The first clip: a dip or a dissolve fades in from the colour (black for a dissolve).
      if (tr.type === "dip-black" || tr.type === "dip-white" || tr.type === "dissolve") out.push({ ...base, type: tr.type === "dip-white" ? "dip-white" : "dip-black", start: 0, end: r3(half), ...(tr.type === "dissolve" ? { note: "first clip: fades in from black" } : {}) });
      else out.push({ ...base, type: tr.type, start: r3(at), end: r3(at), note: "left out: no clip before it" });
      return;
    }
    const prev = live[k - 1];
    half = Math.min(half, f((prev.end - prev.start) / (has(prev.id) ? 2 : 1)));
    const aPart = pic.find((p) => p.start < at - 1e-9 && p.end >= at - 1e-9)!, bPart = pic.find((p) => p.start <= at + 1e-9 && p.end > at + 1e-9)!;
    let note = "";
    if ((USES_HANDLES as string[]).includes(tr.type)) {
      const ra = room(aPart, true), rb = room(bPart, false);
      if (Math.min(ra, rb) < half) { half = f(Math.min(half, ra, rb)); note = `${ra < rb ? "the clip before" : "this clip"} has only ${Math.min(ra, rb).toFixed(2)}s of footage past the cut`; }
    }
    if (half < 1 / FPS - 1e-9) { out.push({ ...base, type: tr.type, start: r3(at), end: r3(at), note: `left out: ${note || "a clip next to it is too short"}` }); return; }
    if (half * 2 < tr.duration - 1 / FPS && !note) note = "a clip next to it is short";
    const start = at - half, end = at + half;
    const sides = (USES_HANDLES as string[]).includes(tr.type) ? {
      a: [...pic.filter((p) => p.end > start + 1e-9 && p.start < at - 1e-9).map((p) => seg(p, Math.max(start, p.start), Math.min(at, p.end), p.clipIds[p.clipIds.length - 1])), seg(aPart, at, end, aPart.clipIds[aPart.clipIds.length - 1])],
      b: [seg(bPart, start, at, bPart.clipIds[0]), ...pic.filter((p) => p.start < end - 1e-9 && p.end > at + 1e-9).map((p) => seg(p, Math.max(at, p.start), Math.min(end, p.end), p.clipIds[0]))],
    } : tr.type === "morph" ? {
      // Phase 8: each side's own frames only (the morph runs from A's frame at the window's start to B's at its end).
      a: pic.filter((p) => p.end > start + 1e-9 && p.start < at - 1e-9).map((p) => seg(p, Math.max(start, p.start), Math.min(at, p.end), p.clipIds[p.clipIds.length - 1])),
      b: pic.filter((p) => p.start < end - 1e-9 && p.end > at + 1e-9).map((p) => seg(p, Math.max(at, p.start), Math.min(end, p.end), p.clipIds[0])),
    } : {};
    out.push({ ...base, ...sides, type: tr.type, start: r3(start), end: r3(end), ...(note ? { note } : {}) });
  });
  return out;
}

/** The render plan's Phase 5 lines: speed, transitions, keyframes. */
function speedLines(v1: SeqClip[], view: SequenceView, transitions: TransitionOp[], clipMotion: Record<string, unknown>, broll: OverlayOp[], graphics: OverlayOp[], texts: TextLayer[]): string[] {
  const off = v1.filter((c) => !normalSpeed(c) && view.clip(c.id)?.pieces.length);
  const tr = transitions.filter((t) => t.end > t.start);
  const keyed = Object.keys(clipMotion).length + [...broll, ...graphics, ...texts].filter((x) => x.keys?.length).length;
  return [
    off.length ? `Speed: ${off.length} ${off.length === 1 ? "clip" : "clips"} (${off.slice(0, 6).map((c) => `${c.id} ${c.freeze ? `freeze ${c.freeze}s` : c.ramp?.length ? "ramp" : `${c.speed ?? 1}x`}${c.reverse ? " reversed" : ""}`).join(", ")}${off.length > 6 ? ", …" : ""}); sound keeps its pitch` : "Speed: all clips at normal speed",
    tr.length ? `Transitions: ${tr.length} (${tr.slice(0, 6).map((t) => `${t.type} ${(t.end - t.start).toFixed(2)}s`).join(", ")}${tr.length > 6 ? ", …" : ""})` : "Transitions: none (cuts)",
    keyed ? `Keyframes: ${keyed} ${keyed === 1 ? "clip" : "clips"} animated` : "Keyframes: none",
  ];
}

// ---------------------------------------------------------------------------------------------
// ffmpegArgs: plan + local files -> one command. The filter graph goes in a script file.
// ---------------------------------------------------------------------------------------------
export type PlanFiles = {
  /** The main footage. */
  source: string;
  /** Phase 6: the reverb rooms' impulse responses written out (by plan.audioMix.irs name). */
  irs?: Record<string, string>;
  /** Phase 7: each stabilized part's shake (vidstabdetect's file), by stabilizeKey. */
  stabilize?: Record<string, string>;
  /** Phase 21: each stabilized copy's file (plan.stabilized), by clip id. */
  stableCopies?: Record<string, string>;
  /** The other videos on V1, by video id. */
  videos?: Record<string, string>;
  output: string;
  assPath?: string;
  /** Phase 2: plan.assBehind written out. */
  assBehindPath?: string;
  /** Phase 2b: each plan.textMattes entry's mask and decor written out, and the library video in its letters (by clip id). */
  textMasks?: Record<string, string>;
  /** Phase 17: each plan.textBlurs entry's ASS file, by clip id. */
  textBlurs?: Record<string, string>;
  textDecor?: Record<string, string>;
  insides?: Record<string, string>;
  fontsDir?: string;
  broll?: Record<string, string>; // by clip id
  graphics?: Record<string, string>; // by clip id
  audio?: Record<string, string>; // by clip id
  /** Phase 6: b-roll drawn behind V1, by clip id; the look files (LUTs, mask pictures), by file name. */
  under?: Record<string, string>;
  /** remove_background: each matte's blocks joined (an FFmpeg concat list), by matte name (plan.mattes). */
  mattes?: Record<string, string>;
  looks?: Record<string, string>;
  /** Phase 7: how long each graphic's file plays (seconds, by clip id). A clip longer than its file holds the last
   *  frame, as the player does with a custom graphic's recording. */
  graphicSeconds?: Record<string, number>;
  /** The library video behind V1 (plan.background.videoId). */
  background?: string;
};

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
const n3 = (x: number) => x.toFixed(3);
const n6 = (x: number) => x.toFixed(6);

export function zoomExpr(zooms: ZoomOp[]): string {
  if (!zooms.length) return "1";
  const terms = zooms.map((z) => {
    const s = (z.scale - 1).toFixed(4);
    if (z.mode === "through") {
      // The zoom transition: in to the cut (the window's middle) and out after it, both quadratic.
      const D = Math.max(0.01, z.end - z.start), p = `(t-${n3(z.start)})/${n6(D)}`;
      return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*if(lt(${p},0.5),pow(2*${p},2),pow(2-2*${p},2)),0)`;
    }
    if (z.mode === "push") return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*(t-${n3(z.start)})/${n3(Math.max(0.1, z.end - z.start))},0)`;
    const ramp = Math.min(0.12, (z.end - z.start) / 3).toFixed(3);
    return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*min(1,(t-${n3(z.start)})/${ramp})*min(1,(${n3(z.end)}-t)/${ramp}),0)`;
  });
  return `min(2,1+${terms.join("+")})`;
}
/** zoomExpr's value at edit time t (the check uses it to place the face on screen). */
export function zoomAt(zooms: ZoomOp[], t: number): number {
  let z = 1;
  for (const x of zooms) {
    if (t < x.start || t > x.end) continue;
    const s = x.scale - 1;
    if (x.mode === "through") { const p = (t - x.start) / Math.max(0.01, x.end - x.start); z += s * (p < 0.5 ? (2 * p) ** 2 : (2 - 2 * p) ** 2); }
    else if (x.mode === "push") z += (s * (t - x.start)) / Math.max(0.1, x.end - x.start);
    else { const ramp = Math.min(0.12, (x.end - x.start) / 3); z += s * Math.min(1, (t - x.start) / ramp) * Math.min(1, (x.end - t) / ramp); }
  }
  return Math.min(2, z);
}

export type FfmpegOpts = {
  threads?: number;
  /** Seconds past what a video's decoder has given before a new, seeked input reads further on (default WINDOW_GAP);
   *  Infinity: one input per video read from the start, as before windows (tests compare the two). */
  windowGap?: number;
  /**
   * Picture windows a video may have at most (by video id). Every window is a decoder of its own, and FFmpeg starts
   * them all at once, each holding frames: at 4K or 6K a few dozen of them fill the worker's memory. Over its budget,
   * a video's windows read further through its gaps instead (the smallest gap that fits, else one input as before).
   */
  windowBudget?: Record<string, number>;
  /** Samples: one frame, picture only, written as a JPEG (no sound is read or made). With plan.window. */
  still?: boolean;
  /**
   * Threads of the filter graph, which each scaler also starts: a graded graph has ~70 scalers, so leaving it to the
   * CPU count on a many-core host starts thousands of threads and FFmpeg fails with EAGAIN at the container's limit.
   */
  filterThreads?: number;
  /**
   * Decoder threads for all the inputs together, each its share (at least 1). Left alone, each decoder starts as many
   * as the host has CPUs (up to 16): a render with 15 graphics and a few footage windows started hundreds and ran the
   * container out of threads. Graphics always decode with 1 or 2 (their pictures are simple).
   */
  inputThreads?: number;
  /** The loudness gain the measuring pass found (dB). Needed when the plan normalizes loudness. */
  loudnessGainDb?: number;
  /** Audio only, up to the mix, through ebur128: the measuring pass (its stderr has the loudness summary). */
  measure?: boolean;
  /** Phase 12 (overlay export): the picture under the overlays as one colour (the worker renders black and white and
   *  takes the alpha from their difference); b-roll, zooms, adjustment layers and the person matte left out. */
  pictureAs?: "black" | "white";
};

/**
 * Each input that sets no decoder threads of its own gets its share of `total` (at least 1, at most 16), as
 * "-threads n" just before its "-i". Without a total the inputs are left as they are.
 */
export function capInputThreads(inputs: string[], total?: number): string[] {
  if (!total) return inputs;
  const groups: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    cur.push(inputs[i]);
    if (inputs[i] === "-i") { cur.push(inputs[++i]); groups.push(cur); cur = []; }
  }
  const open = groups.filter((g) => !g.includes("-threads")).length;
  const share = String(Math.max(1, Math.min(16, Math.floor(total / Math.max(1, open)))));
  return [...groups.flatMap((g) => (g.includes("-threads") ? g : [...g.slice(0, -2), "-threads", share, ...g.slice(-2)])), ...cur];
}

export function ffmpegArgs(plan: RenderPlan, files: PlanFiles, source: SourceInfo, opts: FfmpegOpts = {}): { args: string[]; filterGraph: string } {
  if (plan.model === "A") return ffmpegArgsA(plan, files, source, opts);
  if (opts.windowGap != null || !opts.windowBudget) { const { args, filterGraph } = ffmpegArgsB(plan, files, source, opts); return { args, filterGraph }; }
  // The smallest gap at which every video keeps to its window budget (Infinity: one input each, always within it).
  const budget = opts.windowBudget;
  for (const windowGap of [WINDOW_GAP, 30, 60, 180, 600, Infinity]) {
    const r = ffmpegArgsB(plan, files, source, { ...opts, windowGap });
    if (windowGap === Infinity || Object.entries(r.windows).every(([vid, n]) => n <= Math.max(1, budget[vid] ?? Infinity))) return { args: r.args, filterGraph: r.filterGraph };
  }
  throw new RenderPlanError("No window layout fits."); // not reached: Infinity always fits
}

function ffmpegArgsB(plan: RenderPlan, files: PlanFiles, source: SourceInfo, opts: FfmpegOpts): { args: string[]; filterGraph: string; windows: Record<string, number> } {
  const mix = plan.audioMix;
  if (mix && mix.loudness != null && !opts.measure && opts.loudnessGainDb == null) throw new RenderPlanError("This render sets the loudness: measure the mix first (ffmpegArgs with measure: true), then pass loudnessGainDb.");
  const inputs: string[] = [];
  const g: string[] = [];
  let idx = 0;
  const W = plan.width, H = plan.height;
  // Phase 7: the output's frame rate (30 for previews; a final keeps its footage's). At 30 every string is as before.
  const FPS = plan.fps || 30, R = plan.rate || String(FPS), TB = timeBase(R), fr = { fps: FPS, rate: R };
  const main = plan.sources[0];
  const info = (vid: string): { hasAudio: boolean; hdr: boolean; transfer?: HdrTransfer; seconds?: number } => plan.videos?.[vid] ?? { hasAudio: vid === main ? source.hasAudio : true, hdr: vid === main ? !!source.hdr : false, transfer: vid === main ? source.transfer : undefined, seconds: vid === main ? source.seconds : undefined };
  // Phase 6: an HDR output keeps 10 bits all the way (PF); SDR pictures enter it through the SDR-into-HDR LUT.
  const hdr = plan.hdr ?? null;
  const PF = hdr ? "yuv420p10le" : "yuv420p", PFA = hdr ? "yuva420p10le" : "yuva420p";
  const looks = plan.looks ?? {};
  const lookPath = (name: string) => { const x = files.looks?.[name]; if (!x) throw new RenderPlanError(`A colour file of this edit is missing (${name}). Render again.`); return x; };
  const isMovingFile = (name?: string) => !!name && plan.lookFiles?.[name]?.kind === "moving";
  const isMovingLook = (l: LookOp) => isMovingFile(l.mask) || !!l.effects?.some((e) => isMovingFile(e.file)) || isMovingFile(l.skin?.file);
  /**
   * A look picture (mask or area) as a grey stream `frames` long: a still one (.pgm) repeated, or (Phase 3) a moving
   * one read in footage time and put through `steps` (the segment's own trim and speed, as its picture), at the output
   * size.
   */
  const picture = (name: string, frames: number, tag: string, steps?: string) => {
    const spec = plan.lookFiles?.[name];
    if (spec?.kind === "moving") {
      inputs.push("-i", lookPath(name));
      g.push(`[${idx++}:v]setpts=PTS+${n6(spec.from)}/TB,fps=${R},format=gray,${steps ?? `trim=end_frame=${frames}`},scale=${W}:${H}:flags=bilinear,format=gray,setsar=1,trim=end_frame=${frames}[lp${tag}]`);
      return `lp${tag}`;
    }
    inputs.push("-loop", "1", "-framerate", R, "-t", n3(frames / FPS + 1), "-i", lookPath(name));
    g.push(`[${idx++}:v]format=gray,setsar=1,trim=end_frame=${frames}[lp${tag}]`);
    return `lp${tag}`;
  };
  /**
   * remove_background: the matte of footage a..b of one video (its blocks joined, from the first one a needs), on the
   * output's frame grid with the footage's own times, so the clip's trim, speed, turn and fit apply to it as they do
   * to the picture. Read from the list's start: a seek (-ss) on FFmpeg's concat reader moves its frames' times.
   */
  let nMatte = 0;
  const matteIn = (name: string, a: number, b: number) => {
    const m = plan.mattes?.[name], list = files.mattes?.[name];
    if (!m || !list || a < m.blocks[0] * MATTE_BLOCK - 1e-6) throw new RenderPlanError("The background matte of a clip is missing. Render again.");
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
    const l = `mt${nMatte++}`;
    g.push(`[${idx++}:v]setpts=PTS+${m.blocks[0] * MATTE_BLOCK}/TB,fps=${R},format=gray,trim=end=${n6(b + 1)}[${l}]`);
    return l;
  };
  /** The matte with remove_background's edge (out or in), softness and invert, at the output size. */
  const subjectMatte = (m: string, s: SubjectOp, tag: string) => {
    const k = Math.min(W, H) / 1080, f: string[] = [];
    // Blurred by the edge's size, then the blur's 16% (edge out) or 84% (edge in) made the new middle: the edge moves by
    // about that many pixels; 0 stays 0 and 255 stays 255 (the background stays clear, the person solid).
    if (s.edge) { const T = s.edge > 0 ? 40 : 215; f.push(`gblur=sigma=${n3(Math.max(0.5, Math.abs(s.edge) * k))}`, `lut=c0='if(lt(val,${T}),val*128/${T},128+(val-${T})*127/${255 - T})'`); }
    const soft = 0.06 * s.soft * k;
    if (soft >= 0.3) f.push(`gblur=sigma=${n3(soft)}`);
    if (s.invert) f.push("negate");
    if (!f.length) return m;
    g.push(`[${m}]${f.join(",")}[ms${tag}]`);
    return `ms${tag}`;
  };
  const mattesFor: Record<string, string> = {};
  /** Phase 2: each main part's matte for the person laid back over layers behind them (by part index). */
  const personFor: Record<string, string> = {};
  /**
   * Skin retouch on [inp] (the fitted picture, W x H, still YUV): the skin found by its colour (and inside its area),
   * retouched at the working size (blemishes: spots darker than a closing, filled from the skin around them, then the
   * local brightness put back; smooth: bilateral; even: the colour planes moved towards their blur where they differ a
   * little; brighten: a gamma on luma) and merged in on the skin. Above the working size only its change is added to
   * the full picture (grainextract / grainmerge), so the texture finer than the working size stays. YUV 4:4:4 out (8-bit;
   * 10-bit for HDR footage).
   */
  const skinChain = (inp: string, so: SkinOp, dom: "sdr" | "hdr", frames: number, tag: string, steps?: string): string => {
    const p = so.p, t = `${tag}k`, full = p.ww === W && p.wh === H, T = SKIN_TONE;
    const deep = dom === "hdr", F = deep ? "yuv444p10le" : "yuv444p", M = deep ? 1023 : 255, mid = deep ? 512 : 128, lo = deep ? 64 : 16, span = deep ? 876 : 219;
    if (full) g.push(`[${inp}]format=${F},split=3[kx${t}][ka${t}][km${t}]`);
    else {
      g.push(`[${inp}]format=${F},split[kx${t}][k0${t}]`);
      g.push(`[k0${t}]scale=${p.ww}:${p.wh}:flags=area,split=4[kl${t}][ka${t}][km${t}][kk${t}]`);
    }
    // Where the skin is: its colour (8-bit) at half the working size, small holes closed, softened; times the area.
    g.push(`[km${t}]scale=${p.mw}:${p.mh}:flags=area,format=yuv444p,extractplanes=y+u+v[kmy${t}][kmu${t}][kmv${t}]`);
    g.push(`[kmu${t}][kmv${t}]lut2=c0='${skinChromaExpr()}'[kmc${t}]`);
    g.push(`[kmc${t}][kmy${t}]lut2=c0='x*clip((y-${T.lumaFloor})/${T.lumaSoft},0,1)*${T.strength}'[kmk${t}]`);
    g.push(`[kmk${t}]dilation=coordinates=90,erosion=coordinates=90,gblur=sigma=1,scale=${p.ww}:${p.wh}:flags=bilinear,setrange=pc[kmw${t}]`);
    let mk = `kmw${t}`;
    if (so.file) { g.push(`[${picture(so.file, frames, "k" + t, steps)}]scale=${p.ww}:${p.wh}:flags=area,setrange=pc[kar${t}]`); g.push(`[${mk}][kar${t}]blend=all_mode=multiply[kmx${t}]`); mk = `kmx${t}`; }
    g.push(`[${mk}]${deep ? "format=gray10le," : ""}split=3[kg0${t}][kg1${t}][kg2${t}];[kg0${t}][kg1${t}][kg2${t}]mergeplanes=0x001020:${F}[kmg${t}]`);
    // The retouch at the working size.
    g.push(`[ka${t}]extractplanes=y+u+v[kwy${t}][kwu${t}][kwv${t}]`);
    let y = `kwy${t}`;
    if (p.blemishes) {
      const b = p.blemishes, shape = (f: string) => Array.from({ length: b.passes }, (_, i) => `${f}=coordinates=${i % 2 ? 90 : 255}`).join(",");
      const dark = `((y-x)/max(y,1))`;
      // Found on a lightly smoothed copy, so grain and noise are not taken for spots; filled from the skin's blur.
      g.push(`[${y}]split=3[kbz${t}][kb3${t}][kb4${t}];[kbz${t}]gblur=sigma=1,split=3[kb0${t}][kb1${t}][kb2${t}]`);
      g.push(`[kb1${t}]scale=${p.hw}:${p.hh}:flags=area,${shape("dilation")},${shape("erosion")},scale=${p.ww}:${p.wh}:flags=bilinear[kbc${t}]`);
      g.push(`[kb0${t}][kbc${t}]lut2=c0='${M}*clip((${dark}-${b.r1})/${n3(b.r2 - b.r1)},0,1)*clip((${b.r4}-${dark})/${n3(b.r4 - b.r3)},0,1)',dilation,gblur=sigma=0.8[kbs${t}]`);
      g.push(`[kb2${t}]gblur=sigma=${b.fill}[kbf${t}]`);
      g.push(`[kb3${t}][kbf${t}][kbs${t}]maskedmerge,split[kbh${t}][kbh1${t}]`);
      // Filling only ever lifts what is darker, so the skin's local brightness is put back: spots and creases lose their
      // contrast, the tone stays.
      g.push(`[kbh1${t}][kb4${t}]lut2=c0='clip(x-y+${mid},0,${M})',gblur=sigma=${b.level}[kbl${t}]`);
      g.push(`[kbh${t}][kbl${t}]lut2=c0='clip(x-y+${mid},0,${M})'[kbt${t}]`);
      y = `kbt${t}`;
    }
    g.push(`[${y}][kwu${t}][kwv${t}]mergeplanes=0x001020:${F}${p.smooth ? `,bilateral=sigmaS=${p.smooth.sigmaS}:sigmaR=${p.smooth.sigmaR}` : ""}[kws${t}]`);
    let w = `kws${t}`;
    if (p.even) {
      const ev = p.even, lim = Math.round((ev.limit * M) / 255), near = `x+(y-x)*clip((${lim}-abs(y-x))/${lim / 2},0,1)`;
      g.push(`[${w}]split[ke0${t}][ke1${t}];[ke1${t}]gblur=sigma=${ev.sigma}:planes=6[keb${t}]`);
      g.push(`[ke0${t}][keb${t}]lut2=c0='x':c1='${near}':c2='${near}'[kev${t}]`);
      w = `kev${t}`;
    }
    const lift = p.brighten ? `lutyuv=y='${lo}+${span}*pow(clip((val-${lo})/${span},0,1),${p.brighten.gamma})'` : "null";
    // On the skin: at the working size, the retouched picture itself; above it, only the change, onto the full picture.
    if (full) { g.push(`[${w}]${lift}[kr${t}];[kx${t}][kr${t}][kmg${t}]maskedmerge[ko${t}]`); return `ko${t}`; }
    g.push(`[${w}]${lift}[kr${t}];[kk${t}][kr${t}][kmg${t}]maskedmerge[kq${t}];[kq${t}][kl${t}]blend=all_mode=grainextract[kd${t}]`);
    g.push(`[kd${t}]scale=${W}:${H}:flags=bicubic[ku${t}];[kx${t}][ku${t}]blend=all_mode=grainmerge[ko${t}]`);
    return `ko${t}`;
  };
  /**
   * A clip's look on [inp] (fitted, W x H, `frames` long), in this order: the key's alpha from the fitted colours,
   * despill, the grade (lut3d), blur/pixelate mixed in by their areas (maskedmerge), the masks into the alpha. In an
   * HDR output an SDR picture goes through the SDR-into-HDR LUT (with its grade, 16-bit). dom: what [inp] holds.
   */
  const colorChain = (input: string, look: LookOp | undefined, dom: "sdr" | "hdr", frames: number, tag: string, steps?: string): { out: string; alpha: boolean } => {
    const toHdr = !!hdr && dom === "sdr";
    if (!look && !toHdr) return { out: input, alpha: false };
    // The skin retouch first, on the picture's own YUV: the skin is found by its own colour, not the graded one.
    const inp = look?.skin ? skinChain(input, look.skin, dom, frames, tag, steps) : input;
    // 16-bit RGB after the key: lut3d truncates its output, which at 8 bits would darken a grade by half a level.
    const rgbF = "gbrp16le";
    let rgb = `lc${tag}`, alpha: string | null = null;
    // accurate_rnd: without it FFmpeg 7 loses about a level of luma going to RGB and back.
    g.push(`[${inp}]scale=in_color_matrix=${dom === "hdr" ? "bt2020" : "bt709"}:in_range=tv:flags=accurate_rnd,format=${dom === "hdr" ? "gbrp16le" : "gbrp"}${look?.key ? `,split[${rgb}][lk${tag}]` : `[${rgb}]`}`);
    if (look?.key) {
      const k = look.key, t = spillType(k);
      g.push(`[lk${tag}]format=gbrap,colorkey=0x${k.color.slice(1).toUpperCase()}:${k.similarity}:${k.blend},format=yuva444p,alphaextract,format=gray,setsar=1[ka${tag}]`);
      alpha = `ka${tag}`;
      if (k.spill > 0) { g.push(`[${rgb}]despill=type=${t}:mix=0.5:expand=0:red=0:green=${t === "green" ? -k.spill : 0}:blue=${t === "blue" ? -k.spill : 0}:brightness=0:alpha=0,format=gbrp[ls${tag}]`); rgb = `ls${tag}`; }
    }
    const lut = hdr ? (dom === "sdr" ? look?.lutHdr ?? hdr.lut : undefined) : look?.lut;
    if (lut) { g.push(`[${rgb}]format=${rgbF},lut3d=file=${q(lookPath(lut))}:interp=trilinear[ll${tag}]`); rgb = `ll${tag}`; }
    else if (dom === "sdr") { g.push(`[${rgb}]format=${rgbF}[ll${tag}]`); rgb = `ll${tag}`; }
    let pinAlpha: string | null = null;
    (look?.effects ?? []).forEach((e, j) => {
      const t2 = `${tag}_${j}`;
      // Phase 12: effects that are a small graph of their own (glow, mirror) or move the picture (shake, pin).
      if (e.type === "glow") {
        // The parts above mid-grey, blurred, laid back on by screen: the bright parts bloom.
        g.push(`[${rgb}]split[gw${t2}][gx${t2}]`);
        // Phase 19: the screen in float RGB (FFmpeg's blend gets screen with an opacity wrong on 16-bit RGB: the colours wash out).
        g.push(`[gx${t2}]lutrgb=r='clip((val-32768)*2,0,65535)':g='clip((val-32768)*2,0,65535)':b='clip((val-32768)*2,0,65535)',gblur=sigma=${e.px}:steps=3,format=gbrpf32le[gy${t2}]`);
        g.push(`[gw${t2}]format=gbrpf32le[gv${t2}]`);
        g.push(`[gv${t2}][gy${t2}]blend=all_mode=screen:all_opacity=${n3(Math.min(1, e.amount / 70))},format=${rgbF}[le${t2}]`);
        rgb = `le${t2}`; return;
      }
      if (e.type === "mirror") {
        g.push(`[${rgb}]crop=iw/2:ih:0:0,split[ml${t2}][mr${t2}]`);
        g.push(`[mr${t2}]hflip[mf${t2}]`);
        g.push(`[ml${t2}][mf${t2}]hstack,scale=${W}:${H},setsar=1,format=${rgbF}[le${t2}]`);
        rgb = `le${t2}`; return;
      }
      if (e.type === "shake") {
        // Zoomed in just enough, and moved by two waves each way at frequencies that never line up (seconds of the clip).
        const z = 1 + (2.4 * e.px) / Math.min(W, H), A = e.px;
        g.push(`[${rgb}]scale=${even(W * z)}:${even(H * z)},crop=${W}:${H}:x='(iw-ow)/2+${A}*(0.6*sin(2*PI*t*5.3)+0.4*sin(2*PI*t*11.7+1.3))':y='(ih-oh)/2+${A}*(0.6*sin(2*PI*t*4.1+0.7)+0.4*sin(2*PI*t*9.9+2.1))',setsar=1,format=${rgbF}[le${t2}]`);
        rgb = `le${t2}`; return;
      }
      if (e.type === "pin") {
        // Corner pin: the picture's corners to the four points; outside them transparent (an alpha from a white frame
        // pinned the same way), so what is under the clip shows.
        const c = e.corners ?? [[0, 0], [1, 0], [0, 1], [1, 1]];
        const pts = c.map(([x, y], i) => `x${i}=${r3(x * W)}:y${i}=${r3(y * H)}`).join(":");
        g.push(`[${rgb}]perspective=${pts}:sense=destination,format=${rgbF}[le${t2}]`);
        // A black edge round the white frame: perspective repeats the edge outside the corners, which must be transparent.
        // White inside with a black edge (perspective repeats the edge outside the corners), made full range: a grey
        // frame from a colour source is limited range (235 and 16).
        g.push(`color=c=white:s=${W - 2}x${H - 2}:r=${plan.rate || "30"}:d=${n6(frames / FPS + 1)},format=gray,pad=${W}:${H}:1:1:black,lut=c0='if(gt(val,128),255,0)',trim=end_frame=${frames},perspective=${pts}:sense=destination[pn${t2}]`);
        pinAlpha = `pn${t2}`;
        rgb = `le${t2}`; return;
      }
      const sk = e.type === "sharpen" ? sharpenKernel(e.amount, e.px) : null, km = sk ? `'${sk.m.join(" ")}'` : "";
      const dk = n3(1 - e.amount / 100);
      const fx = e.type === "blur" ? `gblur=sigma=${e.px}:steps=4` : e.type === "pixelate" ? `pixelize=width=${e.px}:height=${e.px}:mode=avg` : e.type === "darken" || e.type === "vignette" ? `colorchannelmixer=rr=${dk}:gg=${dk}:bb=${dk}`
        : e.type === "grain" ? `format=gbrp,noise=alls=${Math.round(e.amount * 0.8)}:allf=t,format=${rgbF}` : e.type === "rgbsplit" ? `rgbashift=rh=${-e.px}:bh=${e.px}:edge=smear`
        : `convolution=0m=${km}:1m=${km}:2m=${km}:0rdiv=1/${sk!.div}:1rdiv=1/${sk!.div}:2rdiv=1/${sk!.div}`;
      if (!e.file) { g.push(`[${rgb}]${fx},format=${rgbF}[le${t2}]`); rgb = `le${t2}`; return; }
      g.push(`[${rgb}]split[la${t2}][lb${t2}]`);
      g.push(`[lb${t2}]${fx},format=${rgbF}[lf${t2}]`);
      g.push(`[${picture(e.file, frames, "e" + t2, steps)}]format=${rgbF}[lm${t2}]`);
      g.push(`[la${t2}][lf${t2}][lm${t2}]maskedmerge[le${t2}]`);
      rgb = `le${t2}`;
    });
    if (look?.mask) {
      const mk = picture(look.mask, frames, "m" + tag, steps);
      if (alpha) { g.push(`[${alpha}][${mk}]blend=all_mode=multiply[lq${tag}]`); alpha = `lq${tag}`; } else alpha = mk;
    }
    if (pinAlpha) { if (alpha) { g.push(`[${alpha}][${pinAlpha}]blend=all_mode=multiply[lp${tag}]`); alpha = `lp${tag}`; } else alpha = pinAlpha; }
    // remove_background: the person's matte (put through the clip's own steps by drawSeg) into the alpha.
    if (look?.subject && mattesFor[tag]) {
      const sm = subjectMatte(mattesFor[tag], look.subject, tag);
      if (alpha) { g.push(`[${alpha}][${sm}]blend=all_mode=multiply[lr${tag}]`); alpha = `lr${tag}`; } else alpha = sm;
    }
    const yuv = `scale=out_color_matrix=${hdr ? "bt2020" : "bt709"}:out_range=tv:flags=accurate_rnd,format=${PF}`;
    if (!alpha) { g.push(`[${rgb}]${yuv}[lo${tag}]`); return { out: `lo${tag}`, alpha: false }; }
    g.push(`[${rgb}]${yuv}[ly${tag}]`);
    // 8 bits: alphamerge. 10 bits (alphamerge is 8-bit only): the alpha goes in as a fourth plane, its values put back
    // to full range after the conversion mergeplanes makes.
    if (!hdr) g.push(`[ly${tag}][${alpha}]alphamerge[lo${tag}]`);
    else {
      g.push(`[${alpha}]scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd,format=yuv420p10le,lutyuv=y='clip((val-64)*1023/876,0,1023)'[lz${tag}]`);
      g.push(`[ly${tag}][lz${tag}]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=0:format=yuva420p10le[lo${tag}]`);
    }
    return { out: `lo${tag}`, alpha: true };
  };
  /**
   * What is behind V1 over [start, start + frames): black, or the edit's background (a picture decoded once and
   * repeated, a library video looped from the edit's start, or `blurSrc` (the clip's own fitted picture) blurred and
   * scaled up by three blur widths a side, so its softened edges stay outside the frame), in the output's format.
   */
  const bg = plan.background ?? null;
  const backOf = (start: number, frames: number, tag: string, blurSrc?: string, dom: "sdr" | "hdr" = "sdr"): string => {
    const out = `bs${tag}`;
    const sdrIn = (lab: string, d: "sdr" | "hdr" = "sdr") => { const c = colorChain(lab, undefined, d, frames, `bg${tag}`); g.push(`[${c.out}]format=${PF}[${out}]`); return out; };
    if (bg?.file && files.looks?.[bg.file]) {
      inputs.push("-i", files.looks[bg.file]);
      g.push(`[${idx++}:v]scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,loop=loop=-1:size=1:start=0,settb=${TB},setpts=N,trim=end_frame=${frames}[bp${tag}]`);
      return sdrIn(`bp${tag}`);
    }
    if (bg?.videoId && files.background && bg.seconds) {
      inputs.push("-stream_loop", "-1", "-ss", n3(start % bg.seconds), "-i", files.background);
      g.push(`[${idx++}:v]fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,trim=end_frame=${frames},settb=${TB},setpts=N[bp${tag}]`);
      return sdrIn(`bp${tag}`);
    }
    if (bg?.blur && blurSrc) {
      const k = bg.scale ?? 1.1;
      g.push(`[${blurSrc}]gblur=sigma=${bg.blur},scale=${even(W * k)}:${even(H * k)},crop=${W}:${H},setsar=1[bp${tag}]`);
      return sdrIn(`bp${tag}`, dom);
    }
    g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${n6(frames / FPS + 1)},format=${PF},trim=end_frame=${frames}[${out}]`);
    return out;
  };
  /** A card's shadow or border: its colour where its picture says, over `base` (format: PF, or PFA on a clear frame). */
  const fillOver = (base: string, f: { file: string; color: string }, frames: number, to: string, fmt: string) => {
    const path = files.looks?.[f.file];
    if (!path) { g.push(`[${base}]null[${to}]`); return; }
    inputs.push("-i", path);
    g.push(`[${idx++}:v]format=gray,loop=loop=-1:size=1:start=0,settb=${TB},setpts=N,trim=end_frame=${frames}[fa${to}]`);
    g.push(`color=c=0x${f.color.slice(1).toUpperCase()}:s=${W}x${H}:r=${R},format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,trim=end_frame=${frames},settb=${TB},setpts=N[fc${to}]`);
    g.push(`[fc${to}][fa${to}]alphamerge${hdr ? ",format=yuva420p10le" : ""}[ff${to}]`);
    g.push(`[${base}][ff${to}]overlay=format=auto,format=${fmt}[${to}]`);
  };
  /** b-roll laid behind V1 over [start, start + frames): the background with the `under` clips on it (as overlays are drawn). */
  const underClips = plan.under ?? [];
  const baseOf = (start: number, frames: number, tag: string, blurSrc?: string, dom: "sdr" | "hdr" = "sdr") => {
    const end = start + frames / FPS;
    let cur = backOf(start, frames, tag, blurSrc, dom);
    underClips.filter((u) => u.start < end - 1e-6 && u.end > start + 1e-6).forEach((u, j) => {
      const st = plan.stabilized?.[u.clipId], cpPath = st ? files.stableCopies?.[u.clipId] : undefined;
      const path = cpPath ?? files.under?.[u.clipId];
      if (!path) return;
      const s = Math.max(start, u.start), e = Math.min(end, u.end), n = Math.max(1, Math.round((e - s) * FPS)), t = `${tag}u${j}`;
      // Phase 21: stabilized b-roll is read from its stabilized copy (its time starts at the copy's srcIn).
      inputs.push("-ss", n3(u.sourceStart + (s - u.start) - (cpPath ? st!.srcIn : 0)), "-t", n3(e - s + 0.25), "-i", path);
      g.push(`[${idx++}:v]fps=${R},${flipFilter(u.flip)}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=${n}[ua${t}]`);
      const c = colorChain(`ua${t}`, looks[u.clipId], "sdr", n, t, `trim=start=${n6(u.sourceStart + (s - u.start))},setpts=PTS-STARTPTS`);
      let ov = c.out;
      // Phase 17: a card's border, before its keys move it.
      if (u.border) { g.push(`[${ov}]settb=${TB},setpts=N[ubb${t}]`); fillOver(`ubb${t}`, u.border, n, `ubd${t}`, PFA); ov = `ubd${t}`; }
      if (u.keys?.length) { motionChain(g, ov, `um${t}`, u.keys, s - u.start, n, W, H, false, t, { hdr: !!hdr, fr, anchor: u.anchor, blur: u.motionBlur }); ov = `um${t}`; }
      g.push(`[${ov}]settb=${TB},setpts=PTS-STARTPTS+${Math.round((s - start) * FPS)}[ub${t}]`);
      g.push(`[${cur}][ub${t}]overlay=eof_action=pass:format=auto,format=${PF}[bu${t}]`);
      cur = `bu${t}`;
    });
    return cur;
  };

  // Each video is read in windows: one input per window, seeked (-ss) to just before the footage it gives and read
  // forward, its picture and its sound apart. Footage over WINDOW_GAP s past what a window has given, or before it (a
  // part played out of the footage's order, like a hook from later played first), gets a window of its own: the
  // decoder never decodes footage nobody uses, nor holds frames in memory for a part that plays later. Timestamps are
  // put back to the footage's own (setpts), so every trim below keeps footage seconds.
  const srcPath: Record<string, string> = {};
  for (const vid of plan.sources) {
    const path = vid === main ? files.source : files.videos?.[vid];
    if (!path) throw new RenderPlanError(`The file of a video on V1 is missing (${vid}).`);
    srcPath[vid] = path;
  }
  // Phase 21: a stabilized copy is read as a video of its own ("copy:<clip>"), its time starting at the copy's srcIn.
  const copyVid = (clipId: string) => `copy:${clipId}`;
  for (const [clipId, st] of Object.entries(plan.stabilized ?? {})) if (files.stableCopies?.[clipId]) srcPath[copyVid(clipId)] = files.stableCopies[clipId];
  /** Where a stretch of a clip's footage is read: its stabilized copy (shifted to the copy's time) when it has one
   *  covering it, else the video itself. */
  const readFrom = (clipId: string | undefined, videoId: string, a: number, b: number) => {
    const st = clipId ? plan.stabilized?.[clipId] : undefined;
    if (!st || !srcPath[copyVid(clipId!)] || st.videoId !== videoId || a < st.srcIn - 1e-6 || b > st.srcOut + 1e-6) return null;
    return { vid: copyVid(clipId!), d: st.srcIn, path: srcPath[copyVid(clipId!)] };
  };
  type Win = { vid: string; idx: number; at: number; min: number; max: number; pos: number; made: "v" | "a"; v: string[]; a: string[] };
  const wins: Win[] = [];
  const gap = opts.windowGap ?? WINDOW_GAP, oneEach = gap === Infinity;
  const ssOf = (w: Win) => (oneEach ? 0 : Math.max(0, Math.floor(w.min - 1))); // a whole second (frames stay on the grid), a second to spare
  const take = (kind: "v" | "a", vid: string, a: number, b: number, label: string) => {
    // Sound rides on the picture's window when that one reads its footage (the file is read once).
    const cover = kind === "a" ? wins.find((w) => w.vid === vid && w.made === "v" && (oneEach || (a >= w.min - 1 && b <= w.max + 2))) : undefined;
    if (cover) { cover.a.push(label); return; }
    const mine = wins.filter((w) => w.vid === vid && w.made === kind), w = mine[mine.length - 1];
    if (w && (oneEach || (a >= w.pos - 0.5 && a <= w.pos + gap))) { w.pos = Math.max(w.pos, b); w.min = Math.min(w.min, a); w.max = Math.max(w.max, b); w[kind].push(label); return; }
    // The seek and length are filled in once the window's footage is known (placeholders, then the input).
    const at = inputs.length;
    inputs.push("-ss", "", "-t", "", "-i", srcPath[vid]);
    wins.push({ vid, idx: idx++, at, min: a, max: b, pos: b, made: kind, v: [], a: [], [kind]: [label] });
  };
  /** The windows' seeks and lengths, and their decoders of this kind, split into the branches their parts took. A
   *  window from the start reads the file as it always did (no seek, no length): the placeholders become no-ops. */
  const openWindows = (kind: "v" | "a") => {
    for (const w of wins) {
      const ss = ssOf(w);
      if (ss > 0) { inputs[w.at] = "-ss"; inputs[w.at + 1] = String(ss); inputs[w.at + 2] = "-t"; inputs[w.at + 3] = n3(w.max - ss + 2); }
      else { inputs[w.at] = inputs[w.at + 1] = inputs[w.at + 2] = inputs[w.at + 3] = ""; }
      const ls = w[kind];
      if (!ls.length) continue;
      const back = ss > 0 ? `${kind === "v" ? "setpts" : "asetpts"}=PTS+${ss}/TB,` : "";
      const n = ls.length, outs = ls.map((l) => `[${l}]`).join("");
      g.push(kind === "v" ? `[${w.idx}:v]${back}fps=${R}${n > 1 ? `,split=${n}` : ""}${outs}` : `[${w.idx}:a]${back}aresample=48000${n > 1 ? `,asplit=${n}` : ""}${outs}`);
    }
  };

  // 1. Picture (not in the measuring pass): put each video on a 30 fps grid, take its parts and join them in edit
  // order. Parts start and end on frames (planRender), so each is a whole number of frames.
  let v = "";
  /** Phase 2: the person's matte over the whole edit (when layers go behind the person). */
  let personMatte: string | null = null;
  if (!opts.measure) {
    const vt = (k: { srcIn: number; srcOut: number }) => `trim=start=${n6(k.srcIn)}:end=${n6(k.srcOut)},setpts=PTS-STARTPTS`;
    const turnOf = (r: number) => (r === 90 ? "transpose=1," : r === 270 ? "transpose=2," : r === 180 ? "hflip,vflip," : "");
    // HDR originals are tone-mapped to SDR BT.709 exactly like the preview copy, so the final looks like the preview
    // (Phase 6: unless the output keeps HDR; a graded or keyed HDR clip is still graded on that SDR picture).
    const toneOf = (vid: string, dom: "sdr" | "hdr" = "sdr") => (info(vid).hdr && dom === "sdr" ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "");
    /** Where a clip's picture lives: HDR (10-bit, the output's transfer) or SDR (graded, keyed, other transfer, or SDR). */
    // A graded, keyed or retouched HDR clip is worked in SDR, as the editor shows it (the skin is found in SDR colours).
    const domOf = (vid: string, look: LookOp | undefined): "sdr" | "hdr" => (hdr && info(vid).hdr && (info(vid).transfer ?? "pq") === hdr.transfer && !look?.grade && !look?.key && !look?.skin ? "hdr" : "sdr");
    const fit = `fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4,setsar=1`;
    // Reframed (a framing's focus): the fit cuts around that point of the footage, as near as its edges allow (fitCrop).
    const fitFor = (f: Framing | null | undefined) => (f?.focus ? `fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:x='clip(${n3(f.focus.x)}*iw-ow/2,0,iw-ow)':y='clip(${n3(f.focus.y)}*ih-oh*0.4,0,ih-oh)',setsar=1` : fit);
    // Scale and offset after the fit (a focus alone only moves the fit).
    const moved = (f: Framing | null | undefined) => (f && (f.scale !== 1 || f.x || f.y) ? f : null);
    const frame = (from: string, f: Framing, to: string, tag: string, canvas: "black" | "clear" | { base: string } = "black", card?: CardOp, frames?: number) => {
      // The fitted picture is scaled about its centre and moved over a black frame (Phase 6: over what is behind V1, or
      // a clear frame when keyframes move it next). A card: its shadow under it, its border over it.
      const sw = even(W * f.scale), sh = even(H * f.scale);
      const ox = Math.round((W - sw) / 2 + f.x * W), oy = Math.round((H - sh) / 2 + f.y * H);
      if (canvas === "black") g.push(`color=c=black:s=${W}x${H}:r=${R}${hdr ? `,format=${PF}` : ""}[fcanvas${tag}]`);
      else if (canvas === "clear") g.push(`color=c=black@0:s=${W}x${H}:r=${R},format=${PFA}[fcanvas${tag}]`);
      let under = typeof canvas === "object" ? canvas.base : `fcanvas${tag}`;
      const fmt = canvas === "clear" ? PFA : PF;
      if (card?.shadow && frames) { fillOver(under, card.shadow, frames, `fsh${tag}`, fmt); under = `fsh${tag}`; }
      g.push(`[${from}]scale=${sw}:${sh},setsar=1[fscaled${tag}]`);
      const top = card?.border && frames ? `fpre${tag}` : to;
      g.push(`[${under}][fscaled${tag}]overlay=x=${ox}:y=${oy}:shortest=1${canvas === "clear" ? `:format=auto,format=${PFA}` : `,format=${PF}`}[${top}]`);
      if (card?.border && frames) fillOver(top, card.border, frames, to, fmt);
    };
    const motion = plan.clipMotion ?? {};
    // Branches of each video's decoder, handed out as segments ask for them (split once all are known).
    let nBranch = 0;
    /** A branch of the video's decoder for footage a..b (seconds): from the window that reads there. */
    const branch = (vid: string, a: number, b: number) => { const l = `sv${nBranch++}`; take("v", vid, a, b, l); return l; };
    const pathOf = (vid: string) => srcPath[vid] ?? (vid === main ? files.source : files.videos?.[vid])!;
    /**
     * One stretch of picture as exactly round(length x 30) frames at output size: its footage at its rate (reversed in
     * 1 s chunks, each from its own input so memory stays small; frozen = one frame held), turned, fitted, framed and
     * moved by its clip's keyframes. `exact` pads or trims to the frame count (transition sides).
     */
    // Phase 7: a stabilized part smoothed by the shake its own frames showed (the worker's vidstabdetect pass over the same
    // frames), zoomed in just enough to hide the edges.
    const stab = (x: { srcIn: number; clipIds?: string[] }) => {
      const st = x.clipIds ? plan.stabilize?.[stabilizeKey({ clipIds: x.clipIds, srcIn: x.srcIn })] : undefined, f = st ? files.stabilize?.[stabilizeKey({ clipIds: x.clipIds!, srcIn: x.srcIn })] : undefined;
      return st && f ? `,vidstabtransform=input=${q(f)}:smoothing=${st.smoothing}:optzoom=1:interpol=bicubic` : "";
    };
    const drawSeg = (x0: { videoId: string; srcIn: number; srcOut: number; rate?: number; start: number; end: number; rotate: number; framing: Framing | null; clipIds?: string[]; clipId?: string; flip?: "h" | "v" | "both"; interp?: "blend" | "flow" }, out: string, tag: string, exact = false) => {
      const N = Math.max(1, Math.round((x0.end - x0.start) * FPS));
      const r = rateOf(x0);
      // Phase 21: footage read from the clip's stabilized copy when it has one (times shifted to the copy's); the look,
      // mattes and keys keep the footage's own (x0).
      const cp = readFrom(x0.clipId ?? (x0.clipIds?.length === 1 ? x0.clipIds[0] : undefined), x0.videoId, x0.srcIn, r === 0 ? x0.srcIn : x0.srcOut);
      const x = cp ? { ...x0, videoId: cp.vid, srcIn: x0.srcIn - cp.d, srcOut: x0.srcOut - cp.d } : x0;
      const lk = looks[x.clipId ?? x.clipIds?.[0] ?? ""], dom = domOf(x0.videoId, lk);
      const look = `${turnOf(x.rotate)}${flipFilter(x.flip)}${toneOf(x0.videoId, dom)}${fitFor(x.framing)}`;
      // tpad clones a frame at the link's frame rate: without a rate (after trim) FFmpeg 7 gives the clones one
      // timestamp and they are dropped, so the stream is put on the 30 fps grid first.
      const pad = `,fps=${R},tpad=stop_mode=clone:stop=2,trim=end_frame=${N}`;
      // At another speed output frame n shows source frame floor(rate x n) of the stretch (in play order): frame j goes to
      // tick ceil(j / rate) and fps keeps the last frame of each tick. The player shows the same frame (showAt).
      const pick = (rate: number) => `settb=${TB},setpts=ceil(N/${rate}-0.000001),fps=${R}`;
      let chain: string;
      if (r < 0) {
        const parts: string[] = [];
        for (let b = x.srcOut, j = 0; b > x.srcIn + 1e-6; b -= 1, j++) {
          const a = Math.max(x.srcIn, b - 1), M = Math.max(1, Math.round((b - a) * FPS));
          inputs.push("-ss", n6(a), "-t", n3(b - a + 0.25), "-i", pathOf(x.videoId));
          const ii = idx++;
          g.push(`[${ii}:v]fps=${R},trim=end_frame=${M},${look},reverse,setpts=PTS-STARTPTS[rc${tag}_${j}]`);
          parts.push(`[rc${tag}_${j}]`);
        }
        chain = `${parts.join("")}concat=n=${parts.length}:v=1:a=0,${pick(-r)}${pad}`;
      } else if (r === 0) chain = `[${branch(x.videoId, x.srcIn, x.srcIn + 1 / FPS)}]trim=start=${n6(x.srcIn)}:end=${n6(x.srcIn + 1 / FPS)},setpts=PTS-STARTPTS,fps=${R},tpad=stop_mode=clone:stop=${N},trim=end_frame=${N},${look}`;
      else if (r > 0 && r < 1 && x.interp) {
        // Phase 11: slow motion's in-between frames made (blend: neighbours mixed; flow: optical flow, motion-compensated),
        // output frame n at footage srcIn + n x rate, as frame sampling shows it. Two frames past the end feed the last.
        const mi = x.interp === "flow" ? "mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none" : "mi_mode=blend:scd=none";
        chain = `[${branch(x.videoId, x.srcIn, x.srcOut + 2 / FPS)}]trim=start=${n6(x.srcIn)}:end=${n6(x.srcOut + 2 / FPS)},fps=${R},settb=1/90000,setpts=(PTS-STARTPTS)/${n6(r)},minterpolate=fps=${R}:${mi}${pad},${look}`;
      }
      else if (r !== 1) chain = `[${branch(x.videoId, x.srcIn, x.srcOut + 1 / FPS)}]trim=start=${n6(x.srcIn)}:end=${n6(x.srcOut + 1 / FPS)},${pick(r)}${pad},${look}`;
      else chain = `[${branch(x.videoId, x.srcIn, x.srcOut)}]${vt(x)}${cp ? "" : stab(x)}${exact ? pad : ""},${look}`;
      // remove_background: the matte through the same trim, speed, turn and fit (not reversed clips: they keep theirs).
      // Phase 2: a main part under a layer behind the person reads one too (plan.person.parts), kept apart.
      const personM = /^\d+$/.test(tag) ? plan.person?.parts[Number(tag)] : undefined;
      // A stream in footage time made to follow this segment as its picture does (its trim, speed, freeze).
      const steps = r < 0 ? undefined : r === 0 ? `trim=start=${n6(x0.srcIn)}:end=${n6(x0.srcIn + 1 / FPS)},setpts=PTS-STARTPTS,fps=${R},tpad=stop_mode=clone:stop=${N},trim=end_frame=${N}`
        : r !== 1 ? `trim=start=${n6(x0.srcIn)}:end=${n6(x0.srcOut + 1 / FPS)},${pick(r)}${pad}` : `${vt(x0)}${exact ? pad : ""}`;
      if ((lk?.subject || personM) && r >= 0) {
        const mt = matteIn(lk?.subject?.matte ?? personM!, x0.srcIn, r === 0 ? x0.srcIn + 1 / FPS : x0.srcOut + 1 / FPS);
        const both = !!lk?.subject && !!personM;
        g.push(`[${mt}]${steps},${turnOf(x.rotate)}${flipFilter(x.flip)}${fitFor(x.framing)},format=gray${both ? `,split[mf${tag}][mp${tag}]` : `[${lk?.subject ? "mf" : "mp"}${tag}]`}`);
        if (lk?.subject) mattesFor[tag] = `mf${tag}`;
        if (personM) personFor[tag] = `mp${tag}`;
      } else if ((lk?.subject || personM) && r < 0) {
        // Phase 18: a reversed clip: its matte in the same 1 s pieces as its picture, each played backwards, joined.
        const name = lk?.subject?.matte ?? personM!, ps: string[] = [];
        for (let b = x0.srcOut, j = 0; b > x0.srcIn + 1e-6; b -= 1, j++) {
          const a = Math.max(x0.srcIn, b - 1), M = Math.max(1, Math.round((b - a) * FPS));
          const mt = matteIn(name, a, b + 1 / FPS);
          g.push(`[${mt}]trim=start=${n6(a)}:end=${n6(b + 1 / FPS)},setpts=PTS-STARTPTS,fps=${R},trim=end_frame=${M},${turnOf(x.rotate)}${flipFilter(x.flip)}${fitFor(x.framing)},format=gray,reverse,setpts=PTS-STARTPTS[mrc${tag}_${j}]`);
          ps.push(`[mrc${tag}_${j}]`);
        }
        const both = !!lk?.subject && !!personM;
        g.push(`${ps.join("")}concat=n=${ps.length}:v=1:a=0,${pick(-r)}${pad},format=gray${both ? `,split[mf${tag}][mp${tag}]` : `[${lk?.subject ? "mf" : "mp"}${tag}]`}`);
        if (lk?.subject) mattesFor[tag] = `mf${tag}`;
        if (personM) personFor[tag] = `mp${tag}`;
      }
      const clipId = x.clipId ?? (x.clipIds?.length === 1 ? x.clipIds[0] : undefined);
      const m = clipId ? motion[clipId] : undefined;
      // A card is drawn through frame() (its shadow and border), framed or not.
      const card = plan.cards?.[x.clipId ?? x.clipIds?.[0] ?? ""];
      const frm = moved(x.framing) ?? (card ? { scale: 1, x: 0, y: 0 } : null);
      // The clip's own picture, blurred, as the background: taken before its look (where something shows behind it).
      const blurBg = !!bg?.blur && (!!frm || !!lk?.alpha || !!m);
      if (!lk && !hdr && !frm && !m) { g.push(`${chain},format=yuv420p[${out}]`); return; }
      if (!lk && !hdr) g.push(`${chain},format=yuv420p${blurBg ? `,split[pf${tag}][pbs${tag}]` : `[pf${tag}]`}`);
      else g.push(`${chain}${blurBg ? `,split[pc${tag}][pbs${tag}]` : `[pc${tag}]`}`);
      const c = !lk && !hdr ? { out: `pf${tag}`, alpha: false } : colorChain(`pc${tag}`, lk, dom, N, tag, steps && `${steps},tpad=stop_mode=clone:stop=2`);
      let cur = c.out;
      // Phase 6: what shows around or through the clip is what is behind V1 (black, the background, or b-roll laid under it).
      const behind = () => (underClips.length || bg ? baseOf(x.start, N, tag, blurBg ? `pbs${tag}` : undefined, dom) : null);
      if (!frm && !m) {
        if (c.alpha) { const b = behind(); if (b) g.push(`[${b}][${cur}]overlay=format=auto,format=${PF}[${out}]`); else { g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${n6(N / FPS + 1)},format=${PF},trim=end_frame=${N}[pb${tag}]`); g.push(`[pb${tag}][${cur}]overlay=format=auto,format=${PF}[${out}]`); } }
        else g.push(`[${cur}]format=${PF}[${out}]`);
        return;
      }
      if (frm) { const b = m ? null : behind(); frame(cur, frm, `pg${tag}`, tag, m ? "clear" : b ? { base: b } : "black", card, N); cur = `pg${tag}`; }
      if (m) { motionChain(g, cur, out, m.keys, x.start - m.start, N, W, H, true, tag, { base: behind() ?? undefined, hdr: !!hdr, fr, anchor: m.anchor, blur: m.motionBlur }); return; }
      g.push(`[${cur}]format=${PF}[${out}]`);
    };

    const N = plan.parts.length;
    // One video, one look, all at normal speed and still: cut, join, then fit once (the same graph model A used).
    // Otherwise each part is drawn on its own first.
    const lookKey = (p: PicturePart) => JSON.stringify(looks[p.clipIds[0]] ?? null);
    const uniform = plan.sources.length === 1 && !underClips.length && !(bg?.videoId) && plan.parts.every((p) => rateOf(p) === 1 && !p.flip && p.rotate === plan.parts[0].rotate && sameFraming(p.framing, plan.parts[0].framing) && !(p.clipIds.length === 1 && motion[p.clipIds[0]]) && lookKey(p) === lookKey(plan.parts[0])) && !Object.values(looks).some((l) => l.subject || isMovingLook(l)) && !Object.keys(plan.person?.parts ?? {}).length && !plan.stabilize && !plan.stabilized;
    plan.parts.forEach((p, i) => { if (uniform) g.push(`[${branch(p.videoId, p.srcIn, p.srcOut)}]${vt(p)}[v${i}]`); else drawSeg(p, `v${i}`, String(i)); });
    const withPerson = !!plan.person?.windows.length && Object.keys(personFor).length > 0;
    const blackFrom = new Set<number>();
    if (withPerson) plan.parts.forEach((_, i) => {
      if (personFor[String(i)]) return;
      g.push(`[v${i}]split[vp${i}][vq${i}];[vq${i}]format=gray,lut=c0=0[mp${i}]`);
      personFor[String(i)] = `mp${i}`;
      blackFrom.add(i);
    });
    const pic = (i: number) => (blackFrom.has(i) ? `[vp${i}]` : `[v${i}]`);
    // concat's output counts in microseconds, a hair before each frame's exact time; back on the 1/30 s grid so every
    // overlay below lines up with its own frame (else each one shows a frame late).
    g.push(`${plan.parts.map((_, i) => pic(i)).join("")}concat=n=${N}:v=1:a=0${uniform ? "" : `,settb=${TB}`}[vcat]`);
    if (withPerson) { g.push(`${plan.parts.map((_, i) => `[${personFor[String(i)]}]`).join("")}concat=n=${N}:v=1:a=0,settb=${TB}[pmatte]`); personMatte = "pmatte"; }
    v = "vcat";
    if (uniform) {
      const p0 = plan.parts[0], lk = looks[p0.clipIds[0]], dom = domOf(p0.videoId, lk);
      const card = plan.cards?.[p0.clipIds[0]];
      const frm = moved(p0.framing) ?? (card ? { scale: 1, x: 0, y: 0 } : null);
      const blurBg = !!bg?.blur && (!!frm || !!lk?.alpha);
      g.push(`[vcat]${turnOf(p0.rotate)}${toneOf(p0.videoId, dom)}${fitFor(p0.framing)}${blurBg ? ",split[vfit][vbs]" : "[vfit]"}`);
      v = "vfit";
      // Phase 6: one look for the whole edit, drawn once (keyed or masked parts show what is behind V1).
      const all = Math.max(1, Math.round((plan.window ? plan.parts[plan.parts.length - 1].end - plan.parts[0].start : plan.outputSeconds) * FPS));
      const c = colorChain(v, lk, dom, all, "u");
      v = c.out;
      const back = () => (bg ? backOf(plan.window ? plan.parts[0].start : 0, all, "U", blurBg ? "vbs" : undefined, dom) : null);
      if (c.alpha && !frm) {
        const b = back();
        if (!b) g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${n6(all / FPS + 1)},format=${PF},trim=end_frame=${all}[ubk]`);
        g.push(`[${b ?? "ubk"}][${v}]overlay=format=auto,format=${PF}[vlook]`); v = "vlook";
      }
      if (frm) { const b = back(); frame(v, frm, "vframed", "", b ? { base: b } : "black", card, all); v = "vframed"; }
    }

    // Samples: the joined picture (only the window's parts) moved to its edit time, so everything laid on it below
    // (transitions, zooms, overlays, captions) keeps its own times. It may start a little before the window (a part at
    // another speed starts on a whole frame of its footage); the end result is trimmed to the window.
    if (plan.window) {
      const k = Math.round(plan.parts[0].start * FPS);
      g.push(`[${v}]settb=${TB},setpts=PTS+${k}[vwin]`); v = "vwin";
      if (personMatte) { g.push(`[${personMatte}]settb=${TB},setpts=PTS+${k}[pmwin]`); personMatte = "pmwin"; }
    }
    // Transitions (Phase 5), laid over the joined picture: dips are a colour fading in to the cut and out after it;
    // dissolve, slide and whip are drawn from both sides' footage over the whole window.
    (plan.transitions ?? []).forEach((t, i) => {
      const D = t.end - t.start;
      if (D < 1 / FPS - 1e-9 || t.type === "zoom") return;
      const span = `enable='between(t,${n6(t.start)},${n6(t.end - 0.5 / FPS)})':eof_action=pass`;
      if (t.type === "dip-black" || t.type === "dip-white") {
        const up = t.at - t.start, down = t.end - t.at;
        // In an HDR output white is SDR white (203 nits), as everything SDR is placed.
        const white = hdr ? "0x" + sdrToHdr(1, 1, 1, hdr.transfer).map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase() : "0xFFFFFF";
        g.push(`color=c=${t.type === "dip-black" ? "0x000000" : white}:s=${W}x${H}:r=${R}:d=${n6(D)},format=${PFA}${up > 1e-6 ? `,fade=t=in:st=0:d=${n6(up)}:alpha=1` : ""},fade=t=out:st=${n6(up)}:d=${n6(down)}:alpha=1,setpts=PTS-STARTPTS+${Math.round(t.start * FPS)}[dp${i}]`);
        g.push(`[${v}][dp${i}]overlay=${span}${hdr ? `:format=auto,format=${PF}` : ""}[vd${i}]`);
        v = `vd${i}`;
        return;
      }
      const side = (segs: Seg[], name: string) => {
        segs.forEach((s, j) => drawSeg(s, `${name}${j}`, `${name}${j}`, true));
        if (segs.length === 1) return `${name}0`;
        g.push(`${segs.map((_, j) => `[${name}${j}]`).join("")}concat=n=${segs.length}:v=1:a=0[${name}]`);
        return name;
      };
      const a = side(t.a, `ta${i}_`), b = side(t.b, `tb${i}_`);
      const [dx, dy] = dirVec(t.dir);
      const p = `(t/${n6(D)})`;
      const xf = xfadeOf(t.type, t.dir);
      if (xf) {
        // Phase 12: FFmpeg's xfade over the window, both sides on the same frames. A film dissolve mixes in linear light.
        const n = Math.max(1, Math.round(D * FPS)), film = t.type === "film-dissolve";
        const lin = (e: string) => `format=gbrp16le,lutrgb=r='${e}':g='${e}':b='${e}'`;
        g.push(`[${a}]fps=${R},settb=${TB},setpts=PTS-STARTPTS,${film ? lin("pow(val/65535,2.2)*65535") : `format=${PF}`}[xa${i}]`);
        g.push(`[${b}]fps=${R},settb=${TB},setpts=PTS-STARTPTS,${film ? lin("pow(val/65535,2.2)*65535") : `format=${PF}`}[xb${i}]`);
        g.push(`[xa${i}][xb${i}]xfade=transition=${xf}:duration=${n6(D)}:offset=0,trim=end_frame=${n}${film ? `,${lin("pow(val/65535,1/2.2)*65535")}` : ""},format=${PF}[tx${i}]`);
      }
      else if (t.type === "dissolve") g.push(`[${b}]format=${PFA},fade=t=in:st=0:d=${n6(D)}:alpha=1[tbf${i}];[${a}][tbf${i}]overlay=format=auto,format=${PF}[tx${i}]`);
      else if (t.type === "morph") {
        // Phase 8 (Morph Cut): A's frame at the window's start and B's at its end, D apart, and the frames between made by
        // motion-compensated interpolation (minterpolate: block motion both ways, overlapped blocks), so the head moves
        // from one place to the other instead of jumping. minterpolate gives nothing for two frames (it needs the frames
        // round the pair) and stops at a scene change: each frame goes in twice, the stretch between the second A and the
        // first B is kept, and scene detection is off.
        const n = Math.max(1, Math.round(D * FPS)), ms = Math.round(D * 1000);
        g.push(`[${a}]trim=end_frame=1,setpts=PTS-STARTPTS,split[mfa${i}][mfc${i}]`);
        g.push(`[${b}]reverse,trim=end_frame=1,setpts=PTS-STARTPTS,split[mfb${i}][mfd${i}]`);
        g.push(`[mfa${i}][mfc${i}][mfb${i}][mfd${i}]concat=n=4:v=1:a=0,settb=1/1000,setpts=N*${ms},minterpolate=fps=${R}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:search_param=64:scd=none,trim=start=${n6(ms / 1000)},setpts=PTS-STARTPTS,trim=end_frame=${n},format=${PF}[tx${i}]`);
      }
      else if (t.type === "slide") g.push(`[${a}][${b}]overlay=x='${-dx * W}*(1-${smoothExpr(p)})':y='${-dy * H}*(1-${smoothExpr(p)})':eval=frame${hdr ? ":format=auto" : ""},format=${PF}[tx${i}]`);
      else {
        // Whip: both sides move together, blurred along the move (strongest at the cut).
        const e = smoothExpr(p);
        const cmds = Array.from({ length: Math.round(D * FPS) }, (_, k) => `${n3(k / FPS)} gblur@wp${i} ${dx ? "sigma" : "sigmaV"} ${Math.max(0.01, (dx ? W : H) * WHIP_BLUR * Math.sin((Math.PI * k) / (D * FPS))).toFixed(2)}`).join(";");
        g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${n6(D)}${hdr ? `,format=${PF}` : ""}[wc${i}]`);
        g.push(`[wc${i}][${a}]overlay=x='${dx * W}*${e}':y='${dy * H}*${e}':eval=frame${hdr ? ":format=auto" : ""}[wa${i}]`);
        g.push(`[wa${i}][${b}]overlay=x='${dx * W}*(${e}-1)':y='${dy * H}*(${e}-1)':eval=frame${hdr ? ":format=auto" : ""},sendcmd=c='${cmds}',gblur@wp${i}=sigma=0.01:sigmaV=0.01,format=${PF}[tx${i}]`);
      }
      g.push(`[tx${i}]settb=${TB},setpts=PTS-STARTPTS+${Math.round(t.start * FPS)}[txo${i}]`);
      g.push(`[${v}][txo${i}]overlay=${span}${hdr ? `:format=auto,format=${PF}` : ""}[vt${i}]`);
      v = `vt${i}`;
    });
    // Each window's decoder, split into the branches its segments took.
    openWindows("v");
  }

  // Samples: a still is picture only (no sound is read or made).
  if (!opts.still) {
    // 2. Dialogue: each sound part from its video (sample-exact), silence for muted parts and parts silent at their speed,
    // joined in edit order. A clip off normal speed plays its stretch through atempo (pitch kept), its speed changing at
    // each step's footage moment. Every unit fades in and out over the declick time (20 ms by default), so no cut clicks.
    const live = (x: SoundPart) => !x.muted && !x.silent && info(x.videoId).hasAudio && srcPath[x.videoId] != null;
    const units: SoundPart[][] = [];
    for (const x of plan.sound) {
      const u = units[units.length - 1], prev = u?.[u.length - 1];
      // A ramp's steps are footage that goes on (each step's ends were put on frames, so they meet within a frame).
      const goesOn = !!prev && live(prev) && live(x) && prev.clipId === x.clipId && prev.videoId === x.videoId && (rateOf(prev) !== 1 || rateOf(x) !== 1) && rateOf(prev) > 0 && rateOf(x) > 0 && Math.abs(prev.srcOut - x.srcIn) <= 1 / FPS + 1e-6;
      if (goesOn) u.push(x); else units.push([x]);
    }
    const editSamples = (u: SoundPart[]) => Math.max(1, Math.round(u.reduce((acc, x) => acc + (rateOf(x) === 1 ? x.srcOut - x.srcIn : rateOf(x) === 0 ? Math.round((x.end - x.start) * FPS) / FPS : Math.round(((x.srcOut - x.srcIn) / Math.abs(rateOf(x))) * FPS) / FPS), 0) * 48000));
    const declick = (len: number, inSide = true, outSide = true) => {
      if (!mix || !(mix.declick > 0) || (!inSide && !outSide)) return "";
      const d = Math.min(mix.declick, len / 4);
      return `${inSide ? `,afade=t=in:d=${n6(d)}` : ""}${outSide ? `,afade=t=out:st=${n6(len - d)}:d=${n6(d)}` : ""}`;
    };
    // Phase 6: an equal-power crossfade at a dialogue cut overlaps the two sides by `xf`, each reading half of it from the
    // footage past its own cut (so nothing moves); there the declick fade is left out. Only where both sides are footage
    // at normal speed, long enough, with footage to spare.
    const xf = mix?.crossfade && mix.crossfade > 0 ? mix.crossfade : 0, hx = xf / 2;
    const plainUnit = (u: SoundPart[]) => u.length === 1 && rateOf(u[0]) === 1 && live(u[0]);
    const joined = units.map((u, i) => xf > 0 && i + 1 < units.length && plainUnit(u) && plainUnit(units[i + 1]) && u[0].srcOut + hx <= (info(u[0].videoId).seconds ?? 0) - 0.005 && units[i + 1][0].srcIn - hx >= 0 && u[0].srcOut - u[0].srcIn > xf && units[i + 1][0].srcOut - units[i + 1][0].srcIn > xf);
    const pre = (i: number) => (i > 0 && joined[i - 1] ? hx : 0), post = (i: number) => (joined[i] ? hx : 0);
    const at = (k: SoundPart, a = 0, b = 0) => `atrim=start=${n6(k.srcIn - a)}:end=${n6(k.srcOut + b)},asetpts=PTS-STARTPTS${declick(k.srcOut - k.srcIn + a + b, !a, !b)}`;
    const tempo = (u: SoundPart[]) => {
      const a = u[0].srcIn, n = editSamples(u);
      const cmds = u.slice(1).map((x) => `${n6(x.srcIn - a)} atempo@at${u[0].start.toFixed(3).replace(".", "_")} tempo ${rateOf(x)}`).join(";");
      const name = `atempo@at${u[0].start.toFixed(3).replace(".", "_")}`;
      return `atrim=start=${n6(a)}:end=${n6(u[u.length - 1].srcOut)},asetpts=PTS-STARTPTS,asetnsamples=n=480${cmds ? `,asendcmd=c='${cmds}'` : ""},${name}=tempo=${rateOf(u[0])},apad,atrim=end_sample=${n},asetpts=PTS-STARTPTS${declick(n / 48000)}`;
    };
    // The user's own file in place of every clip's sound (set_voice): no footage sound is read at all.
    const voice = plan.audio.find((a) => a.kind === "voice" && files.audio?.[a.clipId]);
    if (voice) units.length = 0;
    // Each sound unit from the window that reads its footage, in edit order.
    units.forEach((u, i) => {
      if (!live(u[0])) return;
      take("a", u[0].videoId, Math.min(...u.map((x) => x.srcIn)) - pre(i), Math.max(...u.map((x) => x.srcOut)) + post(i), `sa${i}`);
      // Phase 6: the clip's own pan, EQ and reverb on its sound, before the joins.
      const fx = mix?.clipFx?.[u[0].clipId];
      g.push(`[sa${i}]${u.length === 1 && rateOf(u[0]) === 1 ? at(u[0], pre(i), post(i)) : tempo(u)}[${fx ? `au${i}` : `a${i}`}]`);
      if (fx) g.push(`[${soundFx(g, inputs, () => idx++, files, `au${i}`, fx, `d${i}`)}]anull[a${i}]`);
    });
    openWindows("a");
    units.forEach((u, i) => { if (!live(u[0])) g.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${editSamples(u)},asetpts=PTS-STARTPTS[a${i}]`); });
    // The sound ends where the edit does, to the millisecond; the picture on its last frame: the sound is padded or
    // cut to the picture's length (under half a frame).
    if (voice) {
      inputs.push("-i", files.audio!.voice);
      const vi = idx++;
      const d = Math.max(0.001, voice.end - voice.start);
      g.push(`[${vi}:a]atrim=0:${n6(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${voice.gainDb}dB,adelay=delays=${Math.round(voice.start * 1000)}:all=1,apad=whole_dur=${n6(plan.outputSeconds)},atrim=end=${n6(plan.outputSeconds)}[acat]`);
    } else {
      // Units joined by a crossfade become one stream first (each acrossfade overlaps the two by xf), then all are joined.
      const parts: string[] = [];
      for (let i = 0; i < units.length; i++) {
        let cur = `a${i}`;
        while (joined[i]) { g.push(`[${cur}][a${i + 1}]acrossfade=d=${n6(xf)}:c1=qsin:c2=qsin[ax${i + 1}]`); cur = `ax${i + 1}`; i++; }
        parts.push(`[${cur}]`);
      }
      g.push(`${parts.join("")}concat=n=${parts.length}:v=0:a=1,apad=whole_dur=${n6(plan.outputSeconds)},atrim=end=${n6(plan.outputSeconds)}[acat]`);
    }
  }

  if (opts.pictureAs && !opts.measure) {
    g.push(`[${v}]null[vdrop];color=c=${opts.pictureAs}:s=${plan.width}x${plan.height}:r=${plan.rate || "30"}:d=${n6(plan.outputSeconds + 1)},format=${PF},trim=end=${n6(plan.outputSeconds)}[vplain]`);
    g.push(`[vdrop]nullsink`);
    v = "vplain";
  }
  if (!opts.measure) v = overlays(opts.pictureAs ? { ...plan, broll: [], under: [], zooms: [], adjust: undefined, person: undefined } : plan, files, g, inputs, () => idx++, v, { still: !!opts.still, colorChain, PF, PFA, hdrLut: hdr ? lookPath(hdr.lut) : null, person: opts.pictureAs ? null : personMatte,
    // Phase 18: a b-roll clip's matte, put through its own steps, for its look's subject (by its colour chain's tag).
    subjectMatte: (name: string, from: number, to: number, steps: string, tag: string) => { const mt = matteIn(name, from, to); g.push(`[${mt}]${steps},format=gray[smf${tag}]`); mattesFor[tag] = `smf${tag}`; } });
  if (!opts.still) mixAudio(plan, files, g, inputs, () => idx++, opts);
  // Windows that read from the start left empty placeholders where a seek would go (they never move an input's place).
  const windows: Record<string, number> = {};
  for (const w of wins) if (w.made === "v") windows[w.vid] = (windows[w.vid] || 0) + 1;
  return { args: encodeArgs(plan, inputs.filter((a) => a !== ""), files, opts), filterGraph: g.join(";\n"), windows };
}

/**
 * Keyframes as filters on [inp], a W x H picture `frames` long (Phase 5). FFmpeg's perspective filter puts the
 * picture's four corners where the keys move, scale and turn it, frame by frame, transparent around it; opacity
 * multiplies its alpha. The curves are the same tables the player reads (motion.ts). opaque: laid on black (V1);
 * otherwise it keeps its alpha (b-roll, graphics). `offset`: seconds into the clip at the picture's first frame.
 */
export function motionChain(g: string[], inp: string, out: string, keys: Key[], offset: number, frames: number, W: number, H: number, opaque: boolean, tag: string, o: { base?: string; hdr?: boolean; fr?: { fps: number; rate: string }; anchor?: { x: number; y: number }; blur?: number } = {}) {
  const FPS = o.fr?.fps ?? 30, RATE = o.fr?.rate ?? String(FPS);
  const tracks = keyTracks(keys);
  if (!tracks) { g.push(`[${inp}]null[${out}]`); return; }
  // A picture that only ever gets small is scaled down first (a proper scaler), so the corner mapping does not alias.
  const [, smax] = scaleRange(tracks);
  const pre = smax < 0.75 ? Math.max(0.05, smax) : 1;
  const P = 2, CW = W + 2 * P, CH = H + 2 * P;
  // Phase 11: motion blur: the movement drawn at SUB times the frame rate and the last frames of each frame's shutter
  // averaged (premultiplied, so edges do not darken), then back to the frame rate.
  const SUB = o.blur ? 4 : 1, K = o.blur ? Math.max(2, Math.round((SUB * o.blur) / 100)) : 1;
  const tv = `((in-1)/${FPS * SUB}+${n6(offset)})`; // perspective counts frames from 1
  const S = motionExpr(tracks, "scale", tv), X = motionExpr(tracks, "x", tv), Y = motionExpr(tracks, "y", tv);
  const R = `(${motionExpr(tracks, "rotation", tv)})*PI/180`;
  const k = pre === 1 ? S : `${S}/${pre}`;
  // Phase 11: the anchor (Premiere's Anchor Point): the point of the picture it turns and scales about, which the
  // position keys move. In the padded canvas: where it is on the (shrunk) picture, and where it lands in the frame.
  const ax = o.anchor?.x ?? 0.5, ay = o.anchor?.y ?? 0.5;
  const AXs = CW / 2 + (ax - 0.5) * W * pre, AYs = CH / 2 + (ay - 0.5) * H * pre, AXd = CW / 2 + (ax - 0.5) * W, AYd = CH / 2 + (ay - 0.5) * H;
  const corner = (i: number, sx: number, sy: number) => {
    const dx = r3((sx * CW) / 2 + CW / 2 - AXs), dy = r3((sy * CH) / 2 + CH / 2 - AYs);
    return `x${i}='${r3(AXd)}+${W}*${X}+${k}*(${dx}*cos(${R})-(${dy})*sin(${R}))':y${i}='${r3(AYd)}+${H}*${Y}+${k}*(${dx}*sin(${R})+(${dy})*cos(${R}))'`;
  };
  const shrink = pre < 1 ? `,scale=${even(W * pre)}:${even(H * pre)}` : "";
  const sub = SUB > 1 ? `fps=${FPS * SUB},` : "";
  const blur = SUB > 1 ? `,format=yuva444p,premultiply=inplace=1,tmix=frames=${K},unpremultiply=inplace=1,fps=${RATE},trim=end_frame=${frames},format=yuva420p` : "";
  g.push(`[${inp}]${sub}format=yuva420p${shrink},pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=black@0,perspective=${corner(0, -1, -1)}:${corner(1, 1, -1)}:${corner(2, -1, 1)}:${corner(3, 1, 1)}:sense=destination:eval=frame,crop=${W}:${H}:${P}:${P}${blur}[mv${tag}]`);
  let cur = `mv${tag}`;
  if (tracks.opacity) {
    // The opacity curve on a 2x2 grey picture (cheap per frame), stretched over the frame and multiplied into the alpha.
    g.push(`color=c=white:s=2x2:r=${RATE}:d=${n6(frames / FPS + 1)},format=gray,geq=lum='255*clip(${motionExpr(tracks, "opacity", `(T+${n6(offset)})`)},0,1)',scale=${W}:${H},trim=end_frame=${frames}[mk${tag}]`);
    g.push(`[${cur}]split[ma${tag}][mb${tag}]`);
    g.push(`[ma${tag}]alphaextract[mc${tag}]`);
    g.push(`[mc${tag}][mk${tag}]blend=all_mode=multiply[md${tag}]`);
    g.push(`[mb${tag}][md${tag}]alphamerge[me${tag}]`);
    cur = `me${tag}`;
  }
  if (opaque) {
    // Over black, or (Phase 6) over what is behind V1.
    if (!o.base) g.push(`color=c=black:s=${W}x${H}:r=${RATE}:d=${n6(frames / FPS + 1)},trim=end_frame=${frames}[mbg${tag}]`);
    g.push(`[${o.base ?? `mbg${tag}`}][${cur}]overlay=format=auto,format=${o.hdr ? "yuv420p10le" : "yuv420p"}[${out}]`);
  } else g.push(`[${cur}]null[${out}]`);
}

/**
 * Phase 11: a layer's drop shadow: its alpha blurred, times the shadow's opacity, as the alpha of the shadow's colour,
 * moved by x, y (shares of the frame's short side), laid on `base` over the layer's time. The layer goes on as before.
 */
function dropShadow(g: string[], base: string, layer: string, sh: { color: string; opacity: number; blur: number; x: number; y: number }, op: { start: number; end: number }, n: number, W: number, H: number, tag: string, fr: { fps: number; rate: string }, deep: string | null): { base: string; layer: string } {
  const short = Math.min(W, H), sig = Math.max(0.5, (sh.blur * short) / 2), dx = Math.round(sh.x * short), dy = Math.round(sh.y * short);
  g.push(`[${layer}]split[sdl${tag}][sds${tag}]`);
  g.push(`[sds${tag}]alphaextract,gblur=sigma=${n3(sig)},lut=c0='val*${n3(sh.opacity)}'[sda${tag}]`);
  g.push(`color=c=${sh.color.replace("#", "0x")}:s=${W}x${H}:r=${fr.rate}:d=${n6(n / fr.fps + 1)},format=yuva420p,trim=end_frame=${n}[sdc${tag}]`);
  g.push(`[sdc${tag}][sda${tag}]alphamerge,settb=${timeBase(fr.rate)},setpts=PTS-STARTPTS+${Math.round(op.start * fr.fps)}[sdm${tag}]`);
  g.push(`[${base}][sdm${tag}]overlay=${dx}:${dy}:enable='between(t,${n6(op.start)},${n6(op.end - 0.5 / fr.fps)})':eof_action=pass${deep ? `:format=auto,format=${deep}` : ""}[sdv${tag}]`);
  return { base: `sdv${tag}`, layer: `sdl${tag}` };
}

type ColorCtx = { /** Samples: the picture ends as a JPEG still. */ still?: boolean; colorChain: (inp: string, look: LookOp | undefined, dom: "sdr" | "hdr", frames: number, tag: string) => { out: string; alpha: boolean }; PF: string; PFA: string; hdrLut: string | null; person?: string | null; subjectMatte?: (name: string, from: number, to: number, steps: string, tag: string) => void };
/** Zooms, b-roll, graphics, captions on [v]; returns the label of the finished picture ([vout]). */
function overlays(plan: RenderPlan, files: PlanFiles, g: string[], inputs: string[], next: () => number, v0: string, cc0: ColorCtx): string {
  let cc = cc0;
  const W = plan.width, H = plan.height;
  const FPS = plan.fps || 30, R = plan.rate || String(FPS), TB = timeBase(R), fr = { fps: FPS, rate: R };
  let v = v0;
  // 3. Zooms: scale per frame, crop back to size.
  if (plan.zooms.length) {
    const z = zoomExpr(plan.zooms);
    // crop's iw/ih are fixed when the filter starts, so the offsets are computed from the zoom itself
    // (centred across, 40% down, the same framing as the fit step).
    const zoom = `scale=w='2*trunc(${W}*(${z})/2)':h='2*trunc(${H}*(${z})/2)':eval=frame,crop=${W}:${H}:x='(2*trunc(${W}*(${z})/2)-${W})/2':y='(2*trunc(${H}*(${z})/2)-${H})*0.4'`;
    g.push(`[${v}]${zoom}[vzoom]`);
    v = "vzoom";
    if (cc.person && plan.person?.windows.length) { g.push(`[${cc.person}]${zoom}[pmz]`); cc = { ...cc, person: "pmz" }; }
  }
  // Phase 2: the person, cut from the picture as it is now (zoomed, before b-roll and graphics) by their matte, to be
  // laid back over the layers behind them. 10 bits: the matte goes in as a fourth plane (alphamerge is 8-bit only).
  let person: string | null = null;
  if (cc.person && plan.person?.windows.length) {
    g.push(`[${v}]split[vbase][vpsrc]`);
    v = "vbase";
    if (!plan.hdr) g.push(`[vpsrc][${cc.person}]alphamerge[vperson]`);
    else {
      g.push(`[${cc.person}]scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd,format=yuv420p10le,lutyuv=y='clip((val-64)*1023/876,0,1023)'[pmhdr]`);
      g.push(`[vpsrc][pmhdr]mergeplanes=map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=0:format=yuva420p10le[vperson]`);
    }
    person = "vperson";
  }
  // Phase 4: a layer's opacity (normal mode): its alpha times the opacity.
  const fadeTo = (o: number | undefined) => (o != null && o < 1 ? `format=${cc.PFA},lutyuv=a='val*${n3(o)}',` : "");
  /**
   * Phase 4: a layer with a blend mode. [layer] runs from the layer's start (pts 0), full frame, n frames. The picture
   * over those frames is taken out, blended with the layer in RGB (16-bit for HDR), mixed back by the layer's alpha
   * times its opacity (maskedmerge), and laid back over the picture in its place: frames outside are untouched.
   */
  const blendWindow = (base: string, layer: string, op: OverlayOp, n: number, tag: string): string => {
    const deep = !!plan.hdr, RGB = deep ? "gbrp16le" : "gbrp", RGBA = deep ? "gbrap16le" : "gbrap", GR = deep ? "gray16le" : "gray", mat = deep ? "bt2020" : "bt709";
    const bf = blendFilter(op.blend as Exclude<BlendMode, "normal">, deep ? 65535 : 255), o = op.opacity ?? 1;
    const S = n6(op.start), E = n6(op.start + n / FPS), rgb = (f: string) => `scale=in_color_matrix=${mat}:in_range=tv:flags=accurate_rnd,format=${f}`;
    g.push(`[${base}]split[bo${tag}][bw${tag}]`);
    g.push(`[bw${tag}]trim=start=${S}:end=${E},setpts=PTS-${S}/TB,${rgb(RGB)},split[bp${tag}][bq${tag}]`);
    g.push(`[${layer}]${rgb(RGBA)},split[lc${tag}][la${tag}]`);
    g.push(`[lc${tag}]format=${RGB}[lr${tag}]`);
    g.push(`[la${tag}]alphaextract,format=${GR}${o < 1 ? `,lut=c0='val*${n3(o)}'` : ""},split=3[l0${tag}][l1${tag}][l2${tag}]`);
    g.push(`[l0${tag}][l1${tag}][l2${tag}]mergeplanes=0x001020:${RGB}[lm${tag}]`);
    g.push(bf.layerOnTop ? `[lr${tag}][bp${tag}]${bf.filter}[lf${tag}]` : `[bp${tag}][lr${tag}]${bf.filter}[lf${tag}]`);
    g.push(`[bq${tag}][lf${tag}][lm${tag}]maskedmerge,scale=out_color_matrix=${mat}:out_range=tv:flags=accurate_rnd,format=${cc.PF},setpts=PTS+${S}/TB[lw${tag}]`);
    g.push(`[bo${tag}][lw${tag}]overlay=enable='between(t,${S},${n6(op.end - 0.5 / FPS)})':eof_action=pass${deep ? `:format=auto,format=${cc.PF}` : ""}[lv${tag}]`);
    return `lv${tag}`;
  };
  // 4. B-roll overlays (video only; the dialogue keeps playing underneath).
  plan.broll.forEach((b, i) => {
    const st = plan.stabilized?.[b.clipId], cpPath = st ? files.stableCopies?.[b.clipId] : undefined;
    const path = cpPath ?? files.broll?.[b.clipId];
    if (!path) return;
    // Phase 21: stabilized b-roll is read from its stabilized copy (its time starts at the copy's srcIn).
    inputs.push("-ss", n3(b.sourceStart - (cpPath ? st!.srcIn : 0)), "-t", n3(b.end - b.start), "-i", path);
    const bi = next();
    const n = Math.max(1, Math.round((b.end - b.start) * FPS));
    const look = plan.looks?.[b.clipId];
    if (b.keys?.length || look || plan.hdr || b.border) {
      // Keyframed b-roll: moved, scaled, turned and faded over the picture (picture-in-picture). Phase 6: its look
      // (grade, key, masks, blur) first; in an HDR output it goes in as SDR.
      g.push(`[${bi}:v]fps=${R},${flipFilter(b.flip)}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=${n}[bk${i}]`);
      // Phase 18: remove_background on b-roll: its own matte through the same trim, mirror and fit as its picture.
      if (look?.subject && cc.subjectMatte) cc.subjectMatte(look.subject.matte, b.sourceStart, b.sourceStart + n / FPS + 1 / FPS, `trim=start=${n6(b.sourceStart)}:end=${n6(b.sourceStart + n / FPS + 1 / FPS)},setpts=PTS-STARTPTS,fps=${R},${flipFilter(b.flip)}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=${n}`, `b${i}`);
      let cur = cc.colorChain(`bk${i}`, look, "sdr", n, `b${i}`).out;
      // Phase 17: a card's border, on its own frame before its keys move it (a ring inside the card: its alpha kept).
      const bp = b.border && files.looks?.[b.border.file];
      if (bp) {
        inputs.push("-i", bp);
        const ri = next();
        g.push(`[${ri}:v]format=gray,loop=loop=-1:size=1:start=0,settb=${TB},setpts=N,trim=end_frame=${n}[bda${i}]`);
        g.push(`color=c=0x${b.border!.color.slice(1).toUpperCase()}:s=${W}x${H}:r=${R},format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,trim=end_frame=${n},settb=${TB},setpts=N[bdc${i}]`);
        g.push(`[bdc${i}][bda${i}]alphamerge[bdf${i}]`);
        g.push(`[${cur}]settb=${TB},setpts=N[bdb${i}]`);
        g.push(`[bdb${i}][bdf${i}]overlay=format=auto,format=yuva420p[bdo${i}]`);
        cur = `bdo${i}`;
      }
      if (b.keys?.length) { motionChain(g, cur, `bm${i}`, b.keys, 0, n, W, H, false, `b${i}`, { hdr: !!plan.hdr, fr, anchor: b.anchor, blur: b.motionBlur }); cur = `bm${i}`; }
      // Phase 11: a b-roll card's drop shadow, from its own alpha (crop, corners, masks, its movement), laid on the
      // picture under it first.
      if (b.shadow && (look?.alpha || b.keys?.length)) { const d = dropShadow(g, v, cur, b.shadow, b, n, W, H, `b${i}`, fr, plan.hdr ? cc.PF : null); v = d.base; cur = d.layer; }
      if (b.blend) { g.push(`[${cur}]settb=${TB},setpts=PTS-STARTPTS[brl${i}]`); v = blendWindow(v, `brl${i}`, b, n, `b${i}`); return; }
      g.push(`[${cur}]${fadeTo(b.opacity)}settb=${TB},setpts=PTS-STARTPTS+${Math.round(b.start * FPS)}[br${i}]`);
    } else if (b.blend) {
      g.push(`[${bi}:v]fps=${R},${flipFilter(b.flip)}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=${n},settb=${TB},setpts=PTS-STARTPTS[brl${i}]`);
      v = blendWindow(v, `brl${i}`, b, n, `b${i}`);
      return;
    } else
    g.push(`[${bi}:v]fps=${R},${flipFilter(b.flip)}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,${fadeTo(b.opacity)}settb=${TB},setpts=PTS-STARTPTS+${Math.round(b.start * FPS)}[br${i}]`);
    g.push(`[${v}][br${i}]overlay=0:0:enable='between(t,${n6(b.start)},${n6(b.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : ""}[vb${i}]`);
    v = `vb${i}`;
  });
  // 5. Graphics: transparent WebM, decoded with libvpx to keep the alpha channel.
  // HDR output: a graphic's colours as the same light at SDR white (16-bit RGB through the SDR-into-HDR LUT).
  const toHdr = cc.hdrLut ? `,scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrap16le,lut3d=file=${q(cc.hdrLut)}:interp=trilinear,scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd,format=${cc.PFA}` : "";
  const drawGraphic = (gr: OverlayOp, i: number) => {
    const path = files.graphics?.[gr.clipId];
    if (!path) return;
    inputs.push("-threads", plan.graphics.length <= 3 ? "2" : "1", "-c:v", "libvpx-vp9", "-i", path);
    const gi = next();
    const n = Math.max(1, Math.round((gr.end - gr.start) * FPS));
    // Phase 7: a file shorter than its clip (a custom graphic placed longer than its recording) holds its last frame.
    const hold = (files.graphicSeconds?.[gr.clipId] ?? Infinity) - gr.sourceStart < gr.end - gr.start - 0.5 / FPS;
    // Started part way in (add_graphic from): put on the frame grid first, then cut. The recording keeps one picture
    // for a still stretch, so seeking the file would skip the picture already showing at that time.
    const from = gr.sourceStart > 0 ? `fps=${R},trim=start_frame=${Math.round(gr.sourceStart * FPS)},setpts=PTS-STARTPTS,` : "";
    if (gr.keys?.length || gr.blend) {
      // Keyframed graphic: centred on a transparent frame, then moved, scaled, turned and faded. Phase 4: a graphic with
      // a blend mode is centred on a transparent frame too, and blended over the picture's frames under it.
      g.push(`[${gi}:v]${from}format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=${R},tpad=stop_mode=clone:stop=${hold || gr.blend ? -1 : 2},trim=end_frame=${n}${toHdr}[gk${i}]`);
      let gc = `gk${i}`;
      if (gr.keys?.length) { motionChain(g, gc, `gm${i}`, gr.keys, 0, n, W, H, false, `g${i}`, { hdr: !!plan.hdr, fr, anchor: gr.anchor, blur: gr.motionBlur }); gc = `gm${i}`; }
      if (gr.blend) { g.push(`[${gc}]setpts=PTS-STARTPTS[grl${i}]`); v = blendWindow(v, `grl${i}`, gr, n, `g${i}`); return; }
      g.push(`[${gc}]${fadeTo(gr.opacity)}setpts=PTS-STARTPTS+${n3(gr.start)}/TB[gr${i}]`);
    } else
    g.push(`[${gi}:v]${from}${hold ? `fps=${R},tpad=stop_mode=clone:stop=-1,trim=end_frame=${n},` : ""}format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease${toHdr},${fadeTo(gr.opacity)}setpts=PTS-STARTPTS+${n3(gr.start)}/TB[gr${i}]`);
    g.push(`[${v}][gr${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${n6(gr.start)},${n6(gr.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : ""}[vg${i}]`);
    v = `vg${i}`;
  };
  const tagHdr = plan.hdr ? `setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=${plan.hdr.transfer === "pq" ? "smpte2084" : "arib-std-b67"}:range=tv,` : "";
  const fontsDir = files.fontsDir ? `:fontsdir=${q(files.fontsDir)}` : "";
  // Phase 2b: a text layer drawn from its mask (white on black, from the layer's start): a library video in its letters
  // (what is drawn round them first: card, stroke, shadow, box), or its card with the letters cut out of it.
  const drawTextMatte = (m: TextMatteOp, k: number) => {
    const mask = files.textMasks?.[m.clipId], video = m.inside ? files.insides?.[m.clipId] : null;
    if (!mask || (m.inside && !video)) return;
    const n = Math.max(1, Math.round((m.end - m.start) * FPS)), len = n6(n / FPS + 1);
    const decor = m.decor ? files.textDecor?.[m.clipId] : null;
    if (decor) { g.push(`[${v}]${tagHdr}ass=filename=${q(decor)}${fontsDir}[vtd${k}]`); v = `vtd${k}`; }
    // Drawn on limited-range YUV (black 16, white 235), so the step to grey makes the alpha run the whole 0-255.
    g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${len},format=yuv420p,ass=filename=${q(mask)}${fontsDir},format=gray,trim=end_frame=${n}[tm${k}]`);
    if (m.inside) {
      // From `from`, fitted to cover the frame. Shorter than the text: looped, and cut at `from` after the loop (a seek
      // before it would start every loop there).
      const from = m.inside.from % m.inside.seconds, loops = m.inside.seconds - from < n / FPS;
      inputs.push(...(loops ? ["-stream_loop", "-1"] : ["-ss", n3(from)]), "-i", video!);
      const ii = next();
      g.push(`[${ii}:v]${loops && from > 0 ? `trim=start=${n3(from)},setpts=PTS-STARTPTS,` : ""}fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,trim=end_frame=${n},setpts=PTS-STARTPTS,format=yuva420p[tv${k}]`);
    } else g.push(`color=c=${m.cut!.replace("#", "0x")}:s=${W}x${H}:r=${R}:d=${len},trim=end_frame=${n},format=yuva420p[tv${k}]`);
    g.push(`[tv${k}][tm${k}]alphamerge${toHdr},setpts=PTS-STARTPTS+${n3(m.start)}/TB[tl${k}]`);
    g.push(`[${v}][tl${k}]overlay=enable='between(t,${n6(m.start)},${n6(m.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : ""}[vtm${k}]`);
    v = `vtm${k}`;
  };
  // Phase 17: a keyframed text layer with motion blur: drawn on a clear frame at four times the rate (libass keeps the
  // alpha), the last frames of each frame's shutter averaged premultiplied (edges do not darken), back to the rate.
  const drawTextBlur = (b: TextBlurOp, k: number) => {
    const path = files.textBlurs?.[b.clipId];
    if (!path) return;
    const n = Math.max(1, Math.round((b.end - b.start) * FPS)), SUB = 4, K = Math.max(2, Math.round((SUB * b.blur) / 100));
    g.push(`color=c=black@0:s=${W}x${H}:r=${FPS * SUB}:d=${n6(n / FPS + 1)},format=yuva420p,ass=filename=${q(path)}${fontsDir}:alpha=1,format=yuva444p,premultiply=inplace=1,tmix=frames=${K},unpremultiply=inplace=1,fps=${R},trim=end_frame=${n},format=yuva420p${toHdr},setpts=PTS-STARTPTS+${n3(b.start)}/TB[tbl${k}]`);
    g.push(`[${v}][tbl${k}]overlay=enable='between(t,${n6(b.start)},${n6(b.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : ""}[vtbl${k}]`);
    v = `vtbl${k}`;
  };
  // Phase 2: behind the person: their graphics, their text layers, then the person laid back over them.
  plan.graphics.forEach((gr, i) => { if (gr.behind) drawGraphic(gr, i); });
  plan.textMattes?.forEach((m, k) => { if (m.behind) drawTextMatte(m, k); });
  plan.textBlurs?.forEach((b, k) => { if (b.behind) drawTextBlur(b, k); });
  if (plan.assBehind && files.assBehindPath) {
    g.push(`[${v}]${tagHdr}ass=filename=${q(files.assBehindPath)}${files.fontsDir ? `:fontsdir=${q(files.fontsDir)}` : ""}[vtb]`);
    v = "vtb";
  }
  if (person) {
    const on = plan.person!.windows.map((w) => `between(t,${n6(w.start)},${n6(w.end - 0.5 / FPS)})`).join("+");
    g.push(`[${v}][${person}]overlay=enable='${on}':format=auto${plan.hdr ? `,format=${cc.PF}` : ""}[vpl]`);
    v = "vpl";
  }
  plan.graphics.forEach((gr, i) => { if (!gr.behind) drawGraphic(gr, i); });
  // Phase 9: adjustment layers: the picture so far (footage, b-roll, graphics) over each layer's time through its grade
  // and effects (the clips' own colour chain), laid back in place; text and captions go on after it, untouched.
  (plan.adjust ?? []).forEach((a, k) => {
    const look = plan.looks?.[a.clipId];
    if (!look) return;
    const n = Math.max(1, Math.round((a.end - a.start) * FPS)), S = n6(a.start), E = n6(a.start + n / FPS);
    g.push(`[${v}]split[ajo${k}][ajw${k}]`);
    g.push(`[ajw${k}]trim=start=${S}:end=${E},setpts=PTS-${S}/TB[aji${k}]`);
    const c = cc.colorChain(`aji${k}`, look, plan.hdr ? "hdr" : "sdr", n, `aj${k}`);
    // Phase 16: outside its masks the layer is transparent (the chain's alpha); its strength scales the alpha, and its
    // fades ramp it in straight lines (adjustStrengthAt is the same numbers in the player).
    const len = n / FPS, fi = Math.min(a.fadeIn ?? 0, len), fo = Math.min(a.fadeOut ?? 0, len);
    const ramp = [a.opacity != null && a.opacity < 1 ? `lutyuv=a='val*${n3(a.opacity)}'` : "", fi ? `fade=t=in:st=0:d=${n6(fi)}:alpha=1` : "", fo ? `fade=t=out:st=${n6(len - fo)}:d=${n6(fo)}:alpha=1` : ""].filter(Boolean);
    const clear = c.alpha || ramp.length > 0;
    g.push(`[${c.out}]format=${clear ? cc.PFA : cc.PF}${ramp.map((x) => "," + x).join("")},setpts=PTS+${S}/TB[ajl${k}]`);
    g.push(`[ajo${k}][ajl${k}]overlay=enable='between(t,${S},${n6(a.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : clear ? `,format=${cc.PF}` : ""}[ajv${k}]`);
    v = `ajv${k}`;
  });
  plan.textMattes?.forEach((m, k) => { if (!m.behind) drawTextMatte(m, k); });
  plan.textBlurs?.forEach((b, k) => { if (!b.behind) drawTextBlur(b, k); });
  // 6. Captions on top of everything.
  if (plan.ass && files.assPath) {
    // HDR: the frame is tagged BT.2020 so libass turns the (already PQ/HLG) caption colours into YUV with that matrix.
    g.push(`[${v}]${tagHdr}ass=filename=${q(files.assPath)}${files.fontsDir ? `:fontsdir=${q(files.fontsDir)}` : ""}[vcap]`);
    v = "vcap";
  }
  // Samples: a still is a JPEG (JFIF: BT.601 full range), converted from the picture's BT.709 here, not left to guess.
  const jpeg = cc.still ? ",scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc:flags=accurate_rnd,format=yuvj444p" : "";
  g.push(`[${v}]format=${cc.PF}${plan.window ? `,trim=start=${n6(plan.window.from)}:end=${n6(plan.window.to)},setpts=PTS-STARTPTS` : ""}${jpeg}[vout]`);
  return "vout";
}

const lin = (db: number) => Math.pow(10, db / 20);
/** The limiter's ceiling sits this far under the true-peak target: AAC encoding adds up to ~0.8 dB to sharp peaks (measured at 96k). */
const PEAK_MARGIN = 1.0;

/** Phase 6: a music or sound-effect clip's pan, EQ and reverb (none: null). */
const soundFxOf = (a: AudioOp): Omit<ClipSoundFx, "keys"> | null => (a.pan || a.eq || a.reverb ? { ...(a.pan ? { pan: a.pan } : {}), ...(a.eq ? { eq: a.eq } : {}), ...(a.reverb ? { reverb: a.reverb } : {}) } : null);
/** Phase 6: volume keys on a clip's own sound (t from its start), per 10 ms block. */
const keyVolume = (keys: AudioKey[] | undefined) => (keys?.length ? `,asetnsamples=n=480,volume='pow(10,(${keyExpr(keys)})/20)':eval=frame` : "");
/**
 * Phase 6: pan and EQ on [from], then reverb: the sound split, one side convolved with the room's impulse response
 * (afir: its dry is the gain going in, its output only the room; no gain of its own: the response is made as loud as it
 * lets in) at the reverb's level, mixed back with the dry sound. Returns the label of the result.
 */
function soundFx(g: string[], inputs: string[], next: () => number, files: PlanFiles, from: string, fx: Omit<ClipSoundFx, "keys">, tag: string): string {
  let cur = from;
  const chain = clipFxChain(fx);
  if (chain) { g.push(`[${cur}]aformat=sample_fmts=fltp:channel_layouts=stereo,${chain}[sx${tag}]`); cur = `sx${tag}`; }
  const ir = fx.reverb ? files.irs?.[fx.reverb.ir] : undefined;
  if (fx.reverb && ir) {
    inputs.push("-i", ir);
    const ii = next();
    g.push(`[${cur}]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=48000,asplit[rd${tag}][rw${tag}]`);
    g.push(`[${ii}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=48000[ri${tag}]`);
    g.push(`[rw${tag}][ri${tag}]afir=dry=1:wet=1:gtype=none,volume=${reverbWet(fx.reverb.amount).toFixed(4)}[rv${tag}]`);
    g.push(`[rd${tag}][rv${tag}]amix=inputs=2:normalize=0:duration=first[rx${tag}]`);
    cur = `rx${tag}`;
  }
  return cur;
}

/**
 * 7. Sound: the dialogue (cleanup, its clips' gains and fades), music ducked under speech, sound effects, the mix's
 * fades, then the loudness gain with a 4x oversampled limiter (true peak), or the old limiter when loudness is off.
 * The measuring pass stops before the loudness step and measures the mix with ebur128.
 */
function mixAudio(plan: RenderPlan, files: PlanFiles, g: string[], inputs: string[], next: () => number, opts: FfmpegOpts) {
  const mix = plan.audioMix;
  const cleanup = mix ? cleanupChain(cleanupParams(mix)) : "";
  const dlgExpr = mix ? dialogueExpr(mix.dialogue) : null;
  g.push(`[acat]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${cleanup ? "," + cleanup : ""}${dlgExpr ? `,asetnsamples=n=480,volume='${dlgExpr}':eval=frame` : ""}[dlg]`);
  const music = plan.audio.filter((a) => a.kind === "music" && files.audio?.[a.clipId]);
  const sfx = plan.audio.filter((a) => a.kind === "sfx" && files.audio?.[a.clipId]);
  const fades = (d: number, fi: number, fo: number) => `${fi > 0 ? `,afade=t=in:d=${n3(Math.min(fi, d))}` : ""}${fo > 0 ? `,afade=t=out:st=${n3(Math.max(0, d - fo))}:d=${n3(Math.min(fo, d))}` : ""}`;
  const mixIn: string[] = [];
  if (music.length && !mix) {
    // A plan without mix settings (never made by planRender today): music ducked by a sidechain compressor, as before.
    g.push(`[dlg]asplit=2[dlgmix][dlgsc]`);
    mixIn.push("[dlgmix]");
  } else mixIn.push("[dlg]");
  music.forEach((m, i) => {
    inputs.push("-stream_loop", "-1", "-i", files.audio![m.clipId]);
    const mi = next();
    const d = Math.max(0.1, m.end - m.start);
    const auto = autoMusicFades(d);
    // Music goes down under speech: a fixed envelope (the live player follows the same curve).
    const duck = mix && mix.duck > 0 ? duckExpr(mix.speech, m.start, m.end) : "0";
    const ducking = duck !== "0" ? `,asetnsamples=n=480,volume='pow(10,-${mix!.duck}*(${duck})/20)':eval=frame` : "";
    const mfx = soundFxOf(m);
    g.push(`[${mi}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${fades(d, m.fadeIn ?? auto.fadeIn, m.fadeOut ?? auto.fadeOut)},volume=${m.gainDb}dB${keyVolume(m.keys)}${mfx ? `[mb${i}]` : `,adelay=delays=${Math.round(m.start * 1000)}:all=1${ducking}[mu${i}]`}`);
    if (mfx) g.push(`[${soundFx(g, inputs, next, files, `mb${i}`, mfx, `m${i}`)}]adelay=delays=${Math.round(m.start * 1000)}:all=1${ducking}[mu${i}]`);
  });
  if (music.length) {
    let bus = "[mu0]";
    if (music.length > 1) { g.push(`${music.map((_, i) => `[mu${i}]`).join("")}amix=inputs=${music.length}:normalize=0[mubus]`); bus = "[mubus]"; }
    if (!mix) { g.push(`${bus}[dlgsc]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=350[muduck]`); mixIn.push("[muduck]"); }
    else mixIn.push(bus);
  }
  sfx.forEach((s, i) => {
    inputs.push("-i", files.audio![s.clipId]);
    const si = next();
    const d = Math.max(0.1, s.end - s.start);
    const sfx_ = soundFxOf(s);
    g.push(`[${si}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${fades(d, s.fadeIn ?? 0, s.fadeOut ?? 0)},volume=${s.gainDb}dB${keyVolume(s.keys)}${sfx_ ? `[sb${i}]` : `,adelay=delays=${Math.round(s.start * 1000)}:all=1[fx${i}]`}`);
    if (sfx_) g.push(`[${soundFx(g, inputs, next, files, `sb${i}`, sfx_, `s${i}`)}]adelay=delays=${Math.round(s.start * 1000)}:all=1[fx${i}]`);
    mixIn.push(`[fx${i}]`);
  });
  const T = plan.outputSeconds;
  const mixFades = mix ? `${mix.fadeIn > 0 ? `,afade=t=in:d=${n3(mix.fadeIn)}` : ""}${mix.fadeOut > 0 ? `,afade=t=out:st=${n3(Math.max(0, T - mix.fadeOut))}:d=${n3(mix.fadeOut)}` : ""}` : "";
  const sum = mixIn.length > 1 ? `${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first${mixFades}` : `${mixIn[0]}${mixFades ? "anull" + mixFades : "anull"}`;
  if (opts.measure) { g.push(`${sum},ebur128=peak=true:framelog=quiet[aout]`); return; }
  const win = plan.window ? `,atrim=start=${n6(plan.window.from)}:end=${n6(plan.window.to)},asetpts=PTS-STARTPTS` : "";
  if (mix && mix.loudness != null) {
    // The measured gain, then a limiter at 4x the sample rate so the peaks between samples stay under the ceiling.
    g.push(`${sum},volume=${(opts.loudnessGainDb ?? 0).toFixed(2)}dB,aresample=192000,alimiter=limit=${lin(mix.peak - PEAK_MARGIN).toFixed(4)}:attack=5:release=50:level=disabled,aresample=48000${win}[aout]`);
  } else {
    // Loudness off: a safety limiter only. (The old one had FFmpeg's auto-level on: it raised everything to the limit
    // and then rode loud sound wave by wave, which distorts it; model A plans keep it, unchanged.)
    g.push(`${sum},alimiter=limit=0.95:level=disabled${win}[aout]`);
  }
}

function encodeArgs(plan: RenderPlan, inputs: string[], files: PlanFiles, opts: FfmpegOpts): string[] {
  // Samples: the window's length (the loudness pass above still measures the whole mix).
  const outLen = plan.window ? plan.window.to - plan.window.from : plan.outputSeconds;
  if (opts.measure) {
    return ["-hide_banner", "-nostdin", "-y", "-nostats", ...capInputThreads(inputs, opts.inputThreads), "-filter_complex_script", "__FILTER_SCRIPT__", "-map", "[aout]", "-t", n3(plan.outputSeconds), "-progress", "pipe:1", "-f", "null", "-"];
  }
  const preview = plan.kind === "preview";
  const trc = plan.hdr ? (plan.hdr.transfer === "pq" ? "smpte2084" : "arib-std-b67") : "";
  // HDR (Phase 6): HEVC Main 10 with BT.2020 and the source's transfer in the stream and the container.
  // Phase 7: the output's frame rate (a final keeps its footage's), a keyframe every 2 s, and the export's codec. HEVC
  // carries the hvc1 tag so Apple devices play it; at 4K x265 runs one preset faster.
  const R = plan.rate || "30", gop = String(Math.round((plan.fps || 30) * 2)), x265Preset = plan.width * plan.height > 4e6 ? "faster" : "fast";
  const video0 = plan.hdr
    ? ["-c:v", "libx265", "-preset", x265Preset, "-crf", "20", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-x265-params", `log-level=error:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc:range=limited:repeat-headers=1${plan.hdr.transfer === "pq" ? ":hdr10=1:hdr10-opt=1" : ""}`, "-r", R, "-g", gop, "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", trc]
    : plan.codec === "hevc"
      ? ["-c:v", "libx265", "-preset", x265Preset, "-crf", "22", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-x265-params", "log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited", "-r", R, "-g", gop, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
      : ["-c:v", "libx264", "-preset", preview ? "ultrafast" : "veryfast", "-crf", preview ? "28" : "20", "-pix_fmt", "yuv420p", "-r", R, "-g", gop, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  // Phase 12: a bitrate the export asks for, in place of constant quality (peaks allowed to 1.5x).
  const crf = video0.indexOf("-crf");
  const video = plan.bitrate && crf >= 0 ? [...video0.slice(0, crf), "-b:v", `${plan.bitrate}M`, "-maxrate", `${Math.round(plan.bitrate * 15) / 10}M`, "-bufsize", `${plan.bitrate * 2}M`, ...video0.slice(crf + 2)] : video0;
  const head = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...capInputThreads(inputs, opts.inputThreads), ...(opts.filterThreads ? ["-filter_complex_threads", String(opts.filterThreads)] : []), "-filter_complex_script", "__FILTER_SCRIPT__"];
  const tail = [...(opts.threads ? ["-threads", String(opts.threads)] : []), "-progress", "pipe:1", "-nostats"];
  // Phase 12: the overlay export's two passes (over black, over white), lossless for the worker to take the alpha from.
  // Samples: one frame as a JPEG.
  if (opts.still) return [...head, "-map", "[vout]", "-frames:v", "1", "-update", "1", "-q:v", "2", ...tail, files.output];
  if (opts.pictureAs) return [...head, "-map", "[vout]", "-map", "[aout]", "-c:v", "ffv1", "-level", "3", "-g", "1", "-pix_fmt", "yuv444p", "-r", R, "-c:a", "pcm_s16le", "-ar", "48000", "-t", n3(outLen), ...tail, files.output];
  // Phase 12: sound only: the mix as the file, the picture made and dropped (its graph is the same).
  if (plan.format === "audio" || plan.format === "wav") return [...head, "-map", "[aout]", ...(plan.format === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "256k"]), "-ar", "48000", "-t", n3(outLen), ...tail, files.output, "-map", "[vout]", "-f", "null", "-"];
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    ...capInputThreads(inputs, opts.inputThreads),
    ...(opts.filterThreads ? ["-filter_complex_threads", String(opts.filterThreads)] : []),
    "-filter_complex_script", "__FILTER_SCRIPT__",
    "-map", "[vout]", "-map", "[aout]",
    ...video,
    "-c:a", "aac", "-b:a", preview ? "96k" : "192k", "-ar", "48000",
    "-t", n3(outLen),
    "-movflags", "+faststart",
    ...(opts.threads ? ["-threads", String(opts.threads)] : []),
    "-progress", "pipe:1", "-nostats",
    files.output,
  ];
}

/** Reads the measuring pass's ebur128 summary: integrated loudness (LUFS) and true peak (dBTP). */
export function readMixLoudness(stderr: string): { lufs: number | null; peakDb: number | null } {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  if (!summary.startsWith("Summary:")) return { lufs: null, peakDb: null };
  const num = (re: RegExp) => { const m = re.exec(summary); const n = m ? Number(m[1]) : NaN; return Number.isFinite(n) ? n : null; };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), peakDb: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

/** The loudness step's gain: what brings the measured mix to the target, within -30..+24 dB (a silent mix gets none). */
export function loudnessGain(target: number, measuredLufs: number | null): number {
  if (measuredLufs == null || measuredLufs < -70) return 0;
  return Math.round(Math.min(24, Math.max(-30, target - measuredLufs)) * 100) / 100;
}
