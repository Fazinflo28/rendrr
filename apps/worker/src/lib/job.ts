import { logJob } from "@rendrr/core";
import { UnrecoverableError, type Job } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError } from "./ffmpeg";

export type Ctx = { signal: AbortSignal; dir: string; job: Job; isLastAttempt: boolean };

/**
 * Wraps every job: a temp folder that is always deleted, a hard timeout that kills child processes,
 * and a log row for start / finish / fail with the duration. Friendly errors that retrying cannot fix
 * stop the retries.
 */
export function guarded<T>(queue: string, timeoutMs: number, what: string, fn: (ctx: Ctx) => Promise<T>, onFinalFail: (job: Job, message: string, code?: string) => Promise<void>, userIdOf?: (job: Job) => Promise<string | null>) {
  return async (job: Job): Promise<T> => {
    const started = Date.now();
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    const dir = await mkdtemp(join(tmpdir(), `rendrr-${queue}-`));
    const userId = userIdOf ? await userIdOf(job).catch(() => null) : null;
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await logJob({ queue, jobId: String(job.id), name: job.name, event: "start", userId, meta: { attempt: job.attemptsMade + 1 } });
    try {
      const r = await fn({ signal: ac.signal, dir, job, isLastAttempt });
      await logJob({ queue, jobId: String(job.id), name: job.name, event: "finish", userId, durationMs: Date.now() - started });
      return r;
    } catch (e) {
      const err = e as Error & { friendly?: boolean; code?: string; retry?: boolean };
      const message = timedOut ? `${what} took too long. Try again.` : err.friendly ? err.message : `${what} did not finish. Nothing was lost. Try again.`;
      const final = isLastAttempt || timedOut || (err instanceof JobError && !err.retry);
      await logJob({ queue, jobId: String(job.id), name: job.name, event: "fail", userId, durationMs: Date.now() - started, error: (err.message || String(e)).slice(0, 500), meta: { final, timedOut } });
      console.error(`[${queue}] job ${job.id} failed${final ? " (final)" : ""}:`, (err.message || String(e)).slice(0, 800));
      if (final) {
        await onFinalFail(job, message, timedOut ? "timeout" : err.code).catch((x) => console.error("onFinalFail error", x));
        throw new UnrecoverableError(message);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export function throttle<T extends unknown[]>(fn: (...a: T) => unknown, ms: number) {
  let last = 0;
  return (...a: T) => { const now = Date.now(); if (now - last >= ms) { last = now; void fn(...a); } };
}
