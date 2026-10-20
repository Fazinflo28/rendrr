import { prisma } from "@rendrr/db";

// Every job start, finish and failure, with duration. Never logs tokens or file contents.
export async function logJob(e: { queue: string; jobId: string; name: string; event: "start" | "finish" | "fail"; userId?: string | null; durationMs?: number; error?: string; meta?: Record<string, unknown> }) {
  try {
    await prisma.jobLog.create({ data: { queue: e.queue, jobId: e.jobId, name: e.name, event: e.event, userId: e.userId ?? null, durationMs: e.durationMs ?? null, error: e.error?.slice(0, 500) ?? null, meta: (e.meta ?? {}) as object } });
  } catch { /* logging must never break a job */ }
}
export async function usage(userId: string, kind: string, amount = 0, meta: Record<string, unknown> = {}) {
  try { await prisma.usageEvent.create({ data: { userId, kind, amount, meta: meta as object } }); } catch { /* best effort */ }
}
