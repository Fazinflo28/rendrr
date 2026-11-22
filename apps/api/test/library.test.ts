// Engine Part 4 through the connector: the hidden library (list_library, get_library_item, add_library_item) and the
// icons (search_icons). Ten items placed in one edit: graphics on V3 with their params (auto positions from the
// measured face, clear of a tall frame's buttons), and the items that are edits made into those edits (a transition on
// the nearest cut, a pattern background, picture in picture as a card around the face). The worker's pictures are
// stood in for here (worker/test/library.test.ts draws every item for real). Needs a database, Redis and storage (as
// in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { SnapshotJob, TestGraphicJob } from "@rendrr/core";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("the library through the connector", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { createProject } = await import("../src/services/projects");
  const core = await import("@rendrr/core");
  const { QUEUES, stubTranscript } = await import("@rendrr/shared");
  const { Worker } = await import("bullmq");

  let userId = "", videoId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `lib_${run}` });
  const seen: (SnapshotJob | TestGraphicJob)[] = [];
  // The worker's test queue, stood in for: a picture for a snapshot, a result for a test.
  const worker = new Worker(QUEUES.test.name, async (job) => {
    const d = job.data as SnapshotJob | TestGraphicJob;
    seen.push(d);
    if ("kind" in d && d.kind === "snapshot") {
      const image = `tests/${d.userId}/${d.key}.png`;
      await core.putObject(image, PNG1, "image/png");
      return { image, width: d.width, height: d.height, errors: [], ms: 900 };
    }
    const t = d as TestGraphicJob, base = `tests/${t.userId}/${t.key}`;
    for (const k of [`${base}-f0.jpg`, `${base}-f1.jpg`, `${base}-f2.jpg`, `${base}.mp4`]) await core.putObject(k, Buffer.from("x"), "image/jpeg");
    const r = { clip: `${base}.mp4`, frames: [0, 1, 2].map((k) => `${base}-f${k}.jpg`), times: [0.4, 2, 3.6], width: 540, height: 960, from: t.at, seconds: t.seconds, recordedMs: 1500, totalMs: 3200, cover: { min: 2, avg: 4, max: 6, samples: 8, visible: 8 }, face: undefined, warnings: [] };
    await core.putObject(`${base}.json`, Buffer.from(JSON.stringify(r)), "application/json");
    return r;
  }, { connection: core.newRedis() });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `lib_${run}`, email: `lib-${run}@test.rendrr.dev`, name: "Lib" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Lib's Workspace" } });
    // 30 s of 9:16 footage with the face measured high in the frame the whole time (10 fps).
    const details = { v: 1, fps: 10, size: [1080, 1920], faceFields: "track,x,y,w,h,score", metricFields: "", metrics: [],
      frames: Array.from({ length: 300 }, (_, k) => [k / 10, [[1, 0.35, 0.18, 0.3, 0.17, 0.95, null, null, null, null]]]) };
    const key = `deep/${run}/vision.json.gz`;
    await core.putObject(key, gzipSync(JSON.stringify(details)), "application/gzip");
    const vision = { v: 1, fps: 10, metricsEvery: 0.5, size: [1080, 1920], frames: 300, landmarks: false, faces: { present: 1, tracks: 1, lost: [], offCamera: [], turns: [], mouthOpenShare: null, medianShare: 0.17 }, sharpness: { median: 1, soft: [] }, shake: { median: 0, shaky: [] }, light: { median: 0.5, dark: [], blown: [], skinMedian: null }, motion: { median: 0 }, safeArea: null, key };
    videoId = (await prisma.video.create({ data: { userId, name: `Tall ${run}`, seconds: 30, width: 1080, height: 1920, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`,
      analysis: { create: { transcriber: "stub", transcript: stubTranscript(30) as never, silences: [] as never, sceneCuts: [], keyFrames: [], vision: vision as never } } } })).id;
  });
  after(async () => {
    await worker.close();
    await core.deletePrefix(`tests/${userId}/`).catch(() => {});
    await core.deletePrefix(`deep/${run}/`).catch(() => {});
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await core.queue("test").close();
    await core.redis().quit().catch(() => {});
  });

  it("list_library lists every item, by kind; a kind it does not have is said", async () => {
    const all = (await TOOL_HANDLERS.list_library(c(), {})).text;
    assert.match(all, /^LIBRARY: \d+ ready items\./);
    for (const id of ["lib_text_typewriter", "lib_lt_corner", "lib_stat_ring", "lib_list_flow", "lib_callout_spotlight", "lib_whiteboard", "lib_pip_box", "lib_tr_glitch", "lib_social_post", "lib_bg_dots", "lib_icon"]) assert.match(all, new RegExp(`^${id} \\|`, "m"));
    const lt = (await TOOL_HANDLERS.list_library(c(), { kind: "lower_third" })).text;
    assert.equal(lt.split("\n").length - 1, 6);
    await assert.rejects(TOOL_HANDLERS.list_library(c(), { kind: "memes" }), /No library kind "memes"/);
  });

  it("get_library_item: every param with its default and a preview frame drawn by the worker", async () => {
    const r = await TOOL_HANDLERS.get_library_item(c(), { id: "lib_text_pop" });
    assert.match(r.text, /^Text: pop \(lib_text_pop, text\)/);
    assert.match(r.text, /^text\* = "Make every second count"/m);
    assert.match(r.text, /^easing = "spring" \(linear\|ease-out-cubic\|ease-in-out\|spring\)/m);
    assert.match(r.text, /^speed = 1 \(0\.25-4\)/m);
    assert.match(r.text, /Preview frame attached/);
    assert.equal(r.images?.length, 1);
    const snap = seen.find((x) => "kind" in x && x.kind === "snapshot") as SnapshotJob;
    assert.match(snap.html, /window\.renderFramePure=true/);
    await assert.rejects(TOOL_HANDLERS.get_library_item(c(), { id: "lib_nope" }), /No library item "lib_nope"/);
  });

  it("search_icons: the best match first, no brand logos, a sheet to look at", async () => {
    const r = await TOOL_HANDLERS.search_icons(c(), { query: "rocket" });
    assert.match(r.text, /^1\. tabler:rocket \(/m);
    assert.equal(r.images?.length, 1);
    const g = await TOOL_HANDLERS.search_icons(c(), { query: "github", limit: 48 });
    assert.doesNotMatch(g.text, /brand-/);
    assert.match((await TOOL_HANDLERS.search_icons(c(), { query: "zzqqxx" })).text, /No icon matches/);
  });

  it("ten library items in one edit: graphics with their params, transitions, a background and picture in picture", async () => {
    const p = await createProject(userId, { videoId });
    // Two clips on V1, so there is a cut at edit 8 s.
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "set_clips", track: "v1", clips: [{ start: 0, end: 8, label: "" }, { start: 10, end: 30, label: "" }] }] });
    const add = (itemId: string, x: Record<string, unknown> = {}) => TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId, edit: true, ...x });
    const t1 = await add("lib_text_pop", { start: 1, end: 4, params: { text: "Stop guessing" } });
    // The face is high in a tall frame: auto puts the text at the bottom (which keeps clear of the app's buttons).
    assert.match(t1.text, /Position auto: bottom \(the face is in the upper part of the frame, face box/);
    await add("lib_lt_bar", { start: 2, end: 6, params: { name: "Ronny K", title: "Founder" } });
    await add("lib_stat_counter", { start: 4, end: 7, params: { to: 4200, prefix: "$" } });
    const ic = await add("lib_icon", { start: 5, end: 7, params: { icon: "tabler:rocket", label: "Launch" } });
    assert.match(ic.text, /^Done \(v\d+/);
    await add("lib_callout_arrow", { start: 6, end: 9, params: { x: 0.6, y: 0.3, label: "Here" } });
    await add("lib_social_comment", { start: 9, end: 12, params: { text: "Love this" } });
    await add("lib_list_steps", { start: 12, end: 18, params: { items: ["Hook", "Value", "Offer"] } });
    const tr = await add("lib_tr_flash", { start: 7.7 });
    assert.match(tr.text, /set_transition flash on the cut at edit 8\.00s, before clip \w+, the cut nearest 7\.70s/);
    const bg = await add("lib_bg_grid", { params: { color: "#fdf2f8", ink: "#f9a8d4" } });
    assert.match(bg.text, /set_background \{"pattern":\{"kind":"grid","color":"#fdf2f8","ink":"#f9a8d4","size":0\.06\}\}/);
    const pip = await add("lib_pip_circle", { start: 20, end: 24, params: { corner: "bottom-right" } });
    assert.match(pip.text, /split V1 at both ends, then set_card .*"radius":0\.5.* centred on the measured face\. Made in 2 versions: undo with steps 2/);

    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).timeline as { background?: unknown; tracks: { v1: { id: string; transition?: { type: string }; cardLook?: { radius?: number; crop?: unknown }; framing?: { scale: number } }[]; v3: { kind?: string; graphicId: string; params: Record<string, unknown> }[] } };
    const g = Object.fromEntries(tl.tracks.v3.filter((x) => x.kind === "graphic").map((x) => [x.graphicId, x.params]));
    assert.deepEqual(Object.keys(g).sort(), ["lib_callout_arrow", "lib_icon", "lib_list_steps", "lib_lt_bar", "lib_social_comment", "lib_stat_counter", "lib_text_pop"]);
    assert.equal(g.lib_text_pop.position, "bottom");
    assert.equal(g.lib_lt_bar.position, undefined, "not auto by default: its own place (bottom-left)");
    assert.equal(g.lib_social_comment.position, "bottom");
    assert.match(String(g.lib_icon.svg), /^<svg [^>]*viewBox="0 0 24 24"[^>]*>(<path [^>]*\/>)+<\/svg>$/);
    assert.deepEqual(tl.background, { pattern: { kind: "grid", color: "#FDF2F8", ink: "#F9A8D4", size: 0.06 } });
    assert.equal(tl.tracks.v1.filter((x) => x.transition?.type === "flash").length, 1);
    const carded = tl.tracks.v1.filter((x) => x.cardLook?.radius === 0.5);
    assert.equal(carded.length, 1);
    assert.ok(carded[0].framing && carded[0].framing.scale < 1, JSON.stringify(carded[0].framing));
    assert.equal(tl.tracks.v1.length, 4, "the second clip split at 20 s and 24 s of the edit");
  });

  it("refuses a font that is not there, wrong params, an unknown icon; apply_edits checks library params too", async () => {
    const p = await createProject(userId, { videoId });
    await assert.rejects(TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId: "lib_text_blur_in", start: 1, end: 3, params: { font: "Nope Sans" } }), /Font "Nope Sans" is not installed/);
    await assert.rejects(TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId: "lib_text_blur_in", start: 1, end: 3, params: { colour: "#ffffff" } }), /has no param "colour"/);
    await assert.rejects(TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId: "lib_text_blur_in", start: 1, end: 3, params: { size: 2 } }), /is 0\.015 to 0\.3/);
    await assert.rejects(TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId: "lib_icon", start: 1, end: 3, params: { icon: "tabler:not-an-icon" } }), /No icon "tabler:not-an-icon"/);
    await assert.rejects(TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "add_graphic", graphicId: "lib_stat_ring", start: 1, end: 3, params: { percent: 140 } }] }), /Param "percent" of Stat: percentage ring is 0 to 100/);
    const ok = await TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId: "lib_text_blur_in", start: 1, end: 3, params: { font: "Bebas Neue", position: "top" } });
    assert.match(ok.text, /^Done/);
  });

  it("test_graphic takes a library graphic", async () => {
    const r = await TOOL_HANDLERS.test_graphic(c(), { graphicId: "lib_stat_ring", params: { percent: 84 }, over: { videoId, time: 3 } });
    assert.match(r.text, /^TEST "Stat: percentage ring" with \{"percent":84\}: 0-4s of it over "Tall/);
    const job = seen.find((x) => !("kind" in x) && (x as TestGraphicJob).graphicId === "lib_stat_ring") as TestGraphicJob;
    assert.equal(job.aspect, "9:16");
  });
});
