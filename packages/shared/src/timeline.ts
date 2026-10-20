import { z } from "zod";
import { ASPECTS, CAPTION_LOOKS } from "./constants";

// The shared timeline. Same shape as timelineFor() in ui/rendrr-ui.html.
// All times are seconds in the ORIGINAL footage (source time). Rendering removes cut words and
// anything outside the V1 clips, then maps every other track onto the output.

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
  kind: z.enum(["caption", "graphic"]).optional(),
  lineId: z.string().max(80).optional(),
  graphicId: z.string().max(80).optional(),
  params: z.record(z.unknown()).optional(),
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

export const TimelineSchema = z.object({
  duration: z.number().finite().min(0).max(24 * 3600),
  cut: z.array(id).max(200_000),
  captionsOn: z.boolean(),
  captionLook: z.enum(CAPTION_LOOKS),
  captionText: z.record(z.string().max(2000)),
  tracks: TracksSchema,
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

/** Sorts clips, clamps them to the footage length and rounds times to 1/100 s. */
export function normalizeTimeline(t: Timeline): Timeline {
  const r = (n: number) => Math.round(n * 100) / 100;
  const tracks = {} as Tracks;
  for (const name of TRACK_NAMES) {
    (tracks as Record<string, Clip[]>)[name] = [...t.tracks[name]]
      .map((c) => ({ ...c, start: r(Math.max(0, Math.min(c.start, t.duration))), end: r(Math.max(0, Math.min(c.end, t.duration))) }))
      .filter((c) => c.end > c.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return { ...t, cut: Array.from(new Set(t.cut)), tracks };
}
