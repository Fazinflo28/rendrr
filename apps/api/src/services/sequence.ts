import { signGet } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { allWords, isSequence, outputDuration, sourceVideoIds, type Alignment, type Silence, type Snapshot, type Timeline, type Transcript } from "@rendrr/shared";
import { convertChecked } from "@rendrr/shared/migrate";

/** Video ids a sequence plays on V1 (its clips' footage and its multicam angles), other than its main footage. */
export function otherVideoIds(tl: Timeline, mainId: string): string[] {
  if (!isSequence(tl)) return [];
  // Every multicam angle, shown or not: the editor's camera monitors play them all.
  return Array.from(new Set([...sourceVideoIds(tl), ...(tl.multicam?.angles ?? []).map((a) => a.videoId)])).filter((v) => v !== mainId);
}

/** The other videos on V1 with what the ops and the check need: transcripts and silences (the user's own videos only). */
export async function otherSources(userId: string, tl: Timeline, mainId: string): Promise<Record<string, { transcript: Transcript; silences: Silence[]; alignment: Alignment | null }>> {
  const ids = otherVideoIds(tl, mainId);
  if (!ids.length) return {};
  const vs = await prisma.video.findMany({ where: { id: { in: ids }, userId }, include: { analysis: true } });
  return Object.fromEntries(vs.map((v) => [v.id, { transcript: (v.analysis?.transcript as unknown as Transcript) || [], silences: (v.analysis?.silences as unknown as Silence[]) || [], alignment: (v.analysis?.alignment as unknown as Alignment | null) ?? null }]));
}

/** What the editor's player needs for the other videos on V1: their preview copy, length, name and words. */
export async function playerVideos(userId: string, tl: Timeline, mainId: string) {
  const ids = otherVideoIds(tl, mainId);
  if (!ids.length) return {};
  const vs = await prisma.video.findMany({ where: { id: { in: ids }, userId }, include: { analysis: true } });
  return Object.fromEntries(await Promise.all(vs.map(async (v) => [v.id, {
    name: v.name, seconds: v.seconds, width: v.width, height: v.height,
    url: v.proxyKey && v.status !== "expired" ? await signGet(v.proxyKey, 6 * 3600) : null,
    transcript: (v.analysis?.transcript as unknown as Transcript) || [],
  }] as const)));
}

/**
 * Start-up migration to the sequence model (Phase 2). Each project still stored in model A is converted only when the
 * new planner gives the same render as the old one (convertChecked: picture, dialogue, captions, overlays and audio
 * within one frame); its old timeline is backed up first. A project that differs stays in model A: it keeps rendering
 * with the old planner and converts on its next edit. Versions are not touched: an old version converts when it is
 * restored, and renders with the old planner until then. Safe to run at every start (converted projects are skipped).
 */
export async function migrateToSequences(): Promise<{ converted: number; stayed: { id: string; why: string }[] }> {
  const ps = await prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, timeline: true } });
  const todo = ps.filter((p) => !isSequence(p.timeline as unknown as Timeline)).map((p) => p.id);
  let converted = 0;
  const stayed: { id: string; why: string }[] = [];
  for (const id of todo) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Project" WHERE id = ${id} FOR UPDATE`;
        const p = await tx.project.findUniqueOrThrow({ where: { id }, include: { video: { include: { analysis: true } } } });
        const tl = p.timeline as unknown as Timeline;
        if (isSequence(tl)) return;
        const transcript = (p.video.analysis?.transcript as unknown as Transcript) || [];
        const snap: Snapshot = { timeline: tl, name: p.name, aspect: p.aspect as Snapshot["aspect"], styleId: p.styleId };
        const brollIds = Array.from(new Set(tl.tracks.v2.map((c) => (c as { videoId?: string }).videoId).filter(Boolean) as string[]));
        const broll = brollIds.length ? await tx.video.findMany({ where: { id: { in: brollIds } }, select: { id: true, seconds: true } }) : [];
        const r = convertChecked(snap, transcript, {
          videoId: p.videoId,
          source: { width: p.video.width || 1920, height: p.video.height || 1080, fps: p.video.fps || 30, seconds: p.video.seconds, hasAudio: p.video.hasAudio },
          brollSeconds: Object.fromEntries(broll.map((b) => [b.id, b.seconds])),
        });
        if (r.differences.length) { stayed.push({ id, why: r.differences.slice(0, 3).join(" | ") }); return; }
        await tx.timelineBackup.create({ data: { projectId: id, version: null, model: "A", timeline: tl as unknown as Prisma.InputJsonValue } });
        // The list of edits is ordered by when they were changed: converting is not a change.
        await tx.project.update({ where: { id }, data: {
          timeline: r.timeline as unknown as Prisma.InputJsonValue, updatedAt: p.updatedAt,
          outputSeconds: Math.round(outputDuration(r.timeline, allWords(transcript)) * 100) / 100,
        } });
        converted++;
      }, { timeout: 20_000, maxWait: 10_000 });
    } catch (e) {
      stayed.push({ id, why: `failed: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return { converted, stayed };
}
