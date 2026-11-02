// The container's thread budget and what holds it. Railway caps every container at pids.max tasks (1000): every
// process and every thread counts, a dead process not yet collected (a zombie) too. When it is used up, nothing can
// start a thread: graphics recordings and FFmpeg fail with "pthread_create() failed" until the worker restarts.
//
// Two things used to eat it for hours: a recording browser killed or crashed leaves its child processes behind (handed
// to process 1, which collected nobody: the worker ran as `npx tsx`, now under tini), and those strays kept running or
// stayed as zombies. The watchdog (index.ts) looks every minute: it stops strays, says what holds the budget, and
// restarts the worker when the budget stays used up with no job running.
import { readdirSync, readFileSync } from "node:fs";

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** Tasks in use and allowed (null where the container does not say). */
export function threadUse(): { current: number | null; max: number | null } {
  const cur = Number(read("/sys/fs/cgroup/pids.current")?.trim());
  const m = read("/sys/fs/cgroup/pids.max")?.trim();
  return { current: Number.isFinite(cur) && cur > 0 ? cur : null, max: m && m !== "max" && Number(m) > 0 ? Number(m) : null };
}

export type Proc = { pid: number; ppid: number; comm: string; state: string; threads: number };

/** Every process the container can see, from /proc (empty where there is no /proc). */
export function processes(): Proc[] {
  let ids: string[] = [];
  try { ids = readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return []; }
  const out: Proc[] = [];
  for (const id of ids) {
    const stat = read(`/proc/${id}/stat`);
    if (!stat) continue;
    // "pid (comm) state ppid ...": the name can hold spaces and brackets, so it ends at the last ")".
    const a = stat.indexOf("("), b = stat.lastIndexOf(")");
    if (a < 0 || b < a) continue;
    const rest = stat.slice(b + 2).split(" ");
    const threads = Number(/^Threads:\s+(\d+)/m.exec(read(`/proc/${id}/status`) || "")?.[1] || 1);
    out.push({ pid: Number(id), comm: stat.slice(a + 1, b), state: rest[0], ppid: Number(rest[1]), threads });
  }
  return out;
}

/** The programs the worker starts for a job. One whose parent is gone (handed to process 1) is a stray: nothing will
 *  read its output or wait for it. */
const JOB_PROGRAM = /^(chrom|headless_shell|ffmpeg|ffprobe|python)/i;
export const isStray = (p: Proc, self = process.pid) => p.ppid === 1 && p.pid !== self && p.state !== "Z" && JOB_PROGRAM.test(p.comm);

/** What holds the budget: zombies, strays, browsers and FFmpeg (processes and their threads). */
export function threadReport(ps = processes()) {
  const sum = (f: (p: Proc) => boolean) => ps.filter(f).reduce((n, p) => n + p.threads, 0);
  return {
    zombies: ps.filter((p) => p.state === "Z").length,
    strays: ps.filter((p) => isStray(p)),
    browserThreads: sum((p) => /^(chrom|headless_shell)/i.test(p.comm)),
    ffmpegThreads: sum((p) => /^ff(mpeg|probe)/i.test(p.comm)),
    pythonThreads: sum((p) => /^python/i.test(p.comm)),
    workerThreads: ps.filter((p) => p.pid === process.pid).reduce((n, p) => n + p.threads, 0),
  };
}

/** Stops stray job programs (SIGKILL: their parent is gone, nothing is waiting for them). How many were stopped. */
export function stopStrays(strays: Proc[]): number {
  let n = 0;
  for (const p of strays) { try { process.kill(p.pid, "SIGKILL"); n++; } catch { /* already gone */ } }
  return n;
}

/**
 * One look, every minute: strays stopped, a line when the budget is over half used (or something was stopped), and
 * whether the worker should restart: the budget over 90% for three looks in a row with no job running (nothing can
 * start, and nothing of the user's is lost by a restart), or over 97% for ten looks whatever runs (every job fails).
 */
export function makeWatchdog(o: {
  activeJobs: () => number; restart: (why: string) => void; log?: (s: string) => void; minutes?: { idle?: number; any?: number };
  /** For tests: what the container shows, and how strays are stopped. */
  look?: () => { ps: Proc[]; use: { current: number | null; max: number | null } }; stop?: (strays: Proc[]) => number;
}) {
  const log = o.log ?? ((s: string) => console.log(s));
  let high = 0, full = 0;
  return () => {
    const seen = o.look ? o.look() : { ps: processes(), use: threadUse() };
    const r = threadReport(seen.ps);
    const stopped = r.strays.length ? (o.stop ?? stopStrays)(r.strays) : 0;
    const { current, max } = seen.use;
    if (current == null || max == null) { if (stopped) log(`[threads] stopped ${stopped} stray ${stopped === 1 ? "process" : "processes"} (${r.strays.map((p) => p.comm).join(", ")})`); return; }
    const share = current / max;
    if (share > 0.5 || stopped || r.zombies > 20) {
      log(`[threads] ${current} of ${max} in use: browsers ${r.browserThreads}, FFmpeg ${r.ffmpegThreads}, Python ${r.pythonThreads}, worker ${r.workerThreads}, ${r.zombies} zombies; ${o.activeJobs()} jobs running${stopped ? `; stopped ${stopped} stray (${r.strays.map((p) => p.comm).join(", ")})` : ""}`);
    }
    high = share > 0.9 && o.activeJobs() === 0 ? high + 1 : 0;
    full = share > 0.97 ? full + 1 : 0;
    if (high >= (o.minutes?.idle ?? 3)) o.restart(`threads used up (${current} of ${max}) with no job running`);
    else if (full >= (o.minutes?.any ?? 10)) o.restart(`threads used up (${current} of ${max}) for ${full} minutes`);
  };
}
