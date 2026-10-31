// Phase 10: multicam sync on the server. An angle added without an offset is synced to the main video by their sound:
// both videos' loudness every 10 ms (the deep measurements, made once per video and kept) through shared/multicam.ts.
// The editor asks for one angle's sync (its route); apply_edits fills the offsets the AI left out.
import { AppError } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { syncEnvelope, syncOffset, type SyncResult } from "@rendrr/shared";
import { audioFramesOf, deepOf } from "./deep";

export type AngleSync = SyncResult & { videoId: string; name: string; rotate?: 0 | 90 | 180 | 270 };

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

/** One angle synced to the main video: its offset (angle time = main time + offset), how sure, its name and turn. */
export async function syncAngle(userId: string, mainVideoId: string, videoId: string): Promise<AngleSync> {
  if (videoId === mainVideoId) throw new AppError("That is the main video: pick another camera.", 400, "same-video");
  const [a, b] = await Promise.all([envelopeOf(userId, mainVideoId), envelopeOf(userId, videoId)]);
  const r = syncOffset(a.env, b.env);
  const vision = await prisma.footageAnalysis.findUnique({ where: { videoId }, select: { vision: true } });
  const turned = (vision?.vision as { turned?: number } | null)?.turned;
  return { ...r, videoId, name: b.name.slice(0, 40), ...(turned === 90 || turned === 180 || turned === 270 ? { rotate: turned } : {}) };
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
      filled.push({ ...a, offset: s.offset, score: s.score, ...(a.name ? {} : { name: s.name }), ...(a.rotate == null && s.rotate ? { rotate: s.rotate } : {}) });
    }
    out.push({ ...e, angles: filled });
  }
  return out;
}
