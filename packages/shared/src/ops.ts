import { z } from "zod";
import { findMusic, MUSIC_TRACKS, placementParams } from "./catalog";
import type { Aspect } from "./constants";
import { mergeRules, StyleRulesPatchSchema, type StyleRules } from "./styles";
import {
  AspectSchema, audioSettings, CaptionLookSchema, CLEANUPS, ClipSchema, FocusSchema, FramingSchema, isCaptionMarker, RotationSchema, SnapshotSchema, TimelineSchema, TrackNameSchema,
  normalizeTimeline, timelineProblems, RESOLUTIONS, CODECS,
  type AudioSettings, type Clip, type Framing, type Snapshot, type Timeline, type TrackName, type V2Clip,
} from "./timeline";
import { autoMusicFades, CLEANUP_KNOBS, cleanupText } from "./audio";
import { CaptionStylePatchSchema, CaptionStyleSchema, captionStyleOf, CardSchema, presetStyle, styleText, TEXT_ANIMS, TEXT_PRESETS, TextInsideSchema, textPreset, TextStylePatchSchema, TextStyleSchema, type Card, type TextAnim, type TextInside, type TextStyle } from "./captions";
import { allWords, type Line, type Silence, type Transcript, type Word } from "./transcript";
import { MARK_KINDS, type Mark, type MarkEdit } from "./timeline";
import { editToFootage, RENDRR_MARK } from "./marks";
import { DIRS, KeySchema, RampPointSchema, SOUND_SPEEDS, TRANSITIONS, USES_HANDLES, type Key, type RampPoint, type Transition } from "./motion";
import { exportText, planTransitions, type FootageInfo } from "./renderPlan";
import { libraryItem, libraryParams } from "./library";
import { BlendModeSchema, blendText, type BlendMode } from "./blend";
import { BackgroundSchema, backgroundText, CardLookSchema, cardLookText, hasCard, type CardLook } from "./cardLook";
import { AreaSchema, ChromaKeySchema, CurveSchema, EffectSchema, FaceTracksSchema, followFace, type Effect, type FaceTrack, type Mask, gradeFn, gradeText, KEY_DEFAULTS, LutInputSchema, MaskSchema, masksText, effectsText, chromaKeyText, matchGrade, SKIN_DEFAULTS, skinActive, skinText, SUBJECT_DEFAULTS, subjectText, type Area, type ChromaKey, type ClipLook, type Grade, type Lut, type Skin, type Subject } from "./look";
import {
  asSequence, EditError, findClip, fmtClock, insertSeqClip, layoutTimeline, mainVideoOf, moveSeqClip, newSeqClipId, normalSpeed,
  outputDuration, plainFraming, reattach, removeEditRange, removeSourceRange, restoreSourceRange, sequenceView, splitSeqClip, toModelB, withTracks,
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
/** The user's audio file itself, on set_voice and add_music: the server brings it in first (as add_audio does) and the
 *  op gets its soundId. upload: a link for the AI's code workspace to send the file to (nothing is changed yet). */
const SOUND_SOURCE = { url: z.string().url().max(2000).optional(), driveFileId: z.string().max(200).optional(), upload: z.boolean().optional(), name: z.string().max(120).optional() };
const clipId = z.string().max(80);
// The ops that change an edit step by step. An AI sends a list of them in one go (the `batch` op).
const EDIT_OPS = [
  // wordIds cut those words (restore_words brings them back); from/to removes exactly that range, words or not.
  z.object({ op: z.literal("cut_words"), wordIds: z.array(z.string().max(40)).max(50_000).optional(), from: t.optional(), to: t.optional(), edit }),
  // wordIds back (cut ones, or ones a range cut took out); from/to: footage of the main video put back where a range
  // cut took it (cut_words from/to's undo).
  z.object({ op: z.literal("restore_words"), wordIds: z.array(z.string().max(40)).max(50_000).optional(), from: t.optional(), to: t.optional() }),
  // Retired: Rendrr no longer cuts on its own. Kept so an older call is answered with what to do instead (mark_silences
  // or mark_fillers, then cut_words); not offered to the AI.
  z.object({ op: z.literal("cut_silences"), overSeconds: z.number().min(0.001).max(30).optional(), keep: z.number().min(0).max(1).optional(), edges: z.boolean().optional() }),
  z.object({ op: z.literal("remove_fillers") }),
  // V1: the whole sequence, in order (start/end = footage of videoId, default the main footage). Keep a clip's id
  // to keep that clip. Other tracks: their clips (footage times, or edit times with edit true).
  z.object({ op: z.literal("set_clips"), track: TrackNameSchema, clips: z.array(ClipSchema.extend({ id: z.string().min(1).max(80).optional(), videoId: z.string().max(80).optional() }).passthrough()).max(4000), linked: z.boolean().optional(), edit }),
  // V1 clip times are that clip's own footage (or edit times with edit true).
  z.object({ op: z.literal("split_clip"), track: TrackNameSchema, clipId, at: t, linked: z.boolean().optional(), edit }),
  z.object({ op: z.literal("trim_clip"), track: TrackNameSchema, clipId, start: t, end: t, linked: z.boolean().optional(), edit }),
  // track: found from the clip id when left out.
  z.object({ op: z.literal("delete_clip"), track: TrackNameSchema.optional(), clipId, linked: z.boolean().optional() }),
  // Model A only (picture and dialogue linked by matching times); in the sequence dialogue always follows its picture.
  z.object({ op: z.literal("set_link"), track: TrackNameSchema, clipId, linked: z.boolean() }),
  z.object({ op: z.literal("add_zoom"), start: t, end: t, scale: z.number().min(1.01).max(2), edit }),
  z.object({ op: z.literal("add_broll"), videoId: z.string().max(80), start: t, end: t, sourceStart: t.default(0), label: z.string().max(200).optional(), edit }),
  // look: back to that look's preset style. styleId: the captions of that style (its full caption style if it has one).
  z.object({ op: z.literal("set_captions"), on: z.boolean(), look: CaptionLookSchema.optional(), styleId: z.string().max(80).optional() }),
  z.object({ op: z.literal("edit_caption"), lineId: z.string().max(40), text: z.string().max(2000) }),
  z.object({ op: z.literal("add_music"), trackId: z.string().max(80).optional(), soundId: z.string().max(80).optional(), ...SOUND_SOURCE, gainDb: z.number().min(-40).max(6).optional(), start: t.optional(), end: t.optional(), edit }),
  z.object({ op: z.literal("set_voice"), soundId: z.string().max(80).nullable().optional(), ...SOUND_SOURCE, start: t.optional(), gainDb: z.number().min(-30).max(12).optional() }),
  // from: seconds into a custom graphic where this placement starts (one recording placed many times). params: a
  // template's fields, or values for a custom graphic's window.params (each new set is recorded once, then cached).
  // data: any JSON for the graphic (window.params.data); rerecord: its recording for these params made again (the
  // server drops the kept one before the edit is saved).
  z.object({ op: z.literal("add_graphic"), graphicId: z.string().max(80), start: t, end: t, params: z.record(z.unknown()).default({}), data: z.unknown().optional(), rerecord: z.boolean().optional(), from: z.number().min(0).max(4 * 3600).optional(), label: z.string().max(200).optional(), behind: z.boolean().optional(), edit }),
  // Phase 2 (Premiere parity): text layers and graphics behind the person (the person's AI matte over them).
  z.object({ op: z.literal("behind_person"), clipIds: z.array(z.string().max(80)).min(1).max(200), off: z.boolean().optional() }),
  z.object({ op: z.literal("set_aspect"), aspect: AspectSchema }),
  // Position and scale of the footage in the frame (Premiere's Motion). Leave a field out to keep it.
  // clipIds: those V1 clips (default every clip of the main footage).
  // fitFaceTo: the face in each clip at x, y of the frame (0-1 from the top left), r = half the face's height as a share
  // of the frame's (scale and offset worked out per clip). faces: the measured faces, filled in by Rendrr.
  // focus: where the fit cuts the footage when its shape is not the frame's (reframing for 9:16, 1:1, 4:5): a point of
  // the footage kept in view, "face" (the speaker's face in each clip, measured by Rendrr into `centers`), null = the
  // middle again.
  z.object({ op: z.literal("set_framing"), scale: z.number().min(0.25).max(4).optional(), x: z.number().min(-1).max(1).optional(), y: z.number().min(-1).max(1).optional(), clipIds: z.array(clipId).max(2000).optional(),
    focus: z.union([FocusSchema, z.literal("face"), z.null()]).optional(), centers: z.record(FocusSchema.nullable()).optional(),
    fitFaceTo: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), r: z.number().min(0.02).max(0.5) }).optional(),
    faces: z.record(z.object({ u: z.number(), v: z.number(), r: z.number().positive(), found: z.number().optional(), of: z.number().optional() }).nullable()).optional() }),
  // Turn the footage clockwise (footage filmed sideways); 0 puts it back.
  z.object({ op: z.literal("set_rotation"), degrees: RotationSchema, clipIds: z.array(clipId).max(2000).optional() }),
  // V1 clips drawn as a card (default every clip of the footage): crop, corners, shadow, border; null removes one,
  // reset starts from none. With set_framing to shrink and place it, and set_background for what is behind.
  z.object({ op: z.literal("set_card"), clipIds: z.array(clipId).max(2000).optional(), reset: z.boolean().optional(),
    crop: CardLookSchema.shape.crop.unwrap().nullable().optional(), radius: CardLookSchema.shape.radius.unwrap().nullable().optional(),
    shadow: CardLookSchema.shape.shadow.unwrap().nullable().optional(), border: CardLookSchema.shape.border.unwrap().nullable().optional() }),
  // What is behind V1 for the whole edit: one of color, gradient, videoId (a library video, looped), blur (the
  // clip's own picture, 1-100) or pattern (grid, dots, paper); none: black again.
  z.object({ op: z.literal("set_background"), color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #FF66AA").optional(),
    gradient: z.object({ from: z.string().regex(/^#[0-9a-fA-F]{6}$/), to: z.string().regex(/^#[0-9a-fA-F]{6}$/), angle: z.number().min(0).max(360).optional() }).optional(),
    videoId: z.string().min(1).max(80).optional(), blur: z.number().min(1).max(100).optional(), pattern: BackgroundSchema.innerType().shape.pattern, none: z.boolean().optional() }),
  z.object({ op: z.literal("rename"), name: z.string().min(1).max(200) }),
  // The project bin (the editor's Media panel): library videos kept with the edit to use, or taken off it.
  z.object({ op: z.literal("add_media"), videoIds: z.array(z.string().min(1).max(80)).min(1).max(50) }),
  z.object({ op: z.literal("remove_media"), videoIds: z.array(z.string().min(1).max(80)).min(1).max(50) }),
  // The reference the user (or the AI) attaches for the AI to copy: shown in the editor's Reference monitor, never
  // applied. Kept on the project, not in the edit: the server takes it out of the batch (applyOp refuses it alone).
  z.object({ op: z.literal("set_reference"), videoId: z.string().min(1).max(80).nullable().optional(), styleId: z.string().min(1).max(80).optional() }),
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
  // Phase 2b: inside plays a library video inside the letters; cutout cuts the letters out of the card (the picture shows).
  z.object({ op: z.literal("add_text"), text: z.string().min(1).max(1000), start: t, end: t, edit, preset: z.enum(TEXT_PRESETS).optional(), card: CardSchema.nullable().optional(), anim: z.enum(TEXT_ANIMS).optional(), label: z.string().max(200).optional(), behind: z.boolean().optional(), inside: TextInsideSchema.nullable().optional(), cutout: z.boolean().optional(), ...TextStylePatchSchema.shape }),
  z.object({ op: z.literal("set_text"), clipId, text: z.string().min(1).max(1000).optional(), start: t.optional(), end: t.optional(), edit, preset: z.enum(TEXT_PRESETS).optional(), card: CardSchema.nullable().optional(), anim: z.enum(TEXT_ANIMS).optional(), behind: z.boolean().optional(), inside: TextInsideSchema.nullable().optional(), cutout: z.boolean().optional(), ...TextStylePatchSchema.shape }),
  // ---- sound ----
  // The edit's sound: dialogue cleanup preset, loudness target (LUFS, null = off), true-peak ceiling (dBTP), how many
  // dB music goes down under speech (0 = off), fades of the whole mix. Fields left out keep their value.
  z.object({ op: z.literal("set_audio"), cleanup: z.enum(CLEANUPS).optional(), loudness: z.number().min(-30).max(-6).nullable().optional(), peak: z.number().min(-6).max(0).optional(), duck: z.number().min(0).max(30).optional(), fadeIn: z.number().min(0).max(10).optional(), fadeOut: z.number().min(0).max(10).optional(),
    highpass: z.number().min(0).max(300).nullable().optional(), denoise: z.number().min(0).max(40).nullable().optional(), presence: z.number().min(-8).max(8).nullable().optional(), deess: z.number().min(0).max(1).nullable().optional(), compress: z.number().min(1).max(10).nullable().optional(), declick: z.number().min(0).max(0.03).optional() }),
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
  // (master, r, g, b: points [in, out] 0-1; null removes that channel). lut: an imported LUT {id, amount 0-1, input};
  // by name, or with the .cube text, the server imports it and sends the id (applyOp only takes ids).
  z.object({ op: z.literal("set_grade"), ...lookTargets, reset: z.boolean().optional(),
    exposure: z.number().min(-4).max(4).nullable().optional(), contrast: z.number().min(-100).max(100).nullable().optional(), temperature: z.number().min(-100).max(100).nullable().optional(), tint: z.number().min(-100).max(100).nullable().optional(), saturation: z.number().min(0).max(200).nullable().optional(),
    curves: z.object({ master: CurveSchema.nullable().optional(), r: CurveSchema.nullable().optional(), g: CurveSchema.nullable().optional(), b: CurveSchema.nullable().optional() }).nullable().optional(), lut: LutInputSchema.nullable().optional() }),
  // A clip's grade onto other clips (with: also its key, masks, blur/pixelate).
  z.object({ op: z.literal("copy_grade"), from: clipId, to: z.array(clipId).max(2000).optional(), all: z.boolean().optional(), video: z.string().max(80).optional(), with: z.array(z.enum(["grade", "key", "masks", "effects", "skin", "subject"])).max(6).optional() }),
  // Clips' colour matched to a reference clip from measured frames (the server measures them; the result is a grade).
  z.object({ op: z.literal("match_color"), clipIds: z.array(clipId).min(1).max(200), to: clipId, measured: z.record(z.object({ w: z.number().int().min(1).max(512), h: z.number().int().min(1).max(512), rgb: z.string().max(2_000_000) })).optional() }),
  // Chroma key: color (pick it from the frame), similarity, blend, spill; off removes the key.
  z.object({ op: z.literal("set_key"), ...lookTargets, color: ChromaKeySchema.shape.color.optional(), similarity: ChromaKeySchema.shape.similarity.optional(), blend: ChromaKeySchema.shape.blend.optional(), spill: ChromaKeySchema.shape.spill.optional(), off: z.boolean().optional() }),
  // A clip's masks (replaces them; [] removes them) and its blur/pixelate/sharpen/darken effects (same). Phase 3: a rect
  // or ellipse moves with keys, or follows the face (follow "face": the server measures each clip's face into faceTracks,
  // [footage second, x0, y0, x1, y1] on screen, and the shape gets keys from them).
  z.object({ op: z.literal("set_masks"), ...lookTargets, masks: z.array(MaskSchema).max(8), faceTracks: FaceTracksSchema.optional() }),
  z.object({ op: z.literal("set_effects"), ...lookTargets, effects: z.array(EffectSchema).max(4), faceTracks: FaceTracksSchema.optional() }),
  // Skin retouch (smooth, blemishes, even, brighten 0-100; fields left out keep their value, or the natural defaults).
  // Default clips: every V1 clip. area: "face" (the default: each clip's face, forehead to neck, from the faces Rendrr
  // measured into faceAreas; a clip with no face measured gets the whole picture), "frame", or a shape. off removes it.
  z.object({ op: z.literal("retouch_skin"), ...lookTargets, smooth: z.number().min(0).max(100).optional(), blemishes: z.number().min(0).max(100).optional(), even: z.number().min(0).max(100).optional(), brighten: z.number().min(0).max(100).optional(),
    area: z.union([z.literal("face"), z.literal("frame"), AreaSchema]).optional(), faceAreas: z.record(AreaSchema.nullable()).optional(), off: z.boolean().optional() }),
  // The person kept, the background around them transparent (an AI matte Rendrr makes of the footage; V1 clips; default
  // clips: every V1 clip). edge -20..20 (out / in, px at 1080p), soft 0-100, invert (the person removed); fields left
  // out keep their value or the defaults (0, 20). off puts the background back. What shows: set_background / set_under.
  z.object({ op: z.literal("remove_background"), ...lookTargets, edge: z.number().min(-20).max(20).optional(), soft: z.number().min(0).max(100).optional(), invert: z.boolean().optional(), off: z.boolean().optional() }),
  // A b-roll clip behind V1 (shows where V1 is keyed, masked, framed smaller or moved away) or back over it.
  z.object({ op: z.literal("set_under"), clipId, under: z.boolean() }),
  // Phase 4: how b-roll (V2) or a graphic (V3) lies over the picture: a blend mode and its opacity (0-1). normal at 1 = plain.
  z.object({ op: z.literal("set_blend"), clipId: clipId.optional(), clipIds: z.array(clipId).min(1).max(200).optional(), blend: BlendModeSchema.optional(), opacity: z.number().min(0).max(1).optional() }),
  // How the final file is made: hdr keep (HDR footage stays HDR) or sdr (converted).
  z.object({ op: z.literal("set_export"), hdr: z.enum(["keep", "sdr"]).optional(), resolution: z.enum(RESOLUTIONS).optional(), codec: z.enum(CODECS).optional() }),
  // ---- marks: notes on the footage, kept with the edit; they never change the video ----
  // A mark on a moment (end left out) or a range of a video (default the main footage; edit true: edit seconds).
  z.object({ op: z.literal("add_marks"), marks: z.array(z.object({ kind: z.enum(MARK_KINDS), start: t, end: t.optional(), label: z.string().max(200).optional(), note: z.string().max(2000).optional(), confidence: z.number().min(0).max(1).optional(), videoId: z.string().max(80).optional() })).min(1).max(500), edit }),
  // Your mark: any field. Rendrr's: label, note and hidden only (null puts Rendrr's label back, or clears a note).
  z.object({ op: z.literal("update_mark"), id: z.string().max(80), kind: z.enum(MARK_KINDS).optional(), start: t.optional(), end: t.optional(), label: z.string().max(200).nullable().optional(), note: z.string().max(2000).nullable().optional(), confidence: z.number().min(0).max(1).optional(), hidden: z.boolean().optional(), edit }),
  // Your marks go; Rendrr's are hidden in this edit (update_mark hidden false shows one again).
  z.object({ op: z.literal("delete_mark"), id: z.string().max(80).optional(), ids: z.array(z.string().max(80)).max(5000).optional() }),
] as const;
/** Ops an older client may still send but the AI is no longer offered. */
export const RETIRED_OPS = ["cut_silences", "remove_fillers"] as const;
export const EditOpSchema = z.discriminatedUnion("op", [...EDIT_OPS]);
export const EDIT_OP_NAMES = EDIT_OPS.map((o) => o.shape.op.value).filter((n) => !(RETIRED_OPS as readonly string[]).includes(n)) as [EditOp["op"], ...EditOp["op"][]];
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
/** custom: made with create_graphic (params: its declared params and their defaults). */
/** failed: why its recording failed (it can still be placed; retry_graphic records it again). */
export type GraphicLite = { id: string; name: string; durationSec: number; custom?: boolean; params?: Record<string, unknown>; failed?: string };
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
  /** Other videos on V1: their transcripts and silences. */
  sources?: Record<string, { transcript: Transcript; silences: Silence[] }>;
  /** The user's imported LUTs (Phase 6): their names, and their numbers where an op needs them (match_color). */
  getLut?: (id: string) => { id: string; name: string } | undefined;
  lutData?: (id: string) => Lut | undefined;
  /** The user's own audio files (add_audio), for add_music soundId and set_voice. */
  getSound?: (id: string) => { id: string; name: string; seconds: number; ready: boolean } | undefined;
  /** The ids of Rendrr's own marks on the videos of this edit (for update_mark and delete_mark); missing: not checked. */
  rendrrMarkIds?: () => Set<string>;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
/** A time as text: 1/100 s as before, with the millisecond when there is one ("2.00", "5.123"), so the AI sees exact cuts. */
export function msText(s: number): string { const t = s.toFixed(3); return t.endsWith("0") ? t.slice(0, -1) : t; }
/** Times an edit sets (cuts, trims, footage in and out, sound offsets, where clips hang): to the millisecond. */
const rT = (n: number) => Math.round(n * 1000) / 1000;
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

/** A new edit of several videos (a video filmed in parts), in their order: the first is the edit's footage, the others
 *  follow it on V1, each whole, back to back, as add_clip puts them. Nothing else is applied. */
export function buildRawSequence(tr: Transcript, duration: number, cut: string[], videoId: string, more: VideoLite[]): Timeline {
  const tl = buildRawTimeline(tr, duration, cut, videoId);
  if (!more.length) return tl;
  const ctx: EditContext = { videoId, transcript: tr, silences: [], sceneCuts: [], duration, getStyle: () => undefined, getVideo: (id) => more.find((v) => v.id === id) };
  const ops = more.map((v) => ({ op: "add_clip" as const, videoId: v.id, from: 0, to: rT(v.seconds), label: v.name }));
  return applyOp({ timeline: tl, name: "", aspect: "16:9", styleId: null }, { op: "batch", ops } as Op, ctx).snap.timeline;
}

// ---------------------------------------------------------------------------------------------
// Helpers used by ops.
// ---------------------------------------------------------------------------------------------

function zoomClip(start: number, end: number, scale: number, mode: "punch" | "push", auto = false): V2Clip {
  return { id: rid("z"), start: rT(start), end: rT(end), label: `${mode === "push" ? "Push" : "Zoom"} ${Math.round(scale * 100)}%`, kind: "zoom", zoom: scale, mode, ...(auto ? { auto: true } : {}) } as V2Clip;
}

/** A clip for another track, placed at edit seconds s..e: it hangs on the V1 clip playing at s. */
function attachAt<T extends Clip>(view: SequenceView, c: T, s: number, e: number): T {
  const a = view.anchorFor(s);
  if (!a) throw new EditError("The sequence is empty: add a clip to V1 first.");
  return { ...c, start: rT(s), end: rT(e), anchorId: a.anchorId, anchorAt: rT(a.anchorAt), length: rT(e - s) } as T;
}

const seqClips = (tl: Timeline) => tl.tracks.v1 as SeqClip[];
const setSeq = (tl: Timeline, v1: SeqClip[]) => withTracks(tl, "v1", v1);
const mapClip = (tl: Timeline, id: string, f: (c: SeqClip) => SeqClip) => setSeq(tl, seqClips(tl).map((c) => (c.id === id ? f(c) : c)));
const name = (c: Clip) => c.label || c.id;

// ---------------------------------------------------------------------------------------------
// applyStyle: a style's looks only (its captions). Rendrr never cuts, trims, zooms or adds music on its own: the
// style's other rules come back as text for the AI to carry out with explicit edits.
// ---------------------------------------------------------------------------------------------
export function styleGuidance(rules: StyleRules): string[] {
  const z = rules.zoom, out: string[] = [];
  if (rules.trimEdges) out.push("trim the dead air before the first and after the last word");
  if (rules.cutSilencesOver != null) out.push(`cut pauses over ${rules.cutSilencesOver}s (mark_silences, then cut_words from/to)`);
  if (rules.removeFillers) out.push("cut the filler words (mark_fillers, then cut_words)");
  if (z.mode === "newSentence") out.push(`zoom ${Math.round(z.scale * 100)}% on each new sentence, held ${z.holdSec ?? 1.6}s, at least 2s apart`);
  else if (z.mode === "interval") out.push(`zoom ${Math.round(z.scale * 100)}% every ${z.everySec ?? 3}s, held ${z.holdSec ?? Math.min(1.5, (z.everySec ?? 3) / 2)}s`);
  else if (z.mode === "slowPush") out.push(`a slow push to ${Math.round(z.scale * 100)}% over each shot longer than 1.5s`);
  else if (z.mode === "count") out.push(`${z.count ?? 3} zooms of ${Math.round(z.scale * 100)}% on sentence starts, spread over the edit`);
  if (rules.sfxOnZoom) out.push(`sound effect ${rules.sfxOnZoom} on each zoom`);
  if (rules.music.mood) out.push(`music: ${rules.music.mood} at ${rules.music.gainDb} dB`);
  return out;
}

function applyStyleLooks(snap: Snapshot, style: StyleLite): { snap: Snapshot; summary: string } {
  const rules = style.rules;
  // A style with a full caption style gives exactly those captions; otherwise the look's preset (with its word counts).
  const { captionStyle: _cs, ...noStyle } = snap.timeline;
  const tl: Timeline = { ...noStyle, ...(rules.captions.style ? { captionStyle: rules.captions.style } : {}), captionsOn: rules.captions.on, captionLook: rules.captions.look };
  const rest = styleGuidance(rules);
  const summary = `applied style ${style.name} (looks only): ${rules.captions.on ? `captions ${rules.captions.look}` : "captions off"}` +
    (rest.length ? `. Its other rules, for you to do with explicit edits if you want them: ${rest.join("; ")}` : "");
  return { snap: { ...snap, styleId: style.id, timeline: tl }, summary };
}

// ---------------------------------------------------------------------------------------------
// applyOp
// ---------------------------------------------------------------------------------------------
type Inner = { snap: Snapshot; summary: string; count?: number };

/** What going behind the person means, said once with the edit that does it. */
const BEHIND_NOTE = "the person is drawn over it from an AI matte of the footage (people only), made when the edit is saved; where the clip under it is framed smaller, moved, reversed, or b-roll or a transition plays, it shows in front";

/** remove_background with nothing set behind V1 (no background, no b-roll under it): the result says what to do. */
const BLACK_BEHIND = "; behind it: black until set_background (a colour, gradient, pattern, library video or blur) or b-roll with set_under";
const hasBehind = (tl: Timeline) => !!tl.background || (tl.tracks.v2 as (Clip & { under?: boolean })[]).some((c) => c.under);

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
    // remove_background's "black until set_background" is old news once a later edit in the list set what is behind.
    return { snap: cur, summary: (hasBehind(cur.timeline) ? did.map((d) => d.replace(BLACK_BEHIND, "")) : did).join("; ") };
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
  const at2 = msText;

  switch (op.op) {
    case "replace": {
      // The editor sends the whole timeline. Keep the server's duration: the footage length never changes.
      // Marks are the AI's: an editor that does not send them keeps them as they are.
      const next = { ...op.timeline, duration: tl.duration || op.timeline.duration, ...(op.timeline.marks === undefined && tl.marks ? { marks: tl.marks } : {}), ...(op.timeline.markEdits === undefined && tl.markEdits ? { markEdits: tl.markEdits } : {}) };
      return { snap: { timeline: next, name: op.name ?? snap.name, aspect: (op.aspect ?? snap.aspect) as Aspect, styleId: op.styleId === undefined ? snap.styleId : op.styleId }, summary: "edited in the editor" };
    }
    case "cut_words": {
      const ids = (op.wordIds ?? []).filter((id) => wordById.has(id));
      const range = op.from != null && op.to != null ? { start: rT(Math.min(op.from, op.to)), end: rT(Math.max(op.from, op.to)) } : null;
      if (range && range.end - range.start < 0.001 - 1e-9) throw new EditError("The range is too short to cut: from must be at least 0.001 s (1 ms) before to.");
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
      if (!op.wordIds?.length && (op.from == null || op.to == null)) throw new EditError("restore_words takes wordIds, or from and to (footage seconds a range cut took out).");
      const rm = new Set(op.wordIds ?? []);
      const cut = tl.cut.filter((id) => !rm.has(id));
      const n = tl.cut.length - cut.length;
      let next: Timeline = { ...tl, cut }, back = 0, inRange = 0;
      // Words a range cut took out (not in the cut list): their footage back, a run of them at a time.
      const v1 = tl.tracks.v1 as SeqClip[];
      const plays = (w: Word) => v1.some((c) => c.sourceVideoId === main && c.sourceIn <= w.t + 0.02 && c.sourceOut >= w.end - 0.02);
      const gone = words.filter((w) => rm.has(w.id) && !tl.cut.includes(w.id) && !plays(w));
      const runs: Word[][] = [];
      for (const w of gone) { const last = runs[runs.length - 1]; if (last && words.indexOf(w) === words.indexOf(last[last.length - 1]) + 1) last.push(w); else runs.push([w]); }
      for (const r of runs) { const x = restoreSourceRange(next, main, r[0].t, r[r.length - 1].end); next = x.timeline; back += x.seconds; inRange += r.length; }
      if (op.from != null && op.to != null) { const x = restoreSourceRange(next, main, rT(Math.min(op.from, op.to)), rT(Math.max(op.from, op.to))); next = x.timeline; back += x.seconds; }
      const said = [n || (op.wordIds?.length && !back) ? `restored ${n} cut ${n === 1 ? "word" : "words"}` : "", back ? `put back ${back.toFixed(2)}s of footage a range cut took out${inRange ? ` (${inRange} ${inRange === 1 ? "word" : "words"})` : ""}` : op.from != null ? `${at2(Math.min(op.from, op.to!))}s to ${at2(Math.max(op.from, op.to!))}s already plays` : ""].filter(Boolean);
      return { snap: { ...snap, timeline: next }, summary: said.join("; "), count: n + inRange };
    }
    case "cut_silences":
      throw new EditError("cut_silences is retired: Rendrr no longer cuts on its own. Use mark_silences to list the silences with exact times, then cut the ones you choose with cut_words {from, to}.");
    case "remove_fillers":
      throw new EditError("remove_fillers is retired: Rendrr no longer cuts on its own. Use mark_fillers to list the filler words with their word ids, then cut the ones you choose with cut_words {wordIds}.");
    case "set_clips": {
      if (op.track === "a1" && op.linked === false) throw new EditError("In the sequence the dialogue follows its picture. Use set_audio_offset for J/L cuts or to mute a clip.");
      if (op.track === "v1" || op.track === "a1") {
        // The whole sequence, in this order.
        const old = new Map(seqClips(tl).map((c) => [c.id, c]));
        const used = new Set<string>();
        const taken = new Set([...old.keys(), ...op.clips.map((c) => c.id).filter(Boolean) as string[]]);
        const freshId = () => { let id = rid("vc_"); while (taken.has(id)) id = rid("vc_"); taken.add(id); return id; };
        const fresh: string[] = [];
        const clips = op.clips.map((c, i) => {
          const { videoId: v, id: _id, start, end, timelineStart: _a, timelineEnd: _b, linkId: _l, framing: fr, ...extra } = c as typeof c & Record<string, unknown>;
          const vid = videoIdOf((v as string | undefined) ?? (extra.sourceVideoId as string | undefined));
          inFootage(vid, start, end);
          const prev = c.id && !used.has(c.id) ? old.get(c.id) : undefined;
          const id = c.id && !used.has(c.id) ? c.id : freshId();
          if (!old.has(id)) fresh.push(id);
          used.add(id);
          const out = { ...(prev ?? lookOf(vid)), ...extra, id, label: c.label ?? prev?.label ?? "", start, end, sourceVideoId: vid, sourceIn: rT(start), sourceOut: rT(end) } as SeqClip;
          // Each clip's own framing ({scale, x, y}, as set_framing; null: fill the frame again).
          if (fr !== undefined) {
            delete (out as { framing?: Framing }).framing;
            if (fr !== null) {
              const f = FramingSchema.safeParse(fr);
              if (!f.success) throw new EditError(`Clip ${i + 1}'s framing is {scale 0.25-4, x -1 to 1, y -1 to 1}: ${f.error.issues[0].path.join(".") || "framing"} ${f.error.issues[0].message.toLowerCase()}.`);
              if (plainFraming(f.data)) (out as { framing?: Framing }).framing = f.data;
            }
          }
          return out;
        });
        // Graphics and text on V3 stay where they were in the edit: one whose V1 clip is gone is put back at its edit
        // times (over whatever plays there now); one that moved with its clip is named.
        let next = setSeq(tl, clips);
        const nv = sequenceView(next, words), v3 = tl.tracks.v3 as (Clip & Attached & { kind?: string })[];
        const kept: string[] = [], moved: string[] = [];
        next = withTracks(next, "v3", (next.tracks.v3 as (Clip & Attached & { kind?: string })[]).map((c0) => {
          const c = v3.find((x) => x.id === c0.id);
          if (!c || isCaptionMarker("v3", c) || c.fill) return c0;
          const was = placeOf(view(), c);
          if (!clips.some((x) => x.id === c.anchorId)) {
            const s = Math.min(was.s, Math.max(0, nv.total - 0.05)), e = Math.min(was.e, nv.total);
            if (e - s < 0.05) return c0;
            kept.push(`${c.id}${Math.abs(e - s - (was.e - was.s)) > 0.01 ? ` (shortened to the edit's end)` : ""}`);
            return attachAt(nv, c, s, e);
          }
          const now = placeOf(nv, c0);
          if (Math.abs(now.s - was.s) > 0.05) moved.push(`${c.id} ${fmtClock(was.s)} to ${fmtClock(now.s)}`);
          return c0;
        }));
        const notes = [kept.length ? `kept on V3 at their edit times (their V1 clip was replaced): ${kept.join(", ")}` : "", moved.length ? `moved with their V1 clip: ${moved.join(", ")}` : ""].filter(Boolean).join("; ");
        return { snap: { ...snap, timeline: next }, summary: `set ${clips.length} ${clips.length === 1 ? "clip" : "clips"} on V1${newIds(fresh)}${notes ? `; ${notes}` : ""}` };
      }
      // Another track: each clip hangs on the V1 clip playing at its start.
      let dropped = 0;
      const clips: Clip[] = [];
      const before = new Set((tl.tracks[op.track] as Clip[]).map((x) => x.id));
      op.clips.forEach((c, i) => {
        const base = { ...c, id: c.id || rid(op.track + "_" + i) } as Clip;
        if (isCaptionMarker(op.track, base)) { clips.push({ ...base, sourceVideoId: main, sourceIn: c.start, sourceOut: c.end } as Clip); return; }
        const s = toEdit(c.start, op.edit), e = op.track === "a3" && !op.edit ? s + Math.max(0.1, c.end - c.start) : toEdit(c.end, op.edit);
        if (e - s < 0.05 || s >= view().total) { dropped++; return; }
        const { anchorId: _x, anchorAt: _y, length: _z, fill: _f, ...rest } = base as Attached;
        clips.push(attachAt(view(), rest as Clip, s, e));
      });
      return { snap: { ...snap, timeline: withTracks(tl, op.track, clips) }, summary: `set ${clips.length} ${clips.length === 1 ? "clip" : "clips"} on ${op.track.toUpperCase()}${dropped ? ` (${dropped} not in the edit, left out)` : ""}${newIds(clips.filter((x) => !before.has(x.id) && !isCaptionMarker(op.track, x)).map((x) => x.id))}` };
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
      const first = c.fill ? attachAt(view(), { ...c, fill: undefined } as Clip, lay.s, at) : { ...c, length: rT(at - lay.s) };
      // Keyframes are seconds from the clip's start: the second half's start later by the first half's length.
      const ks = (c as { keys?: Key[] }).keys;
      const moved = ks?.length ? { keys: ks.map((k) => ({ ...k, t: rT(Math.max(0, k.t - (at - lay.s))) })) } : {};
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
        const next = mapClip(tl, c.id, (x) => ({ ...x, sourceIn: rT(Math.max(0, a)), sourceOut: rT(b) }));
        return { snap: { ...snap, timeline: next }, summary: `trimmed ${name(c)} to ${fmtClock(Math.max(0, a))}–${fmtClock(b)} of its footage` };
      }
      const c = findClip(tl, op.track, op.clipId) as Attached;
      if (isCaptionMarker(op.track, c)) return { snap: { ...snap, timeline: withTracks(tl, op.track, (tl.tracks[op.track] as Clip[]).map((x) => (x.id === c.id ? { ...x, sourceIn: rT(op.start), sourceOut: rT(op.end) } : x))) }, summary: `trimmed ${name(c)}` };
      const s = toEdit(op.start, op.edit), e = op.track === "a3" && !op.edit ? s + (op.end - op.start) : toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const { fill: _f, ...rest } = c;
      const next = withTracks(tl, op.track, (tl.tracks[op.track] as Clip[]).map((x) => (x.id === c.id ? attachAt(view(), rest as Clip, s, e) : x)));
      return { snap: { ...snap, timeline: next }, summary: `trimmed ${name(c)} to edit ${fmtClock(s)}–${fmtClock(e)}` };
    }
    case "delete_clip": {
      if (!op.track) {
        const on = (["v1", "v2", "v3", "a2", "a3"] as const).find((k) => (tl.tracks[k] as Clip[]).some((c) => c.id === op.clipId));
        if (!on) throw new EditError(`There is no clip "${op.clipId}" on any track. Read the project again to get the current clip ids. Nothing was changed.`);
        return applyLeaf(snap, { ...op, track: on }, ctx);
      }
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
      return { snap: { ...snap, timeline: withTracks(tl, "v2", [...tl.tracks.v2, z]) }, summary: `added zoom at ${op.edit ? "edit " : ""}${fmtClock(op.start)} (clip ${z.id})` };
    }
    case "add_broll": {
      const v = ctx.getVideo?.(op.videoId);
      if (!v) throw new EditError("That b-roll footage is not in your library.");
      if (!v.ready) throw new EditError(`"${v.name}" is not ready yet. Wait until it finishes processing.`);
      if (!(op.end > op.start)) throw new EditError("B-roll must end after it starts.");
      const s = toEdit(op.start, op.edit), e = toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      if (op.sourceStart + (e - s) > v.seconds + 0.05) throw new EditError(`"${v.name}" is only ${v.seconds.toFixed(1)}s long. Pick an earlier sourceStart or a shorter range.`);
      const c = attachAt(view(), { id: rid("b"), start: 0, end: 0, label: op.label || v.name, kind: "broll", videoId: v.id, sourceStart: rT(op.sourceStart) } as V2Clip, s, e);
      return { snap: { ...snap, timeline: withTracks(tl, "v2", [...tl.tracks.v2, c]) }, summary: `added b-roll ${v.name} at ${op.edit ? "edit " : ""}${fmtClock(op.start)} (clip ${c.id})` };
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
      const ins = textInside(op, {}, op.card ?? null, ctx);
      const c = attachAt(view(), { id: rid("t"), start: 0, end: 0, label: op.label || op.text.split("\n")[0].slice(0, 60), kind: "text" as const, text: op.text, style, card: ins.card, anim: op.anim ?? p.anim, ...(op.behind ? { behind: true } : {}), ...ins.fields } as Clip, s0, e0);
      return { snap: { ...snap, timeline: withTracks(tl, "v3", [...tl.tracks.v3, c]) }, summary: `added text "${op.text.split("\n")[0].slice(0, 40)}" at ${op.edit ? "edit " : ""}${fmtClock(op.start)} (clip ${c.id}; ${styleText(style)})${ins.said}${op.behind ? `; ${BEHIND_NOTE}` : ""}` };
    }
    case "set_text": {
      const c = findClip(tl, "v3", op.clipId) as Clip & { kind?: string; text?: string; style?: TextStyle; card?: Card | null; anim?: TextAnim };
      if (c.kind !== "text") throw new EditError(`Clip "${op.clipId}" on V3 is not a text layer.`);
      const p = op.preset ? textPreset(op.preset) : null;
      const style = TextStyleSchema.parse({ ...(p ? p.style : c.style ?? textPreset("plain").style), ...pickStyle(op) });
      const ins = textInside(op, c as { inside?: TextInside; cutout?: boolean }, op.card !== undefined ? op.card : c.card ?? null, ctx);
      const { inside: _i, cutout: _c, ...rest } = c as Clip & { inside?: TextInside; cutout?: boolean };
      let x: Clip = { ...rest, style, ...(op.text ? { text: op.text, label: op.text.split("\n")[0].slice(0, 60) } : {}), card: ins.card, ...(op.anim || p ? { anim: op.anim ?? p!.anim } : {}), ...ins.fields } as Clip;
      if (op.behind === true) (x as { behind?: boolean }).behind = true;
      else if (op.behind === false) delete (x as { behind?: boolean }).behind;
      if (op.start != null || op.end != null) {
        const cur = placeOf(view(), c as Attached);
        const s0 = op.start != null ? toEdit(op.start, op.edit) : cur.s, e0 = op.end != null ? toEdit(op.end, op.edit) : cur.e;
        if (e0 - s0 < 0.05) throw new EditError("A text layer must end after it starts, inside the edit.");
        x = attachAt(view(), x, s0, e0);
      }
      return { snap: { ...snap, timeline: withTracks(tl, "v3", (tl.tracks.v3 as Clip[]).map((y) => (y.id === c.id ? x : y))) }, summary: `changed text "${String((x as { text?: string }).text ?? "").split("\n")[0].slice(0, 40)}"${ins.said}${op.behind === true ? `; ${BEHIND_NOTE}` : op.behind === false ? "; in front of the person again" : ""}` };
    }
    case "edit_caption": {
      const line = ctx.transcript.find((l) => l.id === op.lineId);
      if (!line) throw new EditError(`There is no caption line "${op.lineId}".`);
      return { snap: { ...snap, timeline: { ...tl, captionText: { ...tl.captionText, [op.lineId]: op.text } } }, summary: `edited caption at ${fmtClock(line.start)}` };
    }
    case "add_music": {
      // The user's own file (add_audio), or a library track or mood.
      let base: Record<string, unknown> & { id: string; label: string; start: number; end: number };
      let track: { name: string } | undefined;
      if (op.url || op.driveFileId || op.upload) throw new EditError("add_music with url, driveFileId or upload is brought in by Rendrr's server (apply_edits through the AI); here send soundId.");
      if (op.soundId) {
        if (op.trackId) throw new EditError("add_music takes trackId (a library track or mood) or soundId (your own file from add_audio), not both.");
        const s = ctx.getSound?.(op.soundId);
        if (!s) throw new EditError(`There is no audio file "${op.soundId}" of yours. add_audio brings one in, or add_music takes the file itself: url (a share link), driveFileId, or upload: true.`);
        if (!s.ready) throw new EditError(`"${s.name}" is still being prepared. Try again in a moment.`);
        track = { name: s.name };
        base = { id: rid("m"), start: 0, end: 0, label: s.name, soundId: s.id, gainDb: op.gainDb ?? -18 };
      } else {
        if (!op.trackId) throw new EditError("add_music needs trackId (a library track or mood) or soundId (your own file from add_audio).");
        const t = findMusic(op.trackId);
        if (!t) throw new EditError(`No music track or mood called "${op.trackId}". Moods: ${Array.from(new Set(MUSIC_TRACKS.map((m) => m.mood))).join(", ")}.`);
        track = t;
        base = { id: rid("m"), start: 0, end: 0, label: t.name, trackId: t.id, assetKey: t.key, gainDb: op.gainDb ?? -18 };
      }
      // A bed under the whole edit replaces the old one; a ranged clip is added next to what is there.
      if (op.start == null && op.end == null) return { snap: { ...snap, timeline: withTracks(tl, "a2", [{ ...base, end: r2(view().total), fill: true } as Clip]) }, summary: `added music: ${track.name} (clip ${base.id})` };
      const s = op.start == null ? 0 : toEdit(op.start, op.edit), e = op.end == null ? view().total : toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const keep = (tl.tracks.a2 as Attached[]).filter((c) => { const p = placeOf(view(), c); return p.e <= s || p.s >= e; });
      return { snap: { ...snap, timeline: withTracks(tl, "a2", [...keep, attachAt(view(), base as Clip, s, e)]) }, summary: `added music: ${track.name} (clip ${base.id})` };
    }
    case "set_voice": {
      if (op.url || op.driveFileId || op.upload) throw new EditError("set_voice with url, driveFileId or upload is brought in by Rendrr's server (apply_edits through the AI); here send soundId.");
      if (op.soundId === null) { const { voice: _v, ...rest } = tl; return { snap: { ...snap, timeline: rest as Timeline }, summary: "the edit plays its clips' own sound again" }; }
      if (!op.soundId) throw new EditError("set_voice needs the file: soundId (from add_audio), or url (a share link), driveFileId, or upload: true for a link your code workspace sends it to; null brings the clips' own sound back.");
      const s = ctx.getSound?.(op.soundId);
      if (!s) throw new EditError(`There is no audio file "${op.soundId}" of yours. add_audio brings one in, or set_voice takes the file itself: url (a share link), driveFileId, or upload: true.`);
      if (!s.ready) throw new EditError(`"${s.name}" is still being prepared. Try again in a moment.`);
      const total = view().total, start = rT(Math.max(0, op.start ?? 0));
      const voice = { soundId: s.id, start, ...(op.gainDb != null ? { gainDb: op.gainDb } : {}), editSeconds: rT(total) };
      const off = rT(start + s.seconds - total);
      const fit = Math.abs(off) <= 0.05 ? "it lines up with the edit's end" : off > 0 ? `it runs ${at2(off)}s past the edit's end (that part is not heard)` : `it ends ${at2(-off)}s before the edit does (silence after it)`;
      return { snap: { ...snap, timeline: { ...tl, voice } }, summary: `the edit's sound is now "${s.name}" (${at2(s.seconds)}s, from ${at2(start)}s of the edit, ${at2(total)}s long): ${fit}. Every clip's own sound is off; later cuts are not in the file, so make it last` };
    }
    case "add_graphic": {
      const g = ctx.getGraphic?.(op.graphicId);
      if (!g) throw new EditError("That graphic does not exist. Use list_graphics to see the ids.");
      if (!(op.end > op.start)) throw new EditError("A graphic must end after it starts.");
      const s = toEdit(op.start, op.edit), e = toEdit(op.end, op.edit);
      if (e - s < 0.05) throw new EditError("That range is not in the edit (its footage is cut).");
      const from = op.from && op.from >= 0.001 ? rT(op.from) : 0;
      if (from && !g.custom) throw new EditError("from works on custom graphics (create_graphic). A template is drawn for each placement: it always starts at its beginning.");
      if (from && from > g.durationSec - 0.05) throw new EditError(`from ${at2(from)}s is past the end of ${g.name} (${at2(g.durationSec)}s long).`);
      const params = op.data !== undefined ? { ...(op.params ?? {}), data: op.data } : op.params;
      if (g.custom) { const p = placementParams(g.name, g.params ?? {}, params); if ("error" in p) throw new EditError(p.error); }
      // A library graphic's params are checked against what it takes (names, types, limits).
      const li = libraryItem(g.id);
      if (li) { const p = libraryParams(li, op.params ?? {}); if ("error" in p) throw new EditError(p.error); }
      const c = attachAt(view(), { id: rid("g"), start: 0, end: 0, label: op.label || g.name, kind: "graphic" as const, graphicId: g.id, params, ...(from ? { sourceStart: from } : {}), ...(op.behind ? { behind: true } : {}) } as Clip, s, e);
      const failed = g.failed ? `; its recording failed (${g.failed.replace(/\.$/, "").slice(0, 160)}): retry_graphic records it again, and a render records it before it starts` : "";
      return { snap: { ...snap, timeline: withTracks(tl, "v3", [...tl.tracks.v3, c]) }, summary: `added graphic ${g.name} at ${op.edit ? "edit " : ""}${fmtClock(op.start)}${from ? ` from ${at2(from)}s of it` : ""} (clip ${c.id})${op.rerecord ? "; recorded again for these params" : ""}${failed}${op.behind ? `; ${BEHIND_NOTE}` : ""}` };
    }
    case "behind_person": {
      const v3 = tl.tracks.v3 as (Clip & { kind?: string; text?: string; behind?: boolean })[];
      const said: string[] = [];
      const ids = new Set(op.clipIds);
      for (const id of ids) {
        const c = v3.find((x) => x.id === id);
        if (!c) throw new EditError(`There is no clip "${id}" on V3 (text layers and graphics).`);
        if (c.kind !== "text" && c.kind !== "graphic") throw new EditError(`Clip "${id}" is a caption: only text layers and graphics go behind the person.`);
        said.push(c.kind === "text" ? `text "${String(c.text ?? "").split("\n")[0].slice(0, 30)}" (${id})` : `graphic ${c.label || c.id} (${id})`);
      }
      const next = v3.map((c) => { if (!ids.has(c.id)) return c; if (op.off) { const { behind: _b, ...rest } = c; return rest as Clip; } return { ...c, behind: true } as Clip; });
      return { snap: { ...snap, timeline: withTracks(tl, "v3", next) }, summary: op.off ? `in front of the person again: ${said.join(", ")}` : `behind the person: ${said.join(", ")}; ${BEHIND_NOTE}` };
    }
    case "set_aspect":
      return { snap: { ...snap, aspect: op.aspect }, summary: `changed shape to ${op.aspect}` };
    case "rename":
      return { snap: { ...snap, name: op.name }, summary: `renamed the edit to "${op.name}"` };
    case "set_reference":
      throw new EditError("set_reference is kept on the project by Rendrr's server: send it with apply_edits.");
    case "add_media": {
      const have = tl.media ?? [];
      const names: string[] = [];
      for (const vid of op.videoIds) {
        const v = ctx.getVideo?.(vid);
        if (ctx.getVideo && !v && vid !== ctx.videoId) throw new EditError(`There is no video "${vid}" in the library. list_footage shows them.`);
        names.push(v?.name ? `"${v.name}"` : vid);
      }
      const media = [...have, ...op.videoIds.filter((x, i, a) => !have.includes(x) && a.indexOf(x) === i)];
      if (media.length > 200) throw new EditError("The project bin holds 200 videos at most.");
      return { snap: { ...snap, timeline: { ...tl, media } }, summary: `project bin: added ${names.join(", ")}` };
    }
    case "remove_media": {
      const media = (tl.media ?? []).filter((x) => !op.videoIds.includes(x));
      return { snap: { ...snap, timeline: { ...tl, media: media.length ? media : undefined } }, summary: `project bin: took off ${op.videoIds.length === 1 ? "1 video" : op.videoIds.length + " videos"}` };
    }
    case "set_framing": {
      const ids = targets(tl, op.clipIds);
      if (op.fitFaceTo && op.focus !== undefined) throw new EditError("Send focus and fitFaceTo in two apply_edits: fitFaceTo measures the face where the reframed fit puts it.");
      if (op.fitFaceTo) return fitFaces(snap, op.fitFaceTo, op, ids);
      if (op.focus === "face" && !op.centers) throw new EditError("focus \"face\" needs the faces measured: send it through apply_edits, which measures them.");
      let shown: Framing | null = null;
      const none: string[] = [], later: string[] = [];
      const next = setSeq(tl, seqClips(tl).map((c) => {
        if (!ids.has(c.id)) return c;
        const cur = c.framing ?? { scale: 1, x: 0, y: 0 };
        // A clip with no entry was made after the faces were measured (in the same apply_edits).
        const fc = op.focus === undefined ? cur.focus : op.focus === "face" ? op.centers![c.id] ?? ((op.centers![c.id] === null ? none : later).push(c.id), cur.focus) : op.focus ?? undefined;
        const f = FramingSchema.parse({ scale: r2(op.scale ?? cur.scale), x: r2(op.x ?? cur.x), y: r2(op.y ?? cur.y), ...(fc ? { focus: { x: rT(fc.x), y: rT(fc.y) } } : {}) });
        shown = f;
        const { framing: _f, ...rest } = c;
        return (plainFraming(f) ? { ...rest, framing: f } : rest) as SeqClip;
      }));
      const f = shown as Framing | null;
      const what = op.clipIds ? `${ids.size} ${ids.size === 1 ? "clip" : "clips"}` : "the footage";
      const noFace = none.length ? `; no face found in ${none.slice(0, 12).join(", ")}${none.length > 12 ? ` and ${none.length - 12} more` : ""}: ${none.length === 1 ? "its" : "their"} fit stays as it was` : "";
      const notYet = later.length ? `; ${later.slice(0, 12).join(", ")}${later.length > 12 ? ` and ${later.length - 12} more` : ""} made in this same call: send focus "face" again in the next apply_edits to reframe ${later.length === 1 ? "it" : "them"}` : "";
      if (op.focus === "face") return { snap: { ...snap, timeline: next }, summary: `reframed ${what} on the speaker's face (${ids.size - none.length - later.length} of ${ids.size})${noFace}${notYet}` };
      return { snap: { ...snap, timeline: next }, summary: (!f || !plainFraming(f) ? `${what} back to filling the frame` : `framed ${what}: ${framingText(f)}`) + noFace };
    }
    case "set_card": {
      const ids = targets(tl, op.clipIds);
      if (!op.reset && op.crop === undefined && op.radius === undefined && op.shadow === undefined && op.border === undefined) throw new EditError("set_card needs crop, radius, shadow, border or reset.");
      let shown: CardLook | null = null;
      const next = setSeq(tl, seqClips(tl).map((c) => {
        if (!ids.has(c.id)) return c;
        const cur: Record<string, unknown> = op.reset ? {} : { ...((c as { cardLook?: CardLook }).cardLook ?? {}) };
        for (const k of ["crop", "radius", "shadow", "border"] as const) {
          const v = op[k];
          if (v === null || (k === "radius" && v === 0)) delete cur[k];
          else if (v !== undefined) cur[k] = v;
        }
        const card = CardLookSchema.parse(cur);
        shown = card;
        const { cardLook: _c, ...rest } = c as SeqClip & { cardLook?: CardLook };
        return (hasCard(card) ? { ...rest, cardLook: card } : rest) as SeqClip;
      }));
      const what = op.clipIds ? `${ids.size} ${ids.size === 1 ? "clip" : "clips"}` : "the footage";
      const card = shown as CardLook | null;
      const framed = seqClips(tl).some((c) => ids.has(c.id) && c.framing && c.framing.scale < 1);
      return { snap: { ...snap, timeline: next }, summary: card && hasCard(card) ? `${what} drawn as a card: ${cardLookText(card)}${framed ? "" : " (set_framing scale under 1 shows it as a card on the background)"}` : `${what}: no card look` };
    }
    case "set_background": {
      const n = [op.color, op.gradient, op.videoId, op.blur, op.pattern].filter((x) => x != null).length;
      if (op.none) { if (n) throw new EditError("set_background: none true, or one of color, gradient, videoId, blur, pattern."); const { background: _b, ...rest } = tl; return { snap: { ...snap, timeline: rest as Timeline }, summary: "background back to black" }; }
      if (n !== 1) throw new EditError("set_background takes one of color, gradient, videoId (a library video), blur (1-100) or pattern {kind: grid|dots|paper, color, ink, size}, or none true.");
      if (op.videoId) {
        const v = ctx.getVideo?.(op.videoId);
        if (!v) throw new EditError("That background video is not in your library.");
        if (!v.ready) throw new EditError(`"${v.name}" is not ready yet. Wait until it finishes processing.`);
      }
      const bg = BackgroundSchema.parse({ ...(op.color ? { color: op.color.toUpperCase() } : {}), ...(op.gradient ? { gradient: op.gradient } : {}), ...(op.videoId ? { videoId: op.videoId } : {}), ...(op.blur ? { blur: op.blur } : {}), ...(op.pattern ? { pattern: { ...op.pattern, color: op.pattern.color.toUpperCase(), ink: op.pattern.ink.toUpperCase() } } : {}) });
      return { snap: { ...snap, timeline: { ...tl, background: bg } }, summary: `background: ${backgroundText(bg, (id) => ctx.getVideo?.(id)?.name)} (it shows where V1 is framed smaller, cropped, rounded, keyed, masked or has its background removed)` };
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
      return applyStyleLooks(snap, op.overrides ? { ...style, rules: mergeRules(style.rules, op.overrides) } : style);
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
      next = insertSeqClip(next, { id, label, start: 0, end: 0, sourceVideoId: vid, sourceIn: rT(op.from), sourceOut: rT(op.to), ...lookOf(vid) } as SeqClip, index);
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
        if (k === i && op.start != null) y = { ...y, audioStart: rT(op.start) };
        if (k === i + 1 && op.end != null) y = { ...y, audioStart: rT(op.end) };
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
      const aOut = rT(a.sourceOut + op.by), bIn = rT(b.sourceIn + op.by);
      if (aOut < a.sourceIn + 0.1 || bIn > b.sourceOut - 0.1) throw new EditError(`Rolling ${op.by}s would leave a clip shorter than 0.1 s.`);
      if (bIn < 0) throw new EditError(`${name(b)}'s footage starts ${b.sourceIn.toFixed(2)}s in; the cut can move at most ${b.sourceIn.toFixed(2)}s earlier.`);
      const sa = secondsOf(a.sourceVideoId);
      if (sa != null && aOut > sa + 0.005) throw new EditError(`${name(a)}'s footage ends ${(sa - a.sourceOut).toFixed(2)}s after the clip; the cut can move at most that much later.`);
      const next = setSeq(tl, v1.map((x, k) => (k === i ? { ...x, sourceOut: aOut } : k === i + 1 ? { ...x, sourceIn: bIn } : x)));
      return { snap: { ...snap, timeline: next }, summary: `moved the cut after ${name(a)} ${op.by > 0 ? "later" : "earlier"} by ${Math.abs(op.by).toFixed(2)}s` };
    }
    case "slip_clip": {
      const c = findClip(tl, "v1", op.clipId) as SeqClip;
      const sIn = rT(c.sourceIn + op.by), sOut = rT(c.sourceOut + op.by);
      if (sIn < 0) throw new EditError(`${name(c)} can slip at most ${c.sourceIn.toFixed(2)}s earlier (the footage starts there).`);
      const s = secondsOf(c.sourceVideoId);
      if (s != null && sOut > s + 0.005) throw new EditError(`${name(c)} can slip at most ${(s - c.sourceOut).toFixed(2)}s later (the footage ends there).`);
      let next = mapClip(tl, c.id, (x) => ({ ...x, sourceIn: sIn, sourceOut: sOut }));
      // Clips hanging on it stay where they are in the edit.
      const tracks = { ...next.tracks } as Timeline["tracks"];
      for (const k of ["v2", "v3", "a2", "a3"] as TrackName[]) (tracks as Record<string, Clip[]>)[k] = (next.tracks[k] as Attached[]).map((x) => (x.anchorId === c.id ? { ...x, anchorAt: rT(Number(x.anchorAt ?? 0) + op.by) } : x));
      next = { ...next, tracks };
      return { snap: { ...snap, timeline: next }, summary: `slipped ${name(c)} ${Math.abs(op.by).toFixed(2)}s ${op.by > 0 ? "later" : "earlier"} in its footage (now ${at2(sIn)}–${at2(sOut)}s)` };
    }
    case "slide_clip": {
      const v1 = seqClips(tl);
      const i = v1.findIndex((c) => c.id === op.clipId);
      if (i < 0) findClip(tl, "v1", op.clipId);
      const prev = v1[i - 1], next0 = v1[i + 1];
      if (!prev || !next0) throw new EditError(`${name(v1[i])} needs a clip before and after it to slide between them.`);
      const pOut = rT(prev.sourceOut + op.by), nIn = rT(next0.sourceIn + op.by);
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
      const still: SeqClip = { id, label: `Freeze ${op.length}s`, start: 0, end: 0, sourceVideoId: c.sourceVideoId, sourceIn: rT(f), sourceOut: rT(f + 0.04), freeze: rT(op.length), ...(c.rotate ? { rotate: c.rotate } : {}), ...(plainFraming(c.framing) ? { framing: c.framing } : {}) };
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
        const stored = keys.map((k) => ({ ...k, t: rT(c.freeze ? c.sourceIn + Math.min(k.t, len) : view().editToSource(c.id, p.start + Math.min(k.t, len))) }));
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
      if (op.lut && !op.lut.id) throw new EditError(`The LUT "${op.lut.name ?? "from its text"}" has to be imported first: send this edit through Rendrr's server (apply_edits), which imports it.`);
      if (op.lut) op.lut = { id: op.lut.id!, ...(op.lut.amount != null ? { amount: op.lut.amount } : {}), ...(op.lut.input != null ? { input: op.lut.input } : {}) };
      if (op.lut && ctx.getLut && !ctx.getLut(op.lut.id!)) throw new EditError(`There is no LUT "${op.lut.id}" in your LUTs. Import the .cube file in the editor's Color tab; get_project lists your LUTs.`);
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
      const fl = following(op.faceTracks);
      const next = mapLook(tl, ids, (c) => { const { masks: _m, ...rest } = c; return (op.masks.length ? { ...rest, masks: op.masks.map((m) => fl.area(m, c.id)) } : rest) as typeof c; });
      const ms = (lookClip(next, ids[0]).clip.masks ?? []) as Mask[];
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${op.masks.length ? `masks ${masksText(ms)}` : "no masks"}${fl.note(ids)}` };
    }
    case "set_effects": {
      const ids = lookIds(tl, op);
      const fl = following(op.faceTracks);
      const next = mapLook(tl, ids, (c) => { const { effects: _e, ...rest } = c; return (op.effects.length ? { ...rest, effects: op.effects.map((e) => (e.area ? { ...e, area: fl.area(e.area, c.id) } : e)) } : rest) as typeof c; });
      const es = (lookClip(next, ids[0]).clip.effects ?? []) as Effect[];
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${op.effects.length ? effectsText(es) : "no effects"}${fl.note(ids)}` };
    }
    case "retouch_skin": {
      const ids = op.clipId || op.clipIds || op.all || op.video ? lookIds(tl, op) : lookIds(tl, { all: true });
      const given = { smooth: op.smooth, blemishes: op.blemishes, even: op.even, brighten: op.brighten };
      const faceless: string[] = [];
      const areaFor = (c: Clip & ClipLook): { area?: Area; face?: boolean } => {
        const want = op.area ?? (c.skin ? (c.skin.area ? "keep" : "frame") : "face");
        if (want === "keep") return { area: c.skin!.area, face: c.skin!.face };
        if (want === "frame") return {};
        if (want !== "face") return { area: want };
        if (!op.faceAreas) throw new EditError("retouch_skin with area \"face\" needs the faces measured: send it through apply_edits, which measures them (or send area \"frame\" or a shape).");
        const a = op.faceAreas[c.id];
        if (!a) faceless.push(c.id);
        return a ? { area: a, face: true } : {};
      };
      const next = mapLook(tl, ids, (c) => {
        const { skin: _s, ...rest } = c;
        if (op.off) return rest as typeof c;
        const base = c.skin ?? SKIN_DEFAULTS;
        const sk: Skin = { smooth: given.smooth ?? base.smooth, blemishes: given.blemishes ?? base.blemishes, even: given.even ?? base.even, brighten: given.brighten ?? base.brighten };
        const { area, face } = areaFor(c);
        if (area) { sk.area = area; if (face) sk.face = true; }
        return (skinActive(sk) ? { ...rest, skin: sk } : rest) as typeof c;
      });
      const sk = lookClip(next, ids[0]).clip.skin;
      const none = faceless.length ? `; no face measured on ${faceless.length === ids.length ? "them" : faceless.slice(0, 8).join(", ") + (faceless.length > 8 ? ` and ${faceless.length - 8} more` : "")}: the skin is found over the whole picture there` : "";
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${sk ? skinText(sk) : "no skin retouch"}${none}` };
    }
    case "remove_background": {
      const ids = op.clipId || op.clipIds || op.all || op.video ? lookIds(tl, op) : lookIds(tl, { all: true });
      const onV1 = new Set((tl.tracks.v1 as Clip[]).map((c) => c.id));
      const broll = ids.filter((id) => !onV1.has(id));
      if (broll.length) throw new EditError(`remove_background works on V1 clips; ${broll.slice(0, 4).join(", ")} ${broll.length === 1 ? "is" : "are"} b-roll.`);
      const next = mapLook(tl, ids, (c) => {
        const { subject: _s, ...rest } = c;
        if (op.off) return rest as typeof c;
        const base = c.subject ?? SUBJECT_DEFAULTS;
        const sj: Subject = { edge: op.edge ?? base.edge, soft: op.soft ?? base.soft };
        if (op.invert ?? c.subject?.invert) sj.invert = true;
        return { ...rest, subject: sj } as typeof c;
      });
      const sj = lookClip(next, ids[0]).clip.subject;
      const behind = hasBehind(tl) ? "" : BLACK_BEHIND;
      return { snap: { ...snap, timeline: next }, summary: `${idsText(tl, ids)}: ${sj ? subjectText(sj) + behind : "background back"}` };
    }
    case "set_under": {
      const c = findClip(tl, "v2", op.clipId) as V2Clip & { under?: boolean };
      if (c.kind !== "broll") throw new EditError(`Clip "${op.clipId}" on V2 is a zoom: only b-roll can go behind V1.`);
      const next = withTracks(tl, "v2", (tl.tracks.v2 as Clip[]).map((x) => { if (x.id !== c.id) return x; const { under: _u, ...rest } = x as Clip & { under?: boolean }; return (op.under ? { ...rest, under: true } : rest) as Clip; }));
      return { snap: { ...snap, timeline: next }, summary: `${name(c)}: ${op.under ? "behind V1 (shows where V1 is keyed, masked, framed smaller or moved)" : "over V1"}` };
    }
    case "set_blend": {
      const ids = op.clipIds ?? (op.clipId ? [op.clipId] : []);
      if (!ids.length) throw new EditError("set_blend needs clipId or clipIds (b-roll on V2, graphics on V3).");
      if (op.blend === undefined && op.opacity === undefined) throw new EditError("set_blend needs blend or opacity.");
      let t = tl;
      const said: string[] = [];
      for (const id of ids) {
        const track = (t.tracks.v2 as Clip[]).some((x) => x.id === id) ? "v2" : (t.tracks.v3 as Clip[]).some((x) => x.id === id) ? "v3" : null;
        if (!track) throw new EditError(`There is no clip "${id}" on V2 or V3.`);
        const c = findClip(t, track, id) as Clip & { kind?: string; under?: boolean; blend?: BlendMode; opacity?: number };
        if (track === "v2" && c.kind !== "broll") throw new EditError(`Clip "${id}" on V2 is a zoom: blend modes are for b-roll and graphics.`);
        if (track === "v2" && c.under) throw new EditError(`Clip "${id}" is behind V1 (set_under): a blend mode is for a layer over the picture.`);
        if (track === "v3" && c.kind !== "graphic") throw new EditError(`Clip "${id}" on V3 is ${c.kind === "text" ? "a text layer" : "a caption"}: blend modes are for b-roll and graphics (a text layer fades with set_keyframes opacity).`);
        const blend = op.blend ?? c.blend, opacity = op.opacity ?? c.opacity;
        const { blend: _b, opacity: _o, ...rest } = c;
        const next = { ...rest, ...(blend && blend !== "normal" ? { blend } : {}), ...(opacity != null && opacity < 1 ? { opacity: Math.round(opacity * 1000) / 1000 } : {}) } as Clip;
        t = withTracks(t, track, (t.tracks[track] as Clip[]).map((x) => (x.id === id ? next : x)));
        said.push(`${track === "v2" ? "b-roll" : "graphic"} ${c.label || id} (${id}): ${blendText(blend, opacity) || "normal"}`);
      }
      return { snap: { ...snap, timeline: t }, summary: said.join("; ") };
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

    // ---- marks ----
    case "add_marks": {
      const have = new Set((tl.marks ?? []).map((m) => m.id));
      const made: Mark[] = op.marks.map((m, i) => {
        const at = markPlace(m.start, m.end ?? m.start, m.videoId, op.edit, op.marks.length > 1 ? `Mark ${i + 1}` : "The mark");
        let id = rid("mk_");
        while (have.has(id)) id = rid("mk_");
        have.add(id);
        return { id, kind: m.kind, ...at, source: "ai" as const, ...(m.label ? { label: m.label } : {}), ...(m.note ? { note: m.note } : {}), ...(m.confidence != null ? { confidence: m.confidence } : {}) };
      });
      const marks = [...(tl.marks ?? []), ...made];
      if (marks.length > 5000) throw new EditError(`An edit keeps up to 5000 of your marks (this would make ${marks.length}): delete some first with delete_mark.`);
      const one = made[0];
      return { snap: { ...snap, timeline: { ...tl, marks } }, count: made.length, summary: made.length === 1 ? `added mark ${one.id} (${one.kind} ${markWhere(one)})` : `added ${made.length} marks: ${made.slice(0, 20).map((m) => m.id).join(", ")}${made.length > 20 ? ", …" : ""}` };
    }
    case "update_mark": {
      const mine = (tl.marks ?? []).find((m) => m.id === op.id);
      if (mine) {
        if (op.hidden != null) throw new EditError("hidden is for Rendrr's marks; delete_mark removes one of yours.");
        let next: Mark = { ...mine };
        if (op.start != null || op.end != null) {
          if (op.edit && op.start == null) throw new EditError("With edit true, send start (and end for a range) in edit seconds.");
          const s = op.start ?? mine.start, e = op.end ?? (op.edit ? op.start! : Math.max(s, mine.end));
          next = { ...next, ...markPlace(s, e, op.edit ? undefined : mine.videoId, op.edit, "The mark") };
        }
        if (op.kind) next.kind = op.kind;
        if (op.confidence != null) next.confidence = op.confidence;
        if (op.label !== undefined) { if (op.label === null) delete next.label; else next.label = op.label; }
        if (op.note !== undefined) { if (op.note === null) delete next.note; else next.note = op.note; }
        return { snap: { ...snap, timeline: { ...tl, marks: (tl.marks ?? []).map((m) => (m.id === op.id ? next : m)) } }, summary: `updated mark ${op.id} (${next.kind} ${markWhere(next)})` };
      }
      rendrrMark(op.id);
      if (op.kind || op.start != null || op.end != null || op.confidence != null) throw new EditError(`${op.id} is one of Rendrr's marks: its kind, times and confidence are measured. Change its label, note or hidden, or add your own mark with add_marks.`);
      const cur: MarkEdit = { ...(tl.markEdits?.[op.id] ?? {}) };
      if (op.label !== undefined) { if (op.label === null) delete cur.label; else cur.label = op.label; }
      if (op.note !== undefined) { if (op.note === null) delete cur.note; else cur.note = op.note; }
      if (op.hidden !== undefined) { if (op.hidden) cur.hidden = true; else delete cur.hidden; }
      const said = [op.label !== undefined && (op.label === null ? "its own label back" : "label"), op.note !== undefined && (op.note === null ? "note cleared" : "note"), op.hidden !== undefined && (op.hidden ? "hidden in this edit" : "shown again")].filter(Boolean);
      return { snap: { ...snap, timeline: withMarkEdits(tl, { [op.id]: cur }) }, summary: `updated Rendrr's mark ${op.id}${said.length ? `: ${said.join(", ")}` : ""}` };
    }
    case "delete_mark": {
      const ids = Array.from(new Set([...(op.ids ?? []), ...(op.id ? [op.id] : [])]));
      if (!ids.length) throw new EditError("delete_mark needs id or ids (list_marks gives them).");
      const mine = new Set((tl.marks ?? []).map((m) => m.id));
      const gone = ids.filter((id) => mine.has(id)), hid = ids.filter((id) => !mine.has(id));
      hid.forEach(rendrrMark);
      let next: Timeline = { ...tl, marks: (tl.marks ?? []).filter((m) => !gone.includes(m.id)) };
      if (!next.marks!.length) delete next.marks;
      if (hid.length) next = withMarkEdits(next, Object.fromEntries(hid.map((id) => [id, { ...(tl.markEdits?.[id] ?? {}), hidden: true }])));
      const said = [gone.length && `deleted ${gone.length} ${gone.length === 1 ? "mark" : "marks"}`, hid.length && `hid ${hid.length === 1 ? `Rendrr's mark ${hid[0]}` : `${hid.length} of Rendrr's marks`} in this edit (update_mark hidden false shows ${hid.length === 1 ? "it" : "one"} again)`].filter(Boolean);
      return { snap: { ...snap, timeline: next }, summary: said.join("; "), count: ids.length };
    }
  }

  /** Where a mark goes: footage seconds of a video (default the main footage), or edit seconds with edit true. */
  function markPlace(start: number, end: number, videoId: string | undefined, isEdit: boolean | undefined, what: string): { videoId: string; start: number; end: number } {
    if (end < start) throw new EditError(`${what} ends (${at2(end)}s) before it starts (${at2(start)}s).`);
    if (isEdit) {
      const v = view();
      if (start > v.total + 0.001) throw new EditError(`${what} starts at edit ${at2(start)}s, but the edit is ${at2(v.total)}s long.`);
      const a = editToFootage(v, start), b = end > start ? editToFootage(v, Math.min(end, v.total), "end") : a;
      if (!a || !b) throw new EditError("The sequence is empty: add a clip to V1 first.");
      if (a.videoId !== b.videoId || b.t < a.t) throw new EditError(`${what} (edit ${at2(start)}s to ${at2(end)}s) runs across a cut to other footage: send one mark per clip, or footage seconds.`);
      return { videoId: a.videoId, start: a.t, end: b.t };
    }
    const vid = videoIdOf(videoId);
    const f = vid === main ? { name: "the footage", seconds: ctx.duration } : (() => { const x = ctx.getVideo?.(vid); if (!x) throw new EditError(`Video "${vid}" is not in your library. Use list_footage for the ids.`); return { name: `"${x.name}"`, seconds: x.seconds }; })();
    if (end > f.seconds + 0.05) throw new EditError(`${what} ends at ${at2(end)}s, but ${f.name} is only ${f.seconds.toFixed(1)}s long.`);
    return { videoId: vid, start: rT(start), end: rT(end) };
  }
  /** A Rendrr mark id that names a real mark (when the caller can say which exist). */
  function rendrrMark(id: string) {
    const known = RENDRR_MARK.test(id) ? ctx.rendrrMarkIds?.() : undefined;
    if (!RENDRR_MARK.test(id) || (known && !known.has(id))) throw new EditError(`There is no mark ${id} in this edit. list_marks gives the ids.`);
  }
}

const markWhere = (m: Mark) => (m.end > m.start ? `${msText(m.start)}s to ${msText(m.end)}s` : `at ${msText(m.start)}s`);
/** The AI's notes on Rendrr's marks, merged; an empty note is dropped, and so is an empty record. */
function withMarkEdits(tl: Timeline, patch: Record<string, MarkEdit>): Timeline {
  const all = { ...(tl.markEdits ?? {}) };
  for (const [id, e] of Object.entries(patch)) { if (Object.keys(e).length) all[id] = e; else delete all[id]; }
  const next: Timeline = { ...tl, markEdits: all };
  if (!Object.keys(all).length) delete next.markEdits;
  return next;
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

/**
 * Phase 3: shapes that follow the face (follow "face"), given each clip's face measured over it (faceTracks, from the
 * server): the shape gets keys from its clip's face; a clip with no face measured keeps the shape still (said once).
 * Without faceTracks a shape that already has its keys keeps them.
 */
function following(tracks: Record<string, FaceTrack | null> | undefined) {
  const faceless = new Set<string>();
  return {
    area: <A extends Area>(a: A, clipId: string): A => {
      if (a.follow !== "face") return a;
      if (!tracks) {
        if (a.keys?.length) return a;
        throw new EditError("follow \"face\" needs the faces measured: send it through apply_edits, which measures them (or send the shape's keys).");
      }
      const tr = tracks[clipId];
      if (!tr?.length) {
        // No face there: the shape stays still, where it was (or, sent without a box, in the middle).
        faceless.add(clipId);
        const { follow: _f, keys: _k, ...still } = a;
        return (still.x == null || still.y == null || still.w == null || still.h == null ? { ...still, x: 0.3, y: 0.15, w: 0.4, h: 0.6 } : still) as A;
      }
      return followFace(a, tr) as A;
    },
    note: (ids: string[]) => (faceless.size ? `; no face measured on ${faceless.size === ids.length ? "them" : Array.from(faceless).slice(0, 8).join(", ")}: the shape stays where it is there` : ""),
  };
}

/**
 * Phase 2b: what shows inside a text layer's letters after an op (add_text, set_text): its own colour, a library video
 * (inside) or the picture under its card (cutout: a card is needed; black when it has none). The fields to set on the
 * clip, its card, and what the result says.
 */
function textInside(op: { inside?: TextInside | null; cutout?: boolean; card?: Card | null }, cur: { inside?: TextInside; cutout?: boolean }, card: Card | null, ctx: EditContext): { fields: { inside?: TextInside; cutout?: true }; card: Card | null; said: string } {
  if (op.inside && op.cutout) throw new EditError("A text layer takes inside (a video inside its letters) or cutout (its letters cut out of its card), not both.");
  if (op.cutout && op.card === null) throw new EditError("cutout cuts the letters out of the text's card: keep a card (card {color, opacity}).");
  // from 0 unless sent (an op applied without parsing has no defaults).
  let inside = op.inside === undefined ? cur.inside : op.inside ? { videoId: op.inside.videoId, from: op.inside.from ?? 0 } : undefined;
  let cutout = op.cutout === undefined ? !!cur.cutout : op.cutout;
  if (op.inside) cutout = false;
  if (op.cutout) inside = undefined;
  let said = "";
  if (op.inside) {
    const v = ctx.getVideo?.(op.inside.videoId);
    if (!v) throw new EditError("That video is not in your library (inside takes a library video's id: list_footage).");
    if (!v.ready) throw new EditError(`"${v.name}" is not ready yet. Wait until it finishes processing.`);
    if (inside!.from >= v.seconds) throw new EditError(`"${v.name}" is only ${v.seconds.toFixed(1)}s long: inside.from must be under that.`);
    said = `; ${v.name} plays inside the letters${inside!.from ? ` from ${+inside!.from.toFixed(3)}s` : ""} (looped when shorter than the text)`;
  } else if (op.inside === null && cur.inside) said = "; no video inside the letters";
  if (cutout && !card) {
    if (op.card === null) { cutout = false; said += "; no card, so no longer cut out"; }
    else card = { color: "#000000", opacity: 1 };
  }
  if (op.cutout) said = `; cut out of its card (${card!.color}): the picture under it shows through the letters`;
  else if (op.cutout === false && cur.cutout) said += "; no longer cut out";
  return { fields: { ...(inside ? { inside } : {}), ...(cutout ? { cutout: true as const } : {}) }, card, said };
}

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
/** The ids of clips an edit made, for its summary (so the next edit can name them without reading the project). */
function newIds(ids: string[]): string {
  return ids.length ? ` (new ${ids.length === 1 ? "clip" : "clips"}: ${ids.slice(0, 30).join(", ")}${ids.length > 30 ? ` and ${ids.length - 30} more` : ""})` : "";
}

/**
 * set_framing fitFaceTo: each clip framed so its face (measured on its frames turned and fitted as the render draws
 * them) lands at x, y of the frame with half its height r. The render scales the fitted picture by `scale` about the
 * centre and moves it by (x, y) frames: a point u of the picture lands at (1 - scale) / 2 + x + u * scale.
 */
function fitFaces(snap: Snapshot, to: { x: number; y: number; r: number }, op: { scale?: number; x?: number; y?: number; faces?: Record<string, { u: number; v: number; r: number } | null> }, ids: Set<string>): { snap: Snapshot; summary: string } {
  if (op.scale != null || op.x != null || op.y != null) throw new EditError("fitFaceTo works out scale, x and y from the face: send one or the other.");
  if (!op.faces) throw new EditError("fitFaceTo needs the faces measured: send it through apply_edits, which measures them.");
  const tl = snap.timeline;
  const none: string[] = [], short: string[] = [], empty: string[] = [];
  let last: Framing | null = null, n = 0;
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const next = setSeq(tl, seqClips(tl).map((c) => {
    if (!ids.has(c.id)) return c;
    const f = op.faces![c.id];
    if (!f) { none.push(c.id); return c; }
    const s0 = to.r / f.r, sc = clamp(s0, 0.25, 4);
    const x0 = to.x - (1 - sc) / 2 - f.u * sc, y0 = to.y - (1 - sc) / 2 - f.v * sc;
    const fr = FramingSchema.parse({ scale: rT(sc), x: rT(clamp(x0, -1, 1)), y: rT(clamp(y0, -1, 1)), ...(c.framing?.focus ? { focus: c.framing.focus } : {}) });
    if (sc !== s0 || Math.abs(x0) > 1 || Math.abs(y0) > 1) short.push(c.id);
    // The moved picture no longer reaches an edge of the frame: black (or what is under V1) shows there.
    const half = (fr.scale - 1) / 2 + 1e-9;
    if (fr.scale < 1 || Math.abs(fr.x) > half || Math.abs(fr.y) > half) empty.push(c.id);
    last = fr; n++;
    const { framing: _f, ...rest } = c;
    return (plainFraming(fr) ? { ...rest, framing: fr } : rest) as SeqClip;
  }));
  const list = (xs: string[]) => xs.slice(0, 12).join(", ") + (xs.length > 12 ? ` and ${xs.length - 12} more` : "");
  const lastF = last as Framing | null;
  return { snap: { ...snap, timeline: next }, summary: `put the face at ${to.x}, ${to.y} (radius ${to.r} of the frame) in ${n} ${n === 1 ? "clip" : "clips"}${n === 1 && lastF ? ` (${framingText(lastF)})` : ""}`
    + (none.length ? `; no face found in ${list(none)}: left as ${none.length === 1 ? "it was" : "they were"}` : "")
    + (short.length ? `; ${list(short)} could not get there within scale 0.25-4 and offset -1 to 1 (as close as allowed)` : "")
    + (empty.length ? `; ${list(empty)} no longer ${empty.length === 1 ? "fills" : "fill"} the frame (an edge shows black)` : "") };
}

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
export function framingText(f: { scale: number; x: number; y: number; focus?: { x: number; y: number } }) {
  const pct = (n: number) => `${Math.round(Math.abs(n) * 100)}%`;
  return [f.focus ? `reframed on ${f.focus.x}, ${f.focus.y} of the footage` : "", f.scale !== 1 || !f.focus ? `scale ${f.scale}` : "", f.x ? `moved ${f.x > 0 ? "right" : "left"} ${pct(f.x)}` : "", f.y ? `moved ${f.y > 0 ? "down" : "up"} ${pct(f.y)}` : ""].filter(Boolean).join(", ");
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

/** v1Offset / v1Limit: a page of the V1 sequence (default the first maxPerTrack clips). clipNote: more to say about a
 *  V1 clip (get_project: its sound at the edges and the pauses inside). */
export type SummaryOpts = { v1Offset?: number; v1Limit?: number; clipNote?: (c: SeqClip) => string };
/** Phase 4: " blend screen 60%" for a layer that is not plain. */
const blendNote = (c: Record<string, unknown>) => { const t = blendText(c.blend as BlendMode | undefined, c.opacity as number | undefined); return t ? ` blend ${t}` : ""; };

export function summarizeTimeline(snap: Snapshot, tr: Transcript, maxPerTrack = 60, mainVideoId?: string, lutName?: (id: string) => string | undefined, footage?: FootageInfo, opts: SummaryOpts = {}): string {
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
  const v1From = Math.max(0, opts.v1Offset ?? 0), v1Count = opts.v1Limit ?? maxPerTrack;
  const shownV1 = v1.slice(v1From, v1From + v1Count).map((c) => {
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
    const ms = msText;
    const at = p.end > p.start ? ` @${ms(p.start)}-${ms(p.end)}` : " (all cut)";
    const note = opts.clipNote?.(c);
    return `  ${c.id} ${vName(c.sourceVideoId)} ${ms(c.sourceIn)}-${ms(c.sourceOut)}${at} "${c.label}"${extra.length ? " " + extra.join(" ") : ""}${note ? ` | ${note}` : ""}`;
  });
  const v1Rest = v1.length - v1From - shownV1.length;
  const v1Page = v1From > 0 || v1Rest > 0 ? ` (clips ${v1From + 1}-${v1From + shownV1.length} of ${v1.length})` : "";
  lines.push(`V1 sequence${v1Page}:${v1.length ? "\n" + shownV1.join("\n") + (v1Rest > 0 ? `\n  …${v1Rest} more: clipsFrom ${v1From + shownV1.length}` : "") : " empty"}`);
  const names: Partial<Record<TrackName, string>> = { v2: "V2 b-roll/zooms", v3: "V3 titles", a2: "A2 music", a3: "A3 sfx" };
  for (const k of Object.keys(names) as TrackName[]) {
    let clips = tl.tracks[k] as (Clip & Record<string, unknown>)[];
    if (k === "v3") clips = clips.filter((c) => !isCaptionMarker("v3", c));
    const shown = clips.slice(0, maxPerTrack).map((c) => {
      // As they render: a music clip that sets only one fade keeps the automatic other one.
      const auto = k === "a2" ? autoMusicFades(c.end - c.start) : { fadeIn: 0, fadeOut: 0 };
      const fd = (own: unknown, a: number) => (own != null ? String(own) : `${+a.toFixed(2)} auto`);
      const fades = c.fadeIn != null || c.fadeOut != null ? ` fades ${fd(c.fadeIn, auto.fadeIn)}/${fd(c.fadeOut, auto.fadeOut)}s` : "";
      const extra = c.kind === "zoom" ? ` x${c.zoom}` : c.kind === "broll" ? ` video=${c.videoId}@${c.sourceStart}${blendNote(c)}` : c.graphicId ? ` graphic=${c.graphicId}${c.sourceStart ? ` from ${c.sourceStart}s` : ""}${c.params && Object.keys(c.params).length ? ` params=${JSON.stringify(c.params).slice(0, 200)}` : ""}${c.behind ? " behind the person" : ""}${blendNote(c)}` : c.kind === "text" ? ` text=${JSON.stringify(c.text)}${c.style ? ` (${styleText(c.style as TextStyle)})` : ""}${c.anim && c.anim !== "none" ? ` ${c.anim}` : ""}${c.card ? ` card ${(c.card as Card).color}` : ""}${c.inside ? ` video ${(c.inside as TextInside).videoId}@${(c.inside as TextInside).from} inside the letters` : ""}${c.cutout ? " cut out of the card" : ""}${c.behind ? " behind the person" : ""}` : c.trackId ? ` track=${c.trackId} ${c.gainDb ?? -18}dB${fades}` : c.sfxId ? ` sfx=${c.sfxId} ${c.gainDb ?? -6}dB${fades}` : "";
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
  const t = [c.grade ? "grade" : "", c.key ? "key" : "", c.masks?.length ? `${c.masks.length} ${c.masks.length === 1 ? "mask" : "masks"}` : "", ...(c.effects ?? []).map((e) => e.type), skinActive(c.skin) ? "skin" : "", c.subject ? "no background" : "", hasCard((c as { cardLook?: CardLook }).cardLook) ? "card" : ""].filter(Boolean);
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
    ...group((c) => (skinActive(c.skin) ? skinText(c.skin!) : "")),
    ...group((c) => (c.subject ? subjectText(c.subject) : "")),
    ...group((c) => { const cl = (c as { cardLook?: CardLook }).cardLook; return hasCard(cl) ? `card ${cardLookText(cl)}` : ""; }),
  ];
  if (tl.background) out.push(`behind V1: ${backgroundText(tl.background)}`);
  if (tl.export?.hdr === "sdr") out.push("export: HDR footage converted to SDR");
  return out.length ? [`Looks: ${out.join("; ")}`] : [];
}
