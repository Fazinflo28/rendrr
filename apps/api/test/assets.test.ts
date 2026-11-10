// The Assets page: counts per section, the heart, the Trash (hidden from the library and the AI, restorable, an edit
// cannot be made from a trashed video), elements (a picture sent through an upload link becomes a transparent graphic
// the AI lists and places), delete for good (asks when an edit uses it), Empty trash and the 30-day cleanup.
// Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deflateSync } from "node:zlib";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
process.env.ELEMENT_WAIT_MS = "0"; // no worker here: the element stays "rendering"
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

const png = (() => {
  const w = 8, h = 4, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([200, 30, 30, x < 4 ? 255 : 0], y * (w * 4 + 1) + 1 + x * 4); }
  const crc = (b: Buffer) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();

describe("the Assets page", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { purgeTrash, redis, queue } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", videoId = "", stillId = "", soundId = "", elementId = "", projectId = "";
  const clerkId = `assets_${run}`;
  const headers = (who = clerkId) => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": who });
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, who?: string) => app.inject({ method, url, headers: headers(who), ...(payload ? { payload } : {}) });
  const summary = async () => (await call("GET", "/assets/summary")).json();

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `assets-${run}@test.rendrr.dev`, name: "Assets" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    stillId = (await prisma.video.create({ data: { userId, name: `Photo ${run}`, seconds: 60, width: 800, height: 600, source: "upload", still: true, status: "ready", analysis: { create: { transcriber: "stub", transcript: [] as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } })).id;
    soundId = (await prisma.sound.create({ data: { userId, name: `Theme ${run}`, status: "ready", key: `sounds/${userId}/x.m4a`, seconds: 30 } })).id;
    elementId = (await prisma.graphic.create({ data: { ownerId: userId, kind: "element", name: `Logo ${run}`, status: "ready", durationSec: 1, width: 400, height: 200, renderedKey: `graphics/${userId}/e.webm`, thumbKey: `graphics/${userId}/e-thumb.png` } })).id;
  });
  after(async () => {
    for (const j of await queue("test").getJobs(["waiting", "delayed", "prioritized"])) if ((j.data as { kind?: string; graphicId?: string }).kind === "element") { const g = await prisma.graphic.findUnique({ where: { id: (j.data as { graphicId: string }).graphicId } }); if (!g || g.ownerId === userId) await j.remove().catch(() => {}); }
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.graphic.deleteMany({ where: { ownerId: userId } });
    await prisma.sound.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.usageEvent.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.aiConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { OR: [{ id: userId }, { clerkId: `other_${run}` }] } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("counts each section", async () => {
    const s = await summary();
    assert.deepEqual({ videos: s.videos, images: s.images, elements: s.elements, audio: s.audio, favorites: s.favorites, trash: s.trash, all: s.all }, { videos: 1, images: 1, elements: 1, audio: 1, favorites: 0, trash: 0, all: 4 });
    const els = (await call("GET", "/elements")).json();
    assert.equal(els.length, 1); assert.equal(els[0].type, "element"); assert.ok(els[0].thumb && els[0].url, "a thumbnail and its clip");
    const snds = (await call("GET", "/sounds")).json();
    assert.equal(snds[0].type, "audio"); assert.ok(snds[0].url);
  });

  it("the heart: favourites from every type", async () => {
    for (const [type, id] of [["video", videoId], ["element", elementId], ["audio", soundId]] as const) {
      const r = await call("PATCH", `/assets/${type}/${id}`, { favorite: true });
      assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().favorite, true);
    }
    assert.equal((await summary()).favorites, 3);
    const v = (await call("GET", "/videos")).json().find((x: { id: string }) => x.id === videoId);
    assert.equal(v.favorite, true);
    const ren = await call("PATCH", `/assets/element/${elementId}`, { name: "Main logo" });
    assert.equal(ren.json().name, "Main logo");
    assert.equal((await call("PATCH", `/assets/element/${elementId}`, { name: "  " })).statusCode, 400);
  });

  it("the Trash hides a video from the library, the AI and new edits; restore brings it back", async () => {
    const t = await call("POST", `/assets/video/${videoId}/trash`);
    assert.equal(t.statusCode, 200, t.body); assert.equal(t.json().daysLeft, 30);
    assert.ok(!(await call("GET", "/videos")).json().some((x: { id: string }) => x.id === videoId), "not in the library");
    const trash = (await call("GET", "/trash")).json();
    assert.equal(trash.length, 1); assert.equal(trash[0].id, videoId); assert.equal(trash[0].type, "video"); assert.equal(trash[0].daysLeft, 30);
    const s = await summary(); assert.equal(s.trash, 1); assert.equal(s.videos, 0); assert.equal(s.favorites, 2, "a trashed favourite is not counted");
    const lf = await app.inject({ method: "POST", url: "/internal/tools/list_footage", headers: { ...headers(), "x-rendrr-ai": "claude" }, payload: {} });
    assert.ok(!lf.json().text.includes(videoId), "the AI does not see it");
    const made = await call("POST", "/projects", { videoId });
    assert.equal(made.statusCode, 409); assert.match(made.json().error.message, /in the Trash/);
    assert.equal((await call("POST", `/assets/video/${videoId}/restore`)).statusCode, 200);
    assert.ok((await call("GET", "/videos")).json().some((x: { id: string }) => x.id === videoId), "back in the library");
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
  });

  it("an element: upload link, a transparent graphic the AI lists and can place", async () => {
    const link = (await call("POST", "/assets/upload-link", { as: "element", name: "Badge.png" })).json();
    assert.match(link.url, /\/footage\/upload\//); assert.equal(link.as, "element");
    const path = new URL(link.url).pathname;
    const up = await app.inject({ method: "POST", url: `${path}?filename=badge.png`, payload: png, headers: { "content-type": "application/octet-stream" } });
    assert.equal(up.statusCode, 200, up.body);
    const b = up.json();
    assert.ok(b.graphicId); assert.equal(b.element.type, "element"); assert.match(b.text, /add_graphic/);
    const g = await prisma.graphic.findUniqueOrThrow({ where: { id: b.graphicId } });
    assert.equal(g.kind, "element"); assert.equal(g.ownerId, userId); assert.match(g.sourceKey!, /-src\.png$/);
    const job = (await queue("test").getJobs(["waiting", "delayed", "prioritized"])).find((j) => (j.data as { graphicId?: string }).graphicId === g.id);
    assert.ok(job, "the worker is asked to make its transparent clip");
    const notPic = (await call("POST", "/assets/upload-link", { as: "element" })).json();
    const bad = await app.inject({ method: "POST", url: new URL(notPic.url).pathname, payload: Buffer.from("not a picture at all, just text"), headers: { "content-type": "application/octet-stream" } });
    assert.equal(bad.statusCode, 400); assert.match(bad.json().error.message, /PNG/);
    const lg = await app.inject({ method: "POST", url: "/internal/tools/list_graphics", headers: { ...headers(), "x-rendrr-ai": "claude" }, payload: {} });
    assert.match(lg.json().text, /Your elements \(logos and overlays/);
    assert.ok(lg.json().text.includes(`\n${elementId} | Main logo | 400x200 | favourite\n`), "the element, its size and the heart");
    assert.ok(lg.json().text.includes(`\n${b.graphicId} | Badge | rendering\n`), "the one being prepared");
    assert.ok(!/Custom graphics[^\n]*\n[^\n]*Main logo/.test(lg.json().text), "elements are not listed as custom graphics");
    // Placed by the AI: add_graphic then set_keyframes.
    const ap = await app.inject({ method: "POST", url: "/internal/tools/apply_edits", headers: { ...headers(), "x-rendrr-ai": "claude" }, payload: { projectId, edits: [{ op: "add_graphic", graphicId: elementId, start: 1, end: 4 }] } });
    assert.equal(ap.statusCode, 200, ap.body);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.ok(JSON.stringify(p.timeline).includes(elementId), "the element is on the edit");
    const full = (await call("GET", `/projects/${projectId}`)).json();
    const clip = (p.timeline as { tracks: { v3: { id: string; graphicId?: string }[] } }).tracks.v3.find((c) => c.graphicId === elementId)!;
    assert.ok(full.graphicClipMedia[clip.id]?.url, "the editor gets its clip to play");
  });

  it("delete for good asks when an edit uses it; Empty trash keeps what edits use", async () => {
    const used = await call("DELETE", `/assets/element/${elementId}`);
    assert.equal(used.statusCode, 409); assert.match(used.json().error.message, new RegExp(`Promo ${run}`));
    await call("POST", `/assets/audio/${soundId}/trash`);
    await call("POST", `/assets/element/${elementId}/trash`);
    const r = (await call("POST", "/trash/empty")).json();
    assert.equal(r.deleted, 1, "the audio file went");
    assert.deepEqual(r.kept.map((k: { id: string }) => k.id), [elementId], "the element an edit uses stays");
    assert.equal(await prisma.sound.count({ where: { id: soundId } }), 0);
    const forced = await call("DELETE", `/assets/element/${elementId}?edits=keep`);
    assert.equal(forced.statusCode, 200);
    assert.equal(await prisma.graphic.count({ where: { id: elementId } }), 0);
  });

  it("the nightly cleanup: 30 days in the Trash, then gone (a video an edit is made from stays)", async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    await prisma.video.update({ where: { id: stillId }, data: { deletedAt: old } });
    await prisma.video.update({ where: { id: videoId }, data: { deletedAt: old } });
    const fresh = await prisma.sound.create({ data: { userId, name: "Fresh", status: "ready", key: "", deletedAt: new Date() } });
    const r = await purgeTrash({ userId });
    assert.equal(r.videos, 1, "the picture went");
    assert.equal(await prisma.video.count({ where: { id: stillId } }), 0);
    assert.equal(await prisma.video.count({ where: { id: videoId } }), 1, "the edit's footage stays");
    assert.ok(r.kept.some((k) => k.id === videoId));
    assert.equal(await prisma.sound.count({ where: { id: fresh.id } }), 1, "trashed today: not yet");
  });

  it("another user cannot touch these assets", async () => {
    await prisma.user.create({ data: { clerkId: `other_${run}`, email: `other-${run}@test.rendrr.dev`, name: "Other" } });
    assert.equal((await call("POST", `/assets/video/${videoId}/restore`, undefined, `other_${run}`)).statusCode, 404);
    assert.equal((await call("PATCH", `/assets/video/${videoId}`, { favorite: false }, `other_${run}`)).statusCode, 404);
    assert.equal((await call("POST", `/assets/nope/${videoId}/trash`)).statusCode, 404);
  });
});
