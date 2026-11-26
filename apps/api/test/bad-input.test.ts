// Odd input gets a clear answer, never a 500: a review comment with a projectId that is not text, and a gallery
// like pressed twice at once (one like, the count right). Needs a database and Redis (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("bad input", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "", galleryId = "";
  const clerkId = `bad_${run}`, token = `bad-${run}-${Math.random().toString(36).slice(2, 10)}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `bad-${run}@test.rendrr.dev`, name: "Bad" } })).id;
    const folder = await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const v = await prisma.video.create({ data: { userId, name: "Talk", source: "local", status: "ready", seconds: 30 } });
    projectId = (await prisma.project.create({ data: { userId, folderId: folder.id, videoId: v.id, name: "Promo", timeline: {}, currentVersion: 1 } })).id;
    await prisma.review.create({ data: { token, userId, projectId, version: 1 } });
    galleryId = (await prisma.galleryItem.create({ data: { userId, author: "Bad", title: "Promo", styleId: "clean", ori: "9:16", platforms: [] } })).id;
  });
  after(async () => {
    await prisma.galleryItem.deleteMany({ where: { userId } });
    await prisma.review.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("a review comment whose projectId is not text goes on the review's own edit", async () => {
    for (const bad of [{ not: "" }, ["x"], 42]) {
      const r = await app.inject({ method: "POST", url: `/public/reviews/${token}/comments`, payload: { time: 1.5, text: "Tighter here", projectId: bad } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().projectId ?? projectId, projectId);
    }
    assert.equal(await prisma.reviewComment.count({ where: { reviewToken: token, text: "Tighter here" } }), 3);
  });

  it("a review comment carries the name its writer typed in; none (an older page) is Client", async () => {
    const send = (payload: object) => app.inject({ method: "POST", url: `/public/reviews/${token}/comments`, payload: { time: 2, text: "Louder music", ...payload } });
    assert.equal((await send({ name: "  Maya   Patel " })).json().author, "Maya Patel");
    assert.equal((await send({ name: "Sam Lee" })).json().author, "Sam Lee");
    assert.equal((await send({})).json().author, "Client");
    assert.equal((await send({ name: "x".repeat(81) })).statusCode, 400);
  });

  it("a like pressed twice at once is one like; pressed again it is taken away", async () => {
    const like = () => app.inject({ method: "POST", url: `/gallery/${galleryId}/like`, headers: headers(), payload: {} });
    const [a, b] = await Promise.all([like(), like()]);
    // Two presses at once: either both land as one like, or they toggle on and off; never an error, never a wrong count.
    assert.equal(a.statusCode, 200, a.body); assert.equal(b.statusCode, 200, b.body);
    const rows = await prisma.galleryLike.count({ where: { galleryItemId: galleryId } });
    assert.equal((await prisma.galleryItem.findUniqueOrThrow({ where: { id: galleryId } })).likes, rows, "the count matches the likes");
    const again = await like();
    assert.equal(again.statusCode, 200);
    const rows2 = await prisma.galleryLike.count({ where: { galleryItemId: galleryId } });
    assert.equal(rows2, rows ? 0 : 1);
    assert.equal((await prisma.galleryItem.findUniqueOrThrow({ where: { id: galleryId } })).likes, rows2);
  });
});
