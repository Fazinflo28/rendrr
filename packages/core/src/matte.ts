import { prisma } from "@rendrr/db";
import { clipsUnderBehind, MATTE_BLOCK, matteBlocks, matteJobId, matteKey, type SeqClip, type Timeline, type VisionSummary, type Word } from "@rendrr/shared";
import { enqueue, type MatteJob } from "./queue";
import { headObject, signGet } from "./storage";

/** Blocks queued by one edit at most (an hour of footage); a render makes any others itself. */
const MAX_BLOCKS = 360;

/**
 * One block's job (its id dedupes: a block queued, being made or failed within the hour is not queued again, so a
 * block that cannot be made is not retried every time the editor asks).
 */
const queueBlock = (userId: string, videoId: string, turn: number, k: number) =>
  enqueue<MatteJob>("matte", { videoId, userId, k, turn }, { jobId: matteJobId(videoId, turn, k), removeOnComplete: true, removeOnFail: { age: 3600 } });

/**
 * After an edit is saved: queues the blocks of footage whose matte is not made yet for every V1 clip with
 * remove_background or under a layer behind the person, so the editor can show the cut-out and renders find it ready. One job per block (the job id
 * dedupes). The turn is the footage's measured one (else the clip's), as the render uses.
 */
export async function prewarmMattes(userId: string, timeline: Timeline, words: Word[] = []) {
  // remove_background's clips, and (Phase 2) the clips under a text layer or graphic behind the person.
  const under = clipsUnderBehind(timeline, words);
  const clips = (timeline.tracks.v1 as (SeqClip & { subject?: unknown })[]).filter((c) => (c.subject || under.has(c.id)) && c.sourceVideoId);
  if (!clips.length) return 0;
  const videos = await prisma.video.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.sourceVideoId))) }, userId, proxyKey: { not: null } }, select: { id: true, seconds: true, analysis: { select: { vision: true } } } });
  const seen = new Set<string>();
  let queued = 0;
  for (const c of clips) {
    const v = videos.find((x) => x.id === c.sourceVideoId);
    if (!v) continue;
    const turn = (v.analysis?.vision as unknown as VisionSummary | null)?.turned ?? c.rotate ?? 0;
    for (const k of matteBlocks(c.sourceIn, c.sourceOut, v.seconds)) {
      const id = matteJobId(v.id, turn, k);
      if (seen.has(id) || seen.size >= MAX_BLOCKS) continue;
      seen.add(id);
      if (await headObject(matteKey(userId, v.id, turn, k))) continue;
      await queueBlock(userId, v.id, turn, k);
      queued++;
    }
  }
  return queued;
}

/**
 * The editor's view of a video's matte over footage from..to: each block's link (an hour) where it is made, null where
 * it is still being made. A missing block is queued (an edit made before a new matte version has none yet). The turn
 * is the one the render and prewarmMattes use.
 */
export async function matteBlockUrls(userId: string, videoId: string, from: number, to: number, clipRotate = 0) {
  const v = await prisma.video.findFirst({ where: { id: videoId, userId }, select: { id: true, seconds: true, proxyKey: true, analysis: { select: { vision: true } } } });
  if (!v) return null;
  const turn = (v.analysis?.vision as unknown as VisionSummary | null)?.turned ?? clipRotate;
  const blocks: Record<number, string | null> = {};
  for (const k of matteBlocks(from, to, v.seconds, 0).slice(0, 60)) {
    const key = matteKey(userId, v.id, turn, k);
    blocks[k] = (await headObject(key)) ? await signGet(key, 3600) : null;
    if (!blocks[k] && v.proxyKey) await queueBlock(userId, v.id, turn, k).catch(() => {});
  }
  return { turn, block: MATTE_BLOCK, blocks };
}
