import { costScope, logJob, newCostNotes, saveJobCost } from "@rendrr/core";
import { jobCost } from "@rendrr/shared";
import { jobEnded, jobStarted } from "./cost";
import { UnrecoverableError, type Job } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError } from "./ffmpeg";

export type Ctx = { signal: AbortSignal; dir: string; job: Job; isLastAttempt: boolean };

/** Jobs running in this worker now (the thread watchdog restarts the worker only when none is). */
let running = 0;
export const activeJobs = () => running;

/**
 * "Stop export": the API publishes "render:<renderId>" on STOP_CHANNEL (it has already marked the render stopped).
 * The job running it here is aborted where it stands (FFmpeg killed), not retried, and its failure is not recorded
 * again. Keys are "<queue>:<renderId or job id>".
 */
export const STOP_CHANNEL = "rendrr:stop";
const controllers = new Map<string, AbortController>();
const stopped = new Set<string>();
const keyOf = (queue: string, job: Job) => `${queue}:${(job.data as { renderId?: string } | null)?.renderId ?? job.id}`;
/** Stops the job with this key if it runs here; true when it did. */
export function stopJob(key: string): boolean {
  const ac = controllers.get(key);
  if (!ac) return false;
  stopped.add(key);
  ac.abort();
  return true;
}

/**
 * Wraps every job: a temp folder that is always deleted, a hard timeout that kills child processes,
 * and a log row for start / finish / fail with the duration. Friendly errors that retrying cannot fix
 * stop the retries.
 */
// Each queue's failure handling and name, so a job BullMQ fails on its own (it stalled twice: the worker died) is
// recorded the same way (failStalled).
const failures = new Map<string, { onFinalFail: (job: Job, message: string, code?: string) => Promise<unknown>; what: string }>();
/** BullMQ failed this job without running it to the end (it stalled: its worker died): record the failure. */
export async function failStalled(queue: string, job: Job, err: Error | undefined) {
  if (!/stalled/i.test(err?.message || "")) return false;
  const f = failures.get(queue);
  if (!f) return false;
  await f.onFinalFail(job, `${f.what} stopped when the server restarted. Nothing was lost. Try again.`, "stalled");
  return true;
}

export function guarded<T>(queue: string, timeoutMs: number | ((job: Job) => Promise<number>), what: string, fn: (ctx: Ctx) => Promise<T>, onFinalFail: (job: Job, message: string, code?: string) => Promise<void>, userIdOf?: (job: Job) => Promise<string | null>) {
  failures.set(queue, { onFinalFail, what });
  return async (job: Job): Promise<T> => {
    const started = Date.now();
    const ac = new AbortController();
    const key = keyOf(queue, job);
    controllers.set(key, ac);
    let timedOut = false;
    const limit = typeof timeoutMs === "number" ? timeoutMs : await timeoutMs(job).catch(() => 15 * 60_000);
    // The limit wins even when some step ignores the abort signal (a stalled download, a database call):
    // the job fails on time, the temp folder is removed and the queue moves on.
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; ac.abort(); reject(new Error(`${queue} job over its ${Math.round(limit / 1000)} s limit`)); }, limit); });
    running++;
    let dir = "";
    try { dir = await mkdtemp(join(tmpdir(), `rendrr-${queue}-`)); } catch (e) { running--; clearTimeout(timer); throw e; }
    const userId = userIdOf ? await userIdOf(job).catch(() => null) : null;
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await logJob({ queue, jobId: String(job.id), name: job.name, event: "start", userId, meta: { attempt: job.attemptsMade + 1 } });
    // Its cost: a share of the container's CPU and memory while it runs, and what it notes (transcription, uploads).
    const costKey = `${queue}:${job.id}:${started}`;
    const notes = newCostNotes();
    let ok = false;
    await jobStarted(costKey, queue).catch(() => {});
    try {
      const work = costScope(notes, () => fn({ signal: ac.signal, dir, job, isLastAttempt }));
      work.catch(() => {}); // if the limit wins, a late failure must not become an unhandled rejection
      // A stop ends the job at once too, even while a step ignores the signal.
      const halted = new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => { if (stopped.has(key)) reject(new Error("stopped by the user")); }, { once: true }));
      halted.catch(() => {});
      const r = await Promise.race([work, expired, halted]);
      ok = true;
      await logJob({ queue, jobId: String(job.id), name: job.name, event: "finish", userId, durationMs: Date.now() - started });
      return r;
    } catch (e) {
      if (stopped.has(key)) {
        // Stopped by the user: the API has recorded it already; no retry, nothing more to record.
        await logJob({ queue, jobId: String(job.id), name: job.name, event: "fail", userId, durationMs: Date.now() - started, error: "stopped by the user", meta: { final: true, stopped: true } });
        console.log(`[${queue}] job ${job.id} stopped by the user`);
        throw new UnrecoverableError("Stopped by the user.");
      }
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
      running--;
      try {
        const m = await jobEnded(costKey);
        const d = (job.data ?? {}) as { renderId?: string; videoId?: string; graphicId?: string; styleFileId?: string };
        await saveJobCost({
          userId, queue, jobId: String(job.id), kind: notes.kind ?? queue, refId: notes.refId ?? d.renderId ?? d.videoId ?? d.graphicId ?? d.styleFileId ?? null, ok,
          wallMs: Date.now() - started, ...m, transcribeSeconds: notes.transcribeSeconds, egressBytes: notes.egressBytes, outputBytes: notes.outputBytes,
          ...jobCost({ cpuSeconds: m.cpuSeconds, memGbSeconds: m.memGbSeconds, transcribeSeconds: notes.transcribeSeconds, egressBytes: notes.egressBytes }),
        });
      } catch { /* cost tracking never breaks a job */ }
      controllers.delete(key);
      stopped.delete(key);
      clearTimeout(timer);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export function throttle<T extends unknown[]>(fn: (...a: T) => unknown, ms: number) {
  let last = 0;
  return (...a: T) => { const now = Date.now(); if (now - last >= ms) { last = now; void Promise.resolve().then(() => fn(...a)).catch(() => {}); } };
}
