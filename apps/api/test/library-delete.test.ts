// Deleting a video from the library: footage no edit uses goes straight away; footage edits use is refused, naming
// them, until the app asks for the edits to go too (?edits=delete). Needs a database (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("deleting a video", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { buildServer } = await import("../src/server");
  const { createProject } = await import("../src/services/projects");
  const { redis } = await import("@rendrr/core");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "";
  const clerkId = `del_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const video = async (name: string) => (await prisma.video.create({ data: { userId, name, seconds: 20, source: "drive", status: "ready", analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [], sceneCuts: [], keyFrames: [] } } } })).id;

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `del-${run}@test.rendrr.dev`, name: "Del" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Del's Workspace" } });
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("footage no edit uses is deleted", async () => {
    const id = await video(`Unused ${run}`);
    const r = await app.inject({ method: "DELETE", url: `/videos/${id}`, headers: headers() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await prisma.video.count({ where: { id } }), 0);
  });

  it("footage in use: refused, naming the edits; with edits=delete both go", async () => {
    const id = await video(`Used ${run}`);
    const p = await createProject(userId, { videoId: id, name: `Cut ${run}` });
    const no = await app.inject({ method: "DELETE", url: `/videos/${id}`, headers: headers() });
    assert.equal(no.statusCode, 409);
    const err = JSON.parse(no.body).error;
    assert.equal(err.code, "in-use");
    assert.match(err.message, new RegExp(`used by 1 edit: "Cut ${run}"\\. Deleting it deletes that edit too`));
    assert.equal(await prisma.video.count({ where: { id } }), 1); // nothing changed
    const yes = await app.inject({ method: "DELETE", url: `/videos/${id}?edits=delete`, headers: headers() });
    assert.equal(yes.statusCode, 200, yes.body);
    assert.equal(await prisma.video.count({ where: { id } }), 0);
    assert.equal(await prisma.project.count({ where: { id: p.id } }), 0);
  });

  it("another account's video cannot be deleted", async () => {
    const other = await prisma.user.create({ data: { clerkId: `del2_${run}`, email: `del2-${run}@test.rendrr.dev`, name: "Other" } });
    const v = await prisma.video.create({ data: { userId: other.id, name: "Theirs", seconds: 5, source: "local", status: "ready" } });
    const r = await app.inject({ method: "DELETE", url: `/videos/${v.id}?edits=delete`, headers: headers() });
    assert.equal(r.statusCode, 404);
    assert.equal(await prisma.video.count({ where: { id: v.id } }), 1);
    await prisma.video.delete({ where: { id: v.id } }); await prisma.user.delete({ where: { id: other.id } });
  });
});
