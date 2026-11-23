// A job's time limit moved later while it waits on something that is not this server's work (the user's computer
// fetching a render's files): a job that would have run over its limit finishes; one that is not moved still fails on
// time; the moving is capped.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "bullmq";
import { EXTEND_MAX_MS, guarded } from "../src/lib/job";

const fakeJob = (id: string): Job => ({ id, name: "render", data: { renderId: id }, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("moving a job's time limit later", () => {
  it("a job past its limit that moved it finishes; one that did not fails on time", async () => {
    const failed: string[] = [];
    const moved = guarded("render", 400, "The render", async (ctx) => { for (let k = 0; k < 6; k++) { await sleep(100); ctx.extend?.(100); } return "made"; }, async (_j, m) => { failed.push(m); });
    assert.equal(await moved(fakeJob("x-1")), "made", "600 ms of work under a 400 ms limit, moved as it went");
    const fixed = guarded("render", 400, "The render", async () => { await sleep(700); return "late"; }, async (_j, m) => { failed.push(m); });
    const err = await fixed(fakeJob("x-2")).then(() => null, (e) => e);
    assert.match(String(err?.message), /took too long/);
    assert.deepEqual(failed, ["The render took too long. Try again."]);
  });
  it("is capped: at most two hours in all, and nothing for a bad number", async () => {
    assert.equal(EXTEND_MAX_MS, 2 * 3600_000);
    const capped = guarded("render", 300, "The render", async (ctx) => { ctx.extend?.(Number.NaN); ctx.extend?.(-5000); await sleep(600); return "late"; }, async () => {});
    const err = await capped(fakeJob("x-3")).then(() => null, (e) => e);
    assert.match(String(err?.message), /took too long/, "a bad number moves nothing");
  });
});
