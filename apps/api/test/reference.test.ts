// Engine Part 4.4 end to end (the request's test 3): analyze_reference measures a reference video into a style file
// (the worker's real style job and python/reference.py on a made-up reference with a known style); the AI places 10
// library items using what it measured; test_graphic answers in under 10 s (the worker's real test job, Chromium).
// Needs a database, Redis, storage, ffmpeg, Chromium and Python with OpenCV (as in .env).
// Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeReferenceVideo, REFERENCE_CUTS, REFERENCE_SPEECH } from "../../worker/test/fixtures/makeReference";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const cv = (() => { try { execFileSync(process.env.PYTHON_BIN || "python3", ["-c", "import cv2"]); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("analyze_reference, then 10 library items from it", { skip: (!ready || !cv) && "needs a database, Redis, storage and Python with OpenCV" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, QUEUES } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const core = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { styleJob } = await import("../../worker/src/jobs/style");
  const { testGraphicJob } = await import("../../worker/src/jobs/testGraphic");
  const { snapshotJob } = await import("../../worker/src/jobs/snapshot");

  let userId = "", refId = "", talkId = "";
  const dir = mkdtempSync(join(tmpdir(), "reference-"));
  const workers: InstanceType<typeof Worker>[] = [];
  const c = () => ({ userId, ai: "claude" as const, clerkId: `ref_${run}` });
  const ctx = (job: unknown) => ({ job, dir: mkdtempSync(join(dir, "job-")), signal: new AbortController().signal, isLastAttempt: true }) as never;

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `ref_${run}`, email: `ref-${run}@test.rendrr.dev`, name: "Ref" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Ref's Workspace" } });
    const file = join(dir, "ref.mp4");
    makeReferenceVideo(file);
    const proxyKey = `proxies/${userId}/ref.mp4`;
    await core.uploadFile(proxyKey, file, "video/mp4");
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: REFERENCE_CUTS, keyFrames: [], audio: { speech: REFERENCE_SPEECH, lufs: -14.2, truePeakDb: -1.1 } as never } };
    refId = (await prisma.video.create({ data: { userId, name: `Pink reference ${run}`, kind: "reference", seconds: 20, width: 540, height: 960, source: "local", status: "ready", proxyKey, analysis } })).id;
    // The footage the AI edits: the same file stands in.
    talkId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 540, height: 960, source: "local", status: "ready", proxyKey, analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } })).id;
    workers.push(new Worker(QUEUES.style.name, async (job) => styleJob(ctx(job)), { connection: core.newRedis() as never }));
    workers.push(new Worker(QUEUES.test.name, async (job) => ((job.data as { kind?: string }).kind === "snapshot" ? snapshotJob(ctx(job)) : testGraphicJob(ctx(job))), { connection: core.newRedis() as never, concurrency: 2 }));
  });
  after(async () => {
    for (const w of workers) await w.close();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await core.deletePrefix(`proxies/${userId}/`).catch(() => {});
    await core.deletePrefix(`tests/${userId}/`).catch(() => {});
    await core.deletePrefix(`graphics/${userId}/`).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    await core.redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  let styleId = "";
  it("measures the reference into a style file: captions, text graphics, transitions, sound, moments", { timeout: 120_000 }, async () => {
    let r = await TOOL_HANDLERS.analyze_reference(c(), { videoId: refId });
    styleId = (r.data as { styleFileId: string }).styleFileId;
    // A slow machine answers with its progress first; it keeps going.
    for (let k = 0; k < 60 && !/^STYLE FILE/.test(r.text); k++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await TOOL_HANDLERS.get_style(c(), { styleId }); }
    const t = r.text;
    const rgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    console.log(t.split("\n").slice(0, 9).join("\n"));
    assert.match(t, new RegExp(`^STYLE FILE ${styleId} "Style of Pink reference ${run}" from "Pink reference ${run}" \\(20s, 9:16\\)`));
    assert.match(t, /^PACING: 9 cuts a minute, shots 5s on average \(4-6s\)/m);
    // Captions at 70% down, white with a yellow active word and a dark outline, two words at a time, every 0.6 s.
    const cap = /^CAPTIONS: at (\d+)% down .*?, text ([\d.]+)% of the short side tall \(set_caption_style size about ([\d.]+)\), (#[0-9A-F]{6}), active word (#[0-9A-F]{6}), outline (#[0-9A-F]{6}).*?, (\w+) strokes .*?, (\d+) words at once, a new chunk every ([\d.]+)s/m.exec(t);
    assert.ok(cap, t);
    const [, y, , size, color, hl, outline, weight, words, chunk] = cap!;
    assert.ok(Number(y) >= 70 && Number(y) <= 74, `y ${y}`);
    assert.ok(Number(size) > 8 && Number(size) < 13, `size ${size}`);
    assert.ok(rgb(color).every((v) => v > 220), `white ${color}`);
    assert.ok(rgb(hl)[0] > 200 && rgb(hl)[1] > 170 && rgb(hl)[2] < 80, `yellow ${hl}`);
    assert.ok(rgb(outline).every((v) => v < 50), `dark outline ${outline}`);
    assert.equal(weight, "black");
    assert.equal(words, "2");
    assert.ok(Math.abs(Number(chunk) - 0.6) <= 0.11, `chunk ${chunk}`);
    // Text graphics: the card on the pink box sliding in from the left, the word that pops.
    assert.match(t, /^TEXT GRAPHICS: 2 /m);
    const card = /^3(?:\.\d+)?s text \d+% wide at the top[-a-z]*, (#[0-9A-F]{6}) on a (#[0-9A-F]{6}) box, black, [\d.]+% tall; in: slide left \d+ ms/m.exec(t);
    assert.ok(card, "the card");
    assert.ok(rgb(card![1]).every((v) => v > 220), `white text ${card![1]}`);
    const [pr, pg, pb] = rgb(card![2]);
    assert.ok(pr > 200 && pg > 70 && pg < 130 && pb > 130 && pb < 200, `pink box ${card![2]}`);
    assert.match(t, /^14(?:\.\d+)?s text \d+% wide at the middle, #F[0-9A-F]{5}, \w+, [\d.]+% tall; in: pop from \d+% \d+ ms/m);
    assert.match(t, /^TRANSITIONS: (cut 1, flash 1, dip-black 1|flash 1, dip-black 1, cut 1)/m);
    assert.match(t, /^6s white flash \(set_transition flash\) at the cut \(\d+ ms\)$/m);
    assert.match(t, /^12s dip to black at the cut \(\d+ ms\)$/m);
    const duck = /its low end is ([\d.]+) dB lower under the voice \(ducking: set_audio duck about (\d+)\); a sound hit on 1 of 3 cuts/.exec(t);
    assert.ok(duck && Number(duck[1]) > 9 && Number(duck[1]) < 15, t);
    assert.match(t, /^SOUND: -14\.2 LUFS, peak -1\.1 dBTP; a bed in the pauses at -[\d.]+ dBFS \([\d.]+ dB over the voice's level\)/m);
    assert.match(t, /^Not measured: font family/m);
  });

  it("is kept with the account: list_styles and get_style read it; asked again it is not measured twice", async () => {
    assert.match((await TOOL_HANDLERS.list_styles(c(), {})).text, new RegExp(`Style files \\(analyze_reference; read with get_style\\):\\n${styleId} \\| Style of Pink reference ${run} \\| style file \\(measured from a reference\\) \\| ready`));
    assert.match((await TOOL_HANDLERS.get_style(c(), { styleId })).text, /^STYLE FILE /);
    const again = await TOOL_HANDLERS.analyze_reference(c(), { videoId: refId });
    assert.match(again.text, new RegExp(`was measured before: style file ${styleId}\\.`));
    assert.equal(await prisma.styleFile.count({ where: { userId } }), 1);
  });

  it("the AI places 10 library items using the style file; test_graphic answers in under 10 s", { timeout: 180_000 }, async () => {
    const sf = (await prisma.styleFile.findUniqueOrThrow({ where: { id: styleId } })).data as { captions: { color: string; highlight: string; stroke: { color: string } }; textGraphics: { boxColor: string | null; color: string }[] };
    const pink = sf.textGraphics.find((g) => g.boxColor)!.boxColor!.toLowerCase(), white = sf.captions.color.toLowerCase(), yellow = sf.captions.highlight.toLowerCase();
    const p = await createProject(userId, { videoId: talkId });
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [
      { op: "set_clips", track: "v1", clips: [{ start: 0, end: 7, label: "" }, { start: 8, end: 20, label: "" }] },
      { op: "set_caption_style", font: "Montserrat", weight: 800, size: 10, color: sf.captions.color, highlight: sf.captions.highlight, stroke: { color: sf.captions.stroke.color, width: 7 }, y: 0.72, wordsAtOnce: 2 },
    ] });
    const items: [string, Record<string, unknown>][] = [
      ["lib_text_slide_in", { start: 1, end: 3, params: { text: "4200 leads", color: white, box: { color: pink, opacity: 1 }, from: "left", position: "top-left" } }],
      ["lib_text_pop", { start: 3, end: 5, params: { text: "Guaranteed", color: white } }],
      ["lib_text_highlight_wipe", { start: 5, end: 7, params: { text: "Stop guessing", accent: yellow } }],
      ["lib_stat_counter", { start: 7, end: 10, params: { to: 4200, accent: pink } }],
      ["lib_stat_ring", { start: 10, end: 13, params: { percent: 84, accent: pink } }],
      ["lib_list_checklist", { start: 13, end: 17, params: { items: ["Hook", "Proof", "Offer"], accent: pink } }],
      ["lib_lt_pill", { start: 2, end: 6, params: { name: "Ronny K", title: "Founder", accent: pink } }],
      ["lib_icon", { start: 17, end: 19, params: { icon: "tabler:rocket", label: "Launch", color: white } }],
      ["lib_tr_flash", { start: 7 }],
      ["lib_bg_gradient", { params: { from: pink, to: "#ffffff", angle: 180 } }],
    ];
    for (const [itemId, x] of items) {
      const r = await TOOL_HANDLERS.add_library_item(c(), { projectId: p.id, itemId, edit: true, ...x });
      assert.match(r.text, /^Done \(v\d+/, `${itemId}: ${r.text}`);
    }
    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).timeline as { background?: { gradient?: { from: string } }; tracks: { v1: { transition?: { type: string } }[]; v3: { kind?: string; graphicId?: string }[] } };
    assert.equal(tl.tracks.v3.filter((x) => x.kind === "graphic" && x.graphicId?.startsWith("lib_")).length, 8);
    assert.equal(tl.tracks.v1.filter((x) => x.transition?.type === "flash").length, 1);
    assert.equal(tl.background?.gradient?.from.toLowerCase(), pink);
    // A quick look at one over the footage: under 10 s, the real worker (Chromium, ffmpeg).
    const t0 = Date.now();
    const r = await TOOL_HANDLERS.test_graphic(c(), { graphicId: "lib_text_slide_in", params: { text: "4200 leads", color: white, box: { color: pink, opacity: 1 } }, over: { videoId: talkId, time: 4 } });
    const took = Date.now() - t0;
    console.log(`test_graphic: ${(took / 1000).toFixed(1)} s: ${r.text.slice(0, 160)}`);
    assert.match(r.text, /^TEST "Text: slide in"/);
    assert.equal(r.images?.length, 3);
    assert.ok(took < 10_000, `${took} ms`);
  });
});
