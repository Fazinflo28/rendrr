// The Projects page's cards: each project comes with the pictures of its newest edits (at most 4), and none when it has
// no edits (its card stays grey); the Claude card's projects get up to 4 too. Needs a database, Redis and storage.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("project cards' pictures", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { appFolders } = await import("../src/services/claudeApp");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", full = "", empty = "";
  const clerkId = `fcards_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `fcards-${run}@test.rendrr.dev`, name: "Cards" } })).id;
    full = (await prisma.folder.create({ data: { userId, name: `Six edits ${run}`, workspace: "Personal" } })).id;
    empty = (await prisma.folder.create({ data: { userId, name: `Empty ${run}`, workspace: "Personal" } })).id;
    for (let i = 0; i < 6; i++) {
      const v = await prisma.video.create({ data: { userId, name: `Clip ${i}`, seconds: 10, width: 720, height: 1280, source: "drive", status: "ready", proxyKey: `proxies/${run}-${i}.mp4`, thumbKey: `thumbs/${run}-${i}.jpg`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(10) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } });
      await createProject(userId, { videoId: v.id, name: `Edit ${i}`, folderId: full });
    }
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("the Projects page: 4 pictures of the newest edits, none for an empty project", async () => {
    const fs = (await app.inject({ method: "GET", url: "/folders", headers: headers() })).json() as { id: string; count: number; thumbs: string[] }[];
    const f = fs.find((x) => x.id === full)!, e = fs.find((x) => x.id === empty)!;
    assert.equal(f.count, 6);
    assert.equal(f.thumbs.length, 4, "never more than 4");
    assert.ok(f.thumbs.every((u) => /thumbs\/\w+-[2-5]\.jpg/.test(u)), "the newest edits' pictures (the last 4 made)");
    assert.deepEqual(e.thumbs, []);
  });

  it("the Claude card's projects: up to 4 too", async () => {
    const cards = await appFolders(userId);
    assert.equal(cards.find((x) => x.id === full)!.thumbs!.length, 4);
    assert.deepEqual(cards.find((x) => x.id === empty)!.thumbs, []);
  });
});
