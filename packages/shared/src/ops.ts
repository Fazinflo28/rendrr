import { z } from "zod";
import { findMusic, MUSIC_TRACKS, SFX } from "./catalog";
import type { Aspect } from "./constants";
import { mergeRules, StyleRulesPatchSchema, type StyleRules } from "./styles";
import {
  AspectSchema, audioSettings, CaptionLookSchema, CLEANUPS, ClipSchema, FramingSchema, isCaptionMarker, RotationSchema, SnapshotSchema, TimelineSchema, TrackNameSchema,
  normalizeTimeline, timelineProblems, RESOLUTIONS, CODECS,
  type AudioSettings, type Clip, type Framing, type Snapshot, type Timeline, type TrackName, type V2Clip,
} from "./timeline";
import { autoMusicFades, CLEANUP_KNOBS, cleanupText } from "./audio";
import { CaptionStylePatchSchema, CaptionStyleSchema, captionStyleOf, CardSchema, presetStyle, styleText, TEXT_ANIMS, TEXT_PRESETS, textPreset, TextStylePatchSchema, TextStyleSchema, type Card, type TextAnim, type TextStyle } from "./captions";
import { allWords, type Line, type Silence, type Transcript, type Word } from "./transcript";
import { DIRS, KeySchema, RampPointSchema, SOUND_SPEEDS, TRANSITIONS, USES_HANDLES, type Key, type RampPoint, type Transition } from "./motion";
import { exportText, planTransitions, type FootageInfo } from "./renderPlan";
import { ChromaKeySchema, CurveSchema, EffectSchema, gradeFn, gradeText, KEY_DEFAULTS, LutRefSchema, MaskSchema, masksText, effectsText, chromaKeyText, matchGrade, type ChromaKey, type ClipLook, type Grade, type Lut } from "./look";
import {
  asSequence, EditError, findClip, fmtClock, insertSeqClip, isPlainSequence, layoutTimeline, mainVideoOf, mergeRanges, moveSeqClip, newSeqClipId, normalSpeed,
  outputDuration, plainFraming, reattach, removeEditRange, removeSourceRange, sequenceView, splitSeqClip, toModelB, withTracks,
  type Attached, type Range, type SeqClip, type SequenceView,
} from "./sequence";

// ---------------------------------------------------------------------------------------------
// Every change to a timeline is one of these ops. The UI sends `replace` (its autosave);
// the AI sends the granular ones. applyOp() is pure; applyTimelineChange() in packages/core
// is the only place that stores the result. Every op works on the sequence (model B): an older timeline is
// converted first (toModelB).
// ---------------------------------------------------------------------------------------------

const t = z.number().finite().min(0).max(24 * 3600);
/** The clips a Phase 6 op works on: clipId / clipIds (V1 or b-roll), all V1 clips, or the V1 clips of one video. */
const lookTargets = { clipId: z.string().max(80).optional(), clipIds: z.array(z.string().max(80)).max(2000).optional(), all: z.boolean().optional(), video: z.string().max(80).optional() };
const by = z.number().finite().min(-3600).max(3600);
/** edit: true = the op's times are seconds of the edit, not of the footage. */
const edit = z.boolean().optional();
const clipId = z.string().max(80);
// The ops that change an edit step by step. An AI sends a list of them in one go (the `batch` op).
const EDIT_OPS = [
  // wordIds cut those words (restore_words brings them back); from/to removes exactly that range, words or not.
  z.object({ op: z.literal("cut_words"), wordIds: z.array(z.string().max(40)).max(50_000).optional(), from: t.optional(), to: t.optional(), edit }),
  z.object({ op: z.literal("restore_words"), wordIds: z.array(z.string().max(40)).max(50_000) }),
  // edges (default on): also the silence at the start and end of every V1 clip (longer than 0.3 s), whatever overSeconds.
  z.object({ op: z.literal("cut_silences"), overSeconds: z.number().min(0.1).max(30), edges: z.boolean().optional() }),
  z.object({ op: z.literal("remove_fillers") }),
  // V1: the whole sequence, in order (start/end = footage of videoId, default the main footage). Keep a clip's id
  // to keep that clip. Other tracks: their clips (footage times, or edit times with edit true).
  z.object({ op: z.literal("set_clips"), track: TrackNameSchema, clips: z.array(ClipSchema.extend({ id: z.string().min(1).max(80).optional(), videoId: z.string().max(80).optional() }).passthrough()).max(4000), linked: z.boolean().optional(), edit }),
  // V1 clip times are that clip's own footage (or edit times with edit true).
  z.object({ op: z.literal("split_clip"), track: TrackNameSchema, clipId, at: t, linked: z.boolean().optional(), edit }),
  z.object({ op: z.literal("trim_clip"), track: TrackNameSchema, clipId, start: t, end: t, linked: z.boolean().optional(), edit }),
  z.object({ op: z.literal("delete_clip"), track: TrackNameSchema, clipId, linked: z.boolean().optional() }),
  // Model A only (picture and dialogue linked by matching times); in the sequence dialogue always follows its picture.
  z.object({ op: z.literal("set_link"), track: TrackNameSchema, clipId, linked: z.boolean() }),
  z.object({ op: z.literal("add_zoom"), start: t, end: t, scale: z.number().min(1.01).max(2), edit }),
  z.object({ op: z.literal("add_broll"), videoId: z.string().max(80), start: t, end: t, sourceStart: t.default(0), label: z.string().max(200).optional(), edit }),
  // look: back to that look's preset style. styleId: the captions of that style (its full caption style if it has one).
  z.object({ op: z.literal("set_captions"), on: z.boolean(), look: CaptionLookSchema.optional(), styleId: z.string().max(80).optional() }),
  z.object({ op: z.literal("edit_caption"), lineId: z.string().max(40), text: z.string().max(2000) }),
  z.object({ op: z.literal("add_music"), trackId: z.string().max(80), gainDb: z.number().min(-40).max(6).optional(), start: t.optional(), end: t.optional(), edit }),
  z.object({ op: z.literal("add_graphic"), graphicId: z.string().max(80), start: t, end: t, params: z.record(z.unknown()).default({}), label: z.string().max(200).optional(), edit }),
  z.object({ op: z.literal("set_aspect"), aspect: AspectSchema }),
  // Position and scale of the footage in the frame (Premiere's Motion). Leave a field out to keep it.
  // clipIds: those V1 clips (default every clip of the main footage).
  z.object({ op: z.literal("set_framing"), scale: z.number().min(0.25).max(4).optional(), x: z.number().min(-1).max(1).optional(), y: z.number().min(-1).max(1).optional(), clipIds: z.array(clipId).max(2000).optional() }),
  // Turn the footage clockwise (footage filmed sideways); 0 puts it back.
  z.object({ op: z.literal("set_rotation"), degrees: RotationSchema, clipIds: z.array(clipId).max(2000).optional() }),
  z.object({ op: z.literal("rename"), name: z.string().min(1).max(200) }),
  z.object({ op: z.literal("apply_style"), styleId: z.string().max(80), overrides: StyleRulesPatchSchema.optional() }),
  // ---- the sequence ----
  // A clip of any video (default the main footage) into V1: at position `index`, or at edit time `at` (a clip
  // playing there is split), else at the end.
  z.object({ op: z.literal("add_clip"), videoId: z.string().max(80).optional(), from: t, to: t, index: z.number().int().min(0).max(4000).optional(), at: t.optional(), label: z.string().max(200).optional() }),
  // Reorder: to position `index` (0 = first) or to the cut nearest edit time `at`.
  z.object({ op: z.literal("move_clip"), clipId, index: z.number().int().min(0).max(4000).optional(), at: t.optional() }),
  // J/L cuts. start -0.5: the clip's sound starts 0.5 s before its picture (J); end 0.5: its sound runs 0.5 s into
  // the next clip (L). muted: no sound.
  z.object({ op: z.literal("set_audio_offset"), clipId, start: by.optional(), end: by.optional(), muted: z.boolean().optional() }),
  // Rolling edit: the cut after clipId moves by `by` seconds (the clip gets longer, the next one shorter).
  z.object({ op: z.literal("roll_edit"), clipId, by }),
  // Slip: same place and length, footage `by` seconds later.
  z.object({ op: z.literal("slip_clip"), clipId, by }),
  // Slide: same footage, `by` seconds later in the edit (the clip before gets longer, the one after shorter).
  z.object({ op: z.literal("slide_clip"), clipId, by }),
  // ---- captions and text (Phase 4) ----
  // The caption style, field by field; look: start from that look's preset. Sizes in % (font size of the frame's
  // short side; stroke, shadow and box padding of the font size); x, y: the caption's bottom centre (shares of the frame).
  z.object({ op: z.literal("set_caption_style"), look: CaptionLookSchema.optional(), ...CaptionStylePatchSchema.shape }),
  // A text layer on V3 (title card, callout): text with \n line breaks, a preset to start from, any style field,
  // a full-frame card behind it, an animation. x, y: the point it hangs on.
  z.object({ op: z.literal("add_text"), text: z.string().min(1).max(1000), start: t, end: t, edit, preset: z.enum(TEXT_PRESETS).optional(), card: CardSchema.nullable().optional(), anim: z.enum(TEXT_ANIMS).optional(), label: z.string().max(200).optional(), ...TextStylePatchSchema.shape }),
  z.object({ op: z.literal("set_text"), clipId, text: z.string().min(1).max(1000).optional(), start: t.optional(), end: t.optional(), edit, preset: z.enum(TEXT_PRESETS).optional(), card: CardSchema.nullable().optional(), anim: z.enum(TEXT_ANIMS).optional(), ...TextStylePatchSchema.shape }),
  // ---- sound ----
  // The edit's sound: dialogue cleanup preset, loudness target (LUFS, null = off), true-peak ceiling (dBTP), how many
  // dB music goes down under speech (0 = off), fades of the whole mix. Fields left out keep their value.
  z.object({ op: z.literal("set_audio"), cleanup: z.enum(CLEANUPS).optional(), loudness: z.number().min(-30).max(-6).nullable().optional(), peak: z.number().min(-6).max(0).optional(), duck: z.number().min(0).max(30).optional(), fadeIn: z.number().min(0).max(10).optional(), fadeOut: z.number().min(0).max(10).optional(),
    highpass: z.number().min(0).max(300).nullable().optional(), denoise: z.number().min(0).max(40).nullable().optional(), presence: z.number().min(0).max(8).nullable().optional(), deess: z.number().min(0).max(1).nullable().optional(), compress: z.number().min(1).max(10).nullable().optional(), declick: z.number().min(0).max(0.03).optional() }),
  // One clip's sound: a V1 clip's dialogue (track v1 or a1, the default), a music clip (a2) or a sound effect (a3).
  z.object({ op: z.literal("set_clip_audio"), track: z.enum(["v1", "a1", "a2", "a3"]).optional(), clipId, gainDb: z.number().min(-40).max(20).optional(), fadeIn: z.number().min(0).max(30).optional(), fadeOut: z.number().min(0).max(30).optional() }),
  // ---- speed, transitions, keyframes (Phase 5) ----
  // A V1 clip's speed: speed (0.1-10, 1 = normal), reverse, ramp: speed points at the clip's footage seconds (linear
  // between them; null removes it). Sound keeps its pitch from 0.5x to 4x and is silent outside that or reversed.
  // freeze: a freeze frame's length.
  z.object({ op: z.literal("set_speed"), clipId, speed: z.number().min(0.1).max(10).optional(), reverse: z.boolean().optional(), ramp: z.array(RampPointSchema).min(2).max(20).nullable().optional(), freeze: z.number().min(0.1).max(60).optional() }),
  // A still of the frame at the clip's footage second `at` (edit seconds with edit true), held `length` seconds.
  z.object({ op: z.literal("freeze_frame"), clipId, at: t, length: z.number().min(0.1).max(60), edit }),
  // The transition on the cut before each clip (clipId, clipIds, or all: every cut). type "cut" removes it.
  z.object({ op: z.literal("set_transition"), clipId: clipId.optional(), clipIds: z.array(clipId).max(2000).optional(), all: z.boolean().optional(), type: z.enum(TRANSITIONS), duration: z.number().min(0.1).max(4).optional(), dir: z.enum(DIRS).optional() }),
  // A clip's keyframes (replaces them; [] removes them): V1, b-roll (v2), text or graphic (v3). Key t = seconds from
  // the clip's start in the edit.
  z.object({ op: z.literal("set_keyframes"), track: z.enum(["v1", "v2", "v3"]).optional(), clipId, keys: z.array(KeySchema).max(60) }),
  // ---- colour and compositing (Phase 6) ----
  // Which clips: clipIds (V1 or b-roll), all: every V1 clip, video: every V1 clip of that video.
  // A grade: fields left out keep their value, null removes one, reset: start from no grade. curves: channels to set
  // (master, r, g, b: points [in, out] 0-1; null removes that channel). lut: an imported LUT {id, amount 0-1, input}.
  z.object({ op: z.literal("set_grade"), ...lookTargets, reset: z.boolean().optional(),
    exposure: z.number().min(-4).max(4).nullable().optional(), contrast: z.number().min(-100).max(100).nullable().optional(), temperature: z.number().min(-100).max(100).nullable().optional(), tint: z.number().min(-100).max(100).nullable().optional(), saturation: z.number().min(0).max(200).nullable().optional(),
    curves: z.object({ master: CurveSchema.nullable().optional(), r: CurveSchema.nullable().optional(), g: CurveSchema.nullable().optional(), b: CurveSchema.nullable().optional() }).nullable().optional(), lut: LutRefSchema.nullable().optional() }),
  // A clip's grade onto other clips (with: also its key, masks, blur/pixelate).
  z.object({ op: z.literal("copy_grade"), from: clipId, to: z.array(clipId).max(2000).optional(), all: z.boolean().optional(), video: z.string().max(80).optional(), with: z.array(z.enum(["grade", "key", "masks", "effects"])).max(4).optional() }),
  // Clips' colour matched to a reference clip from measured frames (the server measures them; the result is a grade).
  z.object({ op: z.literal("match_color"), clipIds: z.array(clipId).min(1).max(200), to: clipId, measured: z.record(z.object({ w: z.number().int().min(1).max(512), h: z.number().int().min(1).max(512), rgb: z.string().max(2_000_000) })).optional() }),
  // Chroma key: color (pick it from the frame), similarity, blend, spill; off removes the key.
  z.object({ op: z.literal("set_key"), ...lookTargets, color: ChromaKeySchema.shape.color.optional(), similarity: ChromaKeySchema.shape.similarity.optional(), blend: ChromaKeySchema.shape.blend.optional(), spill: ChromaKeySchema.shape.spill.optional(), off: z.boolean().optional() }),
  // A clip's masks (replaces them; [] removes them) and its blur/pixelate effects (same).
  z.object({ op: z.literal("set_masks"), ...lookTargets, masks: z.array(MaskSchema).max(8) }),
  z.object({ op: z.literal("set_effects"), ...lookTargets, effects: z.array(EffectSchema).max(4) }),
  // A b-roll clip behind V1 (shows where V1 is keyed, masked, framed smaller or moved away) or back over it.
  z.object({ op: z.literal("set_under"), clipId, under: z.boolean() }),
  // How the final file is made: hdr keep (HDR footage stays HDR) or sdr (converted).
  z.object({ op: z.literal("set_export"), hdr: z.enum(["keep", "sdr"]).optional(), resolution: z.enum(RESOLUTIONS).optional(), codec: z.enum(CODECS).optional() }),
] as const;
export const EditOpSchema = z.discriminatedUnion("op", [...EDIT_OPS]);
export const EDIT_OP_NAMES = EDIT_OPS.map((o) => o.shape.op.value) as [EditOp["op"], ...EditOp["op"][]];
/** The fields of an edit its op does not have (a typo would otherwise be dropped silently and do nothing). */
export function unknownEditFields(e: unknown): { unknown: string[]; known: string[] } {
  const op = (e as { op?: unknown })?.op;
  const def = EDIT_OPS.find((o) => o.shape.op.value === op);
  if (!def || !e || typeof e !== "object") return { unknown: [], known: [] };
  const known = Object.keys(def.shape);
  return { unknown: Object.keys(e).filter((k) => !known.includes(k)), known: known.filter((k) => k !== "op") };
}
export type EditOp = z.infer<typeof EditOpSchema>;
export const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), timeline: TimelineSchema, name: z.string().max(200).optional(), aspect: AspectSchema.optional(), styleId: z.string().max(80).nullable().optional() }),
  ...EDIT_OPS,
  z.object({ op: z.literal("restore_snapshot"), snapshot: SnapshotSchema, note: z.string().max(300) }),
  z.object({ op: z.literal("batch"), ops: z.array(EditOpSchema).min(1).max(50) }),
]);
export type Op = z.infer<typeof OpSchema>;

export type StyleLite = { id: string; name: string; captionLook: "clean" | "bold" | "outline"; rules: StyleRules };
export type GraphicLite = { id: string; name: string; durationSec: number };
export type VideoLite = { id: string; name: string; seconds: number; ready: boolean };
export type EditContext = {
  /** The project's footage (the sequence's main video). */
  videoId?: string;
  transcript: Transcript;
  silences: Silence[];
  sceneCuts: number[];
  duration: number;
  getStyle: (id: string) => StyleLite | undefined;
  getVideo?: (id: string) => VideoLite | undefined;
  getGraphic?: (id: string) => GraphicLite | undefined;
  /** Other videos on V1: their transcripts and silences (cut_silences works on them too). */
  sources?: Record<string, { transcript: Transcript; silences: Silence[] }>;
  /** The user's imported LUTs (Phase 6): their names, and their numbers where an op needs them (match_color). */
  getLut?: (id: string) => { id: string; name: string } | undefined;
  lutData?: (id: string) => Lut | undefined;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const rid = (prefix: string) => prefix + Math.random().toString(36).slice(2, 7);
const firstWords = (l: Line, n = 3) => l.words.slice(0, n).map((w) => w.text).join(" ") + (l.words.length > n ? "…" : "");

// ---------------------------------------------------------------------------------------------
// First timeline for new footage (same shape as the UI's timelineFor()).
// ---------------------------------------------------------------------------------------------
export function paragraphs(tr: Transcript, { gap = 1.5, maxLen = 30 } = {}): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [];
  for (const l of tr) {
    const first = cur[0];
    if (cur.length && (l.start - cur[cur.length - 1].end > gap || l.end - first.start > maxLen)) { out.push(cur); cur = []; }
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** One V1 clip per paragraph, cut in the middle of the pauses between them (footage seconds). */
function paragraphClips(tr: Transcript, duration: number): Clip[] {
  const dur = r2(Math.max(0.5, duration));
  const paras = paragraphs(tr);
  if (!paras.length) return [{ id: "vc1", start: 0, end: dur, label: "Main" }];
  const v1: Clip[] = [];
  paras.forEach((p, i) => {
    const start = i === 0 ? 0 : r2((paras[i - 1][paras[i - 1].length - 1].end + p[0].start) / 2);
    const end = i === paras.length - 1 ? dur : r2((p[p.length - 1].end + paras[i + 1][0].start) / 2);
    if (end - start >= 0.05) v1.push({ id: "vc" + (i + 1), start, end, label: firstWords(p[0]) });
  });
  return v1;
}

/** The first timeline as model A stored it (kept for the migration and its tests). */
export function buildInitialTimelineA(tr: Transcript, duration: number, captionLook: "clean" | "bold" | "outline", cut: string[] = []): Timeline {
  const dur = r2(Math.max(0.5, duration));
  const v1 = paragraphClips(tr, dur);
  const a1 = v1.map((c, i) => ({ id: "d" + (i + 1), start: c.start, end: c.end, label: "Dialogue" }));
  const v3 = tr.map((l, i) => ({ id: "cap" + i, start: l.start, end: r2(Math.min(dur, Math.max(l.end, l.start + 0.6))), label: firstWords(l), kind: "caption" as const, lineId: l.id }));
  return normalizeTimeline({
    duration: dur,
    cut: cut.filter((id) => typeof id === "string"),
    captionsOn: true,
    captionLook,
    captionText: Object.fromEntries(tr.map((l) => [l.id, l.words.map((w) => w.text).join(" ")])),
    tracks: { v1, v2: [], v3, a1, a2: [], a3: [] },
  });
}

/** The first sequence for new footage: one clip per paragraph, in footage order, captions on. */
export function buildInitialTimeline(tr: Transcript, duration: number, captionLook: "clean" | "bold" | "outline", cut: string[] = [], videoId = "main"): Timeline {
  return toModelB(buildInitialTimelineA(tr, duration, captionLook, cut), allWords(tr), videoId);
}

/** A new edit: the footage as recorded and nothing applied (no style, captions off). `cut`: words the user removed
 *  on the footage page before starting it. Everything else comes from the user or their AI. */
export function buildRawTimeline(tr: Transcript, duration: number, cut: string[] = [], videoId = "main"): Timeline {
  return { ...buildInitialTimeline(tr, duration, "clean", cut, videoId), captionsOn: false };
}

// ---------------------------------------------------------------------------------------------
// Helpers used by ops.
// ---------------------------------------------------------------------------------------------

/** Pauses between words longer than `over` seconds. Small padding keeps breaths natural. */
export function pauseRanges(words: Word[], over: number, pad = 0.08): Range[] {
  const out: Range[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i].end, b = words[i + 1].t;
    if (b - a > over) out.push({ start: r2(a + pad), end: r2(b - pad) });
  }
  return out.filter((x) => x.end - x.start > 0.05);
}

const EDGE_SILENCE = 0.3;
/**
 * The silence at the start and end of every V1 clip of a video, before its first and after its last spoken word,
 * when longer than 0.3 s: each cut then sits right on the speech. Small pads keep the breath before the first word
 * and the tail of the last one. Footage seconds of that clip.
 */
export function clipEdgeSilences(tl: Timeline, words: Word[], videoId = mainVideoOf(tl)): (Range & { clipId: string })[] {
  const cut = new Set(videoId === mainVideoOf(tl) ? tl.cut : []);
  const out: (Range & { clipId: string })[] = [];
  for (const c of tl.tracks.v1 as SeqClip[]) {
    if (c.sourceVideoId !== videoId) continue;
    const inside = words.filter((w) => !cut.has(w.id) && w.end > c.sourceIn && w.t < c.sourceOut);
    if (!inside.length) continue; // a clip with no words: the audio's own silences decide (fromAudio)
    const first = inside[0], last = inside[inside.length - 1];
    if (first.t - c.sourceIn > EDGE_SILENCE) out.push({ clipId: c.id, start: c.sourceIn, end: r2(first.t - 0.1) });
    if (c.sourceOut - last.end > EDGE_SILENCE) out.push({ clipId: c.id, start: r2(last.end + 0.15), end: c.sourceOut });
  }
  return out;
}

/** Transcript lines with a word that plays in the edit, with the edit time of the line's start. */
function linesInEdit(tr: Transcript, tl: Timeline, view: SequenceView): { line: Line; at: number; end: number }[] {
  const cut = new Set(tl.cut);
  const main = view.mainVideoId;
  const plays = (w: Word) => !cut.has(w.id) && view.pieces.some((p) => p.videoId === main && w.t >= p.srcIn && w.t < p.srcOut);
  return tr.filter((l) => l.words.some(plays)).map((l) => ({ line: l, at: view.videoToEdit(main, l.start) ?? 0, end: view.videoToEdit(main, l.end) ?? 0 }));
}

function zoomClip(start: number, end: number, scale: number, mode: "punch" | "push", auto = false): V2Clip {
  return { id: rid("z"), start: r2(start), end: r2(end), label: `${mode === "push" ? "Push" : "Zoom"} ${Math.round(scale * 100)}%`, kind: "zoom", zoom: scale, mode, ...(auto ? { auto: true } : {}) } as V2Clip;
}

/** A clip for another track, placed at edit seconds s..e: it hangs on the V1 clip playing at s. */
function attachAt<T extends Clip>(view: SequenceView, c: T, s: number, e: number): T {
  const a = view.anchorFor(s);
  if (!a) throw new EditError("The sequence is empty: add a clip to V1 first.");
  return { ...c, start: r2(s), end: r2(e), anchorId: a.anchorId, anchorAt: r2(a.anchorAt), length: r2(e - s) } as T;
}

const seqClips = (tl: Timeline) => tl.tracks.v1 as SeqClip[];
const setSeq = (tl: Timeline, v1: SeqClip[]) => withTracks(tl, "v1", v1);
const mapClip = (tl: Timeline, id: string, f: (c: SeqClip) => SeqClip) => setSeq(tl, seqClips(tl).map((c) => (c.id === id ? f(c) : c)));
const name = (c: Clip) => c.label || c.id;

// ---------------------------------------------------------------------------------------------
// applyStyle: the machine-readable rules in action. Server side, deterministic, no AI. A plain cut of the footage
// starts again from the paragraph cut (so switching styles does not stack old silence cuts); a sequence that was
// rearranged or mixes videos is kept, and only gets the cuts.
// ---------------------------------------------------------------------------------------------
function applyStyleRules(snap: Snapshot, style: StyleLite, ctx: EditContext): { snap: Snapshot; summary: string } {
  const rules = style.rules;
  const words = allWords(ctx.transcript);
  const main = mainVideoOf(snap.timeline);
  let tl: Timeline = { ...snap.timeline };
  const did: string[] = [];

  if (isPlainSequence(tl)) {
    const before = tl;
    const look = seqClips(tl)[0] ? { ...(seqClips(tl)[0].rotate ? { rotate: seqClips(tl)[0].rotate } : {}), ...(plainFraming(seqClips(tl)[0].framing) ? { framing: seqClips(tl)[0].framing } : {}) } : {};
    tl = setSeq(tl, paragraphClips(ctx.transcript, ctx.duration).map((c) => ({ ...c, sourceVideoId: main, sourceIn: c.start, sourceOut: c.end, ...look }) as SeqClip));
    tl = reattach(before, tl, words);
  }
  // Drop what an earlier style added automatically; keep everything people or the AI placed by hand.
  const notAuto = <T extends Clip>(c: T) => !(c as Record<string, unknown>).auto;
  tl = { ...tl, tracks: { ...tl.tracks, v2: tl.tracks.v2.filter(notAuto), a2: tl.tracks.a2.filter(notAuto), a3: tl.tracks.a3.filter(notAuto) } };

  if (rules.trimEdges && words.length) {
    const before = tl;
    const a = Math.max(0, words[0].t - 0.15), b = Math.min(ctx.duration, words[words.length - 1].end + 0.3);
    tl = removeSourceRange(removeSourceRange(tl, main, 0, a), main, b, ctx.duration + 1);
    tl = reattach(before, tl, words);
    did.push("trimmed the start and end");
  }
  if (rules.cutSilencesOver != null) {
    const r = applyOpInner({ ...snap, timeline: tl }, { op: "cut_silences", overSeconds: rules.cutSilencesOver, edges: false }, ctx); // styles trim edges by their own rule
    tl = r.snap.timeline;
    if (r.count) did.push(`cut ${r.count} ${r.count === 1 ? "pause" : "pauses"} over ${rules.cutSilencesOver}s`);
  }
  if (rules.removeFillers) {
    const r = applyOpInner({ ...snap, timeline: tl }, { op: "remove_fillers" }, ctx);
    tl = r.snap.timeline;
    if (r.count) did.push(`removed ${r.count} filler ${r.count === 1 ? "word" : "words"}`);
  }

  // Zooms land on what people will actually see (edit seconds).
  const view = sequenceView(tl, words);
  const total = view.total;
  const spans: { s: number; e: number; mode: "punch" | "push" }[] = [];
  const z = rules.zoom;
  if (z.mode === "newSentence") {
    let lastAt = -99;
    for (const { line, at } of linesInEdit(ctx.transcript, tl, view)) {
      if (at - lastAt < 2) continue;
      const end = view.videoToEdit(main, Math.min(line.end, line.start + (z.holdSec ?? 1.6))) ?? at;
      if (end - at < 0.3) continue;
      spans.push({ s: at, e: end, mode: "punch" });
      lastAt = at;
    }
  } else if (z.mode === "interval" && total > 0) {
    const every = z.everySec ?? 3, hold = z.holdSec ?? Math.min(1.5, every / 2);
    for (let o = every; o < total - 0.3; o += every) if (Math.min(total, o + hold) - o > 0.2) spans.push({ s: o, e: Math.min(total, o + hold), mode: "punch" });
  } else if (z.mode === "slowPush") {
    for (const p of view.picture) if (p.end - p.start > 1.5) spans.push({ s: p.start, e: p.end, mode: "push" });
  } else if (z.mode === "count" && total > 0) {
    // Exactly `count` zooms on sentence starts, picked evenly across the edit (evenly spaced moments without speech).
    const n = z.count ?? 3, hold = z.holdSec ?? 1.6;
    const starts: { at: number; end: number }[] = [];
    let lastAt = -99;
    for (const { line, at } of linesInEdit(ctx.transcript, tl, view)) {
      if (at - lastAt < 1.5) continue;
      starts.push({ at, end: view.videoToEdit(main, Math.min(line.end, line.start + hold)) ?? at });
      lastAt = at;
    }
    const picks = starts.length >= n
      ? Array.from({ length: n }, (_, k) => starts[Math.min(starts.length - 1, Math.floor(((k + 0.5) * starts.length) / n))])
      : Array.from({ length: n }, (_, k) => { const o = (total * (k + 0.5)) / n; return { at: o, end: Math.min(total, o + hold) }; });
    for (const p of picks) if (p.end - p.at > 0.2) spans.push({ s: p.at, e: p.end, mode: "punch" });
  }
  const zooms = spans.map((x) => attachAt(view, zoomClip(x.s, x.e, z.scale, x.mode, true), x.s, x.e));
  if (zooms.length) did.push(`added ${zooms.length} ${zooms.length === 1 ? "zoom" : "zooms"}`);
  const sfx = rules.sfxOnZoom ? SFX.find((s) => s.id === rules.sfxOnZoom) : undefined;
  const sfxClips = sfx ? zooms.filter((x) => (x as Record<string, unknown>).mode === "punch").map((x) => attachAt(view, { id: rid("x"), start: 0, end: 0, label: sfx.name, sfxId: sfx.id, assetKey: sfx.key, auto: true } as Clip, x.start, x.start + sfx.seconds)) : [];

  const music = rules.music.mood ? findMusic(rules.music.mood) : undefined;
  const musicClips = music ? [{ id: rid("m"), start: 0, end: r2(total), label: music.name, trackId: music.id, assetKey: music.key, gainDb: rules.music.gainDb, auto: true, fill: true }] : [];
  if (music) did.push(`music ${music.name}`);

  // A style with a full caption style gives exactly those captions; otherwise the look's preset (with its word counts).
  const { captionStyle: _cs, ...noStyle } = tl;
  tl = {
    ...noStyle,
    ...(rules.captions.style ? { captionStyle: rules.captions.style } : {}),
    captionsOn: rules.captions.on,
    captionLook: rules.captions.look,
    tracks: { ...tl.tracks, v2: [...tl.tracks.v2, ...zooms], a2: [...tl.tracks.a2, ...musicClips], a3: [...tl.tracks.a3, ...sfxClips] },
  };
  did.push(rules.captions.on ? `captions ${rules.captions.look}` : "captions off");
  return { snap: { ...snap, styleId: style.id, timeline: tl }, summary: `applied style ${style.name}` + (did.length ? ": " + did.join(", ") : "") };
}

// ---------------------------------------------------------------------------------------------
// applyOp
// ---------------------------------------------------------------------------------------------
type Inner = { snap: Snapshot; summary: string; count?: number };

function applyOpInner(snap: Snapshot, op: Op, ctx: EditContext): Inner {
  if (op.op === "batch") {
    // One version for the whole list; the first edit that cannot be made stops it, so nothing half-done is saved.
    let cur = snap;
    const did: string[] = [];
    op.ops.forEach((o, i) => {
      try {
        const r = applyOpInner(cur, o, ctx);
        cur = r.snap;
        did.push(r.summary);
      } catch (e) {
        if (e instanceof EditError && op.ops.length > 1) throw new EditError(`Edit ${i + 1} (${o.op}): ${e.message} Nothing was changed.`);
        throw e;
      }
    });
    return { snap: cur, summary: did.join("; ") };
  }
  const words = allWords(ctx.transcript);
  const r = applyLeaf(snap, op, ctx);
  // A replaced or restored timeline may be an older one: it becomes a sequence too.
  const tl = asSequence(r.snap.timeline, words, ctx.videoId);
  // Clips on other tracks whose V1 clip went away are put back by their footage.
  return { ...r, snap: { ...r.snap, timeline: reattach(snap.timeline, normalizeTimeline(tl), words) } };
}

function applyLeaf(snap: Snapshot, op: Exclude<Op, { op: "batch" }>, ctx: EditContext): Inner {
  const tl = snap.timeline;
  const words = allWords(ctx.transcript);
  const wordById = new Map(words.map((w) => [w.id, w]));
  const main = mainVideoOf(tl);
  let viewCache: SequenceView | null = null;
  const view = () => (viewCache ??= sequenceView(tl, words));
  /** A time the op sent: edit seconds with edit true, else main-footage seconds (where that footage first plays). */
  const toEdit = (x: number, isEdit?: boolean) => (isEdit ? Math.min(x, view().total) : view().videoToEdit(main, x) ?? 0);
  const videoIdOf = (v?: string) => (!v || v === "main" ? main : v);
  const secondsOf = (vid: string) => (vid === main ? ctx.duration : ctx.getVideo?.(vid)?.seconds);
  const wordsOf = (vid: string) => (vid === main ? words : allWords(ctx.sources?.[vid]?.transcript ?? []));
  const lookOf = (vid: string) => {
    const c = seqClips(tl).find((x) => x.sourceVideoId === vid);
    return c ? { ...(c.rotate ? { rotate: c.rotate } : {}), ...(plainFraming(c.framing) ? { framing: c.framing } : {}) } : {};
  };
  /** A video for V1: the main footage, or a ready video of the user's. */
  const footage = (vid: string) => {
    if (vid === main) return { name: "the footage", seconds: ctx.duration };
    const v = ctx.getVideo?.(vid);
    if (!v) throw new EditError(`Video "${vid}" is not in your library. Use list_footage for the ids.`);
    if (!v.ready) throw new EditError(`"${v.name}" is not ready yet. Wait until it finishes processing.`);
    return { name: `"${v.name}"`, seconds: v.seconds };
  };
  const inFootage = (vid: string, a: number, b: number) => {
    const f = footage(vid);
    if (!(b > a)) throw new EditError("The clip must end after it starts.");
    if (b > f.seconds + 0.05) throw new EditError(`${f.name} is only ${f.seconds.toFixed(1)}s long.`);
    return f;
  };
  const v1Footage = (x: Timeline) => seqClips(x).reduce((a, c) => a + c.sourceOut - c.sourceIn, 0);
  const at2 = (s: number) => s.toFixed(2);

  switch (op.op) {
    case "replace": {
      // The editor sends the whole timeline. Keep the server's duration: the footage length never changes.
      const next = { ...op.timeline, duration: tl.duration || op.timeline.duration };
      return { snap: { timeline: next, name: op.name ?? snap.name, aspect: (op.aspect ?? snap.aspect) as Aspect, styleId: op.styleId === undefined ? snap.styleId : op.styleId }, summary: "edited in the editor" };
    }
    case "cut_words": {
      const ids = (op.wordIds ?? []).filter((id) => wordById.has(id));
      const range = op.from != null && op.to != null ? { start: r2(Math.min(op.from, op.to)), end: r2(Math.max(op.from, op.to)) } : null;
      if (range && range.end - range.start < 0.04) throw new EditError("The range is too short to cut: from must be at least 0.04 s before to.");
      if (!ids.length && !range) throw new EditError("None of those words exist in this transcript. Use word ids from get_footage with detail \"words\", or a from/to time range.");
      let next: Timeline = { ...tl, cut: Array.from(new Set([...tl.cut, ...ids])) };
      const added = next.cut.length - tl.cut.length;
      const parts: string[] = [];
      if (ids.length) {
        const ws = ids.map((id) => wordById.get(id)!).sort((a, b) => a.t - b.t);
        parts.push(ws.length === 1 ? `cut the word "${ws[0].text}" at ${fmtClock(ws[0].t)}` : `cut ${fmtClock(ws[0].t)} to ${fmtClock(ws[ws.length - 1].end)} (${added} ${added === 1 ? "word" : "words"})`);
      }
      if (range) {
        // Exactly this range leaves the sequence (picture and dialogue), whether or not anyone speaks in it: footage of
        // the main video wherever it plays, or with edit true that stretch of the edit.
        const before = outputDuration(next, words);
        next = op.edit ? removeEditRange(next, words, range.start, range.end) : removeSourceRange(next, main, range.start, range.end);
        const gone = before - outputDuration(next, words);
        const inside = op.edit ? 0 : words.filter((w) => w.t >= range.start && w.end <= range.end).length;
        const where = `${op.edit ? "edit " : ""}${at2(range.start)}s to ${at2(range.end)}s`;
        parts.push(gone > 0.01 ? `cut ${where} (${gone.toFixed(2)}s${op.edit ? "" : inside ? `, ${inside} ${inside === 1 ? "word" : "words"}` : ", no words"})` : `${where} was already out of the edit`);
      }
      return { snap: { ...snap, timeline: next }, summary: parts.join("; "), count: added };
    }
    case "restore_words": {
      const rm = new Set(op.wordIds);
      const cut = tl.cut.filter((id) => !rm.has(id));
      const n = tl.cut.length - cut.length;
      return { snap: { ...snap, timeline: { ...tl, cut } }, summary: `restored ${n} ${n === 1 ? "word" : "words"}`, count: n };
    }
    case "cut_silences": {
      // Every video on V1 whose transcript Rendrr has: the main footage, and the others in ctx.sources.
      const videos = Array.from(new Set(seqClips(tl).map((c) => c.sourceVideoId))).filter((v) => v === main || ctx.sources?.[v]);
      let next = tl;
      let removed = 0, n = 0;
      const done: Range[] = [];
      const take = (f: () => Timeline, g: Range) => {
        const before = v1Footage(next);
        next = f();
        const diff = before - v1Footage(next);
        if (diff > 0.01) { removed += diff; n++; done.push(g); }
      };
      for (const vid of videos) {
        const ws = wordsOf(vid);
        const sil = vid === main ? ctx.silences : ctx.sources![vid].silences;
        // Each clip's own start and end first (they only shorten clips), then the pauses wherever they play.
        if (op.edges !== false) for (const g of clipEdgeSilences(next, ws, vid)) take(() => removeSourceRange(next, vid, g.start, g.end, g.clipId), g);
        // Long silences the transcript cannot see (no words at all) come from the audio analysis.
        const fromAudio = sil.filter((s) => s.end - s.start > op.overSeconds && !ws.some((w) => w.t < s.end && w.end > s.start)).map((s) => ({ start: r2(s.start + 0.08), end: r2(s.end - 0.08) }));
        for (const g of mergeRanges([...pauseRanges(ws, op.overSeconds), ...fromAudio])) take(() => removeSourceRange(next, vid, g.start, g.end), g);
      }
      const summary = n === 0 ? `no pauses over ${op.overSeconds}s left to cut` : n === 1 ? `cut ${fmtClock(done[0].start)} to ${fmtClock(done[0].end)} (silence, ${removed.toFixed(1)}s)` : `cut ${n} silences over ${op.overSeconds}s (${removed.toFixed(1)}s total)`;
      return { snap: { ...snap, timeline: next }, summary, count: n };
    }
    case "remove_fillers": {
      const ids = words.filter((w) => w.filler && !tl.cut.includes(w.id)).map((w) => w.id);
      return { snap: { ...snap, timeline: { ...tl, cut: [...tl.cut, ...ids] } }, summary: ids.length ? `removed ${ids.length} filler ${ids.length === 1 ? "word" : "words"}` : "no filler words left to remove", count: ids.length };
    }
    case "set_clips": {
      if (op.track === "a1" && op.linked === false) throw new EditError("In the sequence the dialogue follows its picture. Use set_audio_offset for J/L cuts or to mute a clip.");
      if (op.track === "v1" || op.track === "a1") {
        // The whole sequence, in this order.
        const old = new Map(seqClips(tl).map((c) => [c.id, c]));
        const used = new Set<string>();
        const taken = new Set([...old.keys(), ...op.clips.map((c) => c.id).filter(Boolean) as string[]]);
        const freshId = () => { let id = rid("vc_"); while (taken.has(id)) id = rid("vc_"); taken.add(id); return id; };
        const clips = op.clips.map((c) => {
          const { videoId: v, id: _id, start, end, timelineStart: _a, timelineEnd: _b, linkId: _l, ...extra } = c as typeof c & Record<string, unknown>;
          const vid = videoIdOf((v as string | undefined) ?? (extra.sourceVideoId as string | undefined));
          inFootage(vid, start, end);
          const prev = c.id && !used.has(c.id) ? old.get(c.id) : undefined;
          const id = c.id && !used.has(c.id) ? c.id : freshId();
          used.add(id);
          return { ...(prev ?? lookOf(vid)), ...extra, id, label: c.label ?? prev?.label ?? "", start, end, sourceVideoId: vid, sourceIn: r2(start), sourceOut: r2(end) } as SeqClip;
        });
        return { snap: { ...snap, timeline: setSeq(tl, clips) }, summary: `set ${clips.length} ${clips.length === 1 ? "clip" : "clips"} on V1` };
      }
      // Another track: each clip hangs on the V1 clip playing at its start.
      let dropped = 0;
      const clips: Clip[] = [];
      op.clips.forEach((c, i) => {
        const base = { ...c, id: c.id || rid(op.track + "_" + i) } as Clip;
        if (isCaptionMarker(op.track, base)) { clips.push({ ...base, sourceVideoId: main, sourceIn: c.start, sourceOut: c.end } as Clip); return; }
        const s = toEdit(c.start, op.edit), e = op.track === "a3" && !op.edit ? s + Math.max(0.1, c.end - c.start) : toEdit(c.end, op.edit);
        if (e - s < 0.05 || s >= view().total) { dropped++; return; }
        const { anchorId: _x, anchorAt: _y, length: _z, fill: _f, ...rest } = base as Attached;
        clips.push(attachAt(view(), rest as Clip, s, e));
      });
      return { snap: { ...snap, timeline: withTracks(tl, op.track, clips) }, summary: `set ${clips.length} ${clips.length === 1 ? "clip" : "clips"} on ${op.track.toUpperCase()}${dropped ? ` (${dropped} not in the edit, left out)` : ""}` };
    }
    case "split_clip": {
      if (op.track === "v1" || op.track === "a1") {
        if (op.track === "a1" && op.linked === false) throw new EditError("In the sequence the dialogue follows its picture: split the V1 clip.");
        findClip(tl, "v1", op.clipId);
        const at = op.edit ? view().editToSource(op.clipId, op.at) : op.at;
        const r = splitSeqClip(tl, op.clipId, at);
        const c = findClip(tl, "v1", op.clipId);
        return { snap: { ...snap, timeline: r.tl }, summary: `split ${name(c)} at ${op.edit ? "edit " : ""}${fmtClock(op.at)} (second half is clip ${r.newId})` };
      }
      const c = findClip(tl, op.track, op.clipId) as Attached;
      if (isCaptionMarker(op.track, c)) throw new EditError("Caption clips follow their transcript line; they cannot be split.");
      const lay = placeOf(view(), c);
      const at = toEdit(op.at, op.edit);
      if (!(at > lay.s + 0.05 && at < lay.e - 0.05)) throw new EditError(`Split time must be inside the clip (edit ${at2(lay.s)}s to ${at2(lay.e)}s).`);
      const first = c.fill ? attachAt(view(), { ...c, fill: undefined } as Clip, lay.s, at) : { ...c, length: r2(at - lay.s) };
      // Keyframes are seconds from the clip's start: the second half's start later by the first half's length.
      const ks = (c as { keys?: Key[] }).keys;
      const moved = ks?.length ? { keys: ks.map((k) => ({ ...k, t: r2(Math.max(0, k.t - (at - lay.s))) })) } : {};
      const second = attachAt(view(), { ...c, ...moved, fill: undefined, id: rid(op.track + "_"), label: label2(c.label) } as Clip, at, lay.e);
      const clips = (tl.tracks[op.track] as Clip[]).flatMap((x) => (x.id === c.id ? [first as Clip, second] : [x]));
      return { snap: { ...snap, timeline: withTracks(tl, op.track, clips) }, summary: `split ${name(c)} at edit ${fmtClock(at)} (second half is clip ${second.id})` };
    }
    case "trim_clip": {
      if (!(op.end > op.start)) throw new EditError("The new end must be after the new start.");
      if (op.track === "a1" && op.linked === false) {
        // Dialogue trimmed on its own: the cuts between its sound and its neighbours' move (J/L).
        const c = findClip(tl, "v1", op.clipId) as SeqClip;
        const p = view().clip(c.id)!;
        const i = seqClips(tl).findIndex((x) => x.id === c.id);
        const startOff = op.edit ? op.start - p.start : op.start - c.sourceIn;
        const endOff = op.edit ? op.end - p.end : op.end - c.sourceOut;
        return applyLeaf(snap, { op: "set_audio_offset", clipId: c.id, ...(i > 0 ? { start: r2(startOff) } : {}), ...(i < seqClips(tl).length - 1 ? { end: r2(endOff) } : {}) }, ctx);
      }
      if (op.track === "v1" || op.track === "a1") {
        const c = findClip(tl, "v1", op.clipId) as SeqClip;
        const a = op.edit ? view().editToSource(c.id, op.start) : op.start, b = op.edit ? view().editToSource(c.id, op.end) : op.end;
        if (a < -0.005) throw new EditError(`The footage starts at 0s; ${name(c)} cannot start ${(-a).toFixed(2)}s before it.`);
        inFootage(c.sourceVideoId, Math.max(0, a), b);
        const next = mapClip(tl, c.id, (x) => ({ ...x, sourceIn: r2(Math.max(0, a)), sourceOut: r2(b) }));
        return { snap: { ...snap, timeline: next }, summary: `trimmed ${name(c)} to ${fmtClock(Math.max(0, a))}–${fmtClock(b)} of its footage` };
      }
      const c = findClip(tl, op.track, op.clipId) as Attached;
      if (isCaptionMarker(op.track, c)) return { snap: { ...snap, timeline: withTracks(tl, op.track, (tl.tracks[op.track] as Clip[]).map((x) => (x.id === c.id ? { ...x, sourceIn: r2(op.start), sourceOut: r2(op.end) } : x))) }, summary: `trimmed ${name(c)}` };
      const s = toEdit(op.start, op.edit), e = op.track === "a3" && !op.edit ? s + (op.end - op.start) : toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const { fill: _f, ...rest } = c;
      const next = withTracks(tl, op.track, (tl.tracks[op.track] as Clip[]).map((x) => (x.id === c.id ? attachAt(view(), rest as Clip, s, e) : x)));
      return { snap: { ...snap, timeline: next }, summary: `trimmed ${name(c)} to edit ${fmtClock(s)}–${fmtClock(e)}` };
    }
    case "delete_clip": {
      if (op.track === "a1" && op.linked === false) {
        const c = findClip(tl, "v1", op.clipId);
        return { snap: { ...snap, timeline: mapClip(tl, c.id, (x) => ({ ...x, audioMuted: true })) }, summary: `muted the dialogue of ${name(c)}` };
      }
      const track: TrackName = op.track === "a1" ? "v1" : op.track;
      const c = findClip(tl, track, op.clipId);
      const next = withTracks(tl, track, (tl.tracks[track] as Clip[]).filter((x) => x.id !== c.id));
      return { snap: { ...snap, timeline: next }, summary: `removed ${c.label || "a clip"} from ${track.toUpperCase()}${track === "v1" ? " (and its dialogue)" : ""}` };
    }
    case "set_link": {
      const track: TrackName = op.track === "a1" ? "v1" : op.track;
      findClip(tl, track, op.clipId);
      return { snap, summary: "the dialogue always follows its picture in the sequence (set_audio_offset makes J/L cuts or mutes a clip)" };
    }
    case "add_zoom": {
      const s = toEdit(op.start, op.edit), e = toEdit(op.end, op.edit);
      if (!(op.end > op.start)) throw new EditError("A zoom must end after it starts.");
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const z = attachAt(view(), zoomClip(s, e, op.scale, e - s > 4 ? "push" : "punch"), s, e);
      return { snap: { ...snap, timeline: withTracks(tl, "v2", [...tl.tracks.v2, z]) }, summary: `added zoom at ${op.edit ? "edit " : ""}${fmtClock(op.start)}` };
    }
    case "add_broll": {
      const v = ctx.getVideo?.(op.videoId);
      if (!v) throw new EditError("That b-roll footage is not in your library.");
      if (!v.ready) throw new EditError(`"${v.name}" is not ready yet. Wait until it finishes processing.`);
      if (!(op.end > op.start)) throw new EditError("B-roll must end after it starts.");
      const s = toEdit(op.start, op.edit), e = toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      if (op.sourceStart + (e - s) > v.seconds + 0.05) throw new EditError(`"${v.name}" is only ${v.seconds.toFixed(1)}s long. Pick an earlier sourceStart or a shorter range.`);
      const c = attachAt(view(), { id: rid("b"), start: 0, end: 0, label: op.label || v.name, kind: "broll", videoId: v.id, sourceStart: r2(op.sourceStart) } as V2Clip, s, e);
      return { snap: { ...snap, timeline: withTracks(tl, "v2", [...tl.tracks.v2, c]) }, summary: `added b-roll ${v.name} at ${op.edit ? "edit " : ""}${fmtClock(op.start)}` };
    }
    case "set_captions": {
      if (op.styleId) {
        const st = ctx.getStyle(op.styleId);
        if (!st) throw new EditError("That style does not exist. Use list_styles to see the ids.");
        const style = st.rules.captions.style ?? captionStyleOf({ captionLook: st.rules.captions.look }, snap.aspect, st.rules.captions);
        const next = { ...tl, captionsOn: op.on, captionLook: st.rules.captions.look, captionStyle: style };
        return { snap: { ...snap, timeline: next }, summary: `captions ${op.on ? "on" : "off"}, style of ${st.name}: ${styleText(style)}` };
      }
      const next = { ...tl, captionsOn: op.on, captionLook: op.look ?? tl.captionLook };
      if (op.look) delete next.captionStyle;
      return { snap: { ...snap, timeline: next }, summary: op.on ? `captions on (${next.captionStyle ? "own style" : next.captionLook})` : "captions off" };
    }
    case "set_caption_style": {
      const { op: _o, look: lk, ...fields } = op;
      const rules = snap.styleId ? ctx.getStyle(snap.styleId)?.rules.captions : undefined;
      const base = lk ? presetStyle(lk, snap.aspect) : captionStyleOf(tl, snap.aspect, rules);
      const style = CaptionStyleSchema.parse({ ...base, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
      if (fields.wordsAtOnce != null && fields.wordsPerLine == null) style.wordsPerLine = Math.min(style.wordsAtOnce, Math.max(style.wordsPerLine, Math.ceil(style.wordsAtOnce / style.lines)));
      return { snap: { ...snap, timeline: { ...tl, captionStyle: style, ...(lk ? { captionLook: lk } : {}) } }, summary: `caption style: ${styleText(style)}` };
    }
    case "add_text": {
      if (!(op.end > op.start)) throw new EditError("A text layer must end after it starts.");
      const s0 = toEdit(op.start, op.edit), e0 = toEdit(op.end, op.edit);
      if (e0 - s0 < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const p = textPreset(op.preset ?? "plain");
      const style = TextStyleSchema.parse({ ...p.style, ...pickStyle(op) });
      const c = attachAt(view(), { id: rid("t"), start: 0, end: 0, label: op.label || op.text.split("\n")[0].slice(0, 60), kind: "text" as const, text: op.text, style, card: op.card ?? null, anim: op.anim ?? p.anim } as Clip, s0, e0);
      return { snap: { ...snap, timeline: withTracks(tl, "v3", [...tl.tracks.v3, c]) }, summary: `added text "${op.text.split("\n")[0].slice(0, 40)}" at ${op.edit ? "edit " : ""}${fmtClock(op.start)} (${styleText(style)})` };
    }
    case "set_text": {
      const c = findClip(tl, "v3", op.clipId) as Clip & { kind?: string; text?: string; style?: TextStyle; card?: Card | null; anim?: TextAnim };
      if (c.kind !== "text") throw new EditError(`Clip "${op.clipId}" on V3 is not a text layer.`);
      const p = op.preset ? textPreset(op.preset) : null;
      const style = TextStyleSchema.parse({ ...(p ? p.style : c.style ?? textPreset("plain").style), ...pickStyle(op) });
      let x: Clip = { ...c, style, ...(op.text ? { text: op.text, label: op.text.split("\n")[0].slice(0, 60) } : {}), ...(op.card !== undefined ? { card: op.card } : {}), ...(op.anim || p ? { anim: op.anim ?? p!.anim } : {}) } as Clip;
      if (op.start != null || op.end != null) {
        const cur = placeOf(view(), c as Attached);
        const s0 = op.start != null ? toEdit(op.start, op.edit) : cur.s, e0 = op.end != null ? toEdit(op.end, op.edit) : cur.e;
        if (e0 - s0 < 0.05) throw new EditError("A text layer must end after it starts, inside the edit.");
        x = attachAt(view(), x, s0, e0);
      }
      return { snap: { ...snap, timeline: withTracks(tl, "v3", (tl.tracks.v3 as Clip[]).map((y) => (y.id === c.id ? x : y))) }, summary: `changed text "${String((x as { text?: string }).text ?? "").split("\n")[0].slice(0, 40)}"` };
    }
    case "edit_caption": {
      const line = ctx.transcript.find((l) => l.id === op.lineId);
      if (!line) throw new EditError(`There is no caption line "${op.lineId}".`);
      return { snap: { ...snap, timeline: { ...tl, captionText: { ...tl.captionText, [op.lineId]: op.text } } }, summary: `edited caption at ${fmtClock(line.start)}` };
    }
    case "add_music": {
      const track = findMusic(op.trackId);
      if (!track) throw new EditError(`No music track or mood called "${op.trackId}". Moods: ${Array.from(new Set(MUSIC_TRACKS.map((m) => m.mood))).join(", ")}.`);
      const base = { id: rid("m"), start: 0, end: 0, label: track.name, trackId: track.id, assetKey: track.key, gainDb: op.gainDb ?? -18 };
      // A bed under the whole edit replaces the old one; a ranged clip is added next to what is there.
      if (op.start == null && op.end == null) return { snap: { ...snap, timeline: withTracks(tl, "a2", [{ ...base, end: r2(view().total), fill: true } as Clip]) }, summary: `added music: ${track.name}` };
      const s = op.start == null ? 0 : toEdit(op.start, op.edit), e = op.end == null ? view().total : toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const keep = (tl.tracks.a2 as Attached[]).filter((c) => { const p = placeOf(view(), c); return p.e <= s || p.s >= e; });
      return { snap: { ...snap, timeline: withTracks(tl, "a2", [...keep, attachAt(view(), base as Clip, s, e)]) }, summary: `added music: ${track.name}` };
    }
    case "add_graphic": {
      const g = ctx.getGraphic?.(op.graphicId);
      if (!g) throw new EditError("That graphic does not exist. Use list_graphics to see the ids.");
      if (!(op.end > op.start)) throw new EditError("A graphic must end after it starts.");
      const s = toEdit(op.start, op.edit), e = toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const c = attachAt(view(), { id: rid("g"), start: 0, end: 0, label: op.label || g.name, kind: "graphic" as const, graphicId: g.id, params: op.params } as Clip, s, e);
      return { snap: { ...snap, timeline: withTracks(tl, "v3", [...tl.tracks.v3, c]) }, summary: `added graphic ${g.name} at ${op.edit ? "edit " : ""}${fmtClock(op.start)}` };
    }
    case "set_aspect":
      return { snap: { ...snap, aspect: op.aspect }, summary: `changed shape to ${op.aspect}` };
    case "rename":
      return { snap: { ...snap, name: op.name }, summary: `renamed the edit to "${op.name}"` };
    case "set_framing": {
      const ids = targets(tl, op.clipIds);
      let shown: Framing | null = null;
      const next = setSeq(tl, seqClips(tl).map((c) => {
        if (!ids.has(c.id)) return c;
        const cur = c.framing ?? { scale: 1, x: 0, y: 0 };
        const f = FramingSchema.parse({ scale: r2(op.scale ?? cur.scale), x: r2(op.x ?? cur.x), y: r2(op.y ?? cur.y) });
        shown = f;
        const { framing: _f, ...rest } = c;
        return (plainFraming(f) ? { ...rest, framing: f } : rest) as SeqClip;
      }));
      const f = shown as Framing | null;
      const what = op.clipIds ? `${ids.size} ${ids.size === 1 ? "clip" : "clips"}` : "the footage";
      return { snap: { ...snap, timeline: next }, summary: !f || !plainFraming(f) ? `${what} back to filling the frame` : `framed ${what}: ${framingText(f)}` };
    }
    case "set_rotation": {
      const ids = targets(tl, op.clipIds);
      const next = setSeq(tl, seqClips(tl).map((c) => { if (!ids.has(c.id)) return c; const { rotate: _r, ...rest } = c; return (op.degrees ? { ...rest, rotate: op.degrees } : rest) as SeqClip; }));
      const what = op.clipIds ? `${ids.size} ${ids.size === 1 ? "clip" : "clips"}` : "the footage";
      return { snap: { ...snap, timeline: next }, summary: op.degrees ? `turned ${what} ${op.degrees}° clockwise` : `${what} back to ${op.clipIds ? "their" : "its"} own orientation` };
    }
    case "apply_style": {
      const style = ctx.getStyle(op.styleId);
      if (!style) throw new EditError("That style does not exist. Use list_styles to see the ids.");
      return applyStyleRules(snap, op.overrides ? { ...style, rules: mergeRules(style.rules, op.overrides) } : style, ctx);
    }
    case "restore_snapshot":
      return { snap: op.snapshot, summary: op.note };

    // ---- the sequence ----
    case "add_clip": {
      const vid = videoIdOf(op.videoId);
      const f = inFootage(vid, op.from, op.to);
      if (op.to - op.from < 0.1) throw new EditError("A clip must be at least 0.1 s long.");
      let next = tl;
      let index = op.index;
      if (op.at != null && index == null) {
        // Inserted at that moment of the edit; a clip playing there is split around it.
        const v = view();
        const hit = v.clips.find((c) => op.at! > c.start + 0.05 && op.at! < c.end - 0.05);
        if (hit) {
          const r = splitSeqClip(tl, hit.id, v.editToSource(hit.id, op.at));
          next = r.tl;
          index = seqClips(next).findIndex((c) => c.id === r.newId);
        } else {
          const near = v.clips.reduce((best, c, i) => (Math.abs(c.start - op.at!) < Math.abs(best.t - op.at!) ? { i, t: c.start } : best), { i: v.clips.length, t: v.total });
          index = near.i;
        }
      }
      const id = newSeqClipId(next);
      const label = op.label || (vid === main ? "Main" : ctx.getVideo?.(vid)?.name || "Clip");
      next = insertSeqClip(next, { id, label, start: 0, end: 0, sourceVideoId: vid, sourceIn: r2(op.from), sourceOut: r2(op.to), ...lookOf(vid) } as SeqClip, index);
      const pos = seqClips(next).findIndex((c) => c.id === id);
      return { snap: { ...snap, timeline: next }, summary: `added clip ${id} (${f.name} ${at2(op.from)}–${at2(op.to)}s) at position ${pos + 1} of ${seqClips(next).length}` };
    }
    case "move_clip": {
      const v1 = seqClips(tl);
      const from = v1.findIndex((c) => c.id === op.clipId);
      if (from < 0) findClip(tl, "v1", op.clipId);
      let index = op.index;
      if (index == null) {
        if (op.at == null) throw new EditError("Say where to move the clip: index (0 = first) or at (edit seconds).");
        const v = view();
        const cuts = [...v.clips.map((c) => c.start), v.total];
        let best = 0;
        cuts.forEach((x, i) => { if (Math.abs(x - op.at!) < Math.abs(cuts[best] - op.at!)) best = i; });
        index = best - (from < best ? 1 : 0);
      }
      const next = moveSeqClip(tl, op.clipId, index);
      const pos = seqClips(next).findIndex((c) => c.id === op.clipId);
      return { snap: { ...snap, timeline: next }, summary: pos === from ? `${name(v1[from])} stays at position ${pos + 1}` : `moved ${name(v1[from])} to position ${pos + 1} of ${v1.length}` };
    }
    case "set_audio_offset": {
      const v1 = seqClips(tl);
      const i = v1.findIndex((c) => c.id === op.clipId);
      if (i < 0) findClip(tl, "v1", op.clipId);
      if (op.start == null && op.end == null && op.muted == null) throw new EditError("Send start, end or muted.");
      if (op.start && i === 0) throw new EditError("The first clip has no clip before it, so its sound cannot start earlier or later.");
      if (op.end && i === v1.length - 1) throw new EditError("The last clip has no clip after it, so its sound cannot run on.");
      const c = v1[i];
      if (op.start != null && op.start < 0 && c.sourceIn + op.start < -0.005) throw new EditError(`Only ${c.sourceIn.toFixed(2)}s of footage comes before ${name(c)}, so its sound can start at most that much earlier.`);
      if (op.end != null && op.end > 0) { const s = secondsOf(c.sourceVideoId); if (s != null && c.sourceOut + op.end > s + 0.005) throw new EditError(`Only ${(s - c.sourceOut).toFixed(2)}s of footage comes after ${name(c)}, so its sound can run on at most that much.`); }
      let next = setSeq(tl, v1.map((x, k) => {
        let y = x;
        if (k === i && op.start != null) y = { ...y, audioStart: r2(op.start) };
        if (k === i + 1 && op.end != null) y = { ...y, audioStart: r2(op.end) };
        if (k === i && op.muted != null) { y = { ...y }; if (op.muted) y.audioMuted = true; else delete y.audioMuted; }
        return y;
      }));
      next = normalizeTimeline(next);
      // Say what it became (an offset is limited by the neighbouring clips' lengths).
      const nv = sequenceView(next, words);
      const p = nv.clip(c.id)!;
      const bits: string[] = [];
      if (op.start != null) { const d = r2(p.soundStart - p.start); bits.push(d < 0 ? `its sound starts ${(-d).toFixed(2)}s before its picture (J cut)` : d > 0 ? `the clip before is heard ${d.toFixed(2)}s into it (L cut)` : "its sound starts with its picture"); }
      if (op.end != null) { const d = r2(p.soundEnd - p.end); bits.push(d > 0 ? `its sound runs ${d.toFixed(2)}s into the next clip (L cut)` : d < 0 ? `the next clip is heard ${(-d).toFixed(2)}s before its picture (J cut)` : "its sound ends with its picture"); }
      if (op.muted != null) bits.push(op.muted ? "muted" : "sound on");
      return { snap: { ...snap, timeline: next }, summary: `${name(c)}: ${bits.join(", ")}` };
    }
    case "roll_edit": {
      const v1 = seqClips(tl);
      const i = v1.findIndex((c) => c.id === op.clipId);
      if (i < 0) findClip(tl, "v1", op.clipId);
      const a = v1[i], b = v1[i + 1];
      if (!b) throw new EditError(`${name(a)} is the last clip: there is no cut after it to roll.`);
      const aOut = r2(a.sourceOut + op.by), bIn = r2(b.sourceIn + op.by);
      if (aOut < a.sourceIn + 0.1 || bIn > b.sourceOut - 0.1) throw new EditError(`Rolling ${op.by}s would leave a clip shorter than 0.1 s.`);
      if (bIn < 0) throw new EditError(`${name(b)}'s footage starts ${b.sourceIn.toFixed(2)}s in; the cut can move at most ${b.sourceIn.toFixed(2)}s earlier.`);
      const sa = secondsOf(a.sourceVideoId);
      if (sa != null && aOut > sa + 0.005) throw new EditError(`${name(a)}'s footage ends ${(sa - a.sourceOut).toFixed(2)}s after the clip; the cut can move at most that much later.`);
      const next = setSeq(tl, v1.map((x, k) => (k === i ? { ...x, sourceOut: aOut } : k === i + 1 ? { ...x, sourceIn: bIn } : x)));
      return { snap: { ...snap, timeline: next }, summary: `moved the cut after ${name(a)} ${op.by > 0 ? "later" : "earlier"} by ${Math.abs(op.by).toFixed(2)}s` };
    }
    case "slip_clip": {
      const c = findClip(tl, "v1", op.clipId) as SeqClip;
      const sIn = r2(c.sourceIn + op.by), sOut = r2(c.sourceOut + op.by);
      if (sIn < 0) throw new EditError(`${name(c)} can slip at most ${c.sourceIn.toFixed(2)}s earlier (the footage starts there).`);
      const s = secondsOf(c.sourceVideoId);
      if (s != null && sOut > s + 0.005) throw new EditError(`${name(c)} can slip at most ${(s - c.sourceOut).toFixed(2)}s later (the footage ends there).`);
      let next = mapClip(tl, c.id, (x) => ({ ...x, sourceIn: sIn, sourceOut: sOut }));
      // Clips hanging on it stay where they are in the edit.
      const tracks = { ...next.tracks } as Timeline["tracks"];
      for (const k of ["v2", "v3", "a2", "a3"] as TrackName[]) (tracks as Record<string, Clip[]>)[k] = (next.tracks[k] as Attached[]).map((x) => (x.anchorId === c.id ? { ...x, anchorAt: r2(Number(x.anchorAt ?? 0) + op.by) } : x));
      next = { ...next, tracks };
      return { snap: { ...snap, timeline: next }, summary: `slipped ${name(c)} ${Math.abs(op.by).toFixed(2)}s ${op.by > 0 ? "later" : "earlier"} in its footage (now ${at2(sIn)}–${at2(sOut)}s)` };
    }
    case "slide_clip": {
      const v1 = seqClips(tl);
      const i = v1.findIndex((c) => c.id === op.clipId);
      if (i < 0) findClip(tl, "v1", op.clipId);
      const prev = v1[i - 1], next0 = v1[i + 1];
      if (!prev || !next0) throw new EditError(`${name(v1[i])} needs a clip before and after it to slide between them.`);
      const pOut = r2(prev.sourceOut + op.by), nIn = r2(next0.sourceIn + op.by);
      if (pOut < prev.sourceIn + 0.1 || nIn > next0.sourceOut - 0.1) throw new EditError(`Sliding ${op.by}s would leave a neighbouring clip shorter than 0.1 s.`);
      if (nIn < 0) throw new EditError(`${name(next0)}'s footage starts ${next0.sourceIn.toFixed(2)}s in; the clip can slide at most that much earlier.`);
      const sp = secondsOf(prev.sourceVideoId);
      if (sp != null && pOut > sp + 0.005) throw new EditError(`${name(prev)}'s footage ends ${(sp - prev.sourceOut).toFixed(2)}s after it; the clip can slide at most that much later.`);
      const next = setSeq(tl, v1.map((x, k) => (k === i - 1 ? { ...x, sourceOut: pOut } : k === i + 1 ? { ...x, sourceIn: nIn } : x)));
      return { snap: { ...snap, timeline: next }, summary: `slid ${name(v1[i])} ${Math.abs(op.by).toFixed(2)}s ${op.by > 0 ? "later" : "earlier"} in the edit` };
    }

    // ---- sound ----
    case "set_audio": {
      const { op: _op, ...change } = op;
      const audio: AudioSettings = { ...(tl.audio ?? {}) };
      // A hand-set cleanup value sent as null goes back to the preset's; a new preset starts from its own values.
      if (change.cleanup !== undefined) for (const k of CLEANUP_KNOBS) delete (audio as Record<string, unknown>)[k];
      for (const [k, v] of Object.entries(change)) {
        if (v === undefined) continue;
        if (v === null && (CLEANUP_KNOBS as readonly string[]).includes(k)) delete (audio as Record<string, unknown>)[k];
        else (audio as Record<string, unknown>)[k] = v;
      }
      const a = audioSettings({ audio });
      const total = view().total;
      if (a.fadeIn + a.fadeOut > total + 0.01) throw new EditError(`The fades (${a.fadeIn}s in, ${a.fadeOut}s out) are longer than the edit (${total.toFixed(1)}s).`);
      return { snap: { ...snap, timeline: { ...tl, audio } }, summary: `sound: ${audioText(a)}` };
    }
    case "set_clip_audio": {
      const track = op.track ?? "v1";
      if (op.gainDb == null && op.fadeIn == null && op.fadeOut == null) throw new EditError("Send gainDb, fadeIn or fadeOut.");
      if (track === "v1" || track === "a1") {
        const c = findClip(tl, "v1", op.clipId) as SeqClip;
        const p = view().clip(c.id)!;
        const len = p.soundEnd - p.soundStart;
        const fi = op.fadeIn ?? c.audioFadeIn ?? 0, fo = op.fadeOut ?? c.audioFadeOut ?? 0;
        if (fi + fo > len + 0.01) throw new EditError(`${name(c)}'s sound is ${len.toFixed(2)}s long: the fades (${fi}s in, ${fo}s out) do not fit.`);
        const next = mapClip(tl, c.id, (x) => ({ ...x, ...(op.gainDb != null ? { audioGain: r2(op.gainDb) } : {}), ...(op.fadeIn != null ? { audioFadeIn: r2(op.fadeIn) } : {}), ...(op.fadeOut != null ? { audioFadeOut: r2(op.fadeOut) } : {}) }));
        return { snap: { ...snap, timeline: next }, summary: `${name(c)}'s dialogue: ${clipAudioText(op.gainDb ?? c.audioGain ?? 0, fi, fo)}` };
      }
      const c = findClip(tl, track, op.clipId) as Attached & { gainDb?: number; fadeIn?: number; fadeOut?: number };
      const len = placeOf(view(), c).e - placeOf(view(), c).s;
      const fi = op.fadeIn ?? c.fadeIn ?? 0, fo = op.fadeOut ?? c.fadeOut ?? 0;
      if (fi + fo > len + 0.01) throw new EditError(`${name(c)} is ${len.toFixed(2)}s long: the fades (${fi}s in, ${fo}s out) do not fit.`);
      if (op.gainDb != null && (op.gainDb < -60 || op.gainDb > 12)) throw new EditError("Music and sound effects take a gain from -60 to 12 dB.");
      const next = withTracks(tl, track, (tl.tracks[track] as Clip[]).map((x) => (x.id === c.id ? { ...x, ...(op.gainDb != null ? { gainDb: r2(op.gainDb) } : {}), ...(op.fadeIn != null ? { fadeIn: r2(op.fadeIn) } : {}), ...(op.fadeOut != null ? { fadeOut: r2(op.fadeOut) } : {}) } : x)));
      const g = op.gainDb ?? c.gainDb ?? (track === "a2" ? -18 : -6);
      return { snap: { ...snap, timeline: next }, summary: `${name(c)}: ${clipAudioText(g, fi, fo)}` };
    }

    // ---- speed, transitions, keyframes (Phase 5) ----
    case "set_speed": {
      const c = findClip(tl, "v1", op.clipId) as SeqClip;
      if (c.freeze) {
        if (op.freeze == null || op.speed != null || op.reverse != null || op.ramp) throw new EditError(`${name(c)} is a freeze frame: it has no speed. Send freeze (its length in seconds), or delete it.`);
        return { snap: { ...snap, timeline: mapClip(tl, c.id, (x) => ({ ...x, freeze: r2(op.freeze!), label: `Freeze ${r2(op.freeze!)}s` })) }, summary: `${name(c)}: freeze ${r2(op.freeze)}s (silent)` };
      }
      if (op.freeze != null) throw new EditError(`${name(c)} is not a freeze frame. Use freeze_frame to make one.`);
      if (op.speed == null && op.reverse == null && op.ramp === undefined) throw new EditError("Send speed, reverse or ramp.");
      if (op.ramp) for (const p of op.ramp) if (p.at < c.sourceIn - 0.05 || p.at > c.sourceOut + 0.05) throw new EditError(`Ramp point at ${p.at}s is outside ${name(c)}'s footage (${c.sourceIn}s to ${c.sourceOut}s). Ramp points use the clip's own footage seconds.`);
      const next = mapClip(tl, c.id, (x) => {
        const y = { ...x };
        if (op.speed != null) y.speed = op.speed;
        if (op.reverse != null) y.reverse = op.reverse;
        if (op.ramp === null) delete y.ramp; else if (op.ramp) y.ramp = op.ramp as RampPoint[];
        // Off normal speed a clip has no J/L cut (its sound follows its picture).
        if (!normalSpeed(y)) delete y.audioStart;
        return y;
      });
      const nc = findClip(next, "v1", c.id) as SeqClip;
      const len = sequenceView(normalizeTimeline(next), words).clip(c.id);
      return { snap: { ...snap, timeline: next }, summary: `${name(c)}: ${speedText(nc)}${len ? `, now ${(len.end - len.start).toFixed(2)}s in the edit` : ""}` };
    }
    case "freeze_frame": {
      const c = findClip(tl, "v1", op.clipId) as SeqClip;
      if (c.freeze) throw new EditError(`${name(c)} is already a freeze frame. Send its clip before or after it.`);
      const at = op.edit ? view().editToSource(c.id, op.at) : op.at;
      if (at < c.sourceIn - 0.05 || at > c.sourceOut + 0.05) throw new EditError(`${r2(at)}s is outside ${name(c)}'s footage (${c.sourceIn}s to ${c.sourceOut}s).`);
      const f = Math.min(Math.max(at, c.sourceIn), c.sourceOut - 0.04);
      let next = tl;
      let index = seqClips(tl).findIndex((x) => x.id === c.id);
      if (f > c.sourceIn + 0.05 && f < c.sourceOut - 0.05) { next = splitSeqClip(tl, c.id, f).tl; index++; }
      else if (f >= c.sourceOut - 0.05) index++;
      const id = newSeqClipId(next);
      const still: SeqClip = { id, label: `Freeze ${op.length}s`, start: 0, end: 0, sourceVideoId: c.sourceVideoId, sourceIn: r2(f), sourceOut: r2(f + 0.04), freeze: r2(op.length), ...(c.rotate ? { rotate: c.rotate } : {}), ...(plainFraming(c.framing) ? { framing: c.framing } : {}) };
      next = insertSeqClip(next, still, index);
      return { snap: { ...snap, timeline: next }, summary: `froze the frame at ${at2(f)}s of ${name(c)} for ${op.length}s (clip ${id}, silent)` };
    }
    case "set_transition": {
      const v1 = seqClips(tl);
      const ids = op.all ? v1.slice(1).map((c) => c.id) : op.clipIds ?? (op.clipId ? [op.clipId] : []);
      if (!ids.length) throw new EditError(op.all ? "There is only one clip: no cut to put a transition on." : "Send clipId (the clip after the cut), clipIds, or all: true.");
      for (const id of ids) findClip(tl, "v1", id);
      const dur = op.duration ?? (op.type === "whip" ? 0.3 : 0.5);
      const tr: Transition | null = op.type === "cut" ? null : { type: op.type, duration: r2(dur), ...(op.dir && (op.type === "whip" || op.type === "slide") ? { dir: op.dir } : {}) };
      const set = new Set(ids);
      const next = setSeq(tl, v1.map((c) => { if (!set.has(c.id)) return c; const { transition: _t, ...rest } = c; return (tr ? { ...rest, transition: tr } : rest) as SeqClip; }));
      if (!tr) return { snap: { ...snap, timeline: next }, summary: `${ids.length === 1 ? `the cut before ${name(findClip(tl, "v1", ids[0]))} is` : `${ids.length} cuts are`} plain cuts again` };
      // Say what each one became (a short clip or little footage past the cut makes it shorter).
      const nv = sequenceView(normalizeTimeline(next), words);
      const nseq = seqClips(next);
      const planned = planTransitions(nv, new Map(nseq.map((c) => [c.id, c])), (vid) => secondsOf(vid)).filter((x) => set.has(x.clipId));
      const short = planned.filter((x) => x.note);
      const where = ids.length === 1 ? `on the cut before ${name(findClip(tl, "v1", ids[0]))}${planned[0] ? ` (edit ${fmtClock(planned[0].at)})` : ""}` : `on ${ids.length} cuts`;
      const notes = short.slice(0, 4).map((x) => `${x.clipId}: ${x.end > x.start ? `${(x.end - x.start).toFixed(2)}s, ` : ""}${x.note}`);
      return { snap: { ...snap, timeline: next }, summary: `${tr.type}${tr.dir ? ` ${tr.dir}` : ""} ${tr.duration}s ${where}${(USES_HANDLES as string[]).includes(tr.type) ? " (uses footage past the cut)" : ""}${notes.length ? `; ${notes.join("; ")}${short.length > 4 ? `; +${short.length - 4} more` : ""}` : ""}` };
    }
    case "set_keyframes": {
      const track = op.track ?? "v1";
      const keys = [...op.keys].sort((a, b) => a.t - b.t) as Key[];
      if (track === "v1") {
        const c = findClip(tl, "v1", op.clipId) as SeqClip;
        const p = view().clip(c.id);
        if (!p || p.end - p.start < 0.01) throw new EditError(`${name(c)} does not play in the edit (all of it is cut).`);
        const len = p.end - p.start;
        for (const k of keys) if (k.t > len + 0.05) throw new EditError(`Keyframe at ${k.t}s is past the end of ${name(c)} (${len.toFixed(2)}s in the edit). Key times are seconds from the clip's start.`);
        // Stored at footage seconds, so the keys move with the footage when the clip is cut or split.
        const stored = keys.map((k) => ({ ...k, t: r2(c.freeze ? c.sourceIn + Math.min(k.t, len) : view().editToSource(c.id, p.start + Math.min(k.t, len))) }));
        const next = mapClip(tl, c.id, (x) => { const { keys: _k, ...rest } = x; return (stored.length ? { ...rest, keys: stored } : rest) as SeqClip; });
        return { snap: { ...snap, timeline: next }, summary: keys.length ? `${name(c)}: ${keyText(keys)}` : `${name(c)}: keyframes removed` };
      }
      const c = findClip(tl, track, op.clipId) as Attached & { kind?: string };
      if (isCaptionMarker(track, c)) throw new EditError("Caption clips follow their transcript line; style captions with set_caption_style.");
      if (track === "v2" && c.kind !== "broll") throw new EditError(`Clip "${op.clipId}" on V2 is a zoom: keyframes go on b-roll, text, graphics or V1 clips.`);
      const len = placeOf(view(), c).e - placeOf(view(), c).s;
      for (const k of keys) if (k.t > len + 0.05) throw new EditError(`Keyframe at ${k.t}s is past the end of ${name(c)} (${len.toFixed(2)}s). Key times are seconds from the clip's start.`);
      const next = withTracks(tl, track, (tl.tracks[track] as Clip[]).map((x) => { if (x.id !== c.id) return x; const { keys: _k, ...rest } = x as Clip & { keys?: Key[] }; return (keys.length ? { ...rest, keys: keys.map((k) => ({ ...k, t: r2(k.t) })) } : rest) as Clip; }));
      return { snap: { ...snap, timeline: next }, summary: keys.length ? `${name(c)}: ${keyText(keys)}` : `${name(c)}: keyframes removed` };
    }

    // ---- colour and compositing (Phase 6) ----
    case "set_grade": {
      const ids = lookIds(tl, op);
      if (op.lut && ctx.getLut && !ctx.getLut(op.lut.id)) throw new EditError(`There is no LUT "${op.lut.id}" in your LUTs. Import the .cube file in the editor's Color tab; get_project lists your LUTs.`);
      const fields = ["exposure", "contrast", "temperature", "tint", "saturation", "lut"] as const;
      const next = mapLook(tl, ids, (c) => {
        const g: Grade = op.reset ? {} : { ...(c.grade ?? {}) };
        for (const f of fields) { const v = op[f]; if (v === null) delete g[f]; else if (v !== undefined) (g as Record<string, unknown>)[f] = v; }
        if (op.curves === null) delete g.curves;
        else if (op.curves) {
          const cv = { ...(g.curves ?? {}) } as Record<string, unknown>;
          for (const [ch, pts] of Object.entries(op.curves)) { if (pts === null) delete cv[ch]; else if (pts) cv[ch] = [...pts].sort((a, b) => a[0] - b[0]); }
          g.curves = cv as Grade["curves"];
        }
        return { ...c, grade: g };
      });
      const first = lookClip(next, ids[0]).clip;
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: grade ${first.grade ? gradeText(first.grade, (id) => ctx.getLut?.(id)?.name) : "none"}` };
    }
    case "copy_grade": {
      const src = lookClip(tl, op.from).clip;
      const what = op.with?.length ? op.with : ["grade" as const];
      const ids = lookIds(tl, { clipIds: op.to, all: op.all, video: op.video }).filter((id) => id !== op.from);
      if (!ids.length) throw new EditError("Send the clips to copy onto: to (clip ids), all: true, or video.");
      const next = mapLook(tl, ids, (c) => { const x = { ...c }; for (const k of what) { if (src[k]) (x as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(src[k])); else delete x[k]; } return x; });
      return { snap: { ...snap, timeline: next }, summary: `copied the ${what.join(", ")} of ${name(src)} onto ${idsText(tl, ids)}` };
    }
    case "match_color": {
      const ref = lookClip(tl, op.to).clip;
      for (const id of op.clipIds) lookClip(tl, id);
      const m = op.measured;
      const px = (id: string) => { const x = m?.[id]; if (!x) throw new EditError("match_color needs frames of the clips, measured by the server: send it in apply_edits (the editor's Match button does this)."); return decodeB64(x.rgb); };
      const refPx = px(op.to);
      const refLut = ref.grade?.lut ? ctx.lutData?.(ref.grade.lut.id) : undefined;
      const refLook = ref.grade ? gradeFn(ref.grade, refLut) : undefined;
      const said: string[] = [];
      const done = new Map<string, Grade>();
      for (const id of op.clipIds) { if (id === op.to) continue; const r = matchGrade(px(id), refPx, refLook); done.set(id, r.grade); said.push(`${id}: ${r.text}`); }
      const next = mapLook(tl, Array.from(done.keys()), (c) => { const g = done.get(c.id)!; const { grade: _g, ...rest } = c; return (Object.keys(g).length ? { ...rest, grade: g } : rest) as typeof c; });
      return { snap: { ...snap, timeline: next }, summary: `matched to ${name(ref)} (measured): ${said.slice(0, 4).join("; ")}${said.length > 4 ? `; +${said.length - 4} more` : ""}` };
    }
    case "set_key": {
      const ids = lookIds(tl, op);
      const next = mapLook(tl, ids, (c) => {
        if (op.off) { const { key: _k, ...rest } = c; return rest as typeof c; }
        const color = op.color ?? c.key?.color;
        if (!color) throw new EditError(`Send the key colour for ${name(c)} (#RRGGBB, picked from the frame; a typical green screen is #00B140).`);
        const k: ChromaKey = { ...KEY_DEFAULTS, ...(c.key ?? {}), color: color.toUpperCase(), ...(op.similarity != null ? { similarity: op.similarity } : {}), ...(op.blend != null ? { blend: op.blend } : {}), ...(op.spill != null ? { spill: op.spill } : {}) };
        return { ...c, key: k };
      });
      const k = lookClip(next, ids[0]).clip.key;
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${k ? `key ${chromaKeyText(k)}` : "no key"}` };
    }
    case "set_masks": {
      const ids = lookIds(tl, op);
      const next = mapLook(tl, ids, (c) => { const { masks: _m, ...rest } = c; return (op.masks.length ? { ...rest, masks: op.masks } : rest) as typeof c; });
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${op.masks.length ? `masks ${masksText(op.masks)}` : "no masks"}` };
    }
    case "set_effects": {
      const ids = lookIds(tl, op);
      const next = mapLook(tl, ids, (c) => { const { effects: _e, ...rest } = c; return (op.effects.length ? { ...rest, effects: op.effects } : rest) as typeof c; });
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${op.effects.length ? effectsText(op.effects) : "no blur or pixelate"}` };
    }
    case "set_under": {
      const c = findClip(tl, "v2", op.clipId) as V2Clip & { under?: boolean };
      if (c.kind !== "broll") throw new EditError(`Clip "${op.clipId}" on V2 is a zoom: only b-roll can go behind V1.`);
      const next = withTracks(tl, "v2", (tl.tracks.v2 as Clip[]).map((x) => { if (x.id !== c.id) return x; const { under: _u, ...rest } = x as Clip & { under?: boolean }; return (op.under ? { ...rest, under: true } : rest) as Clip; }));
      return { snap: { ...snap, timeline: next }, summary: `${name(c)}: ${op.under ? "behind V1 (shows where V1 is keyed, masked, framed smaller or moved)" : "over V1"}` };
    }
    case "set_export": {
      if (!op.hdr && !op.resolution && !op.codec) throw new EditError("set_export needs hdr, resolution or codec.");
      const ex = { ...(tl.export ?? {}) };
      if (op.hdr) ex.hdr = op.hdr;
      if (op.resolution) ex.resolution = op.resolution;
      if (op.codec) ex.codec = op.codec;
      // Defaults are not stored (HDR kept, 1080p, H.264), so an edit at the defaults has no export field.
      if (ex.hdr === "keep") delete ex.hdr;
      if (ex.resolution === "1080p") delete ex.resolution;
      if (ex.codec === "h264") delete ex.codec;
      const next: Timeline = { ...tl, export: ex };
      if (!Object.keys(ex).length) delete next.export;
      const said = [op.resolution && `final ${op.resolution === "4k" ? "4K" : op.resolution}`, op.codec && (op.codec === "hevc" ? "HEVC" : "H.264"), op.hdr && `HDR ${op.hdr === "sdr" ? "converted to SDR" : "kept when the footage is HDR"}`].filter(Boolean);
      return { snap: { ...snap, timeline: next }, summary: `export: ${said.join(", ")}` };
    }
  }
}

/** Phase 6: a clip that takes a look (a V1 clip or a b-roll clip). */
function lookClip(tl: Timeline, id: string): { track: "v1" | "v2"; clip: Clip & ClipLook } {
  const v1 = (tl.tracks.v1 as Clip[]).find((c) => c.id === id);
  if (v1) return { track: "v1", clip: v1 as Clip & ClipLook };
  const v2 = (tl.tracks.v2 as (V2Clip & ClipLook)[]).find((c) => c.id === id);
  if (v2 && v2.kind === "broll") return { track: "v2", clip: v2 as Clip & ClipLook };
  if (v2) throw new EditError(`Clip "${id}" on V2 is a zoom: colour, keys, masks and blur go on V1 clips and b-roll.`);
  throw new EditError(`There is no clip "${id}" on V1 or V2. Read the project again to get the current clip ids.`);
}
/** The clips a Phase 6 op names: clipId / clipIds, all V1 clips, or the V1 clips of one video. */
function lookIds(tl: Timeline, op: { clipId?: string; clipIds?: string[]; all?: boolean; video?: string }): string[] {
  const v1 = tl.tracks.v1 as SeqClip[];
  const ids = op.all ? v1.map((c) => c.id) : op.video ? v1.filter((c) => c.sourceVideoId === (op.video === "main" ? mainVideoOf(tl) : op.video)).map((c) => c.id) : op.clipIds ?? (op.clipId ? [op.clipId] : []);
  if (!ids.length) throw new EditError(op.video ? `No V1 clip plays video "${op.video}".` : "Send clipId, clipIds, all: true or video.");
  for (const id of ids) lookClip(tl, id);
  return Array.from(new Set(ids));
}
function mapLook(tl: Timeline, ids: string[], f: (c: Clip & ClipLook) => Clip & ClipLook): Timeline {
  const set = new Set(ids);
  return { ...tl, tracks: { ...tl.tracks, v1: (tl.tracks.v1 as (Clip & ClipLook)[]).map((c) => (set.has(c.id) ? f(c) : c)), v2: (tl.tracks.v2 as (Clip & ClipLook)[]).map((c) => (set.has(c.id) ? f(c) : c)) } } as Timeline;
}
const idsText = (tl: Timeline, ids: string[]) => (ids.length === 1 ? name(lookClip(tl, ids[0]).clip) : `${ids.length} clips`);
/** Base64 to bytes, in the browser and in Node. */
export function decodeB64(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** "2x", "reversed 0.5x", "ramp 1x→3x→1x", "freeze 1.5s" (and whether its sound plays). */
export function speedText(c: Partial<SeqClip>): string {
  if (c.freeze) return `freeze ${c.freeze}s (silent)`;
  const sp = c.ramp?.length ? `ramp ${c.ramp.map((p) => `${p.speed}x`).join("→")}` : `${c.speed ?? 1}x`;
  const lo = c.ramp?.length ? Math.min(...c.ramp.map((p) => p.speed)) : c.speed ?? 1, hi = c.ramp?.length ? Math.max(...c.ramp.map((p) => p.speed)) : c.speed ?? 1;
  const sound = c.reverse ? "silent" : hi < SOUND_SPEEDS[0] || lo > SOUND_SPEEDS[1] ? "silent" : lo < SOUND_SPEEDS[0] || hi > SOUND_SPEEDS[1] ? `sound only between ${SOUND_SPEEDS[0]}x and ${SOUND_SPEEDS[1]}x` : "sound pitch kept";
  return `${c.reverse ? "reversed " : ""}${sp} (${sound})`;
}
const keyText = (keys: Key[]) => {
  const props = (["x", "y", "scale", "rotation", "opacity"] as const).filter((p) => keys.some((k) => k[p] != null));
  return `${keys.length} ${keys.length === 1 ? "keyframe" : "keyframes"} (${props.join(", ") || "no values"}) at ${keys.map((k) => k.t.toFixed(2)).join(", ")}s`;
};

/** The style fields of an op (add_text, set_text), leaving out the ones not sent. */
function pickStyle(op: Record<string, unknown>): Partial<TextStyle> {
  const keys = Object.keys(TextStyleSchema.shape);
  return Object.fromEntries(Object.entries(op).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<TextStyle>;
}

/** "cleanup voice, -14 LUFS / -1 dBTP, music 12 dB down under speech, fades in 0.5s out 1s" */
export function audioText(a: ReturnType<typeof audioSettings>): string {
  return [
    `cleanup ${cleanupText(a)}`,
    a.loudness != null ? `${a.loudness} LUFS / ${a.peak} dBTP` : "loudness not normalized",
    a.duck > 0 ? `music ${a.duck} dB down under speech` : "music not ducked",
    ...(a.fadeIn || a.fadeOut ? [`mix fades in ${a.fadeIn}s, out ${a.fadeOut}s`] : []),
  ].join(", ");
}
const clipAudioText = (gainDb: number, fi: number, fo: number) => [`${gainDb > 0 ? "+" : ""}${gainDb} dB`, fi ? `fade in ${fi}s` : "", fo ? `fade out ${fo}s` : ""].filter(Boolean).join(", ");

const label2 = (l: string) => (/\(2\)$/.test(l) ? l : l ? l + " (2)" : "");
/** V1 clips an op works on: the ids given, else every clip of the main footage. */
function targets(tl: Timeline, ids?: string[]): Set<string> {
  if (ids) { for (const id of ids) findClip(tl, "v1", id); return new Set(ids); }
  const main = mainVideoOf(tl);
  return new Set(seqClips(tl).filter((c) => c.sourceVideoId === main).map((c) => c.id));
}
/** Where a clip on another track is in the edit now. */
function placeOf(view: SequenceView, c: Attached): { s: number; e: number } {
  if (c.fill) return { s: 0, e: view.total };
  const s = c.anchorId ? view.editAt(c.anchorId, Number(c.anchorAt ?? 0)) : null;
  if (s == null) return { s: c.start, e: c.end };
  return { s, e: s + Number(c.length ?? c.end - c.start) };
}

export function applyOp(snap: Snapshot, op: Op, ctx: EditContext): { snap: Snapshot; summary: string } {
  const words = allWords(ctx.transcript);
  const start = { ...snap, timeline: asSequence(snap.timeline, words, ctx.videoId) };
  const r = applyOpInner(start, op, ctx);
  const timeline = normalizeTimeline(r.snap.timeline);
  const parsed = TimelineSchema.safeParse(timeline);
  if (!parsed.success) throw new EditError("That change would break the timeline: " + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  const problems = timelineProblems(timeline);
  if (problems.length) throw new EditError(problems.slice(0, 3).join(" "));
  return { snap: { ...r.snap, timeline: layoutTimeline(timeline, words) }, summary: r.summary };
}

// ---------------------------------------------------------------------------------------------
// Small text summary of a project for the AI (get_project). Kept well under 8k tokens.
// ---------------------------------------------------------------------------------------------
/** "scale 1.15, moved down 34%" */
export function framingText(f: { scale: number; x: number; y: number }) {
  const pct = (n: number) => `${Math.round(Math.abs(n) * 100)}%`;
  return [`scale ${f.scale}`, f.x ? `moved ${f.x > 0 ? "right" : "left"} ${pct(f.x)}` : "", f.y ? `moved ${f.y > 0 ? "down" : "up"} ${pct(f.y)}` : ""].filter(Boolean).join(", ");
}

/** "turned 90° (3 of 8 clips)", "framed scale 1.15, moved down 30%": how the clips' look reads, or "" if plain. */
export function lookText(tl: Timeline): string {
  const v1 = seqClips(tl);
  if (!v1.length) return "";
  const out: string[] = [];
  const turned = v1.filter((c) => c.rotate);
  if (turned.length) {
    const degs = Array.from(new Set(turned.map((c) => c.rotate)));
    out.push(`footage turned ${degs.join("/")}°${turned.length < v1.length ? ` (${turned.length} of ${v1.length} clips)` : ""}`);
  }
  const framed = v1.filter((c) => plainFraming(c.framing));
  if (framed.length) {
    const f = framed[0].framing!;
    const same = framed.every((c) => c.framing!.scale === f.scale && c.framing!.x === f.x && c.framing!.y === f.y);
    out.push(`footage framed ${same ? framingText(f) : "per clip"}${framed.length < v1.length ? ` (${framed.length} of ${v1.length} clips)` : ""}`);
  }
  return out.join(", ");
}

export function summarizeTimeline(snap: Snapshot, tr: Transcript, maxPerTrack = 60, mainVideoId?: string, lutName?: (id: string) => string | undefined, footage?: FootageInfo): string {
  const words = allWords(tr);
  const tl = layoutTimeline(asSequence(snap.timeline, words, mainVideoId), words);
  const view = sequenceView(tl, words);
  const main = view.mainVideoId;
  const look = lookText(tl);
  const lines: string[] = [];
  lines.push(`Footage length ${tl.duration.toFixed(1)}s, edit length ${view.total.toFixed(1)}s, aspect ${snap.aspect}${look ? ", " + look : ""}${snap.styleId ? `, style ${snap.styleId}` : ""}.`);
  lines.push(`Cut words: ${tl.cut.length}. Captions ${tl.captionsOn ? "on (" + (tl.captionStyle ? "own style: " + styleText(tl.captionStyle) : tl.captionLook) + ")" : "off"}. Edited caption lines: ${Object.entries(tl.captionText).filter(([id, txt]) => { const l = tr.find((x) => x.id === id); return l && l.words.map((w) => w.text).join(" ") !== txt; }).length}.`);
  lines.push(`Sound: ${audioText(audioSettings(tl))}.`);
  lines.push(exportText(snap, footage) + ".");
  lines.push("V1 plays in this order, back to back: id video footageIn-footageOut @editStart-editEnd. Ops on a V1 clip take its own footage seconds. Its dialogue (A1) follows it; J/L cuts and mutes are shown on it. Other tracks: id @editStart-editEnd on <V1 clip> at <its footage second>; they move with that clip. Their op times are main-footage seconds (where it first plays), or edit seconds with edit:true.");
  const v1 = tl.tracks.v1 as SeqClip[];
  const vName = (v: string) => (v === main ? "main" : v);
  const shownV1 = v1.slice(0, maxPerTrack).map((c) => {
    const p = view.clip(c.id)!;
    const extra: string[] = [];
    if (p.pieces.length && p.soundStart < p.start - 0.005) extra.push(`J ${(p.soundStart - p.start).toFixed(2)}`);
    if (p.pieces.length && p.soundEnd > p.end + 0.005) extra.push(`L +${(p.soundEnd - p.end).toFixed(2)}`);
    if (c.audioMuted) extra.push("muted");
    if (c.audioGain) extra.push(`dialogue ${c.audioGain > 0 ? "+" : ""}${c.audioGain} dB`);
    if (c.audioFadeIn || c.audioFadeOut) extra.push(`fades ${c.audioFadeIn ?? 0}/${c.audioFadeOut ?? 0}s`);
    if (c.rotate && !look.includes("turned") ) extra.push(`turned ${c.rotate}°`);
    if (!normalSpeed(c)) extra.push(speedText(c));
    if (c.transition) extra.push(`${c.transition.type}${c.transition.dir ? " " + c.transition.dir : ""} ${c.transition.duration}s in`);
    if (c.keys?.length) extra.push(`keys ${c.keys.map((k) => (Math.max(0, (c.freeze ? k.t - c.sourceIn : (view.editAt(c.id, k.t) ?? p.start) - p.start))).toFixed(2)).join(",")}s`);
    const lk = lookTags(c);
    if (lk) extra.push(lk);
    const at = p.end > p.start ? ` @${p.start.toFixed(2)}-${p.end.toFixed(2)}` : " (all cut)";
    return `  ${c.id} ${vName(c.sourceVideoId)} ${c.sourceIn.toFixed(2)}-${c.sourceOut.toFixed(2)}${at} "${c.label}"${extra.length ? " " + extra.join(" ") : ""}`;
  });
  lines.push(`V1 sequence: ${v1.length ? "\n" + shownV1.join("\n") + (v1.length > maxPerTrack ? `\n  …and ${v1.length - maxPerTrack} more` : "") : "empty"}`);
  const names: Partial<Record<TrackName, string>> = { v2: "V2 b-roll/zooms", v3: "V3 titles", a2: "A2 music", a3: "A3 sfx" };
  for (const k of Object.keys(names) as TrackName[]) {
    let clips = tl.tracks[k] as (Clip & Record<string, unknown>)[];
    if (k === "v3") clips = clips.filter((c) => !isCaptionMarker("v3", c));
    const shown = clips.slice(0, maxPerTrack).map((c) => {
      // As they render: a music clip that sets only one fade keeps the automatic other one.
      const auto = k === "a2" ? autoMusicFades(c.end - c.start) : { fadeIn: 0, fadeOut: 0 };
      const fd = (own: unknown, a: number) => (own != null ? String(own) : `${+a.toFixed(2)} auto`);
      const fades = c.fadeIn != null || c.fadeOut != null ? ` fades ${fd(c.fadeIn, auto.fadeIn)}/${fd(c.fadeOut, auto.fadeOut)}s` : "";
      const extra = c.kind === "zoom" ? ` x${c.zoom}` : c.kind === "broll" ? ` video=${c.videoId}@${c.sourceStart}` : c.graphicId ? ` graphic=${c.graphicId}` : c.kind === "text" ? ` text=${JSON.stringify(c.text)}${c.style ? ` (${styleText(c.style as TextStyle)})` : ""}${c.anim && c.anim !== "none" ? ` ${c.anim}` : ""}${c.card ? ` card ${(c.card as Card).color}` : ""}` : c.trackId ? ` track=${c.trackId} ${c.gainDb ?? -18}dB${fades}` : c.sfxId ? ` sfx=${c.sfxId} ${c.gainDb ?? -6}dB${fades}` : "";
      const lk = k === "v2" ? lookTags(c as Clip & ClipLook) : "";
      const on = (c.fill ? " (whole edit)" : c.anchorId ? ` on ${c.anchorId} at ${Number(c.anchorAt).toFixed(2)}` : "") + (Array.isArray(c.keys) && c.keys.length ? ` keys ${(c.keys as Key[]).map((k) => k.t).join(",")}s` : "") + (c.under ? " under V1" : "") + (lk ? " " + lk : "");
      return `  ${c.id} @${c.start.toFixed(2)}-${c.end.toFixed(2)}${on} "${c.label}"${extra}`;
    });
    const more = clips.length > maxPerTrack ? `\n  …and ${clips.length - maxPerTrack} more` : "";
    lines.push(`${names[k]}${k === "v3" ? " (graphics only; caption clips follow transcript lines)" : ""}: ${clips.length ? "\n" + shown.join("\n") + more : "empty"}`);
  }
  lines.push(...colorSummary(tl, lutName));
  return lines.join("\n");
}

/** A clip's Phase 6 look in a few words: "grade, key, 2 masks, blur". */
function lookTags(c: Clip & ClipLook): string {
  const t = [c.grade ? "grade" : "", c.key ? "key" : "", c.masks?.length ? `${c.masks.length} ${c.masks.length === 1 ? "mask" : "masks"}` : "", ...(c.effects ?? []).map((e) => e.type)].filter(Boolean);
  return t.length ? `look: ${t.join(", ")}` : "";
}
/** The looks in full, clips with the same one together (get_project). */
export function colorSummary(tl: Timeline, lutName?: (id: string) => string | undefined): string[] {
  const clips = [...(tl.tracks.v1 as (Clip & ClipLook)[]), ...(tl.tracks.v2 as (Clip & ClipLook)[])];
  const group = (f: (c: Clip & ClipLook) => string) => {
    const by = new Map<string, string[]>();
    for (const c of clips) { const k = f(c); if (k) by.set(k, [...(by.get(k) ?? []), c.id]); }
    return Array.from(by.entries()).map(([k, ids]) => `${k} on ${ids.length > 6 ? `${ids.slice(0, 6).join(", ")}… (${ids.length} clips)` : ids.join(", ")}`);
  };
  const out = [
    ...group((c) => (c.grade ? `grade ${gradeText(c.grade, lutName)}` : "")),
    ...group((c) => (c.key ? `key ${chromaKeyText(c.key)}` : "")),
    ...group((c) => (c.masks?.length ? `masks ${masksText(c.masks)}` : "")),
    ...group((c) => (c.effects?.length ? effectsText(c.effects) : "")),
  ];
  if (tl.export?.hdr === "sdr") out.push("export: HDR footage converted to SDR");
  return out.length ? [`Looks: ${out.join("; ")}`] : [];
}
