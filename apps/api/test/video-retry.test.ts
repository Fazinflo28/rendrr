// Retry and Rebuild on a library video run its job once: a double click, or a press while the job already runs,
// leaves the one job in place (no second preview on the same files, no second paid transcription).
// Needs a database and Redis (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("video Retry and Rebuild", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { queue, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "";
  const clerkId = `vrt_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const press = (id: string, what: "retry" | "rebuild") => app.inject({ method: "POST", url: `/videos/${id}/${what}`, headers: headers(), payload: {} });
  const jobsFor = async (name: "proxy" | "analyze", videoId: string) => (await queue(name).getJobs(["waiting", "delayed", "active", "prioritized"])).filter((j) => (j.data as { videoId?: string }).videoId === videoId);

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `vrt-${run}@test.rendrr.dev`, name: "Vrt" } })).id;
  });
  after(async () => {
    for (const name of ["proxy", "analyze"] as const) for (const j of await queue(name).getJobs(["waiting", "delayed", "prioritized"])) if ((j.data as { videoId?: string }).videoId?.length && (await prisma.video.findFirst({ where: { id: (j.data as { videoId: string }).videoId, userId } }))) await j.remove().catch(() => {});
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("Retry pressed twice at once makes one preview job", async () => {
    const v = await prisma.video.create({ data: { userId, name: "Talk", source: "upload", sourceKey: `raw/test-${run}.mp4`, status: "failed", error: "It broke", seconds: 30 } });
    const [a, b] = await Promise.all([press(v.id, "retry"), press(v.id, "retry")]);
    assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
    assert.equal((await jobsFor("proxy", v.id)).length, 1);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: v.id } })).status, "linking");
    // A third press while it is being made changes nothing.
    await press(v.id, "retry");
    assert.equal((await jobsFor("proxy", v.id)).length, 1);
  });

  it("Retry of a video waiting on its transcript makes one analyze job", async () => {
    const v = await prisma.video.create({ data: { userId, name: "Talk 2", source: "local", proxyKey: `proxies/t-${run}.mp4`, audioKey: `audio/t-${run}.m4a`, status: "failed", seconds: 30 } });
    await Promise.all([press(v.id, "retry"), press(v.id, "retry"), press(v.id, "retry")]);
    assert.equal((await jobsFor("analyze", v.id)).length, 1);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: v.id } })).status, "processing");
  });

  it("Rebuild pressed twice makes one preview job", async () => {
    const v = await prisma.video.create({ data: { userId, name: "Talk 3", source: "upload", sourceKey: `raw/test3-${run}.mp4`, status: "ready", seconds: 30 } });
    await Promise.all([press(v.id, "rebuild"), press(v.id, "rebuild")]);
    assert.equal((await jobsFor("proxy", v.id)).length, 1);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: v.id } })).status, "preview");
  });
});
