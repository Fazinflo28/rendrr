// A published video plays its real export in the gallery: publishing copies the edit's best export (and a still)
// to the gallery item, so the gallery serves the same bytes; an edit with no export yet takes it when the gallery is
// next loaded after its render is done; one published before it was ever rendered gets a preview started when the
// gallery is loaded (once); removing the video deletes its copy. Needs a database, Redis and storage.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("gallery plays the real video", { skip: !ready && "needs a database, Redis and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { deletePrefix, headObject, putObject, queue, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  const { previewGate } = await import("../src/tools");
  const { DEFAULT_STYLE_ID } = await import("@rendrr/shared");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", withExport = "", without = "", videoId = "", never = "", neverItem = "";
  const clerkId = `gm_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const clip = randomBytes(300_000), still = randomBytes(20_000);
  const publish = (projectId: string) => app.inject({ method: "POST", url: "/gallery", headers: headers(), payload: { projectId, title: "Promo", platforms: ["instagram"] } });
  const timeline = { tracks: { v1: [], v2: [], v3: [], a1: [], a2: [], a3: [] }, cut: [], captionsOn: false, captionLook: "clean" };

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `gm-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    const folder = await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    videoId = (await prisma.video.create({ data: { userId, name: "Talk", source: "local", status: "ready", seconds: 30 } })).id;
    const mk = (name: string) => prisma.project.create({ data: { userId, folderId: folder.id, videoId, name, timeline, currentVersion: 2, aspect: "9:16" } });
    withExport = (await mk(`With ${run}`)).id; without = (await mk(`Without ${run}`)).id;
    // An edit on footage with a preview copy, published before the gallery copied exports, and never rendered.
    const v2 = await prisma.video.create({ data: { userId, name: "Talk 2", source: "local", status: "ready", seconds: 30, proxyKey: `previews/test-gm-${run}/proxy.mp4` } });
    never = (await prisma.project.create({ data: { userId, folderId: folder.id, videoId: v2.id, name: `Never ${run}`, timeline, currentVersion: 1, aspect: "9:16" } })).id;
    await prisma.projectVersion.create({ data: { projectId: never, v: 1, note: "Start", timeline: { timeline, name: `Never ${run}`, aspect: "9:16" }, createdBy: "user" } });
    neverItem = (await prisma.galleryItem.create({ data: { userId, projectId: never, author: "Ana", title: "Old", styleId: DEFAULT_STYLE_ID, ori: "9:16", platforms: [] } })).id;
    await putObject(`previews/test-gm-${run}/a.mp4`, clip, "video/mp4");
    await putObject(`previews/test-gm-${run}/a-0.jpg`, still, "image/jpeg");
    await putObject(`previews/test-gm-${run}/old.mp4`, randomBytes(1000), "video/mp4");
    // An older version's preview, and the current version's preview: the current one is used.
    await prisma.render.create({ data: { projectId: withExport, userId, kind: "preview", version: 1, status: "done", steps: [], outputKey: `previews/test-gm-${run}/old.mp4`, framesKeys: [], seconds: 9, finishedAt: new Date() } });
    await prisma.render.create({ data: { projectId: withExport, userId, kind: "preview", version: 2, status: "done", steps: [], outputKey: `previews/test-gm-${run}/a.mp4`, framesKeys: [`previews/test-gm-${run}/a-0.jpg`], seconds: 12, finishedAt: new Date() } });
  });
  after(async () => {
    for (const j of await queue("render").getJobs(["waiting", "delayed", "prioritized"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await redis().del(`gallery-export:${neverItem}`).catch(() => {});
    const items = await prisma.galleryItem.findMany({ where: { userId } });
    await prisma.galleryItem.deleteMany({ where: { userId } });
    for (const g of items) await deletePrefix(`gallery/${g.id}`).catch(() => {});
    await prisma.reference.deleteMany({ where: { userId } });
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await deletePrefix(`previews/test-gm-${run}`).catch(() => {});
    await app.close(); await redis().quit().catch(() => {});
  });

  it("publishing copies the current version's export and a still; the gallery serves the same bytes", async () => {
    const r = await publish(withExport);
    assert.equal(r.statusCode, 200, r.body);
    const g = r.json();
    assert.ok(g.video && g.poster, "a video and a still");
    assert.equal(g.seconds, 12);
    assert.ok(Buffer.from(await (await fetch(g.video)).arrayBuffer()).equals(clip), "the export's bytes");
    assert.ok(Buffer.from(await (await fetch(g.poster)).arrayBuffer()).equals(still), "the still's bytes");
    const list = await app.inject({ method: "GET", url: "/gallery", headers: headers() });
    const mine = list.json().find((x: { id: string }) => x.id === g.id);
    assert.ok(mine?.video, "the gallery list has the video too");
    // The copy stays when the project's preview goes (retention, deleted edit).
    await prisma.render.updateMany({ where: { projectId: withExport }, data: { outputKey: null } });
    assert.ok(await headObject(`gallery/${g.id}.mp4`), "the gallery keeps its own copy");
    // Removing the video deletes its copy.
    assert.equal((await app.inject({ method: "DELETE", url: `/gallery/${g.id}`, headers: headers() })).statusCode, 200);
    assert.equal(await headObject(`gallery/${g.id}.mp4`), null);
    assert.equal(await headObject(`gallery/${g.id}.jpg`), null);
  });

  it("an edit with no export yet takes it when the gallery is next loaded after its render is done", async () => {
    const r = await publish(without);
    assert.equal(r.statusCode, 200, r.body);
    const g = r.json();
    assert.equal(g.video, null, "nothing to play yet");
    await putObject(`previews/test-gm-${run}/b.mp4`, clip, "video/mp4");
    await prisma.render.create({ data: { projectId: without, userId, kind: "preview", version: 2, status: "done", steps: [], outputKey: `previews/test-gm-${run}/b.mp4`, framesKeys: [], seconds: 8, finishedAt: new Date() } });
    const list = await app.inject({ method: "GET", url: "/gallery", headers: headers() });
    const now = list.json().find((x: { id: string }) => x.id === g.id);
    assert.ok(now?.video, "the gallery took the new export");
    assert.ok(Buffer.from(await (await fetch(now.video)).arrayBuffer()).equals(clip));
  });

  it("an edit published before it was ever rendered gets one preview started when the gallery is loaded", async () => {
    const load = () => app.inject({ method: "GET", url: "/gallery", headers: headers() });
    const first = await load();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().find((x: { id: string }) => x.id === neverItem)?.video, null, "nothing to play yet");
    const started = await prisma.render.findMany({ where: { projectId: never } });
    assert.equal(started.length, 1, "one preview started");
    assert.equal(started[0].kind, "preview");
    assert.equal(started[0].by, "gallery");
    assert.equal(await previewGate(never), null, "it does not stop the AI's next preview of the edit");
    // It failed: loading again does not start another one at once.
    await prisma.render.updateMany({ where: { projectId: never }, data: { status: "failed" } });
    await load();
    assert.equal(await prisma.render.count({ where: { projectId: never } }), 1, "not retried on every load");
  });
});
