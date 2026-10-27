// The deeper measurements as the tools read them (shared/deep.ts). A video measured before they existed is measured
// on first use: the tool says so and how long it takes, and answers fully once it is done (the worker's backfill
// measures the rest). Read only, apart from queueing that job.
import { AppError, enqueue, getBytes, notFound, readDeepProgress, type DeepJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { audioFrames, DEEP_VERSION, deepTimeoutMs, type Alignment, type AudioFrames, type DeepAudio, type VisionDetails, type VisionSummary } from "@rendrr/shared";
import { gunzipSync } from "node:zlib";

export type DeepVideo = { id: string; name: string; seconds: number; audio: DeepAudio | null; alignment: Alignment | null; vision: VisionSummary | null; ready: boolean; note: string | null };

const fmtLeft = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`);

/** The deeper measurements of one of the user's videos; `note` says what is missing and when it will be there. */
export async function deepOf(userId: string, videoId: string): Promise<DeepVideo> {
  const v = await prisma.video.findUnique({ where: { id: videoId }, select: { id: true, userId: true, name: true, seconds: true, status: true, proxyKey: true, analysis: { select: { audio: true, alignment: true, vision: true, deepVersion: true, deepError: true, deepAt: true } } } });
  if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
  const a = v.analysis;
  const base = { id: v.id, name: v.name, seconds: v.seconds, audio: (a?.audio as DeepAudio | null) ?? null, alignment: (a?.alignment as Alignment | null) ?? null, vision: (a?.vision as VisionSummary | null) ?? null };
  if (a?.deepVersion != null && a.deepVersion >= DEEP_VERSION) return { ...base, ready: true, note: null };
  if (v.status !== "ready" || !v.proxyKey) throw new AppError(`"${v.name}" is ${v.status}: it is measured once it is ready${v.status === "expired" ? " (rebuild its preview in the Library)" : ""}.`, 409, "not-ready");
  const progress = await readDeepProgress(v.id);
  if (progress) return { ...base, ready: false, note: `"${v.name}" is being measured: ${progress.step.toLowerCase()}, ${progress.percent}%${progress.etaSec != null ? `, about ${fmtLeft(progress.etaSec)} left` : ""}. Ask again then.` };
  // Not measured (or measured by an older version), or it failed: (re)start it, at most once an hour.
  const hour = new Date().toISOString().slice(0, 13);
  await enqueue<DeepJob>("deep", { videoId: v.id }, { jobId: `deep-${v.id}-v${DEEP_VERSION}-${hour}`, priority: 1 }).catch(() => {});
  // Measured on the live worker: about 0.1 s per second of footage (20 min in 2 min), plus the wait for its turn.
  const takes = fmtLeft(Math.min(deepTimeoutMs(v.seconds) / 1000, 30 + v.seconds * 0.2));
  if (a?.deepVersion != null) return { ...base, ready: false, note: `"${v.name}" was measured by an older version of Rendrr; measuring it again now. About ${takes}; ask again then.` };
  const why = a?.deepError ? `The last try failed (${a.deepError}); trying again now.` : "Measuring it now (it is done once, then kept).";
  return { ...base, ready: false, note: `"${v.name}" has no sound-every-10-ms, word-alignment or face measurements yet. ${why} About ${takes}; ask again then.` };
}

// The large parts live in storage; the last few read are kept in memory (a tool call often follows another).
const cache = new Map<string, unknown>();
function remember<T>(key: string, value: T): T {
  cache.set(key, value);
  while (cache.size > 6) cache.delete(cache.keys().next().value as string);
  return value;
}
export async function audioFramesOf(a: DeepAudio): Promise<AudioFrames | null> {
  if (!a.key) return null;
  if (cache.has(a.key)) return cache.get(a.key) as AudioFrames;
  const buf = await getBytes(a.key).catch(() => null);
  return buf ? remember(a.key, audioFrames(new Uint8Array(buf))) : null;
}
export async function visionDetailsOf(v: VisionSummary): Promise<VisionDetails | null> {
  if (!v.key) return null;
  if (cache.has(v.key)) return cache.get(v.key) as VisionDetails;
  const buf = await getBytes(v.key).catch(() => null);
  return buf ? remember(v.key, JSON.parse(gunzipSync(buf).toString()) as VisionDetails) : null;
}
