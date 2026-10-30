import { downloadFile, headObject, queue, signGet, uploadFile } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { MATTE_BLOCK, matteJobId, matteKey, type VisionSummary } from "@rendrr/shared";
import type { RenderPlan } from "@rendrr/shared/renderPlan";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobError, run } from "./ffmpeg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATTE_PY = join(HERE, "../../python/matte.py");
const PYTHON = process.env.PYTHON_BIN || "python3";
/** MediaPipe's models (Apache-2.0), fetched into the worker image: the one that cuts the person out, and the fast one that finds them. */
export const MATTE_MODEL = process.env.MATTE_MODEL || "/opt/models/selfie/selfie_multiclass_256x256.tflite";
export const MATTE_LOCATE = process.env.MATTE_LOCATE || "/opt/models/selfie/selfie_segmenter.tflite";
/** Blocks made at once: each is two models, a decoder and an encoder (about 40 threads, one to two CPUs). */
const AT_ONCE = 2;

type MatteVideo = { id: string; userId: string; proxyKey: string | null; seconds: number; turn: number };

/** A video's row with the turn that makes its people upright (measured; else the turn the edit gives it). */
export async function matteVideo(videoId: string, userId: string, fallbackTurn = 0): Promise<MatteVideo> {
  const v = await prisma.video.findFirst({ where: { id: videoId, userId }, select: { id: true, userId: true, proxyKey: true, seconds: true, analysis: { select: { vision: true } } } });
  if (!v) throw new JobError("A video this edit cuts the person out of is not in the library any more.", "not-found", false);
  const turned = (v.analysis?.vision as unknown as VisionSummary | null)?.turned;
  return { id: v.id, userId: v.userId, proxyKey: v.proxyKey, seconds: v.seconds, turn: turned ?? fallbackTurn };
}

/**
 * One block of a video's matte (footage k x MATTE_BLOCK s on, from its preview copy), made and kept. The preview copy
 * is what the editor plays, so the preview, the final and the editor share one matte.
 */
export async function makeMatteBlock(v: MatteVideo, k: number, dir: string, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<string> {
  if (!v.proxyKey) throw new JobError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", "expired", false);
  if (!existsSync(MATTE_MODEL) || !existsSync(MATTE_LOCATE)) throw new JobError("The background remover is not installed on this server.", "no-model", false);
  const from = k * MATTE_BLOCK, to = Math.min(v.seconds, from + MATTE_BLOCK);
  if (to <= from) throw new JobError(`That part of the footage (from ${from}s) is past the video's end.`, "range", false);
  const out = join(dir, `matte-${v.id}-${k}.mp4`);
  await run(PYTHON, [MATTE_PY, "--input", await signGet(v.proxyKey, 3600), "--from", String(from), "--to", String(to), "--turn", String(v.turn), "--model", MATTE_MODEL, "--locate", MATTE_LOCATE, "--out", out],
    { signal, onLine: (l) => { const m = /^PROGRESS (\d+)/.exec(l); if (m) onProgress?.(Number(m[1]) / 100); } });
  await uploadFile(matteKey(v.userId, v.id, v.turn, k), out, "video/mp4");
  return out;
}

/**
 * A block a matte job is making: waited for (up to `ms`), then true if it is there. One still queued behind others is
 * taken off the queue (false: the render makes it now rather than wait its turn).
 */
async function waitForBlock(key: string, jobId: string, ms: number, signal?: AbortSignal) {
  const end = Date.now() + ms;
  while (Date.now() < end && !signal?.aborted) {
    if (await headObject(key)) return true;
    const job = await queue("matte").getJob(jobId).catch(() => null);
    const state = job ? await job.getState() : "gone";
    if (state !== "active") {
      if (["waiting", "delayed", "prioritized"].includes(state)) await job!.remove().catch(() => {});
      return !!(await headObject(key));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return !!(await headObject(key));
}

/**
 * The mattes a render reads (plan.mattes): every block kept in storage is fetched, every missing one made (AT_ONCE at
 * a time; one a matte job is making is waited for, one still queued is made here), and each matte's blocks joined in
 * an FFmpeg concat list.
 * Returns the lists by matte name (PlanFiles.mattes).
 */
export async function ensureMattes(plan: RenderPlan, userId: string, dir: string, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = Object.entries(plan.mattes ?? {});
  if (!entries.length) return out;
  const videos = new Map<string, MatteVideo>();
  for (const [, m] of entries) if (!videos.has(m.videoId)) videos.set(m.videoId, await matteVideo(m.videoId, userId, plan.parts.find((p) => p.videoId === m.videoId)?.rotate ?? 0));
  // Every block once, though several mattes share it.
  const need = new Map<string, { v: MatteVideo; k: number; path: string }>();
  for (const [, m] of entries) {
    const v = videos.get(m.videoId)!;
    for (const k of m.blocks) need.set(`${v.id}:${k}`, { v, k, path: join(dir, `matte-${v.id}-${k}.mp4`) });
  }
  const todo = Array.from(need.values());
  const done = new Map<string, number>();
  const report = () => onProgress?.(Array.from(done.values()).reduce((a, b) => a + b, 0) / todo.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, async () => {
    while (next < todo.length) {
      const b = todo[next++], id = `${b.v.id}:${b.k}`, key = matteKey(b.v.userId, b.v.id, b.v.turn, b.k);
      if (await headObject(key) || await waitForBlock(key, matteJobId(b.v.id, b.v.turn, b.k), 4 * 60_000, signal)) await downloadFile(key, b.path);
      else await makeMatteBlock(b.v, b.k, dir, signal, (f) => { done.set(id, f); report(); });
      done.set(id, 1);
      report();
    }
  }));
  for (const [name, m] of entries) {
    const v = videos.get(m.videoId)!;
    const list = join(dir, `${name}.txt`);
    await writeFile(list, m.blocks.map((k) => `file '${need.get(`${v.id}:${k}`)!.path}'\n`).join(""));
    out[name] = list;
  }
  return out;
}
