import { AppError, enqueue, getText, newRedis, type ColorSamples, type FaceSamples, type FramesJob, type TrackJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { aspectSize, boxOnScreen, faceSkinArea, type FaceTrack, isSequence, mainVideoOf, sequenceView, type TrackedObject, parseCube, QUEUES, speakerCentre, speakerFaceBox, type Area, type ClipLook, type EditOp, type Focus, type Lut, type Timeline, type VisionDetails, type VisionSummary } from "@rendrr/shared";
import { visionDetailsOf } from "./deep";
import { QueueEvents } from "bullmq";

// Phase 6: shot matching measures frames of the clips (the worker reads their preview copies, the pixels the editor
// shows); imported LUTs are read from storage when a grade needs their numbers.

let events: QueueEvents | null = null;
type V1 = { id: string; sourceVideoId?: string; sourceIn: number; sourceOut: number; rotate?: number; freeze?: number; framing?: { focus?: { x: number; y: number } } };
const SAMPLE_WAIT_MS = 60_000;

/** Small frames of these clips (V1 or b-roll) as the editor shows them. Fails loudly: never a silent empty result. */
export async function colorSamples(tl: Timeline, aspect: string, ids: string[]): Promise<ColorSamples> {
  const main = mainVideoOf(tl);
  const { width: w, height: h } = aspectSize(aspect, 36);
  const clips = ids.map((id) => {
    const v1 = (tl.tracks.v1 as unknown as V1[]).find((c) => c.id === id);
    if (v1) return { id, videoId: v1.sourceVideoId || main, srcIn: v1.sourceIn, srcOut: v1.freeze ? v1.sourceIn + 0.04 : v1.sourceOut, rotate: v1.rotate ?? 0, fitY: 0.4, ...(v1.framing?.focus ? { focus: v1.framing.focus } : {}) };
    const v2 = (tl.tracks.v2 as unknown as { id: string; kind?: string; videoId?: string; sourceStart?: number; length?: number; start: number; end: number }[]).find((c) => c.id === id && c.kind === "broll" && c.videoId);
    if (v2) { const s = v2.sourceStart ?? 0; return { id, videoId: v2.videoId!, srcIn: s, srcOut: s + Number(v2.length ?? v2.end - v2.start), rotate: 0, fitY: 0.5 }; }
    throw new AppError(`There is no clip "${id}" on V1 or b-roll on V2. Read the project again to get the current clip ids. Nothing was changed.`, 400, "invalid-edit");
  });
  events ||= new QueueEvents(QUEUES.frames.name, { connection: newRedis() });
  const job = await enqueue<FramesJob>("frames", { times: [], colorSamples: { w, h, clips } });
  try {
    return (await job.waitUntilFinished(events, SAMPLE_WAIT_MS)) as ColorSamples;
  } catch (e) {
    const msg = (e as Error).message || "";
    throw new AppError(/timed out/i.test(msg) ? `Measuring the clips' colour took over ${SAMPLE_WAIT_MS / 1000} s and was stopped. Nothing was changed; try again with fewer clips.` : `Could not measure the clips' colour: ${msg.slice(0, 200)}. Nothing was changed.`, 503, "measure");
  }
}

/**
 * Where the face is in each of these V1 clips, on frames turned and fitted as the render shows them (set_framing
 * fitFaceTo). Fails loudly like colorSamples; a clip with no face found comes back null.
 */
export async function faceSamples(tl: Timeline, aspect: string, ids: string[]): Promise<FaceSamples> {
  const main = mainVideoOf(tl);
  // 360 px on the short side: YuNet's face box at that size matches its size in a full-size frame best.
  const { width: w, height: h } = aspectSize(aspect, aspect === "1:1" || aspect === "4:5" ? 480 : 360);
  const v1 = tl.tracks.v1 as unknown as V1[];
  const clips = ids.slice(0, 40).map((id) => {
    const c = v1.find((x) => x.id === id);
    if (!c) throw new AppError(`There is no clip "${id}" on V1. Read the project again to get the current clip ids. Nothing was changed.`, 400, "invalid-edit");
    return { id, videoId: c.sourceVideoId || main, srcIn: c.sourceIn, srcOut: c.freeze ? c.sourceIn + 0.04 : c.sourceOut, rotate: c.rotate ?? 0, fitY: 0.4, ...(c.framing?.focus ? { focus: c.framing.focus } : {}) };
  });
  events ||= new QueueEvents(QUEUES.frames.name, { connection: newRedis() });
  const job = await enqueue<FramesJob>("frames", { times: [], faces: { w, h, clips } });
  try {
    return (await job.waitUntilFinished(events, SAMPLE_WAIT_MS)) as FaceSamples;
  } catch (e) {
    const msg = (e as Error).message || "";
    throw new AppError(/timed out/i.test(msg) ? `Finding the faces took over ${SAMPLE_WAIT_MS / 1000} s and was stopped. Nothing was changed; try again with fewer clips.` : `Could not find the faces: ${msg.slice(0, 200)}. Nothing was changed.`, 503, "measure");
  }
}

const TRACK_WAIT_MS = 150_000;
/** The longest stretch tracked in one go (seconds, round the moment the box is drawn). */
export const TRACK_SPAN = 60;
type TrackOp = Extract<EditOp, { op: "track_object" }>;
/**
 * Object tracking: the box drawn on a clip followed through its footage by the worker (python/track.py), on frames
 * turned and fitted as the render shows them, at 10 fps; the op gets the tracker's rows ([second, x0, y0, x1, y1,
 * confidence], footage seconds of the clip). A V1 clip on a multicam angle is tracked on that angle's picture. At
 * most TRACK_SPAN seconds round `at`. An edit second (edit: true) is turned into the clip's footage second here.
 */
export async function trackObject(tl: Timeline, aspect: string, e: TrackOp): Promise<TrackOp> {
  const main = mainVideoOf(tl);
  type Look = { objects?: TrackedObject[] };
  const v1 = (tl.tracks.v1 as unknown as (V1 & Look & { angle?: string; start: number; end: number })[]).find((c) => c.id === e.clipId);
  const b = v1 ? null : (tl.tracks.v2 as unknown as ({ id: string; kind?: string; videoId?: string; sourceStart?: number; start: number; end: number } & Look)[]).find((c) => c.id === e.clipId && c.kind === "broll" && c.videoId);
  if (!v1 && !b) throw new AppError(`There is no clip "${e.clipId}" on V1 or b-roll on V2 to track an object on. Read the project again to get the current clip ids. Nothing was changed.`, 400, "invalid-edit");
  const old = e.id ? (v1 ?? b)!.objects?.find((o) => o.id === e.id) : undefined;
  let at = e.at ?? old?.at;
  const box = e.box ?? old?.box;
  if (at == null || !box) throw new AppError("track_object needs at (the clip's footage second, or an edit second with edit: true) and box {x, y, w, h} drawn round the object then. Nothing was changed.", 400, "invalid-edit");
  if (e.edit && e.at != null) at = v1 ? sequenceView(tl, []).editToSource(v1.id, e.at) : (b!.sourceStart ?? 0) + (e.at - b!.start);
  // The clip's footage (main-video seconds for V1), and the picture it shows: a multicam angle's file, `offset` later.
  const from = v1 ? v1.sourceIn : b!.sourceStart ?? 0, to = v1 ? v1.sourceOut : from + (b!.end - b!.start);
  const ang = v1?.angle ? tl.multicam?.angles.find((a) => a.videoId === v1.angle) : undefined;
  const shift = ang?.offset ?? 0;
  const rows = await trackRows({ videoId: ang ? ang.videoId : v1 ? v1.sourceVideoId || main : b!.videoId!, from, to, at, box, rotate: ang ? ang.rotate ?? 0 : v1?.rotate ?? 0, fitY: v1 ? 0.4 : 0.5, shift, ...(!ang && v1?.framing?.focus ? { focus: v1.framing.focus } : {}) }, aspect);
  const { edit: _e, ...rest } = e;
  return { ...rest, at, rows };
}
export type TrackRows = [number, number, number, number, number, number][];
/**
 * The worker's tracker over one clip's footage [from, to] (seconds of the clip's own time; shift: where that time is
 * in the file read, a multicam angle's offset), the box drawn at `at` (shares of the picture as fitted; fitY 0.4 for
 * V1, 0.5 for b-roll). At most TRACK_SPAN seconds round `at`. Rows in the clip's own time.
 */
export async function trackRows(c: { videoId: string; from: number; to: number; at: number; box: { x: number; y: number; w: number; h: number }; rotate: number; fitY: number; shift?: number; focus?: { x: number; y: number } }, aspect: string): Promise<TrackRows> {
  const shift = c.shift ?? 0, at = Math.min(c.to, Math.max(c.from, c.at));
  const lo = Math.max(c.from, Math.min(at + TRACK_SPAN / 2, c.to) - TRACK_SPAN), span = { from: lo, to: Math.min(c.to, lo + TRACK_SPAN) };
  const { width: w, height: h } = aspectSize(aspect, aspect === "1:1" || aspect === "4:5" ? 480 : 360);
  const job: TrackJob = { videoId: c.videoId, srcIn: span.from + shift, srcOut: span.to + shift, at: at + shift, box: c.box, rotate: c.rotate, fitY: c.fitY, w, h, ...(c.focus ? { focus: c.focus } : {}) };
  events ||= new QueueEvents(QUEUES.frames.name, { connection: newRedis() });
  const q = await enqueue<FramesJob>("frames", { times: [], track: job });
  try {
    const rows = (await q.waitUntilFinished(events, TRACK_WAIT_MS)) as TrackRows;
    return rows.map((r) => [Math.round((r[0] - shift) * 1000) / 1000, r[1], r[2], r[3], r[4], r[5]] as TrackRows[number]);
  } catch (err) {
    const msg = (err as Error).message || "";
    throw new AppError(/timed out/i.test(msg) ? `Tracking the object took over ${TRACK_WAIT_MS / 1000} s and was stopped. Nothing was changed; try a shorter clip.` : `Could not track the object: ${msg.slice(0, 200)}. Nothing was changed.`, 503, "measure");
  }
}

/** Closes the queue listener (tests; the server keeps it for its lifetime). */
export async function closeColorEvents() { await events?.close(); events = null; }

/** match_color and set_framing fitFaceTo ops get their measurements (the ops themselves are pure: they need them sent in). */
export async function withMeasurements(projectId: string, edits: EditOp[]): Promise<EditOp[]> {
  const faces = (e: EditOp) => e.op === "set_framing" && !!e.fitFaceTo && !e.faces;
  const speaker = (e: EditOp) => e.op === "set_framing" && e.focus === "face" && !e.centers;
  // retouch_skin on the face (its default) for clips that have no skin area yet.
  const skin = (e: EditOp) => e.op === "retouch_skin" && !e.off && !e.faceAreas && (e.area === "face" || e.area === undefined);
  // Phase 3: masks and effect areas that follow the face.
  const follow = (e: EditOp) => (e.op === "set_masks" || e.op === "set_effects") && !e.faceTracks && (e.op === "set_masks" ? e.masks : e.effects.map((x) => x.area)).some((a) => a?.follow === "face");
  // Object tracking: the box followed through the clip.
  // (a new name only, id and label with no box or moment, needs no tracking).
  const track = (e: EditOp) => e.op === "track_object" && !e.remove && !e.rows && !(e.id && e.label !== undefined && !e.box && e.at == null);
  if (!edits.some((e) => (e.op === "match_color" && !e.measured) || faces(e) || speaker(e) || skin(e) || follow(e) || track(e))) return edits;
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { timeline: true, aspect: true } });
  const tl = p.timeline as unknown as Timeline;
  const out: EditOp[] = [];
  for (const e of edits) {
    if (e.op === "match_color" && !e.measured) out.push({ ...e, measured: await colorSamples(tl, p.aspect, Array.from(new Set([e.to, ...e.clipIds]))) });
    else if (e.op === "track_object" && track(e)) out.push(await trackObject(tl, p.aspect, e));
    else if (e.op === "set_framing" && speaker(e)) {
      const main = mainVideoOf(tl);
      const v1 = tl.tracks.v1 as unknown as V1[];
      const ids = e.clipIds ?? v1.filter((c) => (c.sourceVideoId || main) === main).map((c) => c.id);
      out.push({ ...e, centers: await speakerCentres(v1.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, videoId: c.sourceVideoId || main, srcIn: c.sourceIn, srcOut: c.freeze ? c.sourceIn + 0.04 : c.sourceOut, rotate: c.rotate ?? 0 }))) });
    }
    else if ((e.op === "set_masks" || e.op === "set_effects") && follow(e)) {
      // The V1 clips it names (b-roll keeps the shape still: no face measured there).
      const v1 = tl.tracks.v1 as unknown as V1[], main = mainVideoOf(tl);
      const ids = new Set(e.clipIds ?? (e.clipId ? [e.clipId] : e.video ? v1.filter((c) => (c.sourceVideoId || main) === (e.video === "main" ? main : e.video)).map((c) => c.id) : e.all ? v1.map((c) => c.id) : []));
      out.push({ ...e, faceTracks: await faceTracks(v1.filter((c) => ids.has(c.id)), main, p.aspect) });
    }
    else if (e.op === "retouch_skin" && skin(e)) {
      const v1 = tl.tracks.v1 as unknown as V1[];
      const ids = new Set(e.clipIds ?? (e.clipId ? [e.clipId] : e.video ? v1.filter((c) => (c.sourceVideoId || mainVideoOf(tl)) === (e.video === "main" ? mainVideoOf(tl) : e.video)).map((c) => c.id) : v1.map((c) => c.id)));
      out.push({ ...e, faceAreas: await skinFaceAreas(v1.filter((c) => ids.has(c.id)), mainVideoOf(tl), p.aspect) });
    }
    else if (e.op === "set_framing" && faces(e)) {
      // The clips it frames: those named, else every clip of the main footage (as set_framing does).
      const main = mainVideoOf(tl);
      const ids = e.clipIds ?? (isSequence(tl) ? (tl.tracks.v1 as unknown as { id: string; sourceVideoId?: string }[]).filter((c) => (c.sourceVideoId || main) === main).map((c) => c.id) : []);
      if (ids.length > 40) throw new AppError(`fitFaceTo measures 40 clips at most; this edit has ${ids.length}. Send clipIds in groups of 40. Nothing was changed.`, 400, "invalid-edit");
      out.push({ ...e, faces: await faceSamples(tl, p.aspect, ids) });
    } else out.push(e);
  }
  return out;
}

/**
 * Auto reframe (set_framing focus "face"): where the speaker's face is in each clip, from the faces Rendrr measured at
 * 10 fps when the video came in (speakerCentre), as shares of the picture as the clip turns it. Null: no face there, or
 * that video has no face measurements yet.
 */
export async function speakerCentres(clips: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: number }[]): Promise<Record<string, { x: number; y: number } | null>> {
  const ids = Array.from(new Set(clips.map((c) => c.videoId)));
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, vision: true } });
  const vis = new Map<string, { d: VisionDetails; turned: number }>();
  for (const r of rows) {
    const v = r.vision as unknown as VisionSummary | null;
    const d = v ? await visionDetailsOf(v).catch(() => null) : null;
    if (d) vis.set(r.videoId, { d, turned: v!.turned ?? 0 });
  }
  const out: Record<string, { x: number; y: number } | null> = {};
  for (const c of clips) {
    const v = vis.get(c.videoId);
    // A frozen frame or a very short clip: the faces just around it.
    const pad = c.srcOut - c.srcIn < 0.3 ? 0.15 : 0;
    const at = v ? speakerCentre(v.d, v.turned, c.rotate, c.srcIn - pad, c.srcOut + pad) : null;
    out[c.id] = at ? { x: at.x, y: at.y } : null;
  }
  return out;
}

/**
 * Skin retouch on the face (retouch_skin area "face"): each clip's skin area, an ellipse around where the speaker's face
 * is over the clip (from the faces Rendrr measured at 10 fps), forehead to neck, placed as the render fits the clip.
 * Null: no face there, or no face measurements for that video yet.
 */
export async function skinFaceAreas(clips: V1[], main: string, aspect: string): Promise<Record<string, Area | null>> {
  const ids = Array.from(new Set(clips.map((c) => c.sourceVideoId || main)));
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, vision: true } });
  const vis = new Map<string, { d: VisionDetails; turned: number }>();
  for (const r of rows) {
    const v = r.vision as unknown as VisionSummary | null;
    const d = v ? await visionDetailsOf(v).catch(() => null) : null;
    if (d) vis.set(r.videoId, { d, turned: v!.turned ?? 0 });
  }
  const { width: W, height: H } = aspectSize(aspect, 1080);
  const out: Record<string, Area | null> = {};
  for (const c of clips) {
    const v = vis.get(c.sourceVideoId || main);
    const to = c.freeze ? c.sourceIn + 0.04 : c.sourceOut, pad = to - c.sourceIn < 0.3 ? 0.15 : 0;
    const box = v ? speakerFaceBox(v.d, c.sourceIn - pad, to + pad) : null;
    const onScreen = box && v ? boxOnScreen(box, v.turned, v.d.size, W, H, { rotate: c.rotate ?? 0, framing: { scale: 1, x: 0, y: 0, focus: c.framing?.focus ?? undefined } }) : null;
    out[c.id] = onScreen ? faceSkinArea(onScreen) : null;
  }
  return out;
}

/**
 * Phase 3 (masks that follow the face): each clip's face over it, every 0.1 s of its footage, as the render places it
 * ([footage second, x0, y0, x1, y1], shares of the frame), smoothed over three samples (YuNet's box jitters a little).
 * Null: no face there, or no face measurements for that video yet.
 */
export async function faceTracks(clips: V1[], main: string, aspect: string): Promise<Record<string, FaceTrack | null>> {
  const ids = Array.from(new Set(clips.map((c) => c.sourceVideoId || main)));
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, vision: true } });
  const vis = new Map<string, { d: VisionDetails; turned: number }>();
  for (const r of rows) {
    const v = r.vision as unknown as VisionSummary | null;
    const d = v ? await visionDetailsOf(v).catch(() => null) : null;
    if (d) vis.set(r.videoId, { d, turned: v!.turned ?? 0 });
  }
  const { width: W, height: H } = aspectSize(aspect, 1080);
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const out: Record<string, FaceTrack | null> = {};
  for (const c of clips) {
    const v = vis.get(c.sourceVideoId || main);
    if (!v) { out[c.id] = null; continue; }
    const to = c.freeze ? c.sourceIn + 0.04 : c.sourceOut, raw: FaceTrack = [];
    for (let t = c.sourceIn; t <= to + 1e-6; t = Math.round((t + 0.1) * 1000) / 1000) {
      const box = speakerFaceBox(v.d, t - 0.15, t + 0.15);
      const s = box ? boxOnScreen(box, v.turned, v.d.size, W, H, { rotate: c.rotate ?? 0, framing: { scale: 1, x: 0, y: 0, focus: c.framing?.focus ?? undefined } }) : null;
      if (s) raw.push([Math.round(t * 1000) / 1000, s[0], s[1], s[2], s[3]]);
    }
    out[c.id] = raw.length ? raw.map((p, i) => { const n = [raw[i - 1], p, raw[i + 1]].filter(Boolean); return [p[0], ...[1, 2, 3, 4].map((k) => r4(n.reduce((a, q) => a + q[k], 0) / n.length))] as FaceTrack[number]; }) : null;
  }
  return out;
}

/** The user's LUTs that this timeline's grades use, parsed (for match_color against a reference graded with one). */
export async function lutsFor(userId: string, tl: Timeline): Promise<Record<string, Lut>> {
  const ids = Array.from(new Set([...tl.tracks.v1, ...tl.tracks.v2].map((c) => (c as ClipLook).grade?.lut?.id).filter((x): x is string => !!x)));
  if (!ids.length) return {};
  const out: Record<string, Lut> = {};
  for (const l of await prisma.lut.findMany({ where: { id: { in: ids }, userId } })) {
    try { out[l.id] = parseCube(await getText(l.key)); } catch { /* a broken file: the grade renders without it and says so */ }
  }
  return out;
}
