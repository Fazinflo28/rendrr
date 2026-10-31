// Phase 10: multicam sync on the server. An angle added without an offset is synced to the main video (phase 22: by
// timecode when both files carry one, the sound checking it) by their sound:
// both videos' loudness every 10 ms (the deep measurements, made once per video and kept) through shared/multicam.ts.
// The editor asks for one angle's sync (its route); apply_edits fills the offsets the AI left out.
import { AppError, enqueue, type TimecodeJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { pickSync, speakerPlan, syncEnvelope, syncOffset, timecodeOffset, type AnglePlanPart, type SpeakerSource, type SyncResult, type Timeline } from "@rendrr/shared";
import { audioFramesOf, deepOf } from "./deep";

export type AngleSync = SyncResult & { videoId: string; name: string; rotate?: 0 | 90 | 180 | 270; by: "timecode" | "sound"; note: string; sure: boolean;
  /** Whether the sound was there to sync by (or to check the timecode with): score is its correlation then. */
  checked: boolean };

const envelopeCache = new Map<string, Float32Array>();
async function envelopeOf(userId: string, videoId: string): Promise<{ env: Float32Array; name: string }> {
  const d = await deepOf(userId, videoId);
  if (!d.ready || !d.audio) throw new AppError(d.note ?? `"${d.name}" has no sound measurements yet: ask again in a minute.`, 409, "not-ready");
  const key = d.audio.key ?? videoId;
  let env = envelopeCache.get(key);
  if (!env) {
    const f = await audioFramesOf(d.audio);
    if (!f || f.n < 100) throw new AppError(`"${d.name}" has no sound to sync by.`, 400, "no-sound");
    env = syncEnvelope(f.db);
    envelopeCache.set(key, env);
    while (envelopeCache.size > 8) envelopeCache.delete(envelopeCache.keys().next().value as string);
  }
  return { env, name: d.name };
}

/**
 * Phase 22: the videos' start timecodes. One never read (added before timecode was read on probe) is read by the worker
 * now (its file probed where it is); the wait is a few seconds at most, then the sound decides alone.
 */
async function timecodesOf(userId: string, ids: string[]) {
  const read = () => prisma.video.findMany({ where: { id: { in: ids }, userId }, select: { id: true, timecode: true, fps: true, name: true } });
  let vs = await read();
  const unread = vs.filter((v) => v.timecode === null).map((v) => v.id);
  if (unread.length) {
    await enqueue<TimecodeJob>("test", { kind: "timecode", videoIds: unread }, { attempts: 1, jobId: `tc-${unread.join("-").slice(0, 80)}-${Date.now()}` }).catch(() => {});
    const end = Date.now() + 8000;
    while (Date.now() < end && vs.some((v) => v.timecode === null)) { await new Promise((r) => setTimeout(r, 700)); vs = await read(); }
  }
  return new Map(vs.map((v) => [v.id, { timecode: v.timecode, fps: v.fps ?? 30, name: v.name }]));
}

/**
 * One angle synced to the main video: its offset (angle time = main time + offset), how it was found, how sure, its
 * name and turn. Phase 22: by timecode when both files carry one; the sound checks it and is used when timecode is
 * missing or disagrees (a camera whose clock was not jammed).
 */
export async function syncAngle(userId: string, mainVideoId: string, videoId: string): Promise<AngleSync> {
  if (videoId === mainVideoId) throw new AppError("That is the main video: pick another camera.", 400, "same-video");
  const tcs = await timecodesOf(userId, [mainVideoId, videoId]);
  const m = tcs.get(mainVideoId), v = tcs.get(videoId);
  const tc = m && v ? timecodeOffset(m, v) : null;
  let sound: SyncResult | null = null, name = v?.name ?? "", soundError: AppError | null = null;
  try {
    const [a, b] = await Promise.all([envelopeOf(userId, mainVideoId), envelopeOf(userId, videoId)]);
    sound = syncOffset(a.env, b.env);
    name = b.name;
  } catch (e) { if (!(e instanceof AppError) || tc == null) throw e; soundError = e; }
  const pick = pickSync(tc, sound)!;
  const vision = await prisma.footageAnalysis.findUnique({ where: { videoId }, select: { vision: true } });
  const turned = (vision?.vision as { turned?: number } | null)?.turned;
  const base: SyncResult = sound ?? { offset: pick.offset, score: 0, margin: 1, overlap: 0, sure: true };
  return { ...base, offset: pick.offset, checked: !!sound, videoId, name: name.slice(0, 40), by: pick.by, note: soundError ? `${pick.note} (${soundError.message})` : pick.note,
    sure: pick.by === "timecode" ? true : !!(sound as { sure?: boolean } | null)?.sure, ...(turned === 90 || turned === 180 || turned === 270 ? { rotate: turned } : {}) };
}

/** multicam ops whose angles have no offset get one from the sound (and the angle's name and turn when not sent). */
export async function resolveMulticam<T extends { op: string }>(userId: string, mainVideoId: string, edits: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const e of edits) {
    const angles = (e as { angles?: { videoId: string; offset?: number; name?: string; rotate?: number; score?: number }[] }).angles;
    if (e.op !== "multicam" || !angles?.some((a) => a.offset == null)) { out.push(e); continue; }
    const filled = [];
    for (const a of angles) {
      if (a.offset != null) { filled.push(a); continue; }
      const s = await syncAngle(userId, mainVideoId, a.videoId);
      filled.push({ ...a, offset: s.offset, ...(s.checked ? { score: s.score } : {}), sync: s.by, ...(a.name ? {} : { name: s.name }), ...(a.rotate == null && s.rotate ? { rotate: s.rotate } : {}) });
    }
    out.push({ ...e, angles: filled });
  }
  return out;
}

// ---------------- Phase 13: cut to whoever speaks ----------------
async function loudnessOf(userId: string, videoId: string): Promise<{ db: Int8Array; name: string }> {
  const d = await deepOf(userId, videoId);
  if (!d.ready || !d.audio) throw new AppError(d.note ?? `"${d.name}" has no sound measurements yet: ask again in a minute.`, 409, "not-ready");
  const f = await audioFramesOf(d.audio);
  if (!f || f.n < 100) throw new AppError(`"${d.name}" has no sound to tell who speaks by.`, 400, "no-sound");
  return { db: f.db, name: d.name };
}

type AutoSettings = { cameras?: string[]; wide?: string; minShot?: number; start?: number; end?: number };
type AngleLike = { videoId: string; offset: number; name?: string };

/** The cameras a multicam_auto names ("main", an angle's videoId or name), and its plan from their sound. */
export async function autoPlan(userId: string, mainVideoId: string, tl: Pick<Timeline, "tracks"> & { multicam?: { angles: AngleLike[] } }, o: AutoSettings): Promise<AnglePlanPart[]> {
  const angles = tl.multicam?.angles ?? [];
  if (!angles.length) throw new AppError("This edit has no multicam: add the other cameras first.", 400, "no-multicam");
  const resolve = (ref: string) => {
    if (ref === "main" || ref === mainVideoId) return "main";
    const a = angles.find((x) => x.videoId === ref || (x.name ?? "").toLowerCase() === ref.toLowerCase());
    if (!a) throw new AppError(`"${ref}" is not a camera of this edit (${["main", ...angles.map((x) => x.name ?? x.videoId)].join(", ")}).`, 400, "invalid-input");
    return a.videoId;
  };
  const picked = o.cameras?.length ? Array.from(new Set(o.cameras.map(resolve))) : ["main", ...angles.map((a) => a.videoId)];
  const wide = o.wide ? resolve(o.wide) : undefined;
  const speakers = picked.filter((a) => a !== wide);
  if (speakers.length < 2 && !wide) throw new AppError("Name at least two cameras to cut between.", 400, "invalid-input");
  const v1 = (tl.tracks.v1 as unknown as { sourceVideoId?: string; sourceIn: number; sourceOut: number }[]).filter((c) => c.sourceVideoId === mainVideoId);
  if (!v1.length) throw new AppError("No V1 clip plays the main video.", 400, "invalid-input");
  const from = o.start ?? Math.min(...v1.map((c) => c.sourceIn)), to = o.end ?? Math.max(...v1.map((c) => c.sourceOut));
  if (!(to - from >= 1)) throw new AppError("That stretch is under a second.", 400, "invalid-input");
  const sources: SpeakerSource[] = [];
  for (const a of speakers) {
    const l = await loudnessOf(userId, a === "main" ? mainVideoId : a);
    sources.push({ angle: a, db: l.db, offset: a === "main" ? 0 : angles.find((x) => x.videoId === a)!.offset });
  }
  return speakerPlan(sources, { from, to, minShot: o.minShot, wide });
}

/** multicam_auto edits without a plan get one, against the timeline as the batch has it by then (angles a multicam
 *  earlier in the same batch adds count). */
export async function resolveMulticamAuto<T extends { op: string }>(userId: string, mainVideoId: string, tl: Timeline, edits: T[]): Promise<T[]> {
  if (!edits.some((e) => e.op === "multicam_auto" && !(e as { plan?: unknown }).plan)) return edits;
  let angles: AngleLike[] = [...((tl.multicam?.angles as AngleLike[] | undefined) ?? [])];
  const out: T[] = [];
  for (const e of edits) {
    if (e.op === "multicam") {
      const m = e as unknown as { angles?: AngleLike[]; remove?: string[]; off?: boolean };
      if (m.off) angles = [];
      for (const a of m.angles ?? []) { const i = angles.findIndex((x) => x.videoId === a.videoId); const merged = { ...(i >= 0 ? angles[i] : {}), ...a } as AngleLike; if (i >= 0) angles[i] = merged; else angles.push(merged); }
      if (m.remove) angles = angles.filter((a) => !m.remove!.includes(a.videoId));
    }
    if (e.op === "multicam_auto" && !(e as { plan?: unknown }).plan) {
      const plan = await autoPlan(userId, mainVideoId, { tracks: tl.tracks, multicam: { angles: angles.filter((a) => a.offset != null) } }, e as unknown as AutoSettings);
      out.push({ ...e, plan });
    } else out.push(e);
  }
  return out;
}
