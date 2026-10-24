import { z } from "zod";
import { catalogMusic, catalogSfx } from "./catalog";
import { CaptionStyleSchema, CardSchema, TEXT_ANIMS, TextStyleSchema } from "./captions";
import { ASPECTS, CAPTION_LOOKS } from "./constants";

// The shared timeline. Same shape as timelineFor() in ui/rendrr-ui.html.
// Two models (see docs/timeline-model.md and sequence.ts):
//   A (no `model` field, before Phase 2): clip times are seconds in the project's ORIGINAL footage. Rendering
//     removes cut words and anything outside the V1 clips, then maps every other track onto the output.
//   B (`model: "B"`): V1 is an ordered list of clips from any video (sourceVideoId, sourceIn, sourceOut), played
//     back to back. Other tracks are attached to a V1 clip (anchorId, anchorAt, length). start/end = edit seconds,
//     written by the layout.

const id = z.string().min(1).max(80);
const time = z.number().finite().min(0).max(24 * 3600);
const label = z.string().max(300).default("");

export const ClipSchema = z.object({ id, start: time, end: time, label }).passthrough();

export const V2ClipSchema = ClipSchema.extend({
  kind: z.enum(["zoom", "broll"]).optional(),
  zoom: z.number().min(1).max(3).optional(),
  assetKey: z.string().max(400).optional(),
  videoId: z.string().max(80).optional(),
  sourceStart: time.optional(),
});

export const V3ClipSchema = ClipSchema.extend({
  kind: z.enum(["caption", "graphic", "text"]).optional(),
  lineId: z.string().max(80).optional(),
  graphicId: z.string().max(80).optional(),
  params: z.record(z.unknown()).optional(),
  /** Text layers (kind "text"): the text (line breaks with \n), its style, a full-frame card behind it, its animation. */
  text: z.string().max(1000).optional(),
  style: TextStyleSchema.optional(),
  card: CardSchema.nullable().optional(),
  anim: z.enum(TEXT_ANIMS).optional(),
});

export const A2ClipSchema = ClipSchema.extend({
  assetKey: z.string().max(400).optional(),
  trackId: z.string().max(80).optional(),
  gainDb: z.number().min(-60).max(12).optional(),
});

export const A3ClipSchema = ClipSchema.extend({
  assetKey: z.string().max(400).optional(),
  sfxId: z.string().max(80).optional(),
  gainDb: z.number().min(-60).max(12).optional(),
});

export const TracksSchema = z.object({
  v1: z.array(ClipSchema).max(2000),
  v2: z.array(V2ClipSchema).max(2000),
  v3: z.array(V3ClipSchema).max(4000),
  a1: z.array(ClipSchema).max(2000),
  a2: z.array(A2ClipSchema).max(200),
  a3: z.array(A3ClipSchema).max(500),
});

/** Clockwise turn of the footage, for footage filmed sideways (applied before it is fitted to the shape). */
export const RotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
export type Rotation = z.infer<typeof RotationSchema>;
/** Position and scale of the footage in the frame (after the fit): scale 1 = fills it; x, y = offset as a share of
 *  the frame's width and height (0.3 = moved down by 30% of the height). Uncovered parts are black. */
export const FramingSchema = z.object({ scale: z.number().min(0.25).max(4), x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) });
export type Framing = z.infer<typeof FramingSchema>;

/** Dialogue cleanup presets (see audio.ts CLEANUP_PRESETS); set_audio can change their main numbers by hand. */
export const CLEANUPS = ["none", "light", "voice", "noisy"] as const;
export type Cleanup = (typeof CLEANUPS)[number];
/**
 * The edit's sound. Left out = the defaults: no cleanup, loudness -14 LUFS with a -1 dBTP ceiling, music 12 dB down
 * under speech, no fades of the whole mix.
 */
export const AudioSettingsSchema = z.object({
  cleanup: z.enum(CLEANUPS).optional(),
  /** Integrated loudness of the file in LUFS; null = no normalization (the old limiter only). */
  loudness: z.number().min(-30).max(-6).nullable().optional(),
  /** True-peak ceiling in dBTP. */
  peak: z.number().min(-6).max(0).optional(),
  /** How many dB music goes down under speech; 0 = no ducking. */
  duck: z.number().min(0).max(30).optional(),
  /** Fade of the whole mix at the start and at the end of the edit, in seconds. */
  fadeIn: z.number().min(0).max(10).optional(),
  fadeOut: z.number().min(0).max(10).optional(),
  /** Fade at every dialogue cut in seconds, so cuts don't click (default 0.02; 0 = off). */
  declick: z.number().min(0).max(0.03).optional(),
  /** Hand-set cleanup values on top of the preset: high-pass Hz (0 = off), noise reduction dB, presence lift dB at
   *  3.5 kHz, de-esser 0-1, compression ratio (1 = off). */
  highpass: z.number().min(0).max(300).optional(),
  denoise: z.number().min(0).max(40).optional(),
  presence: z.number().min(0).max(8).optional(),
  deess: z.number().min(0).max(1).optional(),
  compress: z.number().min(1).max(10).optional(),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;
export const AUDIO_DEFAULTS = {
  cleanup: "none" as Cleanup, loudness: -14 as number | null, peak: -1, duck: 12, fadeIn: 0, fadeOut: 0, declick: 0.02,
  highpass: undefined as number | undefined, denoise: undefined as number | undefined, presence: undefined as number | undefined, deess: undefined as number | undefined, compress: undefined as number | undefined,
};
export type AudioMixSettings = typeof AUDIO_DEFAULTS;
/** The edit's audio settings with the defaults filled in. */
export const audioSettings = (tl: { audio?: AudioSettings }): AudioMixSettings => ({ ...AUDIO_DEFAULTS, ...Object.fromEntries(Object.entries(tl.audio ?? {}).filter(([, v]) => v !== undefined)) });

export const TimelineSchema = z.object({
  /** "B" = the sequence model. Missing = model A (stored before Phase 2; converted when edited). */
  model: z.literal("B").optional(),
  /** Model B: the project's own footage (its transcript and cut words). */
  mainVideoId: z.string().max(80).optional(),
  /** The main footage's length in seconds. */
  duration: z.number().finite().min(0).max(24 * 3600),
  cut: z.array(id).max(200_000),
  captionsOn: z.boolean(),
  captionLook: z.enum(CAPTION_LOOKS),
  captionText: z.record(z.string().max(2000)),
  /** The edit's own caption style (Phase 4). Missing = the look's preset (with the project style's word counts). */
  captionStyle: CaptionStyleSchema.optional(),
  tracks: TracksSchema,
  rotate: RotationSchema.optional(),
  framing: FramingSchema.optional(),
  audio: AudioSettingsSchema.optional(),
});

export type Clip = z.infer<typeof ClipSchema>;
export type V2Clip = z.infer<typeof V2ClipSchema>;
export type V3Clip = z.infer<typeof V3ClipSchema>;
export type A2Clip = z.infer<typeof A2ClipSchema>;
export type A3Clip = z.infer<typeof A3ClipSchema>;
export type Tracks = z.infer<typeof TracksSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type TrackName = keyof Tracks;
export const TRACK_NAMES: TrackName[] = ["v1", "v2", "v3", "a1", "a2", "a3"];
export const TrackNameSchema = z.enum(["v1", "v2", "v3", "a1", "a2", "a3"]);

export const AspectSchema = z.enum(ASPECTS);
export const CaptionLookSchema = z.enum(CAPTION_LOOKS);

// Version snapshots hold the timeline plus the project fields an edit can change.
export const SnapshotSchema = z.object({
  timeline: TimelineSchema,
  name: z.string().max(200),
  aspect: AspectSchema,
  styleId: z.string().max(80),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Checks the things zod cannot: clip order, ends after starts, unique ids. Returns plain-English problems. */
export function timelineProblems(t: Timeline): string[] {
  if (t.model === "B") return sequenceProblems(t);
  const out: string[] = [];
  for (const name of TRACK_NAMES) {
    const seen = new Set<string>();
    for (const c of t.tracks[name]) {
      if (seen.has(c.id)) out.push(`Track ${name.toUpperCase()} has two clips with the id "${c.id}".`);
      seen.add(c.id);
      if (!(c.end > c.start)) out.push(`Clip "${c.label || c.id}" on ${name.toUpperCase()} must end after it starts.`);
      if (c.start > t.duration + 0.01) out.push(`Clip "${c.label || c.id}" on ${name.toUpperCase()} starts after the footage ends (${t.duration.toFixed(1)}s).`);
    }
  }
  return out;
}

/** Music and sound effect clips get their storage key from the catalog; an unknown track keeps no key (silent). */
function canonicalAudio(name: TrackName, c: Clip): Clip {
  if (name !== "a2" && name !== "a3") return c;
  const { assetKey: _ignored, ...rest } = c as Clip & { assetKey?: string };
  const hit = name === "a2" ? catalogMusic(c as A2Clip) : catalogSfx(c as A3Clip);
  if (!hit) return rest;
  return name === "a2" ? { ...rest, trackId: hit.id, assetKey: hit.key } : { ...rest, sfxId: hit.id, assetKey: hit.key };
}

/** Model B: V1 clips play footage, every other clip (but captions) hangs on a V1 clip; A1 is written by the layout. */
function sequenceProblems(t: Timeline): string[] {
  const out: string[] = [];
  const v1 = t.tracks.v1 as (Clip & { sourceVideoId?: unknown; sourceIn?: number; sourceOut?: number })[];
  const ids = new Set(v1.map((c) => c.id));
  for (const name of TRACK_NAMES) {
    if (name === "a1") continue;
    const seen = new Set<string>();
    for (const c of t.tracks[name] as (Clip & Record<string, unknown>)[]) {
      if (seen.has(c.id)) out.push(`Track ${name.toUpperCase()} has two clips with the id "${c.id}".`);
      seen.add(c.id);
      if (name === "v1") {
        if (typeof c.sourceVideoId !== "string" || !c.sourceVideoId) out.push(`Clip "${c.label || c.id}" on V1 has no video.`);
        if (!(Number(c.sourceOut) > Number(c.sourceIn))) out.push(`Clip "${c.label || c.id}" on V1 must end after it starts.`);
      } else if (!isCaptionMarker(name, c) && !c.fill) {
        if (!(Number(c.length) > 0)) out.push(`Clip "${c.label || c.id}" on ${name.toUpperCase()} must end after it starts.`);
        if (typeof c.anchorId === "string" && !ids.has(c.anchorId)) out.push(`Clip "${c.label || c.id}" on ${name.toUpperCase()} hangs on a V1 clip that is gone.`);
      }
    }
  }
  return out;
}

/** V3 caption clips mark which transcript lines show captions; they are not placed in the edit by hand. */
export const isCaptionMarker = (track: TrackName, c: Clip) => {
  const x = c as Clip & { kind?: string; lineId?: string; graphicId?: string };
  return track === "v3" && (x.kind === "caption" || (!x.kind && !!x.lineId && !x.graphicId));
};

/** Sorts clips, clamps them to the footage length, rounds times to 1/100 s and fixes audio keys. */
export function normalizeTimeline(t: Timeline): Timeline {
  const r = (n: number) => Math.round(n * 100) / 100;
  if (t.model === "B") return normalizeSequence(t);
  const tracks = {} as Tracks;
  for (const name of TRACK_NAMES) {
    (tracks as Record<string, Clip[]>)[name] = [...t.tracks[name]]
      .map((c) => canonicalAudio(name, { ...c, start: r(Math.max(0, Math.min(c.start, t.duration))), end: r(Math.max(0, Math.min(c.end, t.duration))) }))
      .filter((c) => c.end > c.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return { ...t, cut: Array.from(new Set(t.cut)), tracks };
}

/**
 * Model B: rounds the fields that decide the edit and fixes audio keys. V1 keeps its order (it is the sequence);
 * main-footage clips stay inside the footage. Edit positions are written afterwards by the layout.
 */
function normalizeSequence(t: Timeline): Timeline {
  const r = (n: number) => Math.round(n * 100) / 100;
  const main = t.mainVideoId || "main";
  const tracks = {} as Tracks;
  for (const name of TRACK_NAMES) {
    let clips = (t.tracks[name] as (Clip & Record<string, unknown>)[]).map((c) => canonicalAudio(name, { ...c }) as Clip & Record<string, unknown>);
    if (name === "v1") {
      clips = clips.map((c) => {
        const vid = String(c.sourceVideoId || main);
        const hi = vid === main ? t.duration : 24 * 3600;
        const sIn = r(Math.max(0, Math.min(Number(c.sourceIn ?? c.start), hi))), sOut = r(Math.max(0, Math.min(Number(c.sourceOut ?? c.end), hi)));
        const x: Clip & Record<string, unknown> = { ...c, sourceVideoId: vid, sourceIn: sIn, sourceOut: sOut };
        if (x.audioStart != null) { const a = r(Number(x.audioStart)); if (a) x.audioStart = a; else delete x.audioStart; }
        if (!x.audioMuted) delete x.audioMuted;
        if (!x.rotate) delete x.rotate;
        for (const k of ["audioGain", "audioFadeIn", "audioFadeOut"]) { if (x[k] != null) { const v = r(Number(x[k])); if (v) x[k] = v; else delete x[k]; } }
        return x;
      }).filter((c) => Number(c.sourceOut) - Number(c.sourceIn) >= 0.01);
    } else if (name !== "a1") {
      clips = clips.map((c) => {
        const x: Clip & Record<string, unknown> = { ...c, start: r(Math.max(0, c.start)), end: r(Math.max(0, c.end)) };
        // Attachment to 1/1000 s: a clip keeps its place and length within a frame through any number of saves.
        const r3 = (n: number) => Math.round(n * 1000) / 1000;
        if (x.length != null) x.length = r3(Number(x.length));
        if (x.anchorAt != null) x.anchorAt = r3(Number(x.anchorAt));
        for (const k of ["fadeIn", "fadeOut"]) if (x[k] != null) x[k] = r(Math.max(0, Number(x[k])));
        return x;
      }).filter((c) => isCaptionMarker(name, c) || c.fill || c.length == null || Number(c.length) >= 0.01);
    }
    (tracks as Record<string, Clip[]>)[name] = clips;
  }
  return { ...t, cut: Array.from(new Set(t.cut)), tracks };
}
