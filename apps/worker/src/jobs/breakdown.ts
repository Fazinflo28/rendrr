import { deletePrefix, downloadFile, enqueue, uploadFile, type BreakdownJob } from "@rendrr/core";
import { Prisma, prisma, type FootageAnalysis, type Video } from "@rendrr/db";
import { buildBreakdown, PREFIX, type Measured, type Silence, type Transcript, type VideoKind } from "@rendrr/shared";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { frameAt, run } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

const BREAKDOWN_PY = join(dirname(fileURLToPath(import.meta.url)), "../../python/breakdown.py");
const PYTHON = process.env.PYTHON_BIN || "python3";

/** Where a video's frames live (key frames, contact sheets, frames taken on request). Deleted together. */
export const framesPrefix = (v: { userId: string; id: string }) => `${PREFIX.frames}${v.userId}/${v.id}/`;

/**
 * Turns a video into what an AI can read without watching it: contact sheets of frames with their times, light,
 * colour and motion per shot, loudness per second and the beat (apps/worker/python/breakdown.py), joined with the
 * transcript and scene cuts into one breakdown (shared/breakdown.ts). Videos added from a computer also get their
 * five key frames and thumbnail here, since their preview is made in the browser.
 */
export async function breakdownVideo(ctx: Ctx, v: Video, an: Pick<FootageAnalysis, "transcript" | "silences" | "sceneCuts" | "keyFrames">, proxy: string, audio: string | null) {
  const out = join(ctx.dir, "sheets");
  await mkdir(out, { recursive: true });
  let pcm: string | null = null;
  if (audio && v.hasAudio) {
    pcm = join(ctx.dir, "audio8k.raw");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", audio, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", pcm], { signal: ctx.signal }).catch(() => { pcm = null; });
  }
  const cuts = (an.sceneCuts as number[]) || [];
  const { stdout } = await run(PYTHON, [BREAKDOWN_PY, proxy, "--seconds", String(v.seconds), "--cuts", JSON.stringify(cuts), ...(pcm ? ["--audio", pcm] : []), "--out", out], { signal: ctx.signal });
  const measured = JSON.parse(stdout.trim().split("\n").pop() || "{}") as Measured;
  if (!Array.isArray(measured.samples) || !measured.samples.length) throw new Error("no frames could be read");

  // Sheets of an earlier run (a retry, a rebuilt preview) are replaced.
  const base = framesPrefix(v);
  await deletePrefix(`${base}sheet-`);
  const sheetKeys: string[] = [];
  let bytes = 0; // every path that re-runs this has just reset previewSizeBytes for the new preview copy
  for (const s of measured.sheets) {
    const key = `${base}${s.file}`;
    bytes += await uploadFile(key, join(out, s.file), "image/jpeg");
    sheetKeys.push(key);
  }
  let overviewKey: string | null = null;
  if (measured.overview) {
    overviewKey = `${base}${measured.overview.file}`;
    bytes += await uploadFile(overviewKey, join(out, measured.overview.file), "image/jpeg");
  }

  // Key frames and thumbnail for videos that have none yet (added from a computer).
  let keyFrames = (an.keyFrames as { t: number; key: string }[]) || [];
  let thumbKey = v.thumbKey;
  if (!keyFrames.length) {
    const made: { t: number; key: string }[] = [];
    for (const [i, f] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
      const t = Math.round(v.seconds * f * 100) / 100, path = join(ctx.dir, `kf${i}.jpg`);
      await frameAt(proxy, t, path, 640, ctx.signal).catch(() => {});
      if (!(await stat(path).then((s) => s.size > 0).catch(() => false))) continue;
      const key = `${base}kf${i}.jpg`;
      bytes += await uploadFile(key, path, "image/jpeg");
      made.push({ t, key });
    }
    keyFrames = made;
    thumbKey = thumbKey || made[0]?.key || null;
  }

  const breakdown = buildBreakdown({
    video: { id: v.id, name: v.name, kind: (v.kind as VideoKind) || "footage", seconds: v.seconds, width: v.width || measured.size[0], height: v.height || measured.size[1], orientation: v.orientation, fps: v.fps || 30, hasAudio: v.hasAudio },
    transcript: (an.transcript as unknown as Transcript) || [],
    silences: (an.silences as unknown as Silence[]) || [],
    sceneCuts: cuts,
    measured,
    sheetKeys,
    overviewKey,
  });
  await prisma.footageAnalysis.update({ where: { videoId: v.id }, data: { breakdown: breakdown as unknown as Prisma.InputJsonValue, keyFrames: keyFrames as unknown as Prisma.InputJsonValue } });
  await prisma.video.update({ where: { id: v.id }, data: { thumbKey, previewSizeBytes: { increment: BigInt(bytes) } } });
  return breakdown;
}

/** Breakdown for a video analysed before breakdowns existed (or whose breakdown failed): from its preview copy. */
export async function breakdownJob(ctx: Ctx) {
  const { videoId } = ctx.job.data as BreakdownJob;
  const v = await prisma.video.findUnique({ where: { id: videoId }, include: { analysis: true } });
  if (!v?.analysis || !v.proxyKey || v.status !== "ready") return;
  const proxy = join(ctx.dir, "proxy.mp4");
  await downloadFile(v.proxyKey, proxy);
  let audio: string | null = null;
  if (v.audioKey) { audio = join(ctx.dir, "audio.m4a"); await downloadFile(v.audioKey, audio).catch(() => { audio = null; }); }
  await breakdownVideo(ctx, v, v.analysis, proxy, audio);
}

/**
 * Queues a breakdown for every ready video that has none, or whose breakdown was made before overview sheets existed
 * (at most once a day each). Returns how many.
 */
export async function queueMissingBreakdowns(): Promise<number> {
  const missing = await prisma.video.findMany({ where: { status: "ready", proxyKey: { not: null }, analysis: { is: { breakdown: { equals: Prisma.DbNull } } } }, select: { id: true }, take: 200, orderBy: { createdAt: "desc" } });
  const made = await prisma.footageAnalysis.findMany({ where: { breakdown: { not: Prisma.DbNull }, video: { status: "ready", proxyKey: { not: null } } }, select: { videoId: true, breakdown: true }, take: 500 });
  const noOverview = made.filter((a) => { const f = (a.breakdown as { frames?: { sheets?: unknown[]; overview?: unknown } } | null)?.frames; return !!f && f.overview === undefined && (f.sheets?.length ?? 0) > 1; }).map((a) => ({ id: a.videoId }));
  const day = new Date().toISOString().slice(0, 10);
  const all = [...missing, ...noOverview];
  for (const v of all) await enqueue<BreakdownJob>("breakdown", { videoId: v.id }, { jobId: `breakdown-${v.id}-${day}` }).catch(() => {});
  return all.length;
}
