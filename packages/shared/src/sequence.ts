// The timeline logic, in one place: what plays (V1 minus cut words, back to back), where every clip lands in the
// edit, which clips are linked, and the clip edits (split, trim, delete, unlink, range removal) with ripple and
// links. The connector's ops, the render plan, the after-render check and the editor all go through this module,
// so a later sequence model (every clip placed freely on the edit's timeline) replaces this file, not its callers.
// See docs/timeline-model.md.
//
// Model today ("A"): clip start/end are seconds in the project's ORIGINAL footage. V1 is magnetic: its clips play
// in footage order, minus cut words, with no gaps, so ripple is automatic. The other tracks are pinned to moments
// in the footage and move with them. Every clip also carries these fields, rewritten here after each change:
//   sourceVideoId, sourceIn, sourceOut   the video it plays and its in/out in that video (V1/A1: the footage;
//                                         b-roll: its own video). Clips that play no video (captions, zooms,
//                                         graphics, music, sound effects): the footage moment they are pinned to.
//   timelineStart, timelineEnd            its place in the edit, in edit seconds (equal = not in the edit)
//   linkId                                 shared by a V1 clip and its A1 dialogue while they are linked
import { TRACK_NAMES, type Clip, type Timeline, type TrackName } from "./timeline";
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

export function outputDuration(timeline: Timeline, words: Word[]) {
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
  for (const k of TRACK_NAMES) (tracks as Record<string, Clip[]>)[k] = (tl.tracks[k] as Clip[]).map(withoutLayout);
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
