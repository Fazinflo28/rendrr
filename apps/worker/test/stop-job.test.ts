// "Stop export": the worker stops the job running a render where it stands, without retrying it or recording its
// failure again (the API recorded the stop). Other jobs keep running; a key nothing runs under does nothing.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "bullmq";
import { guarded, stopJob } from "../src/lib/job";
import { run } from "../src/lib/ffmpeg";

const fakeJob = (id: string, data: object): Job => ({ id, name: "render", data, attemptsMade: 0, opts: { attempts: 2 } } as unknown as Job);

describe("stopping a job", () => {
  it("stops the render's job where it stands, kills its process, no retry and no failure recorded", async () => {
    const failures: string[] = [];
    let killedProcess = false;
    const handler = guarded("render", 60_000, "The render", async (ctx) => {
      // A long FFmpeg-like step that honours the signal.
      await run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { signal: ctx.signal }).catch((e) => { killedProcess = /Stopped/.test(String(e)); throw e; });
      return "finished";
    }, async (_job, msg) => { failures.push(msg); });
    const t0 = Date.now();
    const p = handler(fakeJob("job-1", { renderId: "r-1" }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stopJob("render:r-other"), false, "a render not running here: nothing happens");
    assert.equal(stopJob("render:r-1"), true);
    const err = await p.then(() => null, (e) => e);
    assert.ok(err, "the job ended");
    assert.equal(err.name, "UnrecoverableError", "not retried");
    assert.ok(Date.now() - t0 < 3000, "at once");
    assert.equal(failures.length, 0, "the failure is not recorded again (the API did)");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(killedProcess, "its process was killed");
    assert.equal(stopJob("render:r-1"), false, "forgotten once ended");
  });

  it("a step that ignores the signal still ends at once", async () => {
    const handler = guarded("render", 60_000, "The render", async () => { await new Promise((r) => setTimeout(r, 20000)); return "late"; }, async () => {});
    const p = handler(fakeJob("job-2", { renderId: "r-2" }));
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    stopJob("render:r-2");
    const err = await p.then(() => null, (e) => e);
    assert.equal(err?.name, "UnrecoverableError");
    assert.ok(Date.now() - t0 < 1000);
  });

  it("other jobs keep running", async () => {
    const handler = guarded("render", 60_000, "The render", async () => { await new Promise((r) => setTimeout(r, 400)); return "done"; }, async () => {});
    const a = handler(fakeJob("job-3", { renderId: "r-3" })), b = handler(fakeJob("job-4", { renderId: "r-4" }));
    await new Promise((r) => setTimeout(r, 50));
    stopJob("render:r-3");
    assert.equal((await a.then(() => "ok", (e) => e.name)), "UnrecoverableError");
    assert.equal(await b, "done");
  });
});
