import { signGet, transcriber, usage, type HeardJob, type Transcriber } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import type { HeardTranscript } from "@rendrr/shared";
import type { Ctx } from "../lib/job";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Writes the preview's heard transcript into its render's plan (the check and get_preview_frames read it there). */
async function save(renderId: string, heard: HeardTranscript) {
  const r = await prisma.render.findUnique({ where: { id: renderId }, select: { plan: true } });
  if (!r) return;
  await prisma.render.update({ where: { id: renderId }, data: { plan: { ...((r.plan ?? {}) as Record<string, unknown>), heard } as unknown as Prisma.InputJsonValue } });
}

/**
 * Engine Part 3: a finished preview's sound transcribed again by the same transcriber as the footage, so "Transcript
 * as it plays" is what a viewer hears, not the footage's word times. Only the newest preview of an edit is done (an
 * older one is marked skipped). The transcriber has its own 8-minute limit; a failure is kept for the tools to say.
 */
export async function heardJob(ctx: Ctx, tx: Transcriber | null = transcriber()) {
  const { renderId } = ctx.job.data as HeardJob;
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  if (!r || r.kind !== "preview" || r.status !== "done" || !r.outputKey) return;
  const seconds = r.seconds;
  const newer = await prisma.render.findFirst({ where: { projectId: r.projectId, kind: "preview", status: "done", createdAt: { gt: r.createdAt } }, select: { id: true } });
  if (newer) return save(r.id, { status: "skipped", seconds });
  if (!tx) return save(r.id, { status: "off", seconds });
  await save(r.id, { status: "transcribing", startedAt: new Date().toISOString(), seconds });
  const sentences = await tx.transcribe(await signGet(r.outputKey, 2 * 3600), { signal: ctx.signal });
  const words = sentences.flat().map((w) => [w.text, r3(w.start), r3(w.end)] as [string, number, number]);
  await save(r.id, { status: "done", seconds, words, sentences: sentences.filter((s) => s.length).map((s) => [r3(s[0].start), s.map((w) => w.text).join(" ")] as [number, string]) });
  await usage(r.userId, "transcribe_preview", Math.round((seconds / 60) * 100) / 100, { projectId: r.projectId, renderId: r.id });
  console.log(`[heard] ${r.id}: ${Math.round(seconds)}s of preview transcribed again, ${words.length} words`);
}

/** The job failed for good: said where the transcript would be. */
export async function heardFailed(renderId: string, message: string) {
  const r = await prisma.render.findUnique({ where: { id: renderId }, select: { seconds: true } });
  await save(renderId, { status: "failed", error: message.slice(0, 300), seconds: r?.seconds ?? undefined }).catch(() => {});
}
