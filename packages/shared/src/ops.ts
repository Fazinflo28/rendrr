import { z } from "zod";
import { findMusic, MUSIC_TRACKS, SFX } from "./catalog";
import type { Aspect } from "./constants";
import { mergeRules, StyleRulesPatchSchema, type StyleRules } from "./styles";
import {
  AspectSchema, CaptionLookSchema, ClipSchema, SnapshotSchema, TimelineSchema, TrackNameSchema,
  normalizeTimeline, timelineProblems,
  type Clip, type Snapshot, type Timeline, type TrackName, type V2Clip,
} from "./timeline";
import { allWords, type Line, type Silence, type Transcript, type Word } from "./transcript";
import {
  deleteClip, EditError, fmtClock, keptRanges, layoutTimeline, LINKED_TRACK, makeTimeMap, mergeRanges, outputDuration,
  removeFromMainCut, removeRangeFromTrack, setLink, splitClip, trimClip, withTracks, type Range,
} from "./sequence";

// ---------------------------------------------------------------------------------------------
// Every change to a timeline is one of these ops. The UI sends `replace` (its autosave);
// the AI sends the granular ones. applyOp() is pure; applyTimelineChange() in packages/core
// is the only place that stores the result.
// ---------------------------------------------------------------------------------------------

const t = z.number().finite().min(0).max(24 * 3600);
// The ops that change an edit step by step. An AI sends a list of them in one go (the `batch` op).
const EDIT_OPS = [
  // wordIds cut those words (restore_words brings them back); from/to removes exactly that footage range, words or not.
  z.object({ op: z.literal("cut_words"), wordIds: z.array(z.string().max(40)).max(50_000).optional(), from: t.optional(), to: t.optional() }),
  z.object({ op: z.literal("restore_words"), wordIds: z.array(z.string().max(40)).max(50_000) }),
  // edges (default on): also the silence at the start and end of every V1 clip (longer than 0.3 s), whatever overSeconds.
  z.object({ op: z.literal("cut_silences"), overSeconds: z.number().min(0.1).max(30), edges: z.boolean().optional() }),
  z.object({ op: z.literal("remove_fillers") }),
  // A clip without an id gets a new one; keep a clip's id to keep it the same clip. On V1 or A1 the other track
  // gets the same clips too (picture and dialogue stay linked) unless linked is false.
  z.object({ op: z.literal("set_clips"), track: TrackNameSchema, clips: z.array(ClipSchema.extend({ id: z.string().min(1).max(80).optional() }).passthrough()).max(4000), linked: z.boolean().optional() }),
  // linked (default true): a V1 clip and its A1 dialogue change together.
  z.object({ op: z.literal("split_clip"), track: TrackNameSchema, clipId: z.string().max(80), at: t, linked: z.boolean().optional() }),
  z.object({ op: z.literal("trim_clip"), track: TrackNameSchema, clipId: z.string().max(80), start: t, end: t, linked: z.boolean().optional() }),
  z.object({ op: z.literal("delete_clip"), track: TrackNameSchema, clipId: z.string().max(80), linked: z.boolean().optional() }),
  // Unlink a V1 clip from its A1 dialogue (linked false), or link them again (true).
  z.object({ op: z.literal("set_link"), track: TrackNameSchema, clipId: z.string().max(80), linked: z.boolean() }),
  z.object({ op: z.literal("add_zoom"), start: t, end: t, scale: z.number().min(1.01).max(2) }),
  z.object({ op: z.literal("add_broll"), videoId: z.string().max(80), start: t, end: t, sourceStart: t.default(0), label: z.string().max(200).optional() }),
  z.object({ op: z.literal("set_captions"), on: z.boolean(), look: CaptionLookSchema.optional() }),
  z.object({ op: z.literal("edit_caption"), lineId: z.string().max(40), text: z.string().max(2000) }),
  z.object({ op: z.literal("add_music"), trackId: z.string().max(80), gainDb: z.number().min(-40).max(6).optional(), start: t.optional(), end: t.optional() }),
  z.object({ op: z.literal("add_graphic"), graphicId: z.string().max(80), start: t, end: t, params: z.record(z.unknown()).default({}), label: z.string().max(200).optional() }),
  z.object({ op: z.literal("set_aspect"), aspect: AspectSchema }),
  z.object({ op: z.literal("rename"), name: z.string().min(1).max(200) }),
  z.object({ op: z.literal("apply_style"), styleId: z.string().max(80), overrides: StyleRulesPatchSchema.optional() }),
] as const;
export const EditOpSchema = z.discriminatedUnion("op", [...EDIT_OPS]);
export const EDIT_OP_NAMES = EDIT_OPS.map((o) => o.shape.op.value) as [EditOp["op"], ...EditOp["op"][]];
export type EditOp = z.infer<typeof EditOpSchema>;
export const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), timeline: TimelineSchema, name: z.string().max(200).optional(), aspect: AspectSchema.optional(), styleId: z.string().max(80).optional() }),
  ...EDIT_OPS,
  z.object({ op: z.literal("restore_snapshot"), snapshot: SnapshotSchema, note: z.string().max(300) }),
  z.object({ op: z.literal("batch"), ops: z.array(EditOpSchema).min(1).max(50) }),
]);
export type Op = z.infer<typeof OpSchema>;

export type StyleLite = { id: string; name: string; captionLook: "clean" | "bold" | "outline"; rules: StyleRules };
export type GraphicLite = { id: string; name: string; durationSec: number };
export type VideoLite = { id: string; name: string; seconds: number; ready: boolean };
export type EditContext = {
  /** The project's footage: written on every clip as the video it plays (see layoutTimeline). */
  videoId?: string;
  transcript: Transcript;
  silences: Silence[];
  sceneCuts: number[];
  duration: number;
  getStyle: (id: string) => StyleLite | undefined;
  getVideo?: (id: string) => VideoLite | undefined;
  getGraphic?: (id: string) => GraphicLite | undefined;
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

export function buildInitialTimeline(tr: Transcript, duration: number, captionLook: "clean" | "bold" | "outline", cut: string[] = []): Timeline {
  const dur = r2(Math.max(0.5, duration));
  const paras = paragraphs(tr);
  const v1: Clip[] = [];
  const a1: Clip[] = [];
  if (!paras.length) {
    v1.push({ id: "vc1", start: 0, end: dur, label: "Main" });
    a1.push({ id: "d1", start: 0, end: dur, label: "Dialogue" });
  } else {
    paras.forEach((p, i) => {
      const start = i === 0 ? 0 : r2((paras[i - 1][paras[i - 1].length - 1].end + p[0].start) / 2);
      const end = i === paras.length - 1 ? dur : r2((p[p.length - 1].end + paras[i + 1][0].start) / 2);
      if (end - start < 0.05) return;
      v1.push({ id: "vc" + (i + 1), start, end, label: firstWords(p[0]) });
      a1.push({ id: "d" + (i + 1), start, end, label: "Dialogue" });
    });
  }
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



/**
 * The silence at the start and end of every V1 clip, before its first and after its last spoken word, when longer
 * than 0.3 s: each cut then sits right on the speech. Small pads keep the breath before the first word and the
 * tail of the last one.
 */
export function clipEdgeSilences(tl: Timeline, words: Word[]): Range[] {
  const cut = new Set(tl.cut);
  const out: Range[] = [];
  for (const c of tl.tracks.v1) {
    const inside = words.filter((w) => !cut.has(w.id) && w.end > c.start && w.t < c.end);
    if (!inside.length) continue; // a clip with no words: the audio's own silences decide (fromAudio)
    const first = inside[0], last = inside[inside.length - 1];
    if (first.t - c.start > EDGE_SILENCE) out.push({ start: c.start, end: r2(first.t - 0.1) });
    if (c.end - last.end > EDGE_SILENCE) out.push({ start: r2(last.end + 0.15), end: c.end });
  }
  return out;
}
const EDGE_SILENCE = 0.3;

function linesOutsideCuts(tr: Transcript, tl: Timeline) {
  const cut = new Set(tl.cut);
  const kept = keptRanges(tl, allWords(tr));
  const inKept = (time: number) => kept.some((k) => time >= k.start && time < k.end);
  return tr.filter((l) => l.words.some((w) => !cut.has(w.id) && inKept(w.t)));
}

function zoomClip(start: number, end: number, scale: number, mode: "punch" | "push", auto = false): V2Clip {
  return { id: rid("z"), start: r2(start), end: r2(end), label: `${mode === "push" ? "Push" : "Zoom"} ${Math.round(scale * 100)}%`, kind: "zoom", zoom: scale, mode, ...(auto ? { auto: true } : {}) } as V2Clip;
}

// ---------------------------------------------------------------------------------------------
// applyStyle: the machine-readable rules in action. Server side, deterministic, no AI.
// ---------------------------------------------------------------------------------------------
function applyStyleRules(snap: Snapshot, style: StyleLite, ctx: EditContext): { snap: Snapshot; summary: string } {
  const rules = style.rules;
  const words = allWords(ctx.transcript);
  let tl: Timeline = { ...snap.timeline };
  const did: string[] = [];

  // Start from the clean paragraph cut so switching styles does not stack old silence cuts.
  const fresh = buildInitialTimeline(ctx.transcript, ctx.duration, rules.captions.look, tl.cut);
  tl = { ...tl, tracks: { ...tl.tracks, v1: fresh.tracks.v1, a1: fresh.tracks.a1 } };
  // Drop what an earlier style added automatically; keep everything people or the AI placed by hand.
  const notAuto = <T extends Clip>(c: T) => !(c as Record<string, unknown>).auto;
  tl = { ...tl, tracks: { ...tl.tracks, v2: tl.tracks.v2.filter(notAuto), a2: tl.tracks.a2.filter(notAuto), a3: tl.tracks.a3.filter(notAuto) } };

  if (rules.trimEdges && words.length) {
    const a = Math.max(0, words[0].t - 0.15), b = Math.min(ctx.duration, words[words.length - 1].end + 0.3);
    let v1 = removeRangeFromTrack(tl.tracks.v1, 0, a); v1 = removeRangeFromTrack(v1, b, ctx.duration + 1);
    let a1 = removeRangeFromTrack(tl.tracks.a1, 0, a); a1 = removeRangeFromTrack(a1, b, ctx.duration + 1);
    tl = { ...tl, tracks: { ...tl.tracks, v1, a1 } };
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

  // Zooms follow the kept footage so they land on what people will actually see.
  const zooms: V2Clip[] = [];
  const kept = keptRanges(tl, words);
  const map = makeTimeMap(kept);
  const z = rules.zoom;
  if (z.mode === "newSentence") {
    let lastAt = -99;
    for (const l of linesOutsideCuts(ctx.transcript, tl)) {
      const at = l.start;
      if (map.toOutput(at) - lastAt < 2) continue;
      const end = Math.min(l.end, at + (z.holdSec ?? 1.6));
      if (end - at < 0.3) continue;
      zooms.push(zoomClip(at, end, z.scale, "punch", true));
      lastAt = map.toOutput(at);
    }
  } else if (z.mode === "interval" && map.total > 0) {
    const every = z.everySec ?? 3, hold = z.holdSec ?? Math.min(1.5, every / 2);
    for (let o = every; o < map.total - 0.3; o += every) {
      const a = map.toSource(o), b = map.toSource(Math.min(map.total, o + hold));
      if (b - a > 0.2) zooms.push(zoomClip(a, b, z.scale, "punch", true));
    }
  } else if (z.mode === "slowPush" && kept.length) {
    for (const k of kept) if (k.end - k.start > 1.5) zooms.push(zoomClip(k.start, k.end, z.scale, "push", true));
  } else if (z.mode === "count" && map.total > 0) {
    // Exactly `count` zooms on sentence starts, picked evenly across the edit (evenly spaced moments without speech).
    const n = z.count ?? 3, hold = z.holdSec ?? 1.6;
    const starts: { at: number; end: number }[] = [];
    let lastAt = -99;
    for (const l of linesOutsideCuts(ctx.transcript, tl)) {
      if (map.toOutput(l.start) - lastAt < 1.5) continue;
      starts.push({ at: l.start, end: Math.min(l.end, l.start + hold) });
      lastAt = map.toOutput(l.start);
    }
    const picks = starts.length >= n
      ? Array.from({ length: n }, (_, k) => starts[Math.min(starts.length - 1, Math.floor(((k + 0.5) * starts.length) / n))])
      : Array.from({ length: n }, (_, k) => { const o = (map.total * (k + 0.5)) / n; return { at: map.toSource(o), end: map.toSource(Math.min(map.total, o + hold)) }; });
    for (const p of picks) if (p.end - p.at > 0.2) zooms.push(zoomClip(p.at, p.end, z.scale, "punch", true));
  }
  if (zooms.length) did.push(`added ${zooms.length} ${zooms.length === 1 ? "zoom" : "zooms"}`);
  const sfx = rules.sfxOnZoom ? SFX.find((s) => s.id === rules.sfxOnZoom) : undefined;
  const sfxClips = sfx ? zooms.filter((x) => (x as Record<string, unknown>).mode === "punch").map((x) => ({ id: rid("x"), start: x.start, end: r2(Math.min(ctx.duration, x.start + sfx.seconds)), label: sfx.name, sfxId: sfx.id, assetKey: sfx.key, auto: true })) : [];

  const music = rules.music.mood ? findMusic(rules.music.mood) : undefined;
  const musicClips = music ? [{ id: rid("m"), start: 0, end: r2(ctx.duration), label: music.name, trackId: music.id, assetKey: music.key, gainDb: rules.music.gainDb, auto: true }] : [];
  if (music) did.push(`music ${music.name}`);

  tl = {
    ...tl,
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
  const tl = snap.timeline;
  const words = allWords(ctx.transcript);
  const wordById = new Map(words.map((w) => [w.id, w]));
  switch (op.op) {
    case "replace": {
      // The editor sends the whole timeline. Keep the server's duration: the footage length never changes.
      const next = { ...op.timeline, duration: tl.duration || op.timeline.duration };
      return { snap: { timeline: next, name: op.name ?? snap.name, aspect: (op.aspect ?? snap.aspect) as Aspect, styleId: op.styleId ?? snap.styleId }, summary: "edited in the editor" };
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
        // Exactly this footage range leaves the main cut (picture and dialogue), whether or not anyone speaks in it.
        const before = outputDuration(next, words);
        next = removeFromMainCut(next, range.start, range.end);
        const gone = before - outputDuration(next, words);
        const inside = words.filter((w) => w.t >= range.start && w.end <= range.end).length;
        parts.push(gone > 0.01 ? `cut ${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s (${gone.toFixed(2)}s${inside ? `, ${inside} ${inside === 1 ? "word" : "words"}` : ", no words"})` : `${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s was already out of the edit`);
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
      const pauses = pauseRanges(words, op.overSeconds);
      // Long silences the transcript cannot see (no words at all) come from the audio analysis.
      const fromAudio = ctx.silences.filter((s) => s.end - s.start > op.overSeconds && !words.some((w) => w.t < s.end && w.end > s.start))
        .map((s) => ({ start: r2(s.start + 0.08), end: r2(s.end - 0.08) }));
      const edges = op.edges === false ? [] : clipEdgeSilences(tl, words);
      const ranges = mergeRanges([...pauses, ...fromAudio, ...edges]);
      let next = tl;
      let removed = 0, n = 0;
      const done: Range[] = [];
      const v1Len = (x: Timeline) => x.tracks.v1.reduce((a, c) => a + c.end - c.start, 0);
      for (const g of ranges) {
        const before = v1Len(next);
        next = removeFromMainCut(next, g.start, g.end);
        const diff = before - v1Len(next);
        if (diff > 0.01) { removed += diff; n++; done.push(g); }
      }
      const summary = n === 0 ? `no pauses over ${op.overSeconds}s left to cut` : n === 1 ? `cut ${fmtClock(done[0].start)} to ${fmtClock(done[0].end)} (silence, ${removed.toFixed(1)}s)` : `cut ${n} silences over ${op.overSeconds}s (${removed.toFixed(1)}s total)`;
      return { snap: { ...snap, timeline: next }, summary, count: n };
    }
    case "remove_fillers": {
      const ids = words.filter((w) => w.filler && !tl.cut.includes(w.id)).map((w) => w.id);
      return { snap: { ...snap, timeline: { ...tl, cut: [...tl.cut, ...ids] } }, summary: ids.length ? `removed ${ids.length} filler ${ids.length === 1 ? "word" : "words"}` : "no filler words left to remove", count: ids.length };
    }
    case "set_clips": {
      const clips = op.clips.map((c, i) => ({ ...c, id: c.id || rid(op.track + "_" + i) }));
      let next = withTracks(tl, op.track, clips as Clip[]);
      const other = op.linked === false ? undefined : LINKED_TRACK[op.track];
      if (other) next = withTracks(next, other, clips.map((c, i) => ({ id: rid(other + "_" + i), start: c.start, end: c.end, label: other === "a1" ? "Dialogue" : c.label || "Main" })));
      return { snap: { ...snap, timeline: next }, summary: `set ${clips.length} ${clips.length === 1 ? "clip" : "clips"} on ${op.track.toUpperCase()}${other ? ` and ${other.toUpperCase()}` : ""}` };
    }
    case "split_clip": {
      const r = splitClip(tl, op.track, op.clipId, op.at, { linked: op.linked });
      return { snap: { ...snap, timeline: r.tl }, summary: r.summary };
    }
    case "trim_clip": {
      const r = trimClip(tl, op.track, op.clipId, op.start, op.end, { linked: op.linked });
      return { snap: { ...snap, timeline: r.tl }, summary: r.summary };
    }
    case "delete_clip": {
      const r = deleteClip(tl, op.track, op.clipId, { linked: op.linked });
      return { snap: { ...snap, timeline: r.tl }, summary: r.summary };
    }
    case "set_link": {
      const r = setLink(tl, op.track, op.clipId, op.linked);
      return { snap: { ...snap, timeline: r.tl }, summary: r.summary };
    }
    case "add_zoom": {
      if (!(op.end > op.start)) throw new EditError("A zoom must end after it starts.");
      const z = zoomClip(op.start, op.end, op.scale, op.end - op.start > 4 ? "push" : "punch");
      return { snap: { ...snap, timeline: withTracks(tl, "v2", [...tl.tracks.v2, z]) }, summary: `added zoom at ${fmtClock(op.start)}` };
    }
    case "add_broll": {
      const v = ctx.getVideo?.(op.videoId);
      if (!v) throw new EditError("That b-roll footage is not in your library.");
      if (!v.ready) throw new EditError(`"${v.name}" is not ready yet. Wait until it finishes processing.`);
      if (!(op.end > op.start)) throw new EditError("B-roll must end after it starts.");
      if (op.sourceStart + (op.end - op.start) > v.seconds + 0.05) throw new EditError(`"${v.name}" is only ${v.seconds.toFixed(1)}s long. Pick an earlier sourceStart or a shorter range.`);
      const c: V2Clip = { id: rid("b"), start: r2(op.start), end: r2(op.end), label: op.label || v.name, kind: "broll", videoId: v.id, sourceStart: r2(op.sourceStart) };
      return { snap: { ...snap, timeline: withTracks(tl, "v2", [...tl.tracks.v2, c]) }, summary: `added b-roll ${v.name} at ${fmtClock(op.start)}` };
    }
    case "set_captions": {
      const next = { ...tl, captionsOn: op.on, captionLook: op.look ?? tl.captionLook };
      return { snap: { ...snap, timeline: next }, summary: op.on ? `captions on (${next.captionLook})` : "captions off" };
    }
    case "edit_caption": {
      const line = ctx.transcript.find((l) => l.id === op.lineId);
      if (!line) throw new EditError(`There is no caption line "${op.lineId}".`);
      return { snap: { ...snap, timeline: { ...tl, captionText: { ...tl.captionText, [op.lineId]: op.text } } }, summary: `edited caption at ${fmtClock(line.start)}` };
    }
    case "add_music": {
      const track = findMusic(op.trackId);
      if (!track) throw new EditError(`No music track or mood called "${op.trackId}". Moods: ${Array.from(new Set(MUSIC_TRACKS.map((m) => m.mood))).join(", ")}.`);
      const start = op.start ?? 0, end = op.end ?? tl.duration;
      const clip = { id: rid("m"), start: r2(start), end: r2(end), label: track.name, trackId: track.id, assetKey: track.key, gainDb: op.gainDb ?? -18 };
      // A full-length bed replaces the old one; a ranged clip is added next to what is there.
      const a2 = op.start == null && op.end == null ? [clip] : [...tl.tracks.a2.filter((c) => c.end <= start || c.start >= end), clip];
      return { snap: { ...snap, timeline: withTracks(tl, "a2", a2) }, summary: `added music: ${track.name}` };
    }
    case "add_graphic": {
      const g = ctx.getGraphic?.(op.graphicId);
      if (!g) throw new EditError("That graphic does not exist. Use list_graphics to see the ids.");
      if (!(op.end > op.start)) throw new EditError("A graphic must end after it starts.");
      const c = { id: rid("g"), start: r2(op.start), end: r2(op.end), label: op.label || g.name, kind: "graphic" as const, graphicId: g.id, params: op.params };
      return { snap: { ...snap, timeline: withTracks(tl, "v3", [...tl.tracks.v3, c]) }, summary: `added graphic ${g.name} at ${fmtClock(op.start)}` };
    }
    case "set_aspect":
      return { snap: { ...snap, aspect: op.aspect }, summary: `changed shape to ${op.aspect}` };
    case "rename":
      return { snap: { ...snap, name: op.name }, summary: `renamed the edit to "${op.name}"` };
    case "apply_style": {
      const style = ctx.getStyle(op.styleId);
      if (!style) throw new EditError("That style does not exist. Use list_styles to see the ids.");
      return applyStyleRules(snap, op.overrides ? { ...style, rules: mergeRules(style.rules, op.overrides) } : style, ctx);
    }
    case "restore_snapshot":
      return { snap: op.snapshot, summary: op.note };
    case "batch": {
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
  }
}

export function applyOp(snap: Snapshot, op: Op, ctx: EditContext): { snap: Snapshot; summary: string } {
  const r = applyOpInner(snap, op, ctx);
  const timeline = normalizeTimeline(r.snap.timeline);
  const parsed = TimelineSchema.safeParse(timeline);
  if (!parsed.success) throw new EditError("That change would break the timeline: " + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  const problems = timelineProblems(timeline);
  if (problems.length) throw new EditError(problems.slice(0, 3).join(" "));
  return { snap: { ...r.snap, timeline: layoutTimeline(timeline, allWords(ctx.transcript), ctx.videoId) }, summary: r.summary };
}

// ---------------------------------------------------------------------------------------------
// Small text summary of a project for the AI (get_project). Kept well under 8k tokens.
// ---------------------------------------------------------------------------------------------
export function summarizeTimeline(snap: Snapshot, tr: Transcript, maxPerTrack = 60): string {
  const words = allWords(tr);
  const tl = layoutTimeline(snap.timeline, words);
  const out = outputDuration(tl, words);
  const lines: string[] = [];
  lines.push(`Footage length ${tl.duration.toFixed(1)}s, edit length ${out.toFixed(1)}s, aspect ${snap.aspect}, style ${snap.styleId}.`);
  lines.push(`Cut words: ${tl.cut.length}. Captions ${tl.captionsOn ? "on (" + tl.captionLook + ")" : "off"}. Edited caption lines: ${Object.entries(tl.captionText).filter(([id, txt]) => { const l = tr.find((x) => x.id === id); return l && l.words.map((w) => w.text).join(" ") !== txt; }).length}.`);
  lines.push("Each clip: id footageStart-footageEnd @editStart-editEnd (edit = the output; ops take footage seconds). Linked V1/A1 pairs edit together.");
  const names: Record<TrackName, string> = { v1: "V1 main cut", v2: "V2 b-roll/zooms", v3: "V3 titles", a1: "A1 dialogue", a2: "A2 music", a3: "A3 sfx" };
  for (const k of Object.keys(names) as TrackName[]) {
    let clips = tl.tracks[k] as Clip[];
    if (k === "v3") clips = clips.filter((c) => (c as Record<string, unknown>).kind === "graphic");
    const shown = clips.slice(0, maxPerTrack).map((c) => {
      const x = c as Record<string, unknown>;
      const extra = x.kind === "zoom" ? ` x${x.zoom}` : x.kind === "broll" ? ` video=${x.videoId}@${x.sourceStart}` : x.graphicId ? ` graphic=${x.graphicId}` : x.trackId ? ` track=${x.trackId} ${x.gainDb ?? -18}dB` : x.sfxId ? ` sfx=${x.sfxId}` : "";
      const at = Number(x.timelineEnd) > Number(x.timelineStart) ? ` @${Number(x.timelineStart).toFixed(2)}-${Number(x.timelineEnd).toFixed(2)}` : " (not in the edit)";
      const link = x.linkId ? "" : (k === "v1" || k === "a1") && x.unlinked ? " unlinked" : "";
      return `  ${c.id} ${c.start.toFixed(2)}-${c.end.toFixed(2)}${at} "${c.label}"${extra}${link}`;
    });
    const more = clips.length > maxPerTrack ? `\n  …and ${clips.length - maxPerTrack} more` : "";
    lines.push(`${names[k]}${k === "v3" ? " (graphics only; caption clips follow transcript lines)" : ""}: ${clips.length ? "\n" + shown.join("\n") + more : "empty"}`);
  }
  return lines.join("\n");
}
