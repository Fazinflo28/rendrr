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

/** One job's measured cost (see apps/worker/src/lib/cost.ts). Never throws. */
export async function saveJobCost(row: {
  userId?: string | null; queue: string; jobId: string; kind: string; refId?: string | null; ok: boolean; wallMs: number;
  cpuSeconds: number; memGbSeconds: number; transcribeSeconds?: number; egressBytes?: number; outputBytes?: number; measured?: string;
  costCompute: number; costMemory: number; costTranscribe: number; costEgress: number; costTotal: number;
}) {
  try {
    await prisma.jobCost.create({ data: {
      userId: row.userId ?? null, queue: row.queue, jobId: row.jobId, kind: row.kind, refId: row.refId ?? null, ok: row.ok, wallMs: Math.round(row.wallMs),
      cpuSeconds: row.cpuSeconds, memGbSeconds: row.memGbSeconds, transcribeSeconds: row.transcribeSeconds ?? 0,
      egressBytes: BigInt(Math.round(row.egressBytes ?? 0)), outputBytes: BigInt(Math.round(row.outputBytes ?? 0)), measured: row.measured ?? "cgroup",
      costCompute: row.costCompute, costMemory: row.costMemory, costTranscribe: row.costTranscribe, costEgress: row.costEgress, costTotal: row.costTotal,
    } });
  } catch (e) { console.error("[cost] not saved:", (e as Error).message); }
}
