// Timeline -> FFmpeg. The one place that decides what a render looks like.
// planRender() is pure: it turns a snapshot + transcript into an ordered plan in OUTPUT time.
// ffmpegArgs() turns a plan + local file paths into one FFmpeg command (a single pass: fast and lossless between steps).
// Sequences (model B) are planned here; timelines stored in model A go to the unchanged A planner (renderPlanA.ts).
import { catalogMusic, catalogSfx, findTemplate } from "./catalog";
import type { Aspect, CaptionLook } from "./constants";
import { cutRegions, editOf, isSequence, mainVideoOf, mergeRanges, normalSpeed, rateOf, sequenceView, srcAt, type Attached, type PicturePart, type Range, type SeqClip, type SequenceView, type SoundPart } from "./sequence";
import { dirVec, keyTracks, motionExpr, scaleRange, smoothExpr, USES_HANDLES, WHIP_BLUR, ZOOM_PEAK, type Dir, type Key, type TransitionType } from "./motion";
import type { Snapshot, V2Clip, V3Clip, A2Clip, A3Clip, Framing, Resolution, Codec } from "./timeline";
import { allWords, type Transcript, type Word } from "./transcript";
import { ffmpegArgsA, planRenderA } from "./renderPlanA";
import { autoMusicFades, cleanupChain, cleanupParams, cleanupText, dialogueExpr, duckExpr, speechRanges, type DialogueSpan } from "./audio";
import { audioSettings, type AudioMixSettings } from "./timeline";
import { buildStyledAss, captionStyleOf, layoutCaptions, styleText, textPreset, type Card, type CaptionStyle, type StyledCaption, type TextAnim, type TextLayer, type TextStyle } from "./captions";
import { backgroundScale, backgroundSigma, backgroundText, cardBorderPicture, cardLookText, cardShadowPicture, gradientPicture, hasCard, masksWithCard, patternPicture, ppm, SHADOW_DEFAULTS, type CardLook, type Pattern } from "./cardLook";
import { areaPicture, blurSigma, buildLut, chromaKeyText, cubeText, effectsText, gradeFn, gradeIsActive, gradeText, hashOf, hdrLut, hexRgb, maskPicture, masksText, pgm, pixelBlock, sdrToHdr, spillType, type Area, type ChromaKey, type ClipLook, type Effect, type Grade, type HdrTransfer, type Lut, type Mask } from "./look";

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
};

/** through: the zoom transition (in to the cut, out after it). */
export type ZoomOp = { start: number; end: number; scale: number; mode: "punch" | "push" | "through" };
/** keys: keyframes in seconds from the overlay's start (a b-roll clip with keys is a picture-in-picture). */
export type OverlayOp = { clipId: string; start: number; end: number; sourceStart: number; videoId?: string; graphicId?: string; keys?: Key[] };
/** A stretch of one video drawn over an edit window: the same steps as a picture part (speed, turn, fit, framing, the
 *  clip's keyframes). Footage past a part's ends continues at its rate (handles). */
export type Seg = { videoId: string; srcIn: number; srcOut: number; rate: number; start: number; end: number; rotate: 0 | 90 | 180 | 270; framing: Framing | null; clipId: string };
/** A transition on the cut at `at`, over [start, end). a / b: what each side shows over the whole window (dissolve,
 *  slide, whip; dips and zoom draw on the picture itself). asked: the duration the edit asked for. */
export type TransitionOp = { clipId: string; type: Exclude<TransitionType, "cut">; dir?: Dir; at: number; start: number; end: number; asked: number; a: Seg[]; b: Seg[]; note?: string };
export type AudioOp = { clipId: string; start: number; end: number; gainDb: number; assetKey: string; kind: "music" | "sfx"; fadeIn?: number; fadeOut?: number };
/** The sequence's sound settings and the numbers the mix is made from (edit seconds). */
export type AudioMix = AudioMixSettings & {
  /** Where people speak: music ducks under these. */
  speech: Range[];
  /** Dialogue clips with their own gain or fades. */
  dialogue: DialogueSpan[];
};
export type CaptionEvent = { start: number; end: number; text: string };
/**
 * A clip's colour and compositing (Phase 6), with the files the render reads: lut = the grade as a .cube (lutHdr: the
 * grade, then SDR into the HDR output), mask = the masks' picture (.pgm), each effect's area picture. px: blur sigma or
 * block size in pixels at the plan's size. alpha: parts of the clip are transparent (key or masks).
 */
export type LookOp = { grade?: Grade; lut?: string; lutHdr?: string; key?: ChromaKey; masks?: Mask[]; mask?: string; effects?: (Effect & { px: number; file?: string })[]; alpha: boolean };
/** What a look file holds; lookFileData() writes it. shadow and border: a card's, in its framed place; gradient: what
 *  is behind V1 (a colour is a gradient from it to itself). */
export type LookFile = { kind: "lut"; grade: Grade; hdr?: HdrTransfer } | { kind: "hdr"; hdr: HdrTransfer } | { kind: "mask"; masks: Mask[] } | { kind: "area"; area: Area }
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
  /** The dialogue: parts in edit order covering the whole edit (muted = silent). */
  sound: SoundPart[];
  /** The videos it plays, main footage first. */
  sources: string[];
  /** Per video: has a sound track, HDR (tone-mapped like the preview copy in SDR output) and its transfer. */
  videos?: Record<string, { hasAudio: boolean; hdr: boolean; transfer?: HdrTransfer }>;
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
  clipMotion?: Record<string, { start: number; end: number; keys: Key[] }>;
  /** Phase 6: each V1 and b-roll clip's look (by clip id), the files they need (by file name), b-roll drawn behind V1,
   *  and the HDR output (null: SDR). hdr.lut converts SDR pictures (footage, b-roll, graphics) into it. */
  looks?: Record<string, LookOp>;
  lookFiles?: Record<string, LookFile>;
  under?: OverlayOp[];
  hdr?: { transfer: HdrTransfer; lut: string } | null;
  /** V1 clips drawn as cards (by clip id) and what is behind V1 (null: black). */
  cards?: Record<string, CardOp>;
  background?: BackgroundOp | null;
  /** Sequences: the caption style, the captions with their lines and word times, the text layers (Phase 4). */
  captionStyle?: CaptionStyle;
  styledCaptions?: StyledCaption[];
  texts?: TextLayer[];
  ass: string | null;
  operations: string[];
};

export class RenderPlanError extends Error {
  friendly = true;
  constructor(message: string) { super(message); }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const sameFraming = (a: Framing | null, b: Framing | null) => (!a && !b) || (!!a && !!b && a.scale === b.scale && a.x === b.x && a.y === b.y);
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

export function outputSize(aspect: Aspect, kind: RenderKind, resolution?: Resolution | null) {
  // Phase 7: a final's short side follows its export resolution (720, 1080 or 2160); previews stay 540.
  const short = kind === "preview" ? 540 : resolution === "4k" ? 2160 : resolution === "720p" ? 720 : 1080;
  if (aspect === "9:16") return { width: short, height: even((short * 16) / 9) };
  if (aspect === "1:1") return { width: short, height: short };
  return { width: even((short * 16) / 9), height: short };
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
export function planRender(input: PlanInput): RenderPlan {
  // A timeline stored in model A (an old version, or a project the migration left on A) renders exactly as before.
  if (!isSequence(input.snapshot.timeline)) return planRenderA(input);
  const { snapshot, transcript, kind } = input;
  const tl = snapshot.timeline;
  const words = allWords(transcript);
  const main = mainVideoOf(tl);
  const infoOf = (vid: string) => (vid === main ? input.source : input.sources?.[vid]);
  const used = Array.from(new Set([main, ...(tl.tracks.v1 as unknown as { sourceVideoId: string }[]).map((c) => c.sourceVideoId)]));
  const missing = used.filter((v) => !infoOf(v));
  if (missing.length) throw new RenderPlanError(`A clip on V1 plays a video that is no longer in your library (${missing.join(", ")}). Remove that clip, then render again.`);
  // Every part starts and ends on a frame of the output (30 fps; a final at its footage's rate, Phase 7), so each part
  // is a whole number of frames and picture and sound stay together however many cuts there are. Footage beyond a
  // file's real length is left out.
  const out = outputRate(kind, input.source.fps);
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
  const clipMotion: Record<string, { start: number; end: number; keys: Key[] }> = {};
  for (const c of v1) {
    const p = view.clip(c.id);
    if (!c.keys?.length || !p || !p.pieces.length) continue;
    const at = (k: Key) => (c.freeze ? Math.min(p.end - p.start, Math.max(0, k.t - c.sourceIn)) : (view.editAt(c.id, k.t) ?? p.start) - p.start);
    clipMotion[c.id] = { start: r3(p.start), end: r3(p.end), keys: c.keys.map((k) => ({ ...k, t: r3(at(k)) })).sort((a, b) => a.t - b.t) };
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
      if (fe - fs >= 0.05) ((c as { under?: boolean }).under ? under : broll).push({ clipId: c.id, start: fs, end: fe, sourceStart: ss, videoId: c.videoId, ...(c.keys?.length ? { keys: c.keys } : {}) });
    }
  }
  const graphics: OverlayOp[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached)[]) {
    if (c.kind !== "graphic" || !c.graphicId || (input.graphicsReady && !input.graphicsReady[c.id])) continue;
    const sp = placed(c);
    // A custom graphic can start part way into its recording (add_graphic from); a template is drawn for each clip.
    const from = !findTemplate(c.graphicId) && c.sourceStart ? c.sourceStart : 0;
    if (sp && onFrame(sp.end) - onFrame(sp.start) >= 0.05) graphics.push({ clipId: c.id, start: onFrame(sp.start), end: onFrame(sp.end), sourceStart: from, graphicId: c.graphicId, ...(c.keys?.length ? { keys: c.keys } : {}) });
  }
  const audio: AudioOp[] = [];
  // Keys come from the catalog only (see catalogMusic), whatever the stored clip says.
  for (const c of tl.tracks.a2 as (A2Clip & Attached)[]) {
    const track = catalogMusic(c);
    if (!track) continue;
    const sp = placed(c);
    if (!sp) continue;
    // A music clip without fades of its own fades in and out by itself (as before Phase 3).
    const x = c as A2Clip & { fadeIn?: number; fadeOut?: number }, auto = autoMusicFades(sp.end - sp.start);
    audio.push({ clipId: c.id, ...sp, gainDb: c.gainDb ?? -18, assetKey: track.key, kind: "music", fadeIn: r3(x.fadeIn ?? auto.fadeIn), fadeOut: r3(x.fadeOut ?? auto.fadeOut) });
  }
  for (const c of tl.tracks.a3 as (A3Clip & Attached)[]) {
    const sfx = catalogSfx(c);
    if (!sfx || !c.anchorId || !view.clip(c.anchorId)) continue;
    const start = r3(view.editAt(c.anchorId, Number(c.anchorAt ?? 0))!);
    if (start >= total) continue;
    const x = c as A3Clip & { fadeIn?: number; fadeOut?: number };
    audio.push({ clipId: c.id, start, end: r3(Math.min(total, start + Math.max(0.1, Number(c.length ?? c.end - c.start)))), gainDb: c.gainDb ?? -6, assetKey: sfx.key, kind: "sfx", fadeIn: x.fadeIn ?? 0, fadeOut: x.fadeOut ?? 0 });
  }
  // The sound: settings, where music ducks (speech), and dialogue clips with their own gain or fades.
  const settings = audioSettings(tl);
  const cutSet = new Set(tl.cut);
  const speech = speechRanges(view, (vid) => (vid === main ? words : input.transcripts?.[vid] ? allWords(input.transcripts[vid]) : null), cutSet);
  const dialogue: DialogueSpan[] = [];
  for (const p of view.clips) {
    const c = (tl.tracks.v1 as unknown as { id: string; audioGain?: number; audioFadeIn?: number; audioFadeOut?: number; audioMuted?: boolean }[]).find((x) => x.id === p.id);
    if (!c || c.audioMuted || !p.pieces.length || p.soundEnd - p.soundStart < 0.01) continue;
    if (!c.audioGain && !c.audioFadeIn && !c.audioFadeOut) continue;
    dialogue.push({ start: r3(p.soundStart), end: r3(p.soundEnd), gainDb: c.audioGain ?? 0, fadeIn: c.audioFadeIn ?? 0, fadeOut: c.audioFadeOut ?? 0 });
  }
  const audioMix: AudioMix = { ...settings, fadeIn: Math.min(settings.fadeIn, total / 2), fadeOut: Math.min(settings.fadeOut, total / 2), speech, dialogue };
  // Muted clips, and clips silent at their speed: their dialogue is silent.
  const dialogueMutes = mergeRanges(view.sound.filter((x) => x.muted || x.silent).map((x) => ({ start: r3(x.start), end: r3(x.end) })).filter((g) => g.end > g.start));

  const look = tl.captionLook;
  // Captions and text layers (Phase 4): laid out once here, drawn by libass and by the editor from the same layout.
  const captionStyle = captionStyleOf(tl as { captionLook: CaptionLook; captionStyle?: CaptionStyle }, snapshot.aspect, input.captionRules);
  const styledCaptions = layoutCaptions(sequenceCaptionGroups(input, view), captionStyle, width, height, total);
  const captions: CaptionEvent[] = styledCaptions.map((c) => ({ start: c.start, end: c.end, text: c.lines.map((l) => l.map((w) => w.text).join(" ")).join(" ") })); // lines: styledCaptions
  const texts: TextLayer[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached & { text?: string; style?: TextStyle; card?: Card | null; anim?: TextAnim })[]) {
    if (c.kind !== "text" || !c.text?.trim()) continue;
    const sp = placed(c);
    if (!sp) continue;
    const def = textPreset("plain");
    texts.push({ clipId: c.id, start: Math.round(sp.start * 100) / 100, end: Math.round(sp.end * 100) / 100, lines: c.text.split("\n"), style: c.style ?? def.style, card: c.card ?? null, anim: c.anim ?? def.anim, ...(c.keys?.length ? { keys: c.keys } : {}) });
  }
  const ass = buildStyledAss({ captions: styledCaptions, captionStyle, texts, width, height });

  const parts = view.picture.map((p) => ({ ...p, start: r3(p.start), end: r3(p.end) }));

  // Phase 6: HDR stays HDR in a final (unless the edit asks for SDR): the main footage's transfer, else the first HDR
  // video's. Previews are made from the SDR preview copies.
  const hdrSrc = [main, ...parts.map((p) => p.videoId)].map((v) => infoOf(v)).find((x) => x?.hdr);
  const hdrVideos = new Set(parts.map((p) => p.videoId).filter((v) => infoOf(v)?.hdr || input.hdrFootage?.[v]));
  const hdrT: HdrTransfer | null = kind === "final" && (tl.export?.hdr ?? "keep") === "keep" && hdrSrc ? hdrSrc.transfer ?? "pq" : null;
  const lookFiles: Record<string, LookFile> = {};
  const file = (spec: LookFile) => { const name = `${spec.kind}_${hashOf(spec)}.${spec.kind === "mask" || spec.kind === "area" || spec.kind === "shadow" || spec.kind === "border" ? "pgm" : spec.kind === "gradient" || spec.kind === "pattern" ? "ppm" : "cube"}`; lookFiles[name] = spec; return name; };
  const hdr = hdrT ? { transfer: hdrT, lut: file({ kind: "hdr", hdr: hdrT }) } : null;
  // Phase 7: a final's codec (HDR kept is always HEVC 10-bit); previews are H.264.
  const codec: Codec = kind === "final" && (hdr || tl.export?.codec === "hevc") ? "hevc" : "h264";
  const looks: Record<string, LookOp> = {};
  const missingLuts = new Set<string>();
  const lookFor = (c: ClipLook & { id: string; cardLook?: CardLook }) => {
    const grade = c.grade && gradeIsActive(c.grade) ? { ...c.grade } : undefined;
    if (grade?.lut && !input.luts?.[grade.lut.id]) { missingLuts.add(grade.lut.id); delete grade.lut; }
    const g = grade && gradeIsActive(grade) ? grade : undefined;
    // A card's crop and corners are one more mask (drawn as masks are, in the render and the player).
    const masks = masksWithCard(c.masks, c.cardLook);
    if (!g && !c.key && !masks?.length && !c.effects?.length) return;
    looks[c.id] = {
      ...(g ? { grade: g, lut: file({ kind: "lut", grade: g }), ...(hdr ? { lutHdr: file({ kind: "lut", grade: g, hdr: hdr.transfer }) } : {}) } : {}),
      ...(c.key ? { key: c.key } : {}),
      ...(masks?.length ? { masks, mask: file({ kind: "mask", masks }) } : {}),
      ...(c.effects?.length ? { effects: c.effects.map((e) => ({ ...e, px: e.type === "blur" ? blurSigma(e.amount, width, height) : pixelBlock(e.amount, width, height), ...(e.area ? { file: file({ kind: "area", area: e.area }) } : {}) })) } : {}),
      alpha: !!c.key || !!masks?.length,
    };
  };
  for (const c of v1) lookFor(c);
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
  for (const b of [...broll, ...under]) lookFor((tl.tracks.v2 as (V2Clip & ClipLook)[]).find((x) => x.id === b.clipId)!);
  const sound = view.sound.map((x) => ({ ...x, start: r3(x.start), end: r3(x.end) }));
  const sources = Array.from(new Set([main, ...parts.map((p) => p.videoId), ...sound.map((x) => x.videoId)])).filter((v) => parts.some((p) => p.videoId === v) || sound.some((x) => x.videoId === v));
  const videos = Object.fromEntries(sources.map((v) => [v, { hasAudio: infoOf(v)!.hasAudio, hdr: !!infoOf(v)!.hdr, ...(infoOf(v)!.hdr ? { transfer: infoOf(v)!.transfer ?? "pq" } : {}) }]));
  const cutCount = cutRegions(words, new Set(tl.cut)).length;
  const live = view.clips.filter((c) => c.pieces.length);
  const jl = { j: live.filter((c, i) => i > 0 && c.soundStart < c.start - 1e-6).length, l: live.filter((c, i) => i > 0 && c.soundStart > c.start + 1e-6).length, muted: (tl.tracks.v1 as unknown as { audioMuted?: boolean }[]).filter((c) => c.audioMuted).length };
  const turned = new Set(parts.map((p) => p.rotate)), framings = parts.filter((p) => p.framing);
  const lookText = parts.every((p) => p.rotate === parts[0].rotate && sameFraming(p.framing, parts[0].framing))
    ? `${parts[0].rotate ? `Turn the footage ${parts[0].rotate}° clockwise, then fit` : "Fit"} to ${snapshot.aspect} at ${width}x${height}, ${rateText(out.fps)} fps${parts[0].framing ? `; frame it: scale ${parts[0].framing.scale}, offset ${parts[0].framing.x}, ${parts[0].framing.y}` : ""}`
    : `Fit each part to ${snapshot.aspect} at ${width}x${height}, ${rateText(out.fps)} fps (turned ${Array.from(turned).join("/")}°, ${framings.length} framed parts)`;
  const operations = [
    `Play ${parts.length} ${parts.length === 1 ? "part" : "parts"} from ${sources.length} ${sources.length === 1 ? "video" : "videos"} (${live.length} clips, ${cutCount} word cuts): ${total.toFixed(2)}s`,
    lookText,
    zooms.length ? `Zoom: ${zooms.length} (${zooms.filter((z) => z.mode === "punch").length} punch, ${zooms.filter((z) => z.mode === "push").length} slow push)` : "Zoom: none",
    broll.length ? `B-roll overlays: ${broll.length}` : "B-roll overlays: none",
    graphics.length ? `Graphics overlays: ${graphics.length}` : "Graphics overlays: none",
    captions.length ? `Captions: ${captions.length} word-timed events, ${tl.captionStyle ? "own style" : `look ${look}`}: ${styleText(captionStyle)}` : "Captions: off",
    texts.length ? `Text layers: ${texts.length}` : "Text layers: none",
    ...speedLines(v1, view, transitions, clipMotion, broll, graphics, texts),
    ...colorLines(looks, under, missingLuts, hdr, Array.from(new Set(parts.filter((p) => hdrVideos.has(p.videoId)).map((p) => p.clipIds[0]))), kind, hdrVideos.size > 0, tl.export?.hdr === "sdr"),
    ...(Object.keys(cards).length || v1.some((c) => hasCard((c as { cardLook?: CardLook }).cardLook)) ? [`Cards: ${(v1 as (SeqClip & { cardLook?: CardLook })[]).filter((c) => hasCard(c.cardLook)).slice(0, 4).map((c) => `${c.id} ${cardLookText(c.cardLook!)}`).join("; ")}`] : []),
    ...(background ? [`Behind V1: ${background.text}`] : bgIn?.videoId ? ["Behind V1: the background video is not in the library or not ready: black instead"] : []),
    `Audio: dialogue${jl.j || jl.l ? ` (${jl.j} J cuts, ${jl.l} L cuts)` : ""}${jl.muted ? ` (${jl.muted} muted clips)` : ""}${dialogue.length ? ` (${dialogue.length} clips with their own gain or fades)` : ""}${cleanupText(settings) !== "none" ? `, cleanup ${cleanupText(settings)}` : ""}${settings.declick ? `, ${Math.round(settings.declick * 1000)} ms fade at every cut` : ""}${audio.some((a) => a.kind === "music") ? ` + music${settings.duck ? `, ${settings.duck} dB down under speech` : ""}` : ""}${audio.some((a) => a.kind === "sfx") ? ` + ${audio.filter((a) => a.kind === "sfx").length} sound effects` : ""}${settings.fadeIn || settings.fadeOut ? `; mix fades in ${settings.fadeIn}s, out ${settings.fadeOut}s` : ""}`,
    settings.loudness != null ? `Loudness: measured first, then set to ${settings.loudness} LUFS with a ${settings.peak} dBTP true-peak ceiling` : "Loudness: not normalized (limiter only)",
    kind === "preview" ? `Encode preview: H.264 ultrafast, ${width}x${height}` : hdr ? `Encode final: HEVC 10-bit HDR (${hdr.transfer === "pq" ? "PQ" : "HLG"}, BT.2020), ${width}x${height}, ${rateText(out.fps)} fps` : `Encode final: ${codec === "hevc" ? "HEVC" : "H.264"}, ${width}x${height}, ${rateText(out.fps)} fps`,
    // Phase 7: what the final keeps and what it cannot (the check repeats these).
    ...(kind === "final" ? exportNotes(out, width, height, input.source) : []),
  ];
  return {
    model: "B", kind, width, height, fps: out.fps, rate: out.rate, codec, aspect: snapshot.aspect, kept: parts.map((p) => ({ start: p.srcIn, end: p.srcOut })), parts, sound, sources, videos,
    outputSeconds: total, rotate: parts[0].rotate, framing: parts[0].framing, zooms, broll, graphics, audio, dialogueMutes, captions, captionLook: look, captionStyle, styledCaptions, texts, ass, operations, audioMix,
    transitions, clipMotion,
    looks, lookFiles, under, hdr, ...(hdr && ass ? { ass: hdrAss(ass, hdr.transfer) } : {}),
    ...(Object.keys(cards).length ? { cards } : {}), ...(background ? { background } : {}),
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
  const rate = !r ? "the footage's frame rate" : r.capped ? `60 fps (the footage is ${rateText(footage!.fps!)}; finals go up to 60)` : `${rateText(r.fps)} fps (the footage's)`;
  const fw = footage?.width ?? 0, fh = footage?.height ?? 0;
  const up = fw && fh && Math.min(width, height) > Math.min(fw, fh) * 1.05 ? `, scaled up from the footage's ${fw}x${fh}` : "";
  const res = ex.resolution === "4k" ? "4K" : ex.resolution ?? "1080p";
  return `Export (final): ${res} ${width}x${height} ${snap.aspect}, ${codec}, ${rate}${up}`;
}

/** Phase 7: a final's frame rate (kept, or capped at 60) and whether its size is above the footage's (scaled up). */
function exportNotes(out: { fps: number; capped: boolean }, width: number, height: number, src: SourceInfo): string[] {
  const lines = [out.capped ? `Frame rate: 60 fps (the footage is ${rateText(src.fps)} fps; finals go up to 60)` : `Frame rate: ${rateText(out.fps)} fps, the footage's`];
  const srcShort = Math.min(src.width, src.height), outShort = Math.min(width, height);
  if (srcShort > 0 && outShort > srcShort * 1.05) lines.push(`Size: scaled up from the footage's ${src.width}x${src.height} to ${width}x${height}`);
  return lines;
}

/** The render plan's Phase 6 lines: colour, key, masks, blur, under layers, HDR. */
function colorLines(looks: Record<string, LookOp>, under: OverlayOp[], missingLuts: Set<string>, hdr: RenderPlan["hdr"], hdrClips: string[], kind: RenderKind, hdrFootage: boolean, toSdr: boolean): string[] {
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
  if (fx.length) out.push(`Blur/pixelate: ${list(fx, effectsText)}`);
  if (under.length) out.push(`Under V1: ${under.length} b-roll ${under.length === 1 ? "clip" : "clips"} (${under.slice(0, 4).map((u) => u.clipId).join(", ")})`);
  const sdrGraded = hdrClips.filter((id) => looks[id]?.grade || looks[id]?.key);
  const gradedNote = sdrGraded.length ? `; ${sdrGraded.slice(0, 6).join(", ")} graded or keyed in SDR (as the editor shows them): no highlights above SDR white there` : "";
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
  const lut = spec.grade.lut ? luts[spec.grade.lut.id] : null;
  return cubeText(spec.hdr ? hdrLut(spec.hdr, gradeFn(spec.grade, lut)) : buildLut(spec.grade, lut));
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
  /** The other videos on V1, by video id. */
  videos?: Record<string, string>;
  output: string;
  assPath?: string;
  fontsDir?: string;
  broll?: Record<string, string>; // by clip id
  graphics?: Record<string, string>; // by clip id
  audio?: Record<string, string>; // by clip id
  /** Phase 6: b-roll drawn behind V1, by clip id; the look files (LUTs, mask pictures), by file name. */
  under?: Record<string, string>;
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
  /**
   * Threads of the filter graph, which each scaler also starts: a graded graph has ~70 scalers, so leaving it to the
   * CPU count on a many-core host starts thousands of threads and FFmpeg fails with EAGAIN at the container's limit.
   */
  filterThreads?: number;
  /** The loudness gain the measuring pass found (dB). Needed when the plan normalizes loudness. */
  loudnessGainDb?: number;
  /** Audio only, up to the mix, through ebur128: the measuring pass (its stderr has the loudness summary). */
  measure?: boolean;
};

export function ffmpegArgs(plan: RenderPlan, files: PlanFiles, source: SourceInfo, opts: FfmpegOpts = {}): { args: string[]; filterGraph: string } {
  if (plan.model === "A") return ffmpegArgsA(plan, files, source, opts);
  const mix = plan.audioMix;
  if (mix && mix.loudness != null && !opts.measure && opts.loudnessGainDb == null) throw new RenderPlanError("This render sets the loudness: measure the mix first (ffmpegArgs with measure: true), then pass loudnessGainDb.");
  const inputs: string[] = [];
  const g: string[] = [];
  let idx = 0;
  const W = plan.width, H = plan.height;
  // Phase 7: the output's frame rate (30 for previews; a final keeps its footage's). At 30 every string is as before.
  const FPS = plan.fps || 30, R = plan.rate || String(FPS), TB = timeBase(R), fr = { fps: FPS, rate: R };
  const main = plan.sources[0];
  const info = (vid: string): { hasAudio: boolean; hdr: boolean; transfer?: HdrTransfer } => plan.videos?.[vid] ?? { hasAudio: vid === main ? source.hasAudio : true, hdr: vid === main ? !!source.hdr : false, transfer: vid === main ? source.transfer : undefined };
  // Phase 6: an HDR output keeps 10 bits all the way (PF); SDR pictures enter it through the SDR-into-HDR LUT.
  const hdr = plan.hdr ?? null;
  const PF = hdr ? "yuv420p10le" : "yuv420p", PFA = hdr ? "yuva420p10le" : "yuva420p";
  const looks = plan.looks ?? {};
  const lookPath = (name: string) => { const x = files.looks?.[name]; if (!x) throw new RenderPlanError(`A colour file of this edit is missing (${name}). Render again.`); return x; };
  /** A look picture (mask or area, .pgm) as a grey stream `frames` long. */
  const picture = (name: string, frames: number, tag: string) => {
    inputs.push("-loop", "1", "-framerate", R, "-t", n3(frames / FPS + 1), "-i", lookPath(name));
    g.push(`[${idx++}:v]format=gray,setsar=1,trim=end_frame=${frames}[lp${tag}]`);
    return `lp${tag}`;
  };
  /**
   * A clip's look on [inp] (fitted, W x H, `frames` long), in this order: the key's alpha from the fitted colours,
   * despill, the grade (lut3d), blur/pixelate mixed in by their areas (maskedmerge), the masks into the alpha. In an
   * HDR output an SDR picture goes through the SDR-into-HDR LUT (with its grade, 16-bit). dom: what [inp] holds.
   */
  const colorChain = (inp: string, look: LookOp | undefined, dom: "sdr" | "hdr", frames: number, tag: string): { out: string; alpha: boolean } => {
    const toHdr = !!hdr && dom === "sdr";
    if (!look && !toHdr) return { out: inp, alpha: false };
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
    (look?.effects ?? []).forEach((e, j) => {
      const fx = e.type === "blur" ? `gblur=sigma=${e.px}:steps=4` : `pixelize=width=${e.px}:height=${e.px}:mode=avg`, t2 = `${tag}_${j}`;
      if (!e.file) { g.push(`[${rgb}]${fx},format=${rgbF}[le${t2}]`); rgb = `le${t2}`; return; }
      g.push(`[${rgb}]split[la${t2}][lb${t2}]`);
      g.push(`[lb${t2}]${fx},format=${rgbF}[lf${t2}]`);
      g.push(`[${picture(e.file, frames, "e" + t2)}]format=${rgbF}[lm${t2}]`);
      g.push(`[la${t2}][lf${t2}][lm${t2}]maskedmerge[le${t2}]`);
      rgb = `le${t2}`;
    });
    if (look?.mask) {
      const mk = picture(look.mask, frames, "m" + tag);
      if (alpha) { g.push(`[${alpha}][${mk}]blend=all_mode=multiply[lq${tag}]`); alpha = `lq${tag}`; } else alpha = mk;
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
      const path = files.under?.[u.clipId];
      if (!path) return;
      const s = Math.max(start, u.start), e = Math.min(end, u.end), n = Math.max(1, Math.round((e - s) * FPS)), t = `${tag}u${j}`;
      inputs.push("-ss", n3(u.sourceStart + (s - u.start)), "-t", n3(e - s + 0.25), "-i", path);
      g.push(`[${idx++}:v]fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=${n}[ua${t}]`);
      const c = colorChain(`ua${t}`, looks[u.clipId], "sdr", n, t);
      let ov = c.out;
      if (u.keys?.length) { motionChain(g, ov, `um${t}`, u.keys, s - u.start, n, W, H, false, t, { hdr: !!hdr, fr }); ov = `um${t}`; }
      g.push(`[${ov}]settb=${TB},setpts=PTS-STARTPTS+${Math.round((s - start) * FPS)}[ub${t}]`);
      g.push(`[${cur}][ub${t}]overlay=eof_action=pass:format=auto,format=${PF}[bu${t}]`);
      cur = `bu${t}`;
    });
    return cur;
  };

  // One input per video.
  const inOf: Record<string, number> = {};
  for (const vid of plan.sources) {
    const path = vid === main ? files.source : files.videos?.[vid];
    if (!path) throw new RenderPlanError(`The file of a video on V1 is missing (${vid}).`);
    inputs.push("-i", path);
    inOf[vid] = idx++;
  }
  const splitOf = (kind: "v" | "a", vid: string, n: number, name: (i: number) => string) => {
    if (kind === "v") g.push(`[${inOf[vid]}:v]fps=${R}${n > 1 ? `,split=${n}${Array.from({ length: n }, (_, i) => `[${name(i)}]`).join("")}` : `[${name(0)}]`}`);
    else g.push(`[${inOf[vid]}:a]aresample=48000${n > 1 ? `,asplit=${n}${Array.from({ length: n }, (_, i) => `[${name(i)}]`).join("")}` : `[${name(0)}]`}`);
  };

  // 1. Picture (not in the measuring pass): put each video on a 30 fps grid, take its parts and join them in edit
  // order. Parts start and end on frames (planRender), so each is a whole number of frames.
  let v = "";
  if (!opts.measure) {
    const vt = (k: { srcIn: number; srcOut: number }) => `trim=start=${n6(k.srcIn)}:end=${n6(k.srcOut)},setpts=PTS-STARTPTS`;
    const turnOf = (r: number) => (r === 90 ? "transpose=1," : r === 270 ? "transpose=2," : r === 180 ? "hflip,vflip," : "");
    // HDR originals are tone-mapped to SDR BT.709 exactly like the preview copy, so the final looks like the preview
    // (Phase 6: unless the output keeps HDR; a graded or keyed HDR clip is still graded on that SDR picture).
    const toneOf = (vid: string, dom: "sdr" | "hdr" = "sdr") => (info(vid).hdr && dom === "sdr" ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "");
    /** Where a clip's picture lives: HDR (10-bit, the output's transfer) or SDR (graded, keyed, other transfer, or SDR). */
    const domOf = (vid: string, look: LookOp | undefined): "sdr" | "hdr" => (hdr && info(vid).hdr && (info(vid).transfer ?? "pq") === hdr.transfer && !look?.grade && !look?.key ? "hdr" : "sdr");
    const fit = `fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4,setsar=1`;
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
    const branches: Record<string, string[]> = {};
    const branch = (vid: string) => { const l = `sv${Object.values(branches).reduce((a, b) => a + b.length, 0)}`; (branches[vid] ??= []).push(l); return l; };
    const pathOf = (vid: string) => (vid === main ? files.source : files.videos?.[vid])!;
    /**
     * One stretch of picture as exactly round(length x 30) frames at output size: its footage at its rate (reversed in
     * 1 s chunks, each from its own input so memory stays small; frozen = one frame held), turned, fitted, framed and
     * moved by its clip's keyframes. `exact` pads or trims to the frame count (transition sides).
     */
    const drawSeg = (x: { videoId: string; srcIn: number; srcOut: number; rate?: number; start: number; end: number; rotate: number; framing: Framing | null; clipIds?: string[]; clipId?: string }, out: string, tag: string, exact = false) => {
      const N = Math.max(1, Math.round((x.end - x.start) * FPS));
      const r = rateOf(x);
      const lk = looks[x.clipId ?? x.clipIds?.[0] ?? ""], dom = domOf(x.videoId, lk);
      const look = `${turnOf(x.rotate)}${toneOf(x.videoId, dom)}${fit}`;
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
      } else if (r === 0) chain = `[${branch(x.videoId)}]trim=start=${n6(x.srcIn)}:end=${n6(x.srcIn + 1 / FPS)},setpts=PTS-STARTPTS,fps=${R},tpad=stop_mode=clone:stop=${N},trim=end_frame=${N},${look}`;
      else if (r !== 1) chain = `[${branch(x.videoId)}]trim=start=${n6(x.srcIn)}:end=${n6(x.srcOut + 1 / FPS)},${pick(r)}${pad},${look}`;
      else chain = `[${branch(x.videoId)}]${vt(x)}${exact ? pad : ""},${look}`;
      const clipId = x.clipId ?? (x.clipIds?.length === 1 ? x.clipIds[0] : undefined);
      const m = clipId ? motion[clipId] : undefined;
      // A card is drawn through frame() (its shadow and border), framed or not.
      const card = plan.cards?.[x.clipId ?? x.clipIds?.[0] ?? ""];
      const frm = x.framing ?? (card ? { scale: 1, x: 0, y: 0 } : null);
      // The clip's own picture, blurred, as the background: taken before its look (where something shows behind it).
      const blurBg = !!bg?.blur && (!!frm || !!lk?.alpha || !!m);
      if (!lk && !hdr && !frm && !m) { g.push(`${chain},format=yuv420p[${out}]`); return; }
      if (!lk && !hdr) g.push(`${chain},format=yuv420p${blurBg ? `,split[pf${tag}][pbs${tag}]` : `[pf${tag}]`}`);
      else g.push(`${chain}${blurBg ? `,split[pc${tag}][pbs${tag}]` : `[pc${tag}]`}`);
      const c = !lk && !hdr ? { out: `pf${tag}`, alpha: false } : colorChain(`pc${tag}`, lk, dom, N, tag);
      let cur = c.out;
      // Phase 6: what shows around or through the clip is what is behind V1 (black, the background, or b-roll laid under it).
      const behind = () => (underClips.length || bg ? baseOf(x.start, N, tag, blurBg ? `pbs${tag}` : undefined, dom) : null);
      if (!frm && !m) {
        if (c.alpha) { const b = behind(); if (b) g.push(`[${b}][${cur}]overlay=format=auto,format=${PF}[${out}]`); else { g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${n6(N / FPS + 1)},format=${PF},trim=end_frame=${N}[pb${tag}]`); g.push(`[pb${tag}][${cur}]overlay=format=auto,format=${PF}[${out}]`); } }
        else g.push(`[${cur}]format=${PF}[${out}]`);
        return;
      }
      if (frm) { const b = m ? null : behind(); frame(cur, frm, `pg${tag}`, tag, m ? "clear" : b ? { base: b } : "black", card, N); cur = `pg${tag}`; }
      if (m) { motionChain(g, cur, out, m.keys, x.start - m.start, N, W, H, true, tag, { base: behind() ?? undefined, hdr: !!hdr, fr }); return; }
      g.push(`[${cur}]format=${PF}[${out}]`);
    };

    const N = plan.parts.length;
    // One video, one look, all at normal speed and still: cut, join, then fit once (the same graph model A used).
    // Otherwise each part is drawn on its own first.
    const lookKey = (p: PicturePart) => JSON.stringify(looks[p.clipIds[0]] ?? null);
    const uniform = plan.sources.length === 1 && !underClips.length && !(bg?.videoId) && plan.parts.every((p) => rateOf(p) === 1 && p.rotate === plan.parts[0].rotate && sameFraming(p.framing, plan.parts[0].framing) && !(p.clipIds.length === 1 && motion[p.clipIds[0]]) && lookKey(p) === lookKey(plan.parts[0]));
    plan.parts.forEach((p, i) => { if (uniform) g.push(`[${branch(p.videoId)}]${vt(p)}[v${i}]`); else drawSeg(p, `v${i}`, String(i)); });
    // concat's output counts in microseconds, a hair before each frame's exact time; back on the 1/30 s grid so every
    // overlay below lines up with its own frame (else each one shows a frame late).
    g.push(`${plan.parts.map((_, i) => `[v${i}]`).join("")}concat=n=${N}:v=1:a=0${uniform ? "" : `,settb=${TB}`}[vcat]`);
    v = "vcat";
    if (uniform) {
      const p0 = plan.parts[0], lk = looks[p0.clipIds[0]], dom = domOf(p0.videoId, lk);
      const card = plan.cards?.[p0.clipIds[0]];
      const frm = p0.framing ?? (card ? { scale: 1, x: 0, y: 0 } : null);
      const blurBg = !!bg?.blur && (!!frm || !!lk?.alpha);
      g.push(`[vcat]${turnOf(p0.rotate)}${toneOf(p0.videoId, dom)}${fit}${blurBg ? ",split[vfit][vbs]" : "[vfit]"}`);
      v = "vfit";
      // Phase 6: one look for the whole edit, drawn once (keyed or masked parts show what is behind V1).
      const all = Math.max(1, Math.round(plan.outputSeconds * FPS));
      const c = colorChain(v, lk, dom, all, "u");
      v = c.out;
      const back = () => (bg ? backOf(0, all, "U", blurBg ? "vbs" : undefined, dom) : null);
      if (c.alpha && !frm) {
        const b = back();
        if (!b) g.push(`color=c=black:s=${W}x${H}:r=${R}:d=${n6(all / FPS + 1)},format=${PF},trim=end_frame=${all}[ubk]`);
        g.push(`[${b ?? "ubk"}][${v}]overlay=format=auto,format=${PF}[vlook]`); v = "vlook";
      }
      if (frm) { const b = back(); frame(v, frm, "vframed", "", b ? { base: b } : "black", card, all); v = "vframed"; }
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
      if (t.type === "dissolve") g.push(`[${b}]format=${PFA},fade=t=in:st=0:d=${n6(D)}:alpha=1[tbf${i}];[${a}][tbf${i}]overlay=format=auto,format=${PF}[tx${i}]`);
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
    // Each video's decoder, split into the branches its segments took.
    for (const [vid, ls] of Object.entries(branches)) g.push(`[${inOf[vid]}:v]fps=${R}${ls.length > 1 ? `,split=${ls.length}${ls.map((l) => `[${l}]`).join("")}` : `[${ls[0]}]`}`);
  }

  // 2. Dialogue: each sound part from its video (sample-exact), silence for muted parts and parts silent at their speed,
  // joined in edit order. A clip off normal speed plays its stretch through atempo (pitch kept), its speed changing at
  // each step's footage moment. Every unit fades in and out over the declick time (20 ms by default), so no cut clicks.
  const live = (x: SoundPart) => !x.muted && !x.silent && info(x.videoId).hasAudio && inOf[x.videoId] != null;
  const units: SoundPart[][] = [];
  for (const x of plan.sound) {
    const u = units[units.length - 1], prev = u?.[u.length - 1];
    // A ramp's steps are footage that goes on (each step's ends were put on frames, so they meet within a frame).
    const goesOn = !!prev && live(prev) && live(x) && prev.clipId === x.clipId && prev.videoId === x.videoId && (rateOf(prev) !== 1 || rateOf(x) !== 1) && rateOf(prev) > 0 && rateOf(x) > 0 && Math.abs(prev.srcOut - x.srcIn) <= 1 / FPS + 1e-6;
    if (goesOn) u.push(x); else units.push([x]);
  }
  const editSamples = (u: SoundPart[]) => Math.max(1, Math.round(u.reduce((acc, x) => acc + (rateOf(x) === 1 ? x.srcOut - x.srcIn : rateOf(x) === 0 ? Math.round((x.end - x.start) * FPS) / FPS : Math.round(((x.srcOut - x.srcIn) / Math.abs(rateOf(x))) * FPS) / FPS), 0) * 48000));
  const declick = (len: number) => {
    if (!mix || !(mix.declick > 0)) return "";
    const d = Math.min(mix.declick, len / 4);
    return `,afade=t=in:d=${n6(d)},afade=t=out:st=${n6(len - d)}:d=${n6(d)}`;
  };
  const at = (k: SoundPart) => `atrim=start=${n6(k.srcIn)}:end=${n6(k.srcOut)},asetpts=PTS-STARTPTS${declick(k.srcOut - k.srcIn)}`;
  const tempo = (u: SoundPart[]) => {
    const a = u[0].srcIn, n = editSamples(u);
    const cmds = u.slice(1).map((x) => `${n6(x.srcIn - a)} atempo@at${u[0].start.toFixed(3).replace(".", "_")} tempo ${rateOf(x)}`).join(";");
    const name = `atempo@at${u[0].start.toFixed(3).replace(".", "_")}`;
    return `atrim=start=${n6(a)}:end=${n6(u[u.length - 1].srcOut)},asetpts=PTS-STARTPTS,asetnsamples=n=480${cmds ? `,asendcmd=c='${cmds}'` : ""},${name}=tempo=${rateOf(u[0])},apad,atrim=end_sample=${n},asetpts=PTS-STARTPTS${declick(n / 48000)}`;
  };
  for (const vid of plan.sources) {
    const mine = units.map((u, i) => ({ u, i })).filter((y) => y.u[0].videoId === vid && live(y.u[0]));
    if (!mine.length) continue;
    splitOf("a", vid, mine.length, (k) => `sa${mine[k].i}`);
    for (const { u, i } of mine) g.push(`[sa${i}]${u.length === 1 && rateOf(u[0]) === 1 ? at(u[0]) : tempo(u)}[a${i}]`);
  }
  units.forEach((u, i) => { if (!live(u[0])) g.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${editSamples(u)},asetpts=PTS-STARTPTS[a${i}]`); });
  // The sound ends where the edit does, to the millisecond; the picture on its last frame: the sound is padded or
  // cut to the picture's length (under half a frame).
  g.push(`${units.map((_, i) => `[a${i}]`).join("")}concat=n=${units.length}:v=0:a=1,apad=whole_dur=${n6(plan.outputSeconds)},atrim=end=${n6(plan.outputSeconds)}[acat]`);

  if (!opts.measure) v = overlays(plan, files, g, inputs, () => idx++, v, { colorChain, PF, PFA, hdrLut: hdr ? lookPath(hdr.lut) : null });
  mixAudio(plan, files, g, inputs, () => idx++, opts);
  return { args: encodeArgs(plan, inputs, files, opts), filterGraph: g.join(";\n") };
}

/**
 * Keyframes as filters on [inp], a W x H picture `frames` long (Phase 5). FFmpeg's perspective filter puts the
 * picture's four corners where the keys move, scale and turn it, frame by frame, transparent around it; opacity
 * multiplies its alpha. The curves are the same tables the player reads (motion.ts). opaque: laid on black (V1);
 * otherwise it keeps its alpha (b-roll, graphics). `offset`: seconds into the clip at the picture's first frame.
 */
export function motionChain(g: string[], inp: string, out: string, keys: Key[], offset: number, frames: number, W: number, H: number, opaque: boolean, tag: string, o: { base?: string; hdr?: boolean; fr?: { fps: number; rate: string } } = {}) {
  const FPS = o.fr?.fps ?? 30, RATE = o.fr?.rate ?? String(FPS);
  const tracks = keyTracks(keys);
  if (!tracks) { g.push(`[${inp}]null[${out}]`); return; }
  // A picture that only ever gets small is scaled down first (a proper scaler), so the corner mapping does not alias.
  const [, smax] = scaleRange(tracks);
  const pre = smax < 0.75 ? Math.max(0.05, smax) : 1;
  const P = 2, CW = W + 2 * P, CH = H + 2 * P;
  const tv = `((in-1)/${FPS}+${n6(offset)})`; // perspective counts frames from 1
  const S = motionExpr(tracks, "scale", tv), X = motionExpr(tracks, "x", tv), Y = motionExpr(tracks, "y", tv);
  const R = `(${motionExpr(tracks, "rotation", tv)})*PI/180`;
  const k = pre === 1 ? S : `${S}/${pre}`;
  const corner = (i: number, sx: number, sy: number) => {
    const dx = (sx * CW) / 2, dy = (sy * CH) / 2;
    return `x${i}='${CW / 2}+${W}*${X}+${k}*(${dx}*cos(${R})-(${dy})*sin(${R}))':y${i}='${CH / 2}+${H}*${Y}+${k}*(${dx}*sin(${R})+(${dy})*cos(${R}))'`;
  };
  const shrink = pre < 1 ? `,scale=${even(W * pre)}:${even(H * pre)}` : "";
  g.push(`[${inp}]format=yuva420p${shrink},pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=black@0,perspective=${corner(0, -1, -1)}:${corner(1, 1, -1)}:${corner(2, -1, 1)}:${corner(3, 1, 1)}:sense=destination:eval=frame,crop=${W}:${H}:${P}:${P}[mv${tag}]`);
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

type ColorCtx = { colorChain: (inp: string, look: LookOp | undefined, dom: "sdr" | "hdr", frames: number, tag: string) => { out: string; alpha: boolean }; PF: string; PFA: string; hdrLut: string | null };
/** Zooms, b-roll, graphics, captions on [v]; returns the label of the finished picture ([vout]). */
function overlays(plan: RenderPlan, files: PlanFiles, g: string[], inputs: string[], next: () => number, v0: string, cc: ColorCtx): string {
  const W = plan.width, H = plan.height;
  const FPS = plan.fps || 30, R = plan.rate || String(FPS), TB = timeBase(R), fr = { fps: FPS, rate: R };
  let v = v0;
  // 3. Zooms: scale per frame, crop back to size.
  if (plan.zooms.length) {
    const z = zoomExpr(plan.zooms);
    // crop's iw/ih are fixed when the filter starts, so the offsets are computed from the zoom itself
    // (centred across, 40% down, the same framing as the fit step).
    g.push(`[${v}]scale=w='2*trunc(${W}*(${z})/2)':h='2*trunc(${H}*(${z})/2)':eval=frame,crop=${W}:${H}:x='(2*trunc(${W}*(${z})/2)-${W})/2':y='(2*trunc(${H}*(${z})/2)-${H})*0.4'[vzoom]`);
    v = "vzoom";
  }
  // 4. B-roll overlays (video only; the dialogue keeps playing underneath).
  plan.broll.forEach((b, i) => {
    const path = files.broll?.[b.clipId];
    if (!path) return;
    inputs.push("-ss", n3(b.sourceStart), "-t", n3(b.end - b.start), "-i", path);
    const bi = next();
    const n = Math.max(1, Math.round((b.end - b.start) * FPS));
    const look = plan.looks?.[b.clipId];
    if (b.keys?.length || look || plan.hdr) {
      // Keyframed b-roll: moved, scaled, turned and faded over the picture (picture-in-picture). Phase 6: its look
      // (grade, key, masks, blur) first; in an HDR output it goes in as SDR.
      g.push(`[${bi}:v]fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=${n}[bk${i}]`);
      let cur = cc.colorChain(`bk${i}`, look, "sdr", n, `b${i}`).out;
      if (b.keys?.length) { motionChain(g, cur, `bm${i}`, b.keys, 0, n, W, H, false, `b${i}`, { hdr: !!plan.hdr, fr }); cur = `bm${i}`; }
      g.push(`[${cur}]settb=${TB},setpts=PTS-STARTPTS+${Math.round(b.start * FPS)}[br${i}]`);
    } else
    g.push(`[${bi}:v]fps=${R},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,settb=${TB},setpts=PTS-STARTPTS+${Math.round(b.start * FPS)}[br${i}]`);
    g.push(`[${v}][br${i}]overlay=0:0:enable='between(t,${n6(b.start)},${n6(b.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : ""}[vb${i}]`);
    v = `vb${i}`;
  });
  // 5. Graphics: transparent WebM, decoded with libvpx to keep the alpha channel.
  plan.graphics.forEach((gr, i) => {
    const path = files.graphics?.[gr.clipId];
    if (!path) return;
    inputs.push("-c:v", "libvpx-vp9", "-i", path);
    const gi = next();
    // HDR output: the graphic's colours as the same light at SDR white (16-bit RGB through the SDR-into-HDR LUT).
    const toHdr = cc.hdrLut ? `,scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrap16le,lut3d=file=${q(cc.hdrLut)}:interp=trilinear,scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd,format=${cc.PFA}` : "";
    const n = Math.max(1, Math.round((gr.end - gr.start) * FPS));
    // Phase 7: a file shorter than its clip (a custom graphic placed longer than its recording) holds its last frame.
    const hold = (files.graphicSeconds?.[gr.clipId] ?? Infinity) - gr.sourceStart < gr.end - gr.start - 0.5 / FPS;
    // Started part way in (add_graphic from): put on the frame grid first, then cut. The recording keeps one picture
    // for a still stretch, so seeking the file would skip the picture already showing at that time.
    const from = gr.sourceStart > 0 ? `fps=${R},trim=start_frame=${Math.round(gr.sourceStart * FPS)},setpts=PTS-STARTPTS,` : "";
    if (gr.keys?.length) {
      // Keyframed graphic: centred on a transparent frame, then moved, scaled, turned and faded.
      g.push(`[${gi}:v]${from}format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=${R},tpad=stop_mode=clone:stop=${hold ? -1 : 2},trim=end_frame=${n}${toHdr}[gk${i}]`);
      motionChain(g, `gk${i}`, `gm${i}`, gr.keys, 0, n, W, H, false, `g${i}`, { hdr: !!plan.hdr, fr });
      g.push(`[gm${i}]setpts=PTS-STARTPTS+${n3(gr.start)}/TB[gr${i}]`);
    } else
    g.push(`[${gi}:v]${from}${hold ? `fps=${R},tpad=stop_mode=clone:stop=-1,trim=end_frame=${n},` : ""}format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease${toHdr},setpts=PTS-STARTPTS+${n3(gr.start)}/TB[gr${i}]`);
    g.push(`[${v}][gr${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${n6(gr.start)},${n6(gr.end - 0.5 / FPS)})':eof_action=pass${plan.hdr ? `:format=auto,format=${cc.PF}` : ""}[vg${i}]`);
    v = `vg${i}`;
  });
  // 6. Captions on top of everything.
  if (plan.ass && files.assPath) {
    // HDR: the frame is tagged BT.2020 so libass turns the (already PQ/HLG) caption colours into YUV with that matrix.
    g.push(`[${v}]${plan.hdr ? `setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=${plan.hdr.transfer === "pq" ? "smpte2084" : "arib-std-b67"}:range=tv,` : ""}ass=filename=${q(files.assPath)}${files.fontsDir ? `:fontsdir=${q(files.fontsDir)}` : ""}[vcap]`);
    v = "vcap";
  }
  g.push(`[${v}]format=${cc.PF}[vout]`);
  return "vout";
}

const lin = (db: number) => Math.pow(10, db / 20);
/** The limiter's ceiling sits this far under the true-peak target: AAC encoding adds up to ~0.8 dB to sharp peaks (measured at 96k). */
const PEAK_MARGIN = 1.0;

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
    g.push(`[${mi}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${fades(d, m.fadeIn ?? auto.fadeIn, m.fadeOut ?? auto.fadeOut)},volume=${m.gainDb}dB,adelay=delays=${Math.round(m.start * 1000)}:all=1${ducking}[mu${i}]`);
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
    g.push(`[${si}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${fades(d, s.fadeIn ?? 0, s.fadeOut ?? 0)},volume=${s.gainDb}dB,adelay=delays=${Math.round(s.start * 1000)}:all=1[fx${i}]`);
    mixIn.push(`[fx${i}]`);
  });
  const T = plan.outputSeconds;
  const mixFades = mix ? `${mix.fadeIn > 0 ? `,afade=t=in:d=${n3(mix.fadeIn)}` : ""}${mix.fadeOut > 0 ? `,afade=t=out:st=${n3(Math.max(0, T - mix.fadeOut))}:d=${n3(mix.fadeOut)}` : ""}` : "";
  const sum = mixIn.length > 1 ? `${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first${mixFades}` : `${mixIn[0]}${mixFades ? "anull" + mixFades : "anull"}`;
  if (opts.measure) { g.push(`${sum},ebur128=peak=true:framelog=quiet[aout]`); return; }
  if (mix && mix.loudness != null) {
    // The measured gain, then a limiter at 4x the sample rate so the peaks between samples stay under the ceiling.
    g.push(`${sum},volume=${(opts.loudnessGainDb ?? 0).toFixed(2)}dB,aresample=192000,alimiter=limit=${lin(mix.peak - PEAK_MARGIN).toFixed(4)}:attack=5:release=50:level=disabled,aresample=48000[aout]`);
  } else {
    // Loudness off: a safety limiter only. (The old one had FFmpeg's auto-level on: it raised everything to the limit
    // and then rode loud sound wave by wave, which distorts it; model A plans keep it, unchanged.)
    g.push(`${sum},alimiter=limit=0.95:level=disabled[aout]`);
  }
}

function encodeArgs(plan: RenderPlan, inputs: string[], files: PlanFiles, opts: FfmpegOpts): string[] {
  if (opts.measure) {
    return ["-hide_banner", "-nostdin", "-y", "-nostats", ...inputs, "-filter_complex_script", "__FILTER_SCRIPT__", "-map", "[aout]", "-t", n3(plan.outputSeconds), "-progress", "pipe:1", "-f", "null", "-"];
  }
  const preview = plan.kind === "preview";
  const trc = plan.hdr ? (plan.hdr.transfer === "pq" ? "smpte2084" : "arib-std-b67") : "";
  // HDR (Phase 6): HEVC Main 10 with BT.2020 and the source's transfer in the stream and the container.
  // Phase 7: the output's frame rate (a final keeps its footage's), a keyframe every 2 s, and the export's codec. HEVC
  // carries the hvc1 tag so Apple devices play it; at 4K x265 runs one preset faster.
  const R = plan.rate || "30", gop = String(Math.round((plan.fps || 30) * 2)), x265Preset = plan.width * plan.height > 4e6 ? "faster" : "fast";
  const video = plan.hdr
    ? ["-c:v", "libx265", "-preset", x265Preset, "-crf", "20", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-x265-params", `log-level=error:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc:range=limited:repeat-headers=1${plan.hdr.transfer === "pq" ? ":hdr10=1:hdr10-opt=1" : ""}`, "-r", R, "-g", gop, "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", trc]
    : plan.codec === "hevc"
      ? ["-c:v", "libx265", "-preset", x265Preset, "-crf", "22", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-x265-params", "log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited", "-r", R, "-g", gop, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
      : ["-c:v", "libx264", "-preset", preview ? "ultrafast" : "veryfast", "-crf", preview ? "28" : "20", "-pix_fmt", "yuv420p", "-r", R, "-g", gop, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    ...inputs,
    ...(opts.filterThreads ? ["-filter_complex_threads", String(opts.filterThreads)] : []),
    "-filter_complex_script", "__FILTER_SCRIPT__",
    "-map", "[vout]", "-map", "[aout]",
    ...video,
    "-c:a", "aac", "-b:a", preview ? "96k" : "192k", "-ar", "48000",
    "-t", n3(plan.outputSeconds),
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
