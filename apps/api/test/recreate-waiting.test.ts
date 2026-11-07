// Recreate opens the editor at once: the edit waits for its footage (a hidden placeholder, the gallery video attached
// as its reference, the gallery video's shape), and the first video the user adds becomes its footage: version 1 is
// made again from it, the placeholder goes, the name, shape and reference stay. Needs a database and Redis.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("Recreate: an edit waiting for its footage", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { redis } = await import("@rendrr/core");
  const { stubTranscript, DEFAULT_STYLE_ID } = await import("@rendrr/shared");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", otherId = "", galleryId = "", footage = "", notReady = "";
  const clerkId = `rw_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `rw-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    otherId = (await prisma.user.create({ data: { clerkId: `rwo_${run}`, email: `rwo-${run}@test.rendrr.dev`, name: "Ben" } })).id;
    galleryId = (await prisma.galleryItem.create({ data: { userId, author: "Ana", title: "Skydo promo", styleId: DEFAULT_STYLE_ID, ori: "9:16", platforms: [] } })).id;
    footage = (await prisma.video.create({ data: { userId, name: "My take", seconds: 20, width: 1920, height: 1080, orientation: "Landscape", source: "drive", status: "ready", analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [], sceneCuts: [], keyFrames: [] } } } })).id;
    notReady = (await prisma.video.create({ data: { userId, name: "Still coming", seconds: 10, source: "drive", status: "processing" } })).id;
  });
  after(async () => {
    const ps = await prisma.project.findMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.galleryItem.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    void ps;
    await app.close(); await redis().quit().catch(() => {});
  });

  it("makes the edit at once, the reference attached, in the gallery video's shape, waiting for footage", async () => {
    const r = await app.inject({ method: "POST", url: "/projects", headers: headers(), payload: { waiting: true, reference: { kind: "recipe", id: galleryId }, aspect: "9:16", name: "Recreate: Skydo promo" } });
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json();
    assert.equal(p.name, "Recreate: Skydo promo");
    assert.equal(p.aspect, "9:16");
    assert.equal(p.reference?.kind, "recipe"); assert.equal(p.reference?.id, galleryId);
    const full = (await app.inject({ method: "GET", url: `/projects/${p.id}`, headers: headers() })).json();
    assert.equal(full.waiting, true, "the editor knows it is waiting for footage");
    const lib = (await app.inject({ method: "GET", url: "/videos", headers: headers() })).json();
    assert.ok(!lib.some((v: { name: string }) => /waiting for footage/.test(v.name)), "the placeholder is not in the library");

    // A video still being prepared is refused, clearly.
    const early = await app.inject({ method: "POST", url: `/projects/${p.id}/footage`, headers: headers(), payload: { videoIds: [notReady] } });
    assert.equal(early.statusCode, 409); assert.match(early.json().error?.message ?? early.body, /not ready/);

    // The first video added becomes the footage.
    const placeholder = full.video.id;
    const u = await app.inject({ method: "POST", url: `/projects/${p.id}/footage`, headers: headers(), payload: { videoIds: [footage] } });
    assert.equal(u.statusCode, 200, u.body);
    const after_ = (await app.inject({ method: "GET", url: `/projects/${p.id}`, headers: headers() })).json();
    assert.equal(after_.waiting, false);
    assert.equal(after_.videoId, footage);
    assert.equal(after_.name, "Recreate: Skydo promo", "the name stays");
    assert.equal(after_.aspect, "9:16", "the shape stays (the footage is framed to it)");
    assert.equal(after_.reference?.id, galleryId, "the reference stays");
    assert.equal(after_.versions.length, 1, "version 1 is the footage as recorded");
    assert.ok(after_.timeline.tracks.v1.length > 0 && after_.timeline.tracks.v1.every((c: { sourceVideoId?: string }) => (c.sourceVideoId ?? footage) === footage), "V1 is the new footage");
    assert.equal(await prisma.video.count({ where: { id: placeholder } }), 0, "the placeholder is gone");

    // Once it has its footage, more videos go on with Add clips.
    const again = await app.inject({ method: "POST", url: `/projects/${p.id}/footage`, headers: headers(), payload: { videoIds: [footage] } });
    assert.equal(again.statusCode, 409);
  });

  it("someone else's edit cannot be given footage", async () => {
    const p = (await app.inject({ method: "POST", url: "/projects", headers: headers(), payload: { waiting: true, name: "Mine" } })).json();
    const other = await app.inject({ method: "POST", url: `/projects/${p.id}/footage`, headers: { ...headers(), "x-rendrr-clerk-id": `rwo_${run}` }, payload: { videoIds: [footage] } });
    assert.ok([401, 403, 404].includes(other.statusCode), `refused (${other.statusCode})`);
  });
});
