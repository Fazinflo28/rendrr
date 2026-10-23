// The timeline logic, in one place: what plays, where every clip lands in the edit, and the clip edits. The
// connector's ops, the render plan, the after-render check and the editor all go through this module.
// See docs/timeline-model.md.
//
// Model B ("sequence", from Phase 2, second half of this file): V1 is an ordered list of clips from any video, played
// back to back; each V1 clip's dialogue follows its picture, with J/L offsets; other tracks hang on a V1 clip.
//
// Model A (stored before Phase 2, read by the conversion toModelB and the legacy planner): clip start/end are
// seconds in the project's ORIGINAL footage. V1 is magnetic: its clips play
// in footage order, minus cut words, with no gaps, so ripple is automatic. The other tracks are pinned to moments
// in the footage and move with them. Every clip also carries these fields, rewritten here after each change:
//   sourceVideoId, sourceIn, sourceOut   the video it plays and its in/out in that video (V1/A1: the footage;
//                                         b-roll: its own video). Clips that play no video (captions, zooms,
//                                         graphics, music, sound effects): the footage moment they are pinned to.
//   timelineStart, timelineEnd            its place in the edit, in edit seconds (equal = not in the edit)
//   linkId                                 shared by a V1 clip and its A1 dialogue while they are linked
import { isCaptionMarker, normalizeTimeline, TRACK_NAMES, type Clip, type Framing, type Rotation, type Timeline, type TrackName } from "./timeline";
import type { Word } from "./transcript";

export type Range = { start: number; end: number };

export class EditError extends Error {
  friendly = true;
  constructor(message: string) { super(message); }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const rid = (prefix: string) => prefix + Math.random().toString(36).slice(2, 7);
export const fmtClock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

// ---------------------------------------------------------------------------------------------
// Cut maths. cutRegions() is the same logic as the editor's cutRegions in ui/rendrr-ui.html:
// a cut word removes [word.t, nextWord.t), adjacent cut words merge into one region.
// ---------------------------------------------------------------------------------------------
export function cutRegions(words: Word[], cutSet: Set<string>): Range[] {
  const r: Range[] = [];
  words.forEach((w, i) => {
    if (!cutSet.has(w.id)) return;
    // The last word has no next word: cut to its own end (at least 0.35 s, as in the UI).
    const end = words[i + 1] ? words[i + 1].t : Math.max(w.t + 0.35, w.end || 0);
    const last = r[r.length - 1];
    if (last && Math.abs(last.end - w.t) < 0.01) last.end = end;
    else r.push({ start: w.t, end });
  });
  return r;
}

export function mergeRanges(ranges: Range[]): Range[] {
  const s = ranges.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end + 1e-6) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

export function subtractRanges(keep: Range[], remove: Range[]): Range[] {
  let cur = mergeRanges(keep);
  for (const rm of mergeRanges(remove)) {
    const next: Range[] = [];
    for (const k of cur) {
      if (rm.end <= k.start || rm.start >= k.end) { next.push(k); continue; }
      if (rm.start > k.start) next.push({ start: k.start, end: rm.start });
      if (rm.end < k.end) next.push({ start: rm.end, end: k.end });
    }
    cur = next;
  }
  return cur.filter((k) => k.end - k.start >= 0.04);
}

/** Source ranges that end up in the output: V1 clips minus cut words. */
export function keptRanges(timeline: Timeline, words: Word[]): Range[] {
  const v1 = timeline.tracks.v1.map((c) => ({ start: c.start, end: c.end }));
  return subtractRanges(v1, cutRegions(words, new Set(timeline.cut)));
}

/** Maps a source time onto the output timeline. Times inside a removed part snap to the next kept moment. */
export function makeTimeMap(kept: Range[]) {
  const offsets: number[] = [];
  let acc = 0;
  for (const k of kept) { offsets.push(acc); acc += k.end - k.start; }
  const total = acc;
  const toOutput = (src: number): number => {
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      if (src < k.start) return offsets[i];
      if (src <= k.end) return offsets[i] + (src - k.start);
    }
    return total;
  };
  const toSource = (out: number): number => {
    for (let i = 0; i < kept.length; i++) {
      const len = kept[i].end - kept[i].start;
      if (out <= offsets[i] + len) return kept[i].start + Math.max(0, out - offsets[i]);
    }
    return kept.length ? kept[kept.length - 1].end : 0;
  };
  return { toOutput, toSource, total };
}

/** The edit's length in seconds (either model). */
export function outputDuration(timeline: Timeline, words: Word[]) {
  if (isSequence(timeline)) return sequenceView(timeline, words).total;
  return keptRanges(timeline, words).reduce((a, k) => a + (k.end - k.start), 0);
}

// ---------------------------------------------------------------------------------------------
// Links: a V1 clip and its A1 dialogue are linked while they cover the same footage, unless one was unlinked.
// ---------------------------------------------------------------------------------------------
export const LINKED_TRACK: Partial<Record<TrackName, TrackName>> = { v1: "a1", a1: "v1" };
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
const unlinked = (c: Clip) => !!(c as Record<string, unknown>).unlinked;

export function linkedPartner(tl: Timeline, track: TrackName, clip: Clip): { track: TrackName; clip: Clip } | null {
  const other = LINKED_TRACK[track];
  if (!other || unlinked(clip)) return null;
  const c = (tl.tracks[other] as Clip[]).find((x) => !unlinked(x) && near(x.start, clip.start) && near(x.end, clip.end));
  return c ? { track: other, clip: c } : null;
}

/** Where A1 does not follow V1 (in footage seconds): kept V1 with no dialogue (muted), and A1 outside V1 (unused). */
export function dialogueMismatch(tl: Timeline, words: Word[]): { muted: Range[]; unused: Range[] } {
  const kept = keptRanges(tl, words);
  const a1 = mergeRanges(tl.tracks.a1.map((c) => ({ start: c.start, end: c.end })));
  const v1 = mergeRanges(tl.tracks.v1.map((c) => ({ start: c.start, end: c.end })));
  return { muted: subtractRanges(kept, a1).filter((r) => r.end - r.start >= 0.1), unused: subtractRanges(a1, v1).filter((r) => r.end - r.start >= 0.1) };
}

// ---------------------------------------------------------------------------------------------
// Layout: every clip's place in the edit and the media it plays. Model A derives both from the clip's footage
// times; they are stored so the player can draw from them and a sequence model can start from them.
// ---------------------------------------------------------------------------------------------
export const LAYOUT_FIELDS = ["sourceVideoId", "sourceIn", "sourceOut", "timelineStart", "timelineEnd", "linkId"] as const;
const withoutLayout = (c: Clip): Clip => { const x = { ...c } as Record<string, unknown>; for (const k of LAYOUT_FIELDS) delete x[k]; return x as Clip; };

export function layoutTimeline(tl: Timeline, words: Word[], mainVideoId = "main"): Timeline {
  if (isSequence(tl)) return layoutSequence(tl, words);
  const map = makeTimeMap(keptRanges(tl, words));
  const tracks = {} as Timeline["tracks"];
  for (const k of TRACK_NAMES) {
    (tracks as Record<string, Clip[]>)[k] = (tl.tracks[k] as Clip[]).map((c) => {
      const x = withoutLayout(c) as Clip & Record<string, unknown>;
      const broll = k === "v2" && x.kind === "broll" && typeof x.videoId === "string";
      const sIn = broll ? Number(x.sourceStart ?? 0) : c.start;
      const partner = linkedPartner(tl, k, c);
      return {
        ...x,
        sourceVideoId: broll ? (x.videoId as string) : mainVideoId,
        sourceIn: r2(sIn), sourceOut: r2(sIn + c.end - c.start),
        timelineStart: r2(map.toOutput(c.start)), timelineEnd: r2(map.toOutput(c.end)),
        ...(partner ? { linkId: `lk_${k === "v1" ? c.id : partner.clip.id}` } : {}),
      } as Clip;
    });
  }
  return { ...tl, tracks };
}

/** The timeline without the derived fields: what an edit actually decides. */
export function stripLayout(tl: Timeline): Timeline {
  const tracks = {} as Timeline["tracks"];
  // Model B: the source fields decide the edit; only the edit positions shown in the timeline and links are derived.
  const strip = isSequence(tl) ? (c: Clip) => { const x = { ...c } as Record<string, unknown>; delete x.timelineStart; delete x.timelineEnd; delete x.linkId; return x as Clip; } : withoutLayout;
  for (const k of TRACK_NAMES) (tracks as Record<string, Clip[]>)[k] = (tl.tracks[k] as Clip[]).map(strip);
  return { ...tl, tracks };
}

// ---------------------------------------------------------------------------------------------
// Clip edits. Linked V1/A1 clips change together unless `linked` is false. V1 has no gaps in the output by
// construction, so removing or shortening a V1 clip closes up the edit (ripple).
// ---------------------------------------------------------------------------------------------
export function removeRangeFromTrack(clips: Clip[], a: number, b: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if (b <= c.start || a >= c.end) { out.push(c); continue; }
    if (a - c.start >= 0.15) out.push({ ...c, end: r2(a) });
    if (c.end - b >= 0.15) out.push({ ...c, id: c.id.split("_")[0] + "_" + Math.random().toString(36).slice(2, 6), start: r2(b) });
  }
  return out;
}

export function findClip(tl: Timeline, track: TrackName, clipId: string) {
  const c = (tl.tracks[track] as Clip[]).find((x) => x.id === clipId);
  if (!c) throw new EditError(`There is no clip "${clipId}" on ${track.toUpperCase()}. Read the project again to get the current clip ids.`);
  return c;
}

export function withTracks(tl: Timeline, track: TrackName, clips: Clip[]): Timeline {
  return { ...tl, tracks: { ...tl.tracks, [track]: clips } } as Timeline;
}

type EditResult = { tl: Timeline; summary: string };
const alsoLinked = (p: { track: TrackName } | null) => (p ? ` (and its linked ${p.track === "a1" ? "dialogue" : "picture"})` : "");

function splitOne(tl: Timeline, track: TrackName, c: Clip, at: number): { tl: Timeline; newId: string } {
  const ids = new Set((tl.tracks[track] as Clip[]).map((x) => x.id));
  let newId = rid(track + "_");
  while (ids.has(newId)) newId = rid(track + "_");
  const label2 = /\(2\)$/.test(c.label) ? c.label : (c.label ? c.label + " (2)" : "");
  const clips = (tl.tracks[track] as Clip[]).flatMap((x) => (x.id !== c.id ? [x] : [{ ...x, end: r2(at) }, { ...x, id: newId, start: r2(at), label: label2 }]));
  return { tl: withTracks(tl, track, clips), newId };
}

export function splitClip(tl: Timeline, track: TrackName, clipId: string, at: number, opts: { linked?: boolean } = {}): EditResult {
  const c = findClip(tl, track, clipId);
  if (!(at > c.start + 0.05 && at < c.end - 0.05)) throw new EditError(`Split time ${at}s must be inside the clip (${c.start}s to ${c.end}s).`);
  const partner = opts.linked === false ? null : linkedPartner(tl, track, c);
  const a = splitOne(tl, track, c, at);
  const b = partner ? splitOne(a.tl, partner.track, partner.clip, at) : null;
  return { tl: b ? b.tl : a.tl, summary: `split ${c.label || c.id} at ${fmtClock(at)} (second half is clip ${a.newId}${b ? `; its linked ${partner!.track === "a1" ? "dialogue" : "picture"} too, clip ${b.newId}` : ""})` };
}

export function trimClip(tl: Timeline, track: TrackName, clipId: string, start: number, end: number, opts: { linked?: boolean } = {}): EditResult {
  const c = findClip(tl, track, clipId);
  if (!(end > start)) throw new EditError("The new end must be after the new start.");
  const partner = opts.linked === false ? null : linkedPartner(tl, track, c);
  const set = (t: Timeline, k: TrackName, id: string) => withTracks(t, k, (t.tracks[k] as Clip[]).map((x) => (x.id === id ? { ...x, start: r2(start), end: r2(end) } : x)));
  let next = set(tl, track, c.id);
  if (partner) next = set(next, partner.track, partner.clip.id);
  return { tl: next, summary: `trimmed ${c.label || c.id} to ${fmtClock(start)}–${fmtClock(end)}${alsoLinked(partner)}` };
}

export function deleteClip(tl: Timeline, track: TrackName, clipId: string, opts: { linked?: boolean } = {}): EditResult {
  const c = findClip(tl, track, clipId);
  const partner = opts.linked === false ? null : linkedPartner(tl, track, c);
  let next = withTracks(tl, track, (tl.tracks[track] as Clip[]).filter((x) => x.id !== c.id));
  if (partner) next = withTracks(next, partner.track, (next.tracks[partner.track] as Clip[]).filter((x) => x.id !== partner.clip.id));
  return { tl: next, summary: `removed ${c.label || "a clip"} from ${track.toUpperCase()}${alsoLinked(partner)}` };
}

/** Unlinks a V1 clip from its A1 dialogue (they then edit separately), or links it again to the clip it lines up with. */
export function setLink(tl: Timeline, track: TrackName, clipId: string, linked: boolean): EditResult {
  const c = findClip(tl, track, clipId);
  const other = LINKED_TRACK[track];
  if (!other) throw new EditError(`Only V1 and A1 clips link (picture and its dialogue); ${track.toUpperCase()} clips edit on their own.`);
  const mate = (tl.tracks[other] as Clip[]).find((x) => near(x.start, c.start) && near(x.end, c.end));
  if (!mate) {
    if (!linked) return { tl, summary: `${c.label || c.id} was not linked` };
    throw new EditError(`No ${other.toUpperCase()} clip lines up with ${c.label || c.id} (same start and end), so there is nothing to link it to. Trim them to match first.`);
  }
  const set = (t: Timeline, k: TrackName, id: string) => withTracks(t, k, (t.tracks[k] as Clip[]).map((x) => {
    if (x.id !== id) return x;
    const { unlinked: _u, ...rest } = x as Clip & { unlinked?: boolean };
    return (linked ? rest : { ...rest, unlinked: true }) as Clip;
  }));
  return { tl: set(set(tl, track, c.id), other, mate.id), summary: `${linked ? "linked" : "unlinked"} ${c.label || c.id} and its ${other === "a1" ? "dialogue" : "picture"}` };
}

/** Removes a footage range from the main cut (V1 and its A1 dialogue together), closing the gap in the edit. */
export function removeFromMainCut(tl: Timeline, a: number, b: number): Timeline {
  return { ...tl, tracks: { ...tl.tracks, v1: removeRangeFromTrack(tl.tracks.v1, a, b), a1: removeRangeFromTrack(tl.tracks.a1, a, b) } };
}

// =============================================================================================
// Model B: the sequence.
//
//   V1          an ordered list of clips: sourceVideoId, sourceIn, sourceOut (seconds in that video). They play back
//               to back in list order, so the edit never has gaps and every change ripples by itself. The same
//               footage may play twice, and clips may come from several videos. Cut words (main footage only) are
//               left out of main-footage clips, as in model A.
//   dialogue    each V1 clip's sound plays its own footage in sync with its picture. audioStart on a clip moves the
//               cut between its sound and the sound before it: < 0 its sound starts that much before its picture
//               (J cut), > 0 the clip before is heard that much into it (L cut). audioMuted: no sound.
//               A1 is written from this by the layout, one clip per V1 clip (same id).
//   other tracks V2, V3 graphics, A2, A3 hang on a V1 clip at a moment of its footage (anchorId, anchorAt) and keep
//               their length in the edit (length), so they move with their clip. fill: a music bed under the whole
//               edit. V3 caption clips only say which transcript lines show captions.
//   start/end   on every clip: edit seconds, written by the layout (with timelineStart/timelineEnd and linkId).
//   rotate, framing   per V1 clip.
// =============================================================================================
export type SeqClip = Clip & { sourceVideoId: string; sourceIn: number; sourceOut: number; audioStart?: number; audioMuted?: boolean; rotate?: Rotation; framing?: Framing };
export type Attached = Clip & { anchorId?: string; anchorAt?: number; length?: number; fill?: boolean };

export const isSequence = (tl: Timeline) => tl.model === "B";
export const mainVideoOf = (tl: Timeline) => tl.mainVideoId || "main";
/** The tracks whose clips hang on a V1 clip (V3 caption clips excepted). */
export const ATTACHED_TRACKS: TrackName[] = ["v2", "v3", "a2", "a3"];
export const isAttached = (track: TrackName, c: Clip) => ATTACHED_TRACKS.includes(track) && !isCaptionMarker(track, c);

/** Part of one V1 clip that plays, in its video and in the edit. */
export type Piece = { clipId: string; videoId: string; srcIn: number; srcOut: number; start: number; end: number };
/** A stretch of picture with no cut in it (it may span several clips whose footage continues). */
export type PicturePart = { videoId: string; srcIn: number; srcOut: number; start: number; end: number; rotate: Rotation; framing: Framing | null; clipIds: string[] };
/** A stretch of dialogue: its video and footage; muted parts keep their footage (captions follow them) but are silent. */
export type SoundPart = { videoId: string; srcIn: number; srcOut: number; start: number; end: number; muted: boolean; clipId: string };
export type ClipPlace = { id: string; videoId: string; start: number; end: number; pieces: Piece[]; soundStart: number; soundEnd: number };

export type ViewOpts = {
  /** Frames per second: every part starts and ends on a frame of the output (the render plan uses 30). */
  align?: number;
  /** Each video's length in seconds: footage past its end is left out. */
  seconds?: Record<string, number>;
};

export type SequenceView = {
  mainVideoId: string;
  clips: ClipPlace[];
  pieces: Piece[];
  picture: PicturePart[];
  sound: SoundPart[];
  total: number;
  clip(id: string): ClipPlace | undefined;
  /** The piece playing at edit time t (the last one at the very end). */
  pieceAt(t: number): Piece | null;
  /** Where a clip placed at edit time t hangs: the V1 clip playing then, and the footage moment. */
  anchorFor(t: number): { anchorId: string; anchorAt: number } | null;
  /** Edit time of a footage moment of a V1 clip; a moment that does not play snaps to the next one that does. */
  editAt(clipId: string, src: number): number | null;
  /** Edit time of a footage moment of a video, where it first plays (else the next moment that plays). */
  videoToEdit(videoId: string, src: number): number | null;
  /** The footage moment of a V1 clip at edit time t (beyond the clip: its footage continued). */
  editToSource(clipId: string, t: number): number;
};

const sameFraming = (a?: Framing | null, b?: Framing | null) => (!a && !b) || (!!a && !!b && a.scale === b.scale && a.x === b.x && a.y === b.y);
export const plainFraming = (f?: Framing | null): Framing | null => (!f || (f.scale === 1 && f.x === 0 && f.y === 0) ? null : f);
const sameLook = (a: SeqClip, b: SeqClip) => (a.rotate ?? 0) === (b.rotate ?? 0) && sameFraming(plainFraming(a.framing), plainFraming(b.framing));

/** Cuts ranges out of ranges, keeping every leftover however short (the caller decides what is too short). */
function cutOut(keep: Range[], remove: Range[]): Range[] {
  let cur = keep.map((k) => ({ ...k }));
  for (const rm of remove) {
    const next: Range[] = [];
    for (const k of cur) {
      if (rm.end <= k.start || rm.start >= k.end) { next.push(k); continue; }
      if (rm.start > k.start) next.push({ start: k.start, end: rm.start });
      if (rm.end < k.end) next.push({ start: rm.end, end: k.end });
    }
    cur = next;
  }
  return cur;
}

export function sequenceView(tl: Timeline, words: Word[], opts: ViewOpts = {}): SequenceView {
  const main = mainVideoOf(tl);
  const v1 = tl.tracks.v1 as SeqClip[];
  const cuts = mergeRanges(cutRegions(words, new Set(tl.cut)));
  const fps = opts.align;
  const lenOf = (vid: string) => opts.seconds?.[vid];

  // 1. What each clip keeps: its footage minus cut words (main footage) and anything past the video's end.
  type Raw = { clip: SeqClip; srcIn: number; srcOut: number };
  const raws: Raw[] = [];
  for (const c of v1) {
    let rs: Range[] = [{ start: c.sourceIn, end: c.sourceOut }];
    if (c.sourceVideoId === main && cuts.length) rs = cutOut(rs, cuts);
    const len = lenOf(c.sourceVideoId);
    if (len != null) rs = cutOut(rs, [{ start: len, end: Infinity }]);
    for (const r of rs) if (r.end - r.start > 1e-6) raws.push({ clip: c, srcIn: r.start, srcOut: r.end });
  }

  // 2. Parts: footage that continues (same video, same turn and framing) plays as one part, so the picture only cuts
  // where it really jumps. Parts under 0.04 s are dropped, as in model A.
  type P = { videoId: string; srcIn: number; srcOut: number; look: SeqClip; raws: Raw[] };
  const join = (list: P[], p: P) => {
    const last = list[list.length - 1];
    if (last && last.videoId === p.videoId && Math.abs(p.srcIn - last.srcOut) <= 1e-6 && sameLook(last.look, p.look)) { last.srcOut = p.srcOut; last.raws.push(...p.raws); }
    else list.push(p);
  };
  let parts: P[] = [];
  for (const r of raws) join(parts, { videoId: r.clip.sourceVideoId, srcIn: r.srcIn, srcOut: r.srcOut, look: r.clip, raws: [r] });
  parts = parts.filter((p) => p.srcOut - p.srcIn >= 0.04);
  if (fps) {
    // Every part starts and ends on a frame, so the picture and the sound of each part are exactly as long as planned.
    const f = (x: number) => Math.round(x * fps) / fps;
    const aligned: P[] = [];
    for (const p of parts) {
      const len = lenOf(p.videoId);
      const a = f(p.srcIn), b = Math.min(f(p.srcOut), len != null ? Math.floor(len * fps) / fps : Infinity);
      if (b - a >= 1 / fps - 1e-9) join(aligned, { ...p, srcIn: a, srcOut: b, raws: [...p.raws] });
    }
    parts = aligned;
  }

  // 3. Edit times.
  let acc = 0;
  const picture: PicturePart[] = [];
  const pieces: Piece[] = [];
  for (const p of parts) {
    const start = acc;
    acc += p.srcOut - p.srcIn;
    picture.push({ videoId: p.videoId, srcIn: p.srcIn, srcOut: p.srcOut, start, end: acc, rotate: (p.look.rotate ?? 0) as Rotation, framing: plainFraming(p.look.framing), clipIds: Array.from(new Set(p.raws.map((r) => r.clip.id))) });
    p.raws.forEach((r, j) => {
      const a = j === 0 ? p.srcIn : Math.max(r.srcIn, p.srcIn), b = j === p.raws.length - 1 ? p.srcOut : Math.min(r.srcOut, p.srcOut);
      if (b - a > 1e-9) pieces.push({ clipId: r.clip.id, videoId: p.videoId, srcIn: a, srcOut: b, start: start + (a - p.srcIn), end: start + (b - p.srcIn) });
    });
  }
  const total = acc;

  // 4. Each clip's place. A clip with nothing left sits where it would play, with no length.
  const piecesOf = new Map<string, Piece[]>();
  for (const x of pieces) { const l = piecesOf.get(x.clipId); if (l) l.push(x); else piecesOf.set(x.clipId, [x]); }
  const clips: ClipPlace[] = [];
  let cursor = 0;
  for (const c of v1) {
    const ps = piecesOf.get(c.id) || [];
    const start = ps.length ? ps[0].start : cursor, end = ps.length ? ps[ps.length - 1].end : cursor;
    cursor = end;
    clips.push({ id: c.id, videoId: c.sourceVideoId, start, end, pieces: ps, soundStart: start, soundEnd: end });
  }

  // 5. Dialogue. The cut between two clips' sounds sits at the picture cut moved by audioStart. It never passes the
  // picture cut before or after it, and never reaches outside the footage.
  const clipById = new Map(v1.map((c) => [c.id, c]));
  const live = clips.filter((c) => c.pieces.length);
  const D: number[] = [];
  for (let k = 0; k < live.length; k++) {
    if (k === 0) { D.push(0); continue; }
    const cur = live[k], prev = live[k - 1];
    let off = Number(clipById.get(cur.id)!.audioStart || 0);
    if (fps) off = Math.round(off * fps) / fps;
    let d = cur.start + off;
    d = Math.max(d, cur.start - cur.pieces[0].srcIn); // a J cut can only use footage that exists
    const prevLen = lenOf(prev.videoId) ?? (prev.videoId === main ? tl.duration : undefined);
    if (prevLen != null) d = Math.min(d, cur.start + Math.max(0, prevLen - prev.pieces[prev.pieces.length - 1].srcOut));
    D.push(Math.min(Math.max(d, prev.start, D[k - 1]), cur.end));
  }
  const sound: SoundPart[] = [];
  const pushSound = (s: SoundPart) => {
    if (s.end - s.start <= 1e-9) return;
    const last = sound[sound.length - 1];
    if (last && last.videoId === s.videoId && last.muted === s.muted && Math.abs(last.srcOut - s.srcIn) <= 1e-6 && Math.abs(last.end - s.start) <= 1e-6) { last.srcOut = s.srcOut; last.end = s.end; }
    else sound.push({ ...s });
  };
  live.forEach((pl, k) => {
    const a = D[k], b = k + 1 < live.length ? D[k + 1] : total;
    pl.soundStart = a; pl.soundEnd = b;
    const muted = !!clipById.get(pl.id)!.audioMuted;
    const first = pl.pieces[0], last = pl.pieces[pl.pieces.length - 1];
    if (a < pl.start) pushSound({ videoId: pl.videoId, srcIn: first.srcIn - (pl.start - a), srcOut: first.srcIn, start: a, end: pl.start, muted, clipId: pl.id });
    for (const x of pl.pieces) {
      const s = Math.max(a, x.start), e = Math.min(b, x.end);
      if (e > s) pushSound({ videoId: x.videoId, srcIn: x.srcIn + (s - x.start), srcOut: x.srcIn + (e - x.start), start: s, end: e, muted, clipId: pl.id });
    }
    if (b > pl.end) pushSound({ videoId: pl.videoId, srcIn: last.srcOut, srcOut: last.srcOut + (b - pl.end), start: pl.end, end: b, muted, clipId: pl.id });
  });

  const byClip = new Map(clips.map((c) => [c.id, c]));
  const pieceAt = (t: number): Piece | null => {
    if (!pieces.length) return null;
    let lo = 0, hi = pieces.length - 1;
    if (t >= pieces[hi].start) return pieces[hi];
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pieces[mid].start <= t) lo = mid; else hi = mid - 1; }
    return pieces[lo];
  };
  return {
    mainVideoId: main, clips, pieces, picture, sound, total,
    clip: (id) => byClip.get(id),
    pieceAt,
    anchorFor(t) {
      const tt = Math.max(0, Math.min(t, total));
      const p = pieceAt(tt);
      return p ? { anchorId: p.clipId, anchorAt: Math.round((p.srcIn + Math.min(Math.max(0, tt - p.start), p.end - p.start)) * 1000) / 1000 } : null;
    },
    editAt(clipId, src) {
      const c = byClip.get(clipId);
      if (!c) return null;
      if (!c.pieces.length) return c.start;
      for (const p of c.pieces) { if (src < p.srcIn) return p.start; if (src <= p.srcOut) return p.start + (src - p.srcIn); }
      return c.end;
    },
    videoToEdit(videoId, src) {
      let next: Piece | null = null, furthest: Piece | null = null;
      for (const p of pieces) {
        if (p.videoId !== videoId) continue;
        if (src >= p.srcIn && src <= p.srcOut) return p.start + (src - p.srcIn);
        if (p.srcIn > src && (!next || p.srcIn < next.srcIn)) next = p;
        if (!furthest || p.srcOut > furthest.srcOut) furthest = p;
      }
      return next ? next.start : furthest ? furthest.end : null;
    },
    editToSource(clipId, t) {
      const c = byClip.get(clipId), clip = clipById.get(clipId);
      if (!c || !clip) return 0;
      if (!c.pieces.length) return clip.sourceIn + Math.max(0, t - c.start);
      if (t <= c.start) return c.pieces[0].srcIn - (c.start - t);
      for (const p of c.pieces) if (t <= p.end) return p.srcIn + Math.max(0, t - p.start);
      return c.pieces[c.pieces.length - 1].srcOut + (t - c.end);
    },
  };
}

/** Writes every clip's place in the edit (start/end, timelineStart/timelineEnd), the links and A1 (model B). */
function layoutSequence(tl: Timeline, words: Word[]): Timeline {
  const view = sequenceView(tl, words);
  const main = view.mainVideoId;
  const at = (s: number, e: number) => ({ start: r2(s), end: r2(Math.max(s, e)), timelineStart: r2(s), timelineEnd: r2(Math.max(s, e)) });
  const v1 = (tl.tracks.v1 as SeqClip[]).map((c) => { const p = view.clip(c.id)!; return { ...c, ...at(p.start, p.end), linkId: `lk_${c.id}` }; });
  const byId = new Map(v1.map((c) => [c.id, c]));
  const a1 = view.clips.filter((p) => p.pieces.length && p.soundEnd - p.soundStart > 0.005).map((p) => {
    const c = byId.get(p.id)!;
    const sIn = p.soundStart < p.start ? p.pieces[0].srcIn - (p.start - p.soundStart) : view.editToSource(p.id, p.soundStart);
    const sOut = p.soundEnd > p.end ? p.pieces[p.pieces.length - 1].srcOut + (p.soundEnd - p.end) : view.editToSource(p.id, p.soundEnd);
    return { id: p.id, label: "Dialogue", ...at(p.soundStart, p.soundEnd), sourceVideoId: p.videoId, sourceIn: r2(sIn), sourceOut: r2(sOut), linkId: `lk_${p.id}`, ...(c.audioMuted ? { audioMuted: true } : {}) } as Clip;
  });
  const tracks = { ...tl.tracks, v1, a1 } as Timeline["tracks"];
  for (const k of ATTACHED_TRACKS) {
    (tracks as Record<string, Clip[]>)[k] = (tl.tracks[k] as Attached[]).map((c) => {
      const x = { ...c } as Attached & Record<string, unknown>;
      if (isCaptionMarker(k, c)) {
        // A caption clip covers its transcript line where the line first plays.
        const sIn = Number(x.sourceIn ?? c.start), sOut = Number(x.sourceOut ?? c.end);
        const s = view.videoToEdit(main, sIn) ?? 0, e = view.videoToEdit(main, sOut) ?? s;
        return { ...x, sourceVideoId: main, sourceIn: r2(sIn), sourceOut: r2(sOut), ...at(s, e) } as Clip;
      }
      let s: number, len: number;
      if (x.fill) { s = 0; len = view.total; }
      else if (x.anchorId && view.clip(x.anchorId)) {
        s = view.editAt(x.anchorId, Number(x.anchorAt ?? 0)) ?? 0;
        len = Number(x.length ?? c.end - c.start);
      } else {
        // Not attached yet (a clip placed by its edit times): it hangs on the V1 clip playing at its start.
        s = c.start; len = c.end - c.start;
        const a = view.anchorFor(s);
        if (a) { x.anchorId = a.anchorId; x.anchorAt = r2(a.anchorAt); x.length = r2(len); }
      }
      const broll = k === "v2" && x.kind === "broll" && typeof x.videoId === "string";
      const anchor = x.anchorId ? v1.find((v) => v.id === x.anchorId) : undefined;
      const src = broll
        ? { sourceVideoId: x.videoId as string, sourceIn: r2(Number(x.sourceStart ?? 0)), sourceOut: r2(Number(x.sourceStart ?? 0) + len) }
        : anchor ? { sourceVideoId: anchor.sourceVideoId, sourceIn: r2(Number(x.anchorAt ?? 0)), sourceOut: r2(Number(x.anchorAt ?? 0) + len) } : {};
      return { ...x, ...src, ...at(s, s + len) } as Clip;
    }).sort((a, b) => a.start - b.start); // stable: clips starting together keep their order (overlays stack in it)
  }
  return { ...tl, tracks };
}

/** The sequence is a plain cut of the main footage: footage order, no repeats, no J/L or muted clips, one look. */
export function isPlainSequence(tl: Timeline): boolean {
  const v1 = tl.tracks.v1 as SeqClip[];
  const main = mainVideoOf(tl);
  return v1.every((c, i) => c.sourceVideoId === main && !c.audioStart && !c.audioMuted && sameLook(c, v1[0]) && (i === 0 || c.sourceIn >= v1[i - 1].sourceOut - 1e-6));
}

// ---------------------------------------------------------------------------------------------
// A -> B. The sequence plays exactly what model A played: V1 clips keep their footage in footage order (overlaps
// once), a stretch without A1 dialogue becomes a muted clip, the edit-wide turn and framing go onto every clip,
// and every other clip hangs on the kept moment its start lands on, with the length it had in the edit.
// ---------------------------------------------------------------------------------------------
const A_ONLY = ["unlinked", "linkId", "timelineStart", "timelineEnd", "sourceVideoId", "sourceIn", "sourceOut"];
const cleanA = (c: Clip) => { const x = { ...c } as Record<string, unknown>; for (const k of A_ONLY) delete x[k]; return x as Clip; };

export function toModelB(tl: Timeline, words: Word[], mainVideoId = "main", opts: { seconds?: number } = {}): Timeline {
  if (isSequence(tl)) return tl;
  const main = mainVideoId;
  // Measured exactly as the model A planner did: kept parts on frames of the 30 fps output, within the file's length.
  const seconds = opts.seconds ?? tl.duration;
  const f30 = (x: number) => Math.round(x * 30) / 30;
  const kept = mergeRanges(subtractRanges(keptRanges(tl, words), [{ start: seconds, end: 1e9 }])
    .map((k) => ({ start: f30(k.start), end: Math.min(f30(k.end), Math.floor(seconds * 30) / 30) }))
    .filter((k) => k.end - k.start >= 1 / 30 - 1e-9));
  const map = makeTimeMap(kept);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const toOut = (x: number) => r3(map.toOutput(x));
  const look = { ...(tl.rotate ? { rotate: tl.rotate } : {}), ...(plainFraming(tl.framing) ? { framing: tl.framing } : {}) };

  // V1 in footage order; footage that two clips share plays once (in the first).
  const sorted = [...tl.tracks.v1].sort((a, b) => a.start - b.start || a.end - b.end);
  const base: { c: Clip; start: number; end: number }[] = [];
  let reach = -Infinity;
  for (const c of sorted) {
    const start = Math.max(c.start, reach);
    reach = Math.max(reach, c.end);
    if (c.end - start >= 0.01) base.push({ c, start, end: c.end });
  }
  // Kept footage that no A1 clip covers played muted: it becomes its own muted clip.
  const muted = subtractRanges(kept, mergeRanges(tl.tracks.a1.map((c) => ({ start: c.start, end: c.end }))));
  const keptIn = (a: number, b: number) => kept.reduce((s, k) => s + Math.max(0, Math.min(b, k.end) - Math.max(a, k.start)), 0);
  const isMuted = (a: number, b: number) => {
    // Judged on the footage that plays (cut words left out).
    const playing = kept.map((k) => ({ start: Math.max(a, k.start), end: Math.min(b, k.end) })).filter((k) => k.end > k.start);
    const mid = playing.length ? (playing[0].start + playing[0].end) / 2 : (a + b) / 2;
    return muted.some((m) => mid > m.start && mid < m.end);
  };
  const v1: SeqClip[] = [];
  for (const { c, start, end } of base) {
    const edges = Array.from(new Set([start, ...muted.flatMap((m) => [m.start, m.end]).filter((x) => x > start + 1e-6 && x < end - 1e-6), end])).sort((a, b) => a - b);
    const segs: { a: number; b: number; m: boolean | null }[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i], b = edges[i + 1];
      segs.push({ a, b, m: keptIn(a, b) > 1e-6 ? isMuted(a, b) : null }); // null: nothing of it plays, joins its neighbour
    }
    const joined: { a: number; b: number; m: boolean }[] = [];
    for (const sg of segs) {
      const last = joined[joined.length - 1];
      if (last && (sg.m === null || sg.m === last.m)) last.b = sg.b;
      else joined.push({ a: sg.a, b: sg.b, m: sg.m ?? false });
    }
    if (joined.length > 1 && segs[0].m === null) joined[0].m = joined[1].m;
    joined.forEach((sg, n) => {
      const x = cleanA(c) as SeqClip;
      v1.push({ ...x, id: n === 0 ? c.id : `${c.id}_${n + 1}`, start: sg.a, end: sg.b, sourceVideoId: main, sourceIn: sg.a, sourceOut: sg.b, ...look, ...(sg.m ? { audioMuted: true } : {}) });
    });
  }

  const { rotate: _r, framing: _f, ...rest } = tl;
  const draft: Timeline = { ...rest, model: "B", mainVideoId: main, tracks: { ...tl.tracks, v1, a1: [] } };
  // Other clips hang on the kept moment their start lands on, with the length they had in the edit.
  const view = sequenceView(normalizeTimeline(draft), words, { align: 30, seconds: { [main]: seconds } });
  const total = r3(map.total);
  for (const k of ATTACHED_TRACKS) {
    const out: Clip[] = [];
    for (const c of tl.tracks[k] as Clip[]) {
      if (isCaptionMarker(k, c)) { out.push({ ...cleanA(c), sourceVideoId: main, sourceIn: c.start, sourceOut: c.end } as Clip); continue; }
      const s = toOut(c.start), e = toOut(c.end);
      let length = e - s;
      if (k === "a3") { if (s >= total) continue; length = Math.max(0.1, c.end - c.start); } // a sound effect keeps its own length
      else if (length < 0.05) continue; // not in the edit
      const x = cleanA(c) as Attached;
      if (k === "a2" && s <= 0.01 && e >= total - 0.01) { out.push({ ...x, start: 0, end: total, fill: true } as Clip); continue; }
      const a = view.anchorFor(s);
      if (!a) continue;
      out.push({ ...x, start: s, end: s + length, anchorId: a.anchorId, anchorAt: a.anchorAt, length } as Clip);
    }
    (draft.tracks as Record<string, Clip[]>)[k] = out;
  }
  return layoutSequence(normalizeTimeline(draft), words);
}

/** Any timeline as model B (an old one is converted; the project's footage is `mainVideoId`). */
export const asSequence = (tl: Timeline, words: Word[], mainVideoId?: string, seconds?: number) => (isSequence(tl) ? tl : toModelB(tl, words, mainVideoId || tl.mainVideoId || "main", { seconds }));

// ---------------------------------------------------------------------------------------------
// Sequence edits (model B). V1 stays a list played back to back, so each change ripples by itself; clips on other
// tracks move with the V1 clip they hang on.
// ---------------------------------------------------------------------------------------------
const seqOf = (tl: Timeline) => tl.tracks.v1 as SeqClip[];
const withV1 = (tl: Timeline, v1: SeqClip[]) => withTracks(tl, "v1", v1);
function freshIds(tl: Timeline) {
  const ids = new Set(seqOf(tl).map((c) => c.id));
  return (base: string) => { const b = base.split("_")[0] || "vc"; let id = `${b}_${Math.random().toString(36).slice(2, 6)}`; while (ids.has(id)) id = `${b}_${Math.random().toString(36).slice(2, 6)}`; ids.add(id); return id; };
}
/** Clips on other tracks hanging on `fromId` at footage moment `from` or later move to `toId` (at `snap` at the earliest). */
function moveAnchors(tl: Timeline, fromId: string, toId: string, from: number, snap?: number): Timeline {
  const tracks = { ...tl.tracks } as Timeline["tracks"];
  for (const k of ATTACHED_TRACKS) {
    (tracks as Record<string, Clip[]>)[k] = (tl.tracks[k] as Attached[]).map((c) => {
      if (c.anchorId !== fromId || Number(c.anchorAt ?? 0) < from - 1e-9) return c;
      return { ...c, anchorId: toId, ...(snap != null && Number(c.anchorAt ?? 0) < snap ? { anchorAt: r2(snap) } : {}) };
    });
  }
  return { ...tl, tracks };
}
const label2 = (l: string) => (/\(2\)$/.test(l) ? l : l ? l + " (2)" : "");
const noAudioStart = (c: SeqClip): SeqClip => { const x = { ...c }; delete x.audioStart; return x; };

/** Splits a V1 clip at a moment of its footage. The second half gets a new id; nothing moves. */
export function splitSeqClip(tl: Timeline, clipId: string, at: number): { tl: Timeline; newId: string } {
  const c = findClip(tl, "v1", clipId) as SeqClip;
  if (!(at > c.sourceIn + 0.05 && at < c.sourceOut - 0.05)) throw new EditError(`Split time ${r2(at)}s must be inside the clip's footage (${c.sourceIn}s to ${c.sourceOut}s).`);
  const newId = freshIds(tl)(c.id);
  const v1 = seqOf(tl).flatMap((x) => (x.id !== c.id ? [x] : [{ ...x, sourceOut: r2(at) }, noAudioStart({ ...x, id: newId, sourceIn: r2(at), label: label2(x.label) })]));
  return { tl: moveAnchors(withV1(tl, v1), c.id, newId, at), newId };
}

/**
 * Takes a footage range of one video out of the V1 clips that play it (all of them, or only `onlyId`). A leftover
 * under 0.15 s goes too, as in model A. The edit closes up.
 */
export function removeSourceRange(tl: Timeline, videoId: string, a: number, b: number, onlyId?: string): Timeline {
  const ids = freshIds(tl);
  const out: SeqClip[] = [];
  const moves: [string, string, number, number][] = [];
  for (const c of seqOf(tl)) {
    if (c.sourceVideoId !== videoId || (onlyId && c.id !== onlyId) || b <= c.sourceIn || a >= c.sourceOut) { out.push(c); continue; }
    const keepA = a - c.sourceIn >= 0.15, keepB = c.sourceOut - b >= 0.15;
    if (keepA) out.push({ ...c, sourceOut: r2(a) });
    if (keepB) {
      const id = keepA ? ids(c.id) : c.id;
      out.push(keepA ? noAudioStart({ ...c, id, sourceIn: r2(b), label: label2(c.label) }) : { ...c, sourceIn: r2(b) });
      moves.push([c.id, id, keepA ? a : -Infinity, b]);
    }
  }
  let next = withV1(tl, out);
  for (const [from, to, at, snap] of moves) next = moveAnchors(next, from, to, at, snap);
  return next;
}

/** Takes a stretch of the edit (edit seconds) out of whatever plays there. */
export function removeEditRange(tl: Timeline, words: Word[], a: number, b: number): Timeline {
  const view = sequenceView(tl, words);
  const jobs = view.clips.filter((c) => c.end > a + 1e-6 && c.start < b - 1e-6)
    .map((c) => ({ id: c.id, video: c.videoId, sa: view.editToSource(c.id, Math.max(a, c.start)), sb: view.editToSource(c.id, Math.min(b, c.end)) }));
  let next = tl;
  for (const j of jobs) {
    const c = seqOf(next).find((x) => x.id === j.id)!;
    // A range that reaches the clip's edge takes the edge too (cut words there would otherwise stay).
    const sa = view.clip(j.id)!.start >= a - 1e-6 ? Math.min(j.sa, c.sourceIn) : j.sa;
    const sb = view.clip(j.id)!.end <= b + 1e-6 ? Math.max(j.sb, c.sourceOut) : j.sb;
    next = removeSourceRange(next, j.video, sa, sb, j.id);
  }
  return next;
}

/** Moves a V1 clip to position `index` (0 = first). The J/L offsets at the edges that change are reset. */
export function moveSeqClip(tl: Timeline, clipId: string, index: number): Timeline {
  const v1 = seqOf(tl);
  const from = v1.findIndex((c) => c.id === clipId);
  if (from < 0) findClip(tl, "v1", clipId);
  const rest = v1.filter((c) => c.id !== clipId);
  const to = Math.max(0, Math.min(rest.length, Math.round(index)));
  const oldNext = v1[from + 1]?.id;
  const moved = [...rest.slice(0, to), v1[from], ...rest.slice(to)];
  const newNext = moved[to + 1]?.id;
  return withV1(tl, moved.map((c) => (c.id === clipId || c.id === oldNext || c.id === newNext ? noAudioStart(c) : c)));
}

/** Puts a clip into V1 at position `index` (default: the end). */
export function insertSeqClip(tl: Timeline, clip: SeqClip, index?: number): Timeline {
  const v1 = seqOf(tl);
  const at = index == null ? v1.length : Math.max(0, Math.min(v1.length, Math.round(index)));
  const next = v1[at] ? noAudioStart(v1[at]) : null;
  return withV1(tl, [...v1.slice(0, at), clip, ...(next ? [next, ...v1.slice(at + 1)] : v1.slice(at + 1))]);
}

/** A new V1 clip id. */
export const newSeqClipId = (tl: Timeline) => freshIds(tl)("vc");

/**
 * After an edit: clips on other tracks whose V1 clip is gone are put back by their footage, as model A did. Their
 * start and end footage moments are found again in the new sequence; a clip whose footage no longer plays leaves
 * the edit, one whose footage partly plays gets shorter. A sound effect keeps its length.
 */
export function reattach(before: Timeline, after: Timeline, words: Word[]): Timeline {
  if (!isSequence(before) || !isSequence(after)) return after;
  const ids = new Set(seqOf(after).map((c) => c.id));
  const lost = (c: Attached) => !!c.anchorId && !ids.has(c.anchorId);
  if (!ATTACHED_TRACKS.some((k) => (after.tracks[k] as Attached[]).some(lost))) return after;
  const old = sequenceView(before, words), now = sequenceView(after, words);
  const tracks = { ...after.tracks } as Timeline["tracks"];
  for (const k of ATTACHED_TRACKS) {
    (tracks as Record<string, Clip[]>)[k] = (after.tracks[k] as Attached[]).flatMap((c) => {
      if (!lost(c)) return [c];
      const s0 = old.editAt(c.anchorId!, Number(c.anchorAt ?? 0));
      if (s0 == null) return [];
      const len = Number(c.length ?? c.end - c.start);
      const p1 = old.pieceAt(s0), p2 = old.pieceAt(Math.max(s0, Math.min(old.total, s0 + len) - 1e-6));
      if (!p1) return [];
      const s = now.videoToEdit(p1.videoId, p1.srcIn + (s0 - p1.start));
      if (s == null) return [];
      let length = len;
      if (k !== "a3" && p2) {
        const e = p2.videoId === p1.videoId ? now.videoToEdit(p2.videoId, p2.srcIn + (Math.min(old.total, s0 + len) - p2.start)) : null;
        length = e != null ? e - s : Math.min(len, now.total - s);
        if (length < 0.05) return [];
      } else if (s >= now.total) return [];
      const a = now.anchorFor(s);
      return a ? [{ ...c, anchorId: a.anchorId, anchorAt: r2(a.anchorAt), length: r2(length) }] : [];
    });
  }
  return { ...after, tracks };
}
