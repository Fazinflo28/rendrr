// Engine Part 5 through the connector: test_graphic sends the test to the worker's test queue and answers with its
// frames and measures; the same test again answers from the kept result; a wrong id or a graphic still recording
// answers at once. The worker's job is stood in for here (its own test draws real clips). Needs a database, Redis
// and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TestGraphicJob, TestGraphicResult } from "@rendrr/core";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("test_graphic through the connector", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const core = await import("@rendrr/core");
  const { QUEUES } = await import("@rendrr/shared");
  const { Worker } = await import("bullmq");

  let userId = "", videoId = "", busyId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `tgapi_${run}` });
  const seen: TestGraphicJob[] = [];
  // The worker's job, stood in for: it keeps what it was asked and stores a result with three frames.
  const worker = new Worker(QUEUES.test.name, async (job) => {
    const d = job.data as TestGraphicJob;
    seen.push(d);
    const base = `tests/${d.userId}/${d.key}`;
    const frames = [0, 1, 2].map((k) => `${base}-f${k}.jpg`);
    for (const k of [...frames, `${base}.mp4`]) await core.putObject(k, Buffer.from("x"), "image/jpeg");
    const r: TestGraphicResult = { clip: `${base}.mp4`, frames, times: [0.4, 2, 3.6], width: 540, height: 960, from: d.at, seconds: d.seconds, recordedMs: 2100, totalMs: 4300,
      cover: { min: 3, avg: 7.5, max: 12, samples: 8, visible: 8 }, face: d.over ? { max: 0, at: 0.25, of: 8 } : undefined, warnings: [] };
    await core.putObject(`${base}.json`, Buffer.from(JSON.stringify(r)), "application/json");
    return r;
  }, { connection: core.newRedis() });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `tgapi_${run}`, email: `tgapi-${run}@test.rendrr.dev`, name: "Test" } })).id;
    videoId = (await prisma.video.create({ data: { userId, name: `Vertical ${run}`, seconds: 30, width: 1080, height: 1920, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4` } })).id;
    busyId = (await prisma.graphic.create({ data: { ownerId: userId, name: "Busy", kind: "custom", durationSec: 10, status: "rendering" } })).id;
  });
  after(async () => {
    await worker.close();
    await core.deletePrefix(`tests/${userId}/`).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    await core.queue("test").close();
    await core.redis().quit().catch(() => {});
  });

  it("a template over a video: the footage's shape, the frames, what it covers; the same test again is kept", async () => {
    const r = await TOOL_HANDLERS.test_graphic(c(), { graphicId: "gt_lower_third", params: { name: "Ronny" }, over: { videoId, time: 12 } });
    assert.equal(seen.length, 1);
    assert.deepEqual({ ...seen[0], key: "" }, { userId, key: "", graphicId: "gt_lower_third", params: { name: "Ronny" }, at: 0, seconds: 4, aspect: "9:16", over: { videoId, time: 12 } });
    assert.match(r.text, new RegExp(`^TEST "Lower third" with \\{"name":"Ronny"\\}: 0-4s of it over "Vertical ${run}" from 12s, 540x960 \\(9:16\\); recorded in 2\\.1 s, done in 4\\.3 s\\. Of the frame: min 3%, avg 8%, max 12%, shows in 8 of 8 moments; over the face up to 0% \\(at 0\\.25s of the test\\)\\. 3 frames attached \\(0\\.4s, 2s, 3\\.6s of the test\\)\\. Clip \\(1 hour\\): \\S+ Nothing was changed\\.$`));
    assert.equal(r.images?.length, 3);
    const again = await TOOL_HANDLERS.test_graphic(c(), { graphicId: "gt_lower_third", params: { name: "Ronny" }, over: { videoId, time: 12 } });
    assert.equal(seen.length, 1, "kept: not drawn again");
    assert.match(again.text, /the same test as before \(kept a day\), answered in \d+\.\d s/);
  });

  it("a wrong id, a graphic still recording, a video not in the library: said at once", async () => {
    await assert.rejects(TOOL_HANDLERS.test_graphic(c(), { graphicId: "nope" }), /does not exist/);
    assert.match((await TOOL_HANDLERS.test_graphic(c(), { graphicId: busyId })).text, /is still recording: get_graphic shows how far it got/);
    await assert.rejects(TOOL_HANDLERS.test_graphic(c(), { graphicId: "gt_title_card", over: { videoId: "nope", time: 0 } }), /not in the library/);
    assert.equal(seen.length, 1);
  });
});
