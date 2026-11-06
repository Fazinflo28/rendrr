// Giving the original of local footage for a final: the same name and size, or a renamed or re-saved copy of the
// same length, is taken; a different video is refused, saying what was given and what is needed.
// Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("the original file for a final", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { buildServer } = await import("../src/server");
  const { createProject } = await import("../src/services/projects");
  const { abortMultipart, redis } = await import("@rendrr/core");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "";
  const clerkId = `orig_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const ask = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `/projects/${projectId}/original`, headers: headers(), payload: body });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `orig-${run}@test.rendrr.dev`, name: "Orig" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Orig's Workspace" } });
    const v = await prisma.video.create({ data: { userId, name: "Ranking", seconds: 658.7, source: "local", status: "ready", originalName: "Ranking cold outreaching methods-compressed.mp4", originalSize: BigInt(1_482_000_000), sizeBytes: BigInt(1_482_000_000), proxyKey: `proxies/${run}.mp4`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [], sceneCuts: [], keyFrames: [] } } } });
    projectId = (await createProject(userId, { videoId: v.id, name: `Orig ${run}` })).id;
  });
  after(async () => {
    for (const t of await prisma.tempOriginal.findMany({ where: { projectId } })) if (t.uploadId) await abortMultipart(t.key, t.uploadId).catch(() => {});
    await prisma.tempOriginal.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("takes the same name and size", async () => {
    const r = await ask({ name: "Ranking cold outreaching methods-compressed.mp4", size: 1_482_000_000 });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().urls.length > 0);
  });
  it("takes a renamed or re-saved copy of the same length", async () => {
    const r = await ask({ name: "Ranking cold outreaching methods.mp4", size: 1_400_000_000, seconds: 658.6 });
    assert.equal(r.statusCode, 200, r.body);
  });
  it("refuses a different video, saying what was given and what is needed", async () => {
    const r = await ask({ name: "Other.mp4", size: 9_000_000, seconds: 31 });
    assert.equal(r.statusCode, 400);
    console.log(r.json().error || r.json().message);
    assert.match(r.body, /That is a different video\. You picked 'Other\.mp4' \(9 MB, 0:31\.0\); we need 'Ranking cold outreaching methods-compressed\.mp4' \(1482 MB, 10:58\.7\)\./);
  });
});
