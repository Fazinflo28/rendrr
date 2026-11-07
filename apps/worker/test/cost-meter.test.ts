// The worker's cost meter: the container's CPU and memory, shared among the jobs running at the time (by how heavy
// their kind of work is), and what a job notes while it runs (transcription, uploads); none of it outside a job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { costScope, newCostNotes, noteCost } from "@rendrr/core";
import { jobEnded, jobStarted, QUEUE_WEIGHT, readUsage, sample } from "../src/lib/cost";

test("the container's counters can be read (cgroup v2 or v1, else this process)", async () => {
  const r = await readUsage();
  assert.ok(r.cpuSeconds > 0 && r.memBytes > 0, JSON.stringify(r));
  console.log(`source ${r.source}: ${r.cpuSeconds.toFixed(1)} CPU s, ${(r.memBytes / 1024 ** 2).toFixed(0)} MB`);
});

test("CPU used while two jobs run is shared by their weights, and adds up to what was measured", async () => {
  await sample();
  await jobStarted("render:1", "render");
  await jobStarted("analyze:1", "analyze");
  const before = await readUsage();
  const end = Date.now() + 600; while (Date.now() < end) Math.sqrt(Math.random()); // burn some CPU
  await sample();
  const after = await readUsage();
  const r = await jobEnded("render:1"), a = await jobEnded("analyze:1");
  const measured = after.cpuSeconds - before.cpuSeconds;
  console.log(`render ${r.cpuSeconds.toFixed(3)} s, analyze ${a.cpuSeconds.toFixed(3)} s, measured ${measured.toFixed(3)} s`);
  // The container's CPU counts every process in it (other tests too), so the shares are checked, not an amount.
  // Both jobs ran the whole measured stretch: they split it 8 : 0.5 and together get all of it. The render also
  // gets the moment before the analyze job started, so its share can only be a little higher.
  const share = r.cpuSeconds / Math.max(1e-9, r.cpuSeconds + a.cpuSeconds), weight = QUEUE_WEIGHT.render / (QUEUE_WEIGHT.render + QUEUE_WEIGHT.analyze);
  assert.ok(a.cpuSeconds > 0 && share >= weight - 0.01 && share <= weight + 0.04, `shared 8 : 0.5 (render's share ${share.toFixed(3)}, weight ${weight.toFixed(3)})`);
  assert.ok(r.cpuSeconds + a.cpuSeconds >= measured * 0.95, "the two jobs get all the CPU measured while they ran");
  assert.ok(r.memGbSeconds > 0);
});

test("transcription seconds and uploaded bytes are noted inside a job only", async () => {
  noteCost({ transcribeSeconds: 99 }); // outside: nothing to note into, no error
  const n = newCostNotes();
  await costScope(n, async () => {
    noteCost({ transcribeSeconds: 61.5 });
    await new Promise((r) => setTimeout(r, 5));
    noteCost({ egressBytes: 1000, outputBytes: 1000, kind: "render_final", refId: "r1" });
  });
  assert.deepEqual(n, { transcribeSeconds: 61.5, egressBytes: 1000, outputBytes: 1000, kind: "render_final", refId: "r1" });
});
