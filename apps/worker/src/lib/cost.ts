// What each job costs, measured. The container's own CPU and memory counters (cgroup v2, or v1) are read every couple
// of seconds and each interval's use is shared among the jobs running then, weighted by how heavy their kind of work
// is (a render uses far more CPU than a transcription that waits on AssemblyAI). What the worker uses while no job
// runs goes to an hourly "idle" row. The rows add up to what Railway bills for the worker.
import { readFile } from "node:fs/promises";
import { jobCost } from "@rendrr/shared";

/** How much of an interval's CPU and memory a running job of each queue takes, relative to the others running. */
export const QUEUE_WEIGHT: Record<string, number> = {
  render: 8, graphic: 6, matte: 6, proxy: 4, test: 3, deep: 3, breakdown: 2, frames: 2, style: 2,
  drive: 1, analyze: 0.5, heard: 0.5, maintenance: 0.5,
};
const weightOf = (queue: string) => QUEUE_WEIGHT[queue] ?? 1;

type Reading = { cpuSeconds: number; memBytes: number; at: number; source: "cgroup" | "process" };
type Running = { queue: string; cpuSeconds: number; memGbSeconds: number };

let source: "cgroup" | "process" | null = null;
async function readNumber(path: string): Promise<number | null> {
  try { const n = Number((await readFile(path, "utf8")).trim().split(/\s+/)[0]); return Number.isFinite(n) ? n : null; } catch { return null; }
}
/** The container's CPU seconds used so far and its memory now. */
export async function readUsage(): Promise<Reading> {
  const at = Date.now();
  // cgroup v2
  try {
    const stat = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
    const usec = Number(/usage_usec\s+(\d+)/.exec(stat)?.[1]);
    const mem = await readNumber("/sys/fs/cgroup/memory.current");
    if (Number.isFinite(usec) && mem != null) return { cpuSeconds: usec / 1e6, memBytes: mem, at, source: (source = "cgroup") };
  } catch { /* not v2 */ }
  // cgroup v1
  const ns = await readNumber("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  const mem1 = await readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (ns != null && mem1 != null) return { cpuSeconds: ns / 1e9, memBytes: mem1, at, source: (source = "cgroup") };
  // This process only (child processes are not counted): better than nothing, marked as such.
  const u = process.cpuUsage();
  return { cpuSeconds: (u.user + u.system) / 1e6, memBytes: process.memoryUsage().rss, at, source: (source = "process") };
}

const running = new Map<string, Running>();
let last: Reading | null = null;
let idle = { cpuSeconds: 0, memGbSeconds: 0, since: Date.now() };
let timer: NodeJS.Timeout | null = null;
let flushIdle: ((row: { cpuSeconds: number; memGbSeconds: number; wallMs: number; measured: string }) => Promise<void>) | null = null;

/** One reading: the CPU and memory used since the last one go to the jobs running now (or to idle). */
export async function sample(): Promise<void> {
  const r = await readUsage();
  if (!last) { last = r; return; }
  const dt = Math.max(0, (r.at - last.at) / 1000);
  const dCpu = Math.max(0, r.cpuSeconds - last.cpuSeconds);
  const memGbS = ((r.memBytes + last.memBytes) / 2 / 1024 ** 3) * dt;
  last = r;
  const jobs = Array.from(running.values());
  const total = jobs.reduce((s, j) => s + weightOf(j.queue), 0);
  if (!jobs.length || total <= 0) { idle.cpuSeconds += dCpu; idle.memGbSeconds += memGbS; }
  else for (const j of jobs) { const share = weightOf(j.queue) / total; j.cpuSeconds += dCpu * share; j.memGbSeconds += memGbS * share; }
  if (flushIdle && Date.now() - idle.since >= 3600_000) {
    const row = { cpuSeconds: idle.cpuSeconds, memGbSeconds: idle.memGbSeconds, wallMs: Date.now() - idle.since, measured: r.source };
    idle = { cpuSeconds: 0, memGbSeconds: 0, since: Date.now() };
    await flushIdle(row).catch(() => {});
  }
}

/** Starts the readings (every `everyMs`); `onIdle` saves the hourly idle row. */
export function startCostMeter(everyMs = 2000, onIdle?: typeof flushIdle) {
  flushIdle = onIdle ?? null;
  if (timer) return;
  void sample();
  timer = setInterval(() => { void sample().catch(() => {}); }, everyMs);
  timer.unref();
}
export function stopCostMeter() { if (timer) clearInterval(timer); timer = null; last = null; }

export async function jobStarted(key: string, queue: string) {
  await sample().catch(() => {});
  running.set(key, { queue, cpuSeconds: 0, memGbSeconds: 0 });
}
/** The job's measured CPU and memory (a last reading first); its row is the caller's to save. */
export async function jobEnded(key: string): Promise<{ cpuSeconds: number; memGbSeconds: number; measured: "cgroup" | "process" }> {
  await sample().catch(() => {});
  const j = running.get(key);
  running.delete(key);
  return { cpuSeconds: j?.cpuSeconds ?? 0, memGbSeconds: j?.memGbSeconds ?? 0, measured: source ?? "process" };
}

export { jobCost };
