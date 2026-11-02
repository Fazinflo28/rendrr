// The thread watchdog (lib/threads.ts): it reads what runs from /proc, calls a job program whose parent is gone a
// stray and stops it, says what holds the container's thread budget, and restarts the worker when the budget stays
// used up: after three looks over 90% with no job running, after ten over 97% whatever runs, never while it is fine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { isStray, makeWatchdog, processes, stopStrays, threadReport, type Proc } from "../src/lib/threads";

const proc = (pid: number, comm: string, ppid: number, threads = 1, state = "S"): Proc => ({ pid, comm, ppid, threads, state });

describe("thread watchdog", () => {
  it("reads the processes from /proc, this worker with its threads", () => {
    const me = processes().find((p) => p.pid === process.pid);
    assert.ok(me, "this process is listed");
    assert.ok(me!.threads >= 1 && me!.ppid > 0);
  });

  it("a stray is a browser, FFmpeg or Python whose parent is gone; the worker's own children and zombies are not", () => {
    assert.equal(isStray(proc(50, "chromium", 1)), true);
    assert.equal(isStray(proc(51, "chrome", 1)), true);
    assert.equal(isStray(proc(52, "ffmpeg", 1)), true);
    assert.equal(isStray(proc(53, "python3", 1)), true);
    assert.equal(isStray(proc(54, "chromium", process.pid)), false, "a browser the worker runs");
    assert.equal(isStray(proc(55, "chromium", 1, 1, "Z")), false, "a zombie cannot be stopped, only collected");
    assert.equal(isStray(proc(56, "node", 1)), false, "npx and the worker itself are left alone");
    const r = threadReport([proc(60, "chromium", 1, 40), proc(61, "chromium", process.pid, 30), proc(62, "ffmpeg", process.pid, 12), proc(63, "x", 1, 1, "Z"), proc(process.pid, "node", 1, 11)]);
    assert.deepEqual([r.zombies, r.strays.map((p) => p.pid), r.browserThreads, r.ffmpegThreads, r.workerThreads], [1, [60], 70, 12, 11]);
  });

  it("stops a stray for real", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const gone = new Promise<string | null>((r) => child.on("exit", (_c, sig) => r(sig)));
    assert.equal(stopStrays([proc(child.pid!, "sleep", 1)]), 1);
    assert.equal(await gone, "SIGKILL");
    assert.equal(stopStrays([proc(child.pid!, "sleep", 1)]), 0, "already gone: nothing to stop");
  });

  it("restarts after three looks over 90% with no job running; not while a job runs or after a dip", () => {
    let use = 950, jobs = 0; const why: string[] = [], logs: string[] = [];
    const w = makeWatchdog({ activeJobs: () => jobs, restart: (s) => why.push(s), log: (s) => logs.push(s), look: () => ({ ps: [], use: { current: use, max: 1000 } }) });
    w(); w();
    use = 400; w(); // a dip starts the count again
    use = 950; w(); w();
    assert.equal(why.length, 0);
    jobs = 1; w(); w(); w(); // a job running: left alone
    assert.equal(why.length, 0);
    jobs = 0; w(); w(); w();
    assert.match(why[0], /threads used up \(950 of 1000\) with no job running/);
    assert.match(logs[0], /^\[threads\] 950 of 1000 in use: browsers 0, FFmpeg 0, Python 0, worker 0, 0 zombies; 0 jobs running$/);
  });

  it("restarts after ten looks over 97% even with jobs running (they all fail); says nothing while the budget is fine", () => {
    const why: string[] = [], logs: string[] = [];
    let use = 300;
    const w = makeWatchdog({ activeJobs: () => 2, restart: (s) => why.push(s), log: (s) => logs.push(s), look: () => ({ ps: [], use: { current: use, max: 1000 } }) });
    for (let i = 0; i < 5; i++) w();
    assert.deepEqual([why.length, logs.length], [0, 0], "quiet while under half");
    use = 990;
    for (let i = 0; i < 9; i++) w();
    assert.equal(why.length, 0);
    w();
    assert.match(why[0], /threads used up \(990 of 1000\) for 10 minutes/);
  });

  it("stops strays at each look and says so", () => {
    const stopped: number[] = [], logs: string[] = [];
    const w = makeWatchdog({ activeJobs: () => 0, restart: () => {}, log: (s) => logs.push(s), stop: (s) => { stopped.push(...s.map((p) => p.pid)); return s.length; },
      look: () => ({ ps: [proc(70, "chromium", 1, 20), proc(71, "chromium", 1, 15), proc(72, "chromium", process.pid, 60)], use: { current: 200, max: 1000 } }) });
    w();
    assert.deepEqual(stopped, [70, 71]);
    assert.match(logs[0], /^\[threads\] 200 of 1000 in use: browsers 95, .*; stopped 2 stray \(chromium, chromium\)$/);
  });
});
