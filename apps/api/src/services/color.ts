import { AppError, enqueue, getText, newRedis, type ColorSamples, type FaceSamples, type FramesJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { isSequence, mainVideoOf, parseCube, QUEUES, type ClipLook, type EditOp, type Lut, type Timeline } from "@rendrr/shared";
import { QueueEvents } from "bullmq";

// Phase 6: shot matching measures frames of the clips (the worker reads their preview copies, the pixels the editor
// shows); imported LUTs are read from storage when a grade needs their numbers.

let events: QueueEvents | null = null;
const SAMPLE_WAIT_MS = 60_000;

/** Small frames of these clips (V1 or b-roll) as the editor shows them. Fails loudly: never a silent empty result. */
export async function colorSamples(tl: Timeline, aspect: string, ids: string[]): Promise<ColorSamples> {
  const main = mainVideoOf(tl);
  const [w, h] = aspect === "9:16" ? [36, 64] : aspect === "1:1" ? [48, 48] : [64, 36];
  const clips = ids.map((id) => {
    const v1 = (tl.tracks.v1 as unknown as { id: string; sourceVideoId?: string; sourceIn: number; sourceOut: number; rotate?: number; freeze?: number }[]).find((c) => c.id === id);
    if (v1) return { id, videoId: v1.sourceVideoId || main, srcIn: v1.sourceIn, srcOut: v1.freeze ? v1.sourceIn + 0.04 : v1.sourceOut, rotate: v1.rotate ?? 0, fitY: 0.4 };
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
  const [w, h] = aspect === "9:16" ? [360, 640] : aspect === "1:1" ? [480, 480] : [640, 360];
  const v1 = tl.tracks.v1 as unknown as { id: string; sourceVideoId?: string; sourceIn: number; sourceOut: number; rotate?: number; freeze?: number }[];
  const clips = ids.slice(0, 40).map((id) => {
    const c = v1.find((x) => x.id === id);
    if (!c) throw new AppError(`There is no clip "${id}" on V1. Read the project again to get the current clip ids. Nothing was changed.`, 400, "invalid-edit");
    return { id, videoId: c.sourceVideoId || main, srcIn: c.sourceIn, srcOut: c.freeze ? c.sourceIn + 0.04 : c.sourceOut, rotate: c.rotate ?? 0, fitY: 0.4 };
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

/** Closes the queue listener (tests; the server keeps it for its lifetime). */
export async function closeColorEvents() { await events?.close(); events = null; }

/** match_color and set_framing fitFaceTo ops get their measurements (the ops themselves are pure: they need them sent in). */
export async function withMeasurements(projectId: string, edits: EditOp[]): Promise<EditOp[]> {
  const faces = (e: EditOp) => e.op === "set_framing" && !!e.fitFaceTo && !e.faces;
  if (!edits.some((e) => (e.op === "match_color" && !e.measured) || faces(e))) return edits;
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { timeline: true, aspect: true } });
  const tl = p.timeline as unknown as Timeline;
  const out: EditOp[] = [];
  for (const e of edits) {
    if (e.op === "match_color" && !e.measured) out.push({ ...e, measured: await colorSamples(tl, p.aspect, Array.from(new Set([e.to, ...e.clipIds]))) });
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
