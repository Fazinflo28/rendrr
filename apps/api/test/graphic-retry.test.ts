// A graphic that failed on Rendrr's side (the browser could not start, the server ran out of threads) is recorded again
// from its own code with get_graphic retry: true: the result and list_graphics say so; its old job, still holding the
// graphic's id on the queue, is taken off so the new one is queued; a graphic whose own code failed is told to fix
// the code instead. Needs a database and Redis (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("recording a failed graphic again", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { enqueue, queue, redis } = await import("@rendrr/core");
  const { MCP_TOOLS } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  let userId = "", crashed = "", broken = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const graphic = (name: string, error: string) => prisma.graphic.create({ data: { ownerId: userId, name: `${name} ${run}`, kind: "custom", code: "<div style='color:#fff'>Hi</div>", durationSec: 3, width: 640, height: 360, status: "failed", error, attempts: 2 } });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `gr_${run}`, email: `gr-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    crashed = (await graphic("Crashed", "The graphic crashed while recording: Failed to launch the browser process:  spawn /usr/bin/chromium EAGAIN\n\nstderr:\n\nTROUBLESHOOTING: https://pptr.dev/troubleshooting")).id;
    broken = (await graphic("Broken", "The graphic code threw an error: ReferenceError: foo is not defined")).id;
  });
  after(async () => {
    for (const id of [crashed, broken]) await queue("graphic").remove(id).catch(() => {});
    await prisma.graphic.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { clerkId: `gr_${run}` } });
    await redis().quit().catch(() => {});
  });

  it("a server-side failure says it can be recorded again; a code error says to fix the code", async () => {
    assert.match((await tool("get_graphic", { graphicId: crashed })).text, /problem on Rendrr's side, not in the code: get_graphic \{graphicId: "\w+", retry: true\} records it again/);
    assert.match((await tool("get_graphic", { graphicId: broken })).text, /foo is not defined\. Fix the code and call create_graphic again\./);
    const list = (await tool("list_graphics", {})).text;
    assert.match(list, new RegExp(`${crashed} \\| Crashed ${run} \\| failed \\(The graphic crashed while recording: .*; get_graphic retry: true records it again\\)`));
    assert.doesNotMatch(list, /stderr:\n/, "the error is on one line");
    assert.doesNotMatch(list.split("\n").find((l) => l.startsWith(broken))!, /retry/);
  });

  it("retry: queued again from its own code, its old job taken off the queue first", async () => {
    // The first try's job is still on the queue under the graphic's id (BullMQ keeps failed jobs): it would stop a new one.
    await enqueue("graphic", { graphicId: crashed, stale: true }, { jobId: crashed });
    const out = await tool("get_graphic", { graphicId: crashed, retry: true });
    // No worker runs here: it is queued, and the answer says so.
    assert.match(out.text, new RegExp(`^${crashed} \\| Crashed ${run} \\| (queued|recording)`));
    const g = await prisma.graphic.findUniqueOrThrow({ where: { id: crashed } });
    assert.deepEqual([g.status, g.error, g.attempts], ["queued", null, 0]);
    const job = await queue("graphic").getJob(crashed);
    assert.deepEqual(job!.data, { graphicId: crashed }, "the new job, not the old one");
  });

  it("retry on a graphic that is not failed changes nothing", async () => {
    const before = await prisma.graphic.findUniqueOrThrow({ where: { id: crashed } });
    await tool("get_graphic", { graphicId: crashed, retry: true });
    const after_ = await prisma.graphic.findUniqueOrThrow({ where: { id: crashed } });
    assert.equal(after_.status, before.status);
  });
});
