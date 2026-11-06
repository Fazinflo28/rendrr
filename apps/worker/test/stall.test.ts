// A frozen FFmpeg is stopped, not waited on for half an hour (a heavy final sat at 78% with the CPU idle until the
// job's limit): run's stallMs watch stops a process whose output time has not moved while it used almost no CPU,
// and says where it stood and what its threads were doing. A slow but working process (CPU busy) and a process
// that keeps making progress are left alone. Short music is looped in a pass of its own (loopedMusic).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { probe, run, Stalled, stalled } from "../src/lib/ffmpeg";
import { loopedMusic } from "../src/jobs/render";

const node = (code: string) => ["-e", code];

describe("the freeze watch", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "stall-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("stops a process that stopped moving and sits idle, and says where it stood", async () => {
    const t0 = Date.now();
    const err = await run(process.execPath, node(`process.stdout.write("out_time_us=1500000\\n"); setTimeout(() => {}, 30000);`), { onProgress: () => {}, stallMs: 1200, checkMs: 200 }).then(() => null, (e) => e);
    assert.ok(stalled(err), "rejects as frozen: " + err);
    assert.ok(err instanceof Stalled);
    assert.equal(err.at, 1.5);
    assert.ok(Date.now() - t0 < 4000, `within the limit (${Date.now() - t0} ms)`);
    assert.match(err.threads, /node/, "names its threads: " + err.threads);
    assert.match(err.message, /froze at 1\.50 s/);
  });

  it("leaves a slow process alone while it works (CPU busy, no progress)", async () => {
    const r = await run(process.execPath, node(`const end = Date.now() + 2500; while (Date.now() < end) {} process.stdout.write("out_time_us=1\\n");`), { onProgress: () => {}, stallMs: 1000, checkMs: 200 });
    assert.ok(r, "finished");
  });

  it("leaves a process alone while its output time keeps moving, even with the CPU idle", async () => {
    const r = await run(process.execPath, node(`let t = 0; const i = setInterval(() => { t += 1e5; process.stdout.write("out_time_us=" + t + "\\n"); if (t >= 1e6) clearInterval(i); }, 250);`), { onProgress: () => {}, stallMs: 1000, checkMs: 200 });
    assert.ok(r);
  });

  it("without stallMs nothing is watched", async () => {
    await run(process.execPath, node(`setTimeout(() => {}, 1500);`), { onProgress: () => {} });
  });

  it("stops a real FFmpeg that waits forever for its input, naming FFmpeg's own threads", async () => {
    const fifo = join(dir, "in.fifo");
    execFileSync("mkfifo", [fifo]);
    // A writer that sends two seconds of video (a frame every 75 ms, so FFmpeg reports progress as it goes), then keeps
    // the pipe open and sends nothing more.
    const raw = join(dir, "two-seconds.yuv");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=2", "-f", "rawvideo", "-pix_fmt", "yuv420p", raw]);
    const writer = spawn(process.execPath, node(`const fs = require("fs"); const fd = fs.openSync(${JSON.stringify(fifo)}, "w"); const all = fs.readFileSync(${JSON.stringify(raw)}); const F = 160 * 90 * 3 / 2; let k = 0; const t = setInterval(() => { if (k * F >= all.length) return clearInterval(t); fs.writeSync(fd, all.subarray(k * F, (k + 1) * F)); k++; }, 75); setTimeout(() => {}, 60000);`), { stdio: "ignore" });
    try {
      const err = await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "160x90", "-r", "10", "-i", fifo, "-progress", "pipe:1", "-nostats", "-f", "null", "-"], { onProgress: () => {}, stallMs: 2000, checkMs: 250 }).then(() => null, (e) => e);
      assert.ok(stalled(err), "frozen FFmpeg stopped: " + err);
      assert.ok(err.at > 0.5 && err.at <= 2.01, `it stood at the end of what it got (${err.at} s)`);
      assert.match(err.threads, /ffmpeg/i, "its threads: " + err.threads);
    } finally { writer.kill("SIGKILL"); }
  });
});

describe("music shorter than its part is looped on its own", () => {
  let dir = "", short = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "loop-music-"));
    short = join(dir, "short.m4a");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "aac", short]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("a 2 s song under a 5 s part becomes a 5.5 s WAV", async () => {
    const out = await loopedMusic(short, 5, join(dir, "looped.wav"));
    assert.ok(out);
    const p = await probe(out!);
    assert.ok(Math.abs(p.seconds - 5.5) < 0.05, `length ${p.seconds}`);
    assert.ok(p.hasAudio);
  });

  it("a song long enough is used as it is", async () => {
    assert.equal(await loopedMusic(short, 1.5, join(dir, "unused.wav")), null);
  });
});
