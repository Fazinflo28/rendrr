// Rendering on the user's Mac, end to end with the real pieces: an edit with captions (its fonts), a graphic and built-in
// music is planned as the worker plans it; its FFmpeg run made into a task (macTaskFor: footage by its storage key, the
// rest inline or sent up, paths relative); the "Mac" (desktop/render.js, the app's own code) takes it through the API,
// fetches the files by signed link, runs FFmpeg, uploads to the render's key and reports done; the worker waiting on it
// (runOnMac) gets the sizes. The file is the cloud's own render of the same edit (PSNR). Then: a Mac that does not pick
// a task up, one that fails, one told to stop, and the API refusing a wrong token or another user's claim.
// Needs a database, Redis and storage.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
process.env.MAC_CLAIM_MS = "1500";
process.env.MAC_QUIET_MS = "4000";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const here = dirname(fileURLToPath(import.meta.url));
const sh = promisify(execFile);
const ff = (args: string[]) => sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 26 });

describe("renders made on the user's Mac", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const core = await import("@rendrr/core");
  const { applyOp, buildInitialTimeline, stubTranscript, PREFIX } = await import("@rendrr/shared");
  const { ffmpegArgs, planRender } = await import("@rendrr/shared/renderPlan");
  const { macTaskFor, runOnMac } = await import("../../worker/src/lib/macTask");
  const { macPieceRuns, macPiecesFirst } = await import("../../worker/src/lib/macPieces");
  const { buildServer } = await import("../src/server");
  // The Mac app's own render code (CommonJS).
  const mac = (await import("../../../desktop/render.js")) as unknown as { runTask: (t: unknown, o: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; stopped?: string; outputs?: Record<string, number> }> };
  let app: Awaited<ReturnType<typeof buildServer>>, api = "", dir = "", elsewhere = "", work = "";
  const userId = `mac-user-${run}`, keys: string[] = [];
  const SECONDS = 4, W = 640, H = 360;
  let plan: ReturnType<typeof planRender>;
  const files: Record<string, unknown> = {};
  const source = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };

  before(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    dir = await mkdtemp(join(tmpdir(), "mac-job-")); elsewhere = await mkdtemp(join(tmpdir(), "mac-assets-")); work = await mkdtemp(join(tmpdir(), "mac-work-"));
    // The footage (as storage keeps a preview copy) and built-in music (in the asset cache, outside the job's folder).
    await ff(["-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=330:d=${SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4", join(dir, "source")]);
    await ff(["-f", "lavfi", "-i", `sine=f=660:d=${SECONDS + 2}`, "-c:a", "aac", join(elsewhere, "music.m4a")]);
    // A transparent graphic, as the recorder leaves it (no storage key: it goes inline).
    await ff(["-f", "lavfi", "-i", "color=red@0.6:s=200x100:d=2,format=yuva420p", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", join(dir, "graphic-g1.webm")]);
    for (const [p, key] of [[join(dir, "source"), `${PREFIX.tests}mac-${run}/source.mp4`], [join(elsewhere, "music.m4a"), `${PREFIX.tests}mac-${run}/music.m4a`]] as const) {
      await core.uploadFile(key, p, "video/mp4"); keys.push(key);
      core.noteOrigin(p, key, { size: (await stat(p)).size });
    }
    // The edit: captions on, a graphic placed 0.5-3 s, music under it.
    const ctx = { videoId: "v", transcript: stubTranscript(SECONDS), silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: () => undefined, getGraphic: (id: string) => (id === "gfx" ? { id, name: "Card", durationSec: 2 } : undefined) } as never;
    let s = { timeline: buildInitialTimeline(stubTranscript(SECONDS), SECONDS, "bold", [], "v"), name: "e", aspect: "16:9", styleId: "s2" } as never;
    s = applyOp(s, { op: "add_graphic", graphicId: "gfx", start: 0.5, end: 3, params: {}, edit: true } as never, ctx).snap as never;
    plan = planRender({ kind: "preview", snapshot: s, transcript: stubTranscript(SECONDS), source, videoId: "v" });
    const gclip = plan.graphics[0]?.clipId;
    assert.ok(plan.ass, "the plan has captions");
    Object.assign(files, { source: join(dir, "source"), output: join(dir, "out.mp4"), assPath: join(dir, "captions.ass"), fontsDir: join(here, "../../web/public/fonts"), graphics: gclip ? { [gclip]: join(dir, "graphic-g1.webm") } : {}, graphicSeconds: gclip ? { [gclip]: 2 } : {}, audio: {}, broll: {}, videos: {}, under: {}, looks: {} });
    await writeFile(join(dir, "captions.ass"), plan.ass!);
  });
  after(async () => {
    await core.deleteObjects(keys).catch(() => {});
    for (const d of [dir, elsewhere, work]) await rm(d, { recursive: true, force: true });
    await app.close(); await core.redis().quit().catch(() => {});
  });

  // The Mac app: list the user's waiting tasks, take the first, run it (as main.js does after the web app claims it).
  const macTakes = async (o: Record<string, unknown> = {}) => {
    for (let i = 0; i < 40; i++) {
      const t = (await core.listMacTasks(userId))[0];
      if (t) {
        const got = await core.claimMacTask(userId, t.id, "Test Mac");
        assert.ok(got, "claimed");
        assert.equal(await core.claimMacTask(userId, t.id, "Other Mac"), null, "only once");
        const manifest = await core.macManifest(got!.task, got!.token, api);
        return mac.runTask(manifest, { ffmpeg: "ffmpeg", cacheDir: join(work, "cache"), workDir: work, allowHttp: true, ...o });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no task appeared");
  };
  const argsFor = (out: string, threads: number) => ffmpegArgs(plan, { ...files, output: out } as never, source, { threads, filterThreads: 2, inputThreads: threads * 2, loudnessGainDb: 0 });
  const outKey = `${PREFIX.tests}mac-${run}/out.mp4`;

  it("is made on the Mac: same picture and sound as the cloud's own render, uploaded to the render's key", async () => {
    const a = argsFor(join(dir, "out.mp4"), 4);
    const { spec, temps } = await macTaskFor({ renderId: `r-${run}`, userId, kind: "preview", label: "Preview v1 of Test", dir, fontsDir: (files as { fontsDir: string }).fontsDir, runs: [{ args: a.args, graph: a.filterGraph, seconds: plan.outputSeconds }], outputs: [{ path: join(dir, "out.mp4"), key: outKey, type: "video/mp4" }] });
    keys.push(outKey, ...temps);
    // Footage and music by their storage keys; the graphic and captions inline; fonts by link; nothing names this machine.
    const by = Object.fromEntries(spec.inputs.map((x) => [x.name, x]));
    assert.equal(by.source.key, `${PREFIX.tests}mac-${run}/source.mp4`);
    const music = spec.inputs.find((x) => x.name.startsWith("ext/"));
    assert.ok(!music || music.key, "outside files by key");
    assert.ok(by["graphic-g1.webm"]?.data && by["captions.ass"]?.data, "small generated files inline");
    assert.ok((spec.fonts ?? []).length > 10, "the caption fonts");
    const text = JSON.stringify(spec.commands);
    assert.ok(!text.includes(dir) && !text.includes("/web/public/fonts"), "no path of this machine");
    assert.ok(spec.needs.includes("ass") && spec.needs.includes("libx264") && spec.needs.includes("libvpx-vp9"));
    const steps: string[] = [];
    const [res, macRes] = await Promise.all([
      runOnMac(spec, { signal: new AbortController().signal, pollMs: 100, onClaim: (d) => steps.push(`claim:${d}`), onDownload: () => steps.includes("download") || steps.push("download"), onRender: () => steps.includes("render") || steps.push("render"), onUpload: () => steps.includes("upload") || steps.push("upload") }),
      macTakes(),
    ]);
    assert.equal(macRes.ok, true, macRes.error);
    assert.equal(res.ok, true, (res as { why?: string }).why);
    assert.deepEqual(steps.slice(0, 1), ["claim:Test Mac"]);
    assert.ok(steps.includes("render"), `the worker heard it render (${steps.join(", ")})`);
    // The Mac's file against the cloud's own run of the same edit.
    const fromMac = join(work, "from-mac.mp4");
    const size = await core.downloadFile(outKey, fromMac);
    assert.equal(size, (res as { outputs: Record<string, number> }).outputs["out.mp4"]);
    const cloud = argsFor(join(work, "cloud.mp4"), 2);
    await writeFile(join(work, "graph.txt"), cloud.filterGraph);
    await sh("ffmpeg", cloud.args.map((x) => (x === "__FILTER_SCRIPT__" ? join(work, "graph.txt") : x)), { maxBuffer: 1 << 26 });
    const { stderr } = await sh("ffmpeg", ["-hide_banner", "-i", fromMac, "-i", join(work, "cloud.mp4"), "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { maxBuffer: 1 << 26 });
    const psnr = Number((stderr.match(/average:([\d.]+|inf)/) || [])[1]?.replace("inf", "99"));
    assert.ok(psnr > 35, `the same picture (PSNR ${psnr})`);
    const probe = (await sh("ffmpeg", ["-hide_banner", "-i", fromMac]).catch((e) => e)).stderr as string;
    assert.match(probe, /Audio: aac/); assert.match(probe, /Duration: 00:00:0[34]/);
  });

  it("a graphic's recording kept in storage goes in the task as the task's own copy: dropped meanwhile (its code changed), the Mac still has it", async () => {
    // As a render holds a graphic it fetched from storage: its recording's key noted for the file in the job's folder.
    const g = join(dir, "graphic-g1.webm"), gKey = `${PREFIX.graphics}mac-${run}/g1-v-abc.webm`, size = (await stat(g)).size;
    await core.uploadFile(gKey, g, "video/webm"); keys.push(gKey);
    core.noteOrigin(g, gKey, { size });
    try {
      const { spec, temps } = await macTaskFor({ renderId: `r4-${run}`, userId, kind: "preview", label: "Preview v4", dir, runs: [{ args: ["-hide_banner", "-nostdin", "-y", "-c:v", "libvpx-vp9", "-i", "graphic-g1.webm", "-frames:v", "1", "out.png"] }], outputs: [{ path: join(dir, "out.png"), key: `${PREFIX.tests}mac-${run}/r4.png`, type: "image/png" }] });
      keys.push(...temps);
      const input = spec.inputs.find((x) => x.name === "graphic-g1.webm") as { key?: string; size?: number } | undefined;
      assert.equal(input?.key, `${PREFIX.mac}r4-${run}/graphic-g1.webm`, "the task's own copy, not the recording's key");
      assert.equal(input?.size, size);
      assert.ok(temps.includes(input!.key!), "dropped with the task's other files when it is over");
      // The graphic's code changes: its recordings are dropped. The task's copy is still there for the Mac.
      await core.deleteObject(gKey);
      assert.equal((await core.headObject(input!.key!))?.size, size);
    } finally { core.forgetOrigins(g); }
  });

  it("a Mac that does not pick it up: the cloud makes it", async () => {
    const a = argsFor(join(dir, "out.mp4"), 2);
    const { spec } = await macTaskFor({ renderId: `r2-${run}`, userId, kind: "preview", label: "Preview v2", dir, runs: [{ args: a.args, graph: a.filterGraph }], outputs: [{ path: join(dir, "out.mp4"), key: outKey, type: "video/mp4" }], fontsDir: (files as { fontsDir: string }).fontsDir });
    const t0 = Date.now();
    const res = await runOnMac(spec, { signal: new AbortController().signal, pollMs: 100, onClaim: () => {}, onDownload: () => {}, onRender: () => {}, onUpload: () => {} });
    assert.deepEqual(res, { ok: false, why: "your Mac did not pick it up" });
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(await core.listMacTasks(userId), [], "no longer offered to the Mac");
  });

  it("a Mac that fails says why, and the cloud makes it", async () => {
    const { spec } = await macTaskFor({ renderId: `r3-${run}`, userId, kind: "preview", label: "Preview v3", dir, runs: [{ args: ["-hide_banner", "-nostdin", "-y", "-i", join(dir, "source"), "-vf", "nosuchfilter", join(dir, "out.mp4")] }], outputs: [{ path: join(dir, "out.mp4"), key: outKey, type: "video/mp4" }] });
    const [res] = await Promise.all([runOnMac(spec, { signal: new AbortController().signal, pollMs: 100, onClaim: () => {}, onDownload: () => {}, onRender: () => {}, onUpload: () => {} }), macTakes()]);
    assert.equal(res.ok, false);
    assert.match((res as { why: string }).why, /^the Mac could not render it: FFmpeg failed/);
  });

  it("stopped while the Mac makes it: the Mac stops too", async () => {
    const { spec } = await macTaskFor({ renderId: `r4-${run}`, userId, kind: "preview", label: "Preview v4", dir, runs: [{ args: ["-hide_banner", "-nostdin", "-y", "-re", "-stream_loop", "-1", "-i", join(dir, "source"), "-c:v", "libx264", "-preset", "ultrafast", "-t", "60", "-progress", "pipe:1", "-nostats", join(dir, "out.mp4")], seconds: 60 }], outputs: [{ path: join(dir, "out.mp4"), key: outKey, type: "video/mp4" }] });
    const ac = new AbortController();
    const waiting = runOnMac(spec, { signal: ac.signal, pollMs: 100, onClaim: () => {}, onDownload: () => {}, onRender: () => setTimeout(() => ac.abort(), 300), onUpload: () => {} });
    const [worker, macRes] = await Promise.allSettled([waiting, macTakes()]);
    assert.equal(worker.status, "rejected", "the worker's job stops");
    assert.equal(macRes.status === "fulfilled" && macRes.value.stopped, "stopped", "the Mac stopped when told");
  });

  it("a final from an original that stays on the Mac: planned from the preview copy, made from the Mac's own file, nothing uploaded", async () => {
    // The Mac's disk: the original, at 1280x720 (its preview copy in the cloud is 640x360).
    const disk = await mkdtemp(join(tmpdir(), "mac-disk-")), job = await mkdtemp(join(tmpdir(), "mac-job2-"));
    const original = join(disk, "Talk original.mov");
    await ff(["-f", "lavfi", "-i", `testsrc2=s=1280x720:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mov", original]);
    const osize = (await stat(original)).size;
    await ff(["-i", original, "-vf", "scale=640:360", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "mp4", join(job, "source")]);
    core.noteOrigin(join(job, "source"), `${PREFIX.tests}mac-${run}/proxy.mp4`, { size: (await stat(join(job, "source"))).size });
    const big = { width: 1280, height: 720, fps: 30, seconds: SECONDS, hasAudio: true };
    const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: () => undefined, getGraphic: () => undefined } as never;
    const snap = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "e", aspect: "16:9", styleId: "s2" } as never, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] } as never, ctx).snap;
    const fplan = planRender({ kind: "final", snapshot: snap, transcript: [], source: big, videoId: "v" });
    const ffiles = { source: join(job, "source"), output: join(job, "out.mp4"), broll: {}, graphics: {}, graphicSeconds: {}, audio: {}, videos: {}, under: {}, looks: {} };
    const a = ffmpegArgs(fplan, ffiles as never, big, { threads: 4, filterThreads: 2, inputThreads: 8 });
    const key = `${PREFIX.tests}mac-${run}/final.mp4`;
    keys.push(key);
    const macSources = new Map([[join(job, "source"), { videoId: "vid-orig", size: osize }]]);
    const { spec } = await macTaskFor({ renderId: `r5-${run}`, userId, kind: "final", label: "Final v1", dir: job, runs: [{ args: a.args, graph: a.filterGraph, seconds: fplan.outputSeconds }], outputs: [{ path: join(job, "out.mp4"), key, type: "video/mp4" }], macSources });
    const src = spec.inputs.find((x) => x.name === "source");
    assert.deepEqual(src, { name: "source", local: { videoId: "vid-orig", size: osize } }, "the Mac reads its own original: not the preview copy, nothing sent");
    const localFile = async (id: string, size: number) => (id === "vid-orig" && size === osize ? original : null);
    const [res, macRes] = await Promise.all([runOnMac(spec, { signal: new AbortController().signal, pollMs: 100, onClaim: () => {}, onDownload: () => {}, onRender: () => {}, onUpload: () => {} }), macTakes({ localFile })]);
    assert.equal(macRes.ok, true, macRes.error);
    assert.equal(res.ok, true);
    const got = join(work, "final-from-mac.mp4");
    await core.downloadFile(key, got);
    const probe = (await sh("ffmpeg", ["-hide_banner", "-i", got]).catch((e) => e)).stderr as string;
    assert.match(probe, new RegExp(`${fplan.width}x${fplan.height}`), `the final at its size (${fplan.width}x${fplan.height})`);
    // The original changed on the Mac (re-saved): the Mac says so; the final is not made from another file.
    const { spec: spec2 } = await macTaskFor({ renderId: `r6-${run}`, userId, kind: "final", label: "Final v2", dir: job, runs: [{ args: a.args, graph: a.filterGraph, seconds: fplan.outputSeconds }], outputs: [{ path: join(job, "out.mp4"), key, type: "video/mp4" }], macSources: new Map([[join(job, "source"), { videoId: "vid-orig", size: osize + 1 }]]) });
    const [res2] = await Promise.all([runOnMac(spec2, { signal: new AbortController().signal, pollMs: 100, onClaim: () => {}, onDownload: () => {}, onRender: () => {}, onUpload: () => {} }), macTakes({ localFile })]);
    assert.equal(res2.ok, false);
    assert.match((res2 as { why: string }).why, /original of this video is no longer where it was on this Mac/);
    await rm(disk, { recursive: true, force: true }); await rm(job, { recursive: true, force: true });
  });

  it("a heavy final on the Mac is made in pieces (the sound once, each piece, joined): the same file as one pass", async () => {
    // A 40 s edit of six clips (pieces of about 15 s).
    const job = await mkdtemp(join(tmpdir(), "mac-pieces-")), LONG = 48;
    await ff(["-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=${LONG}`, "-f", "lavfi", "-i", `sine=f=440:d=${LONG}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4", join(job, "source")]);
    const skey = `${PREFIX.tests}mac-${run}/long.mp4`;
    await core.uploadFile(skey, join(job, "source"), "video/mp4"); keys.push(skey);
    core.noteOrigin(join(job, "source"), skey, { size: (await stat(join(job, "source"))).size });
    const src = { width: W, height: H, fps: 30, seconds: LONG, hasAudio: true };
    const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: LONG, getStyle: () => undefined, getVideo: () => undefined, getGraphic: () => undefined } as never;
    const clips = [[1, 8], [9, 15], [16, 23], [24, 31], [32, 38], [39, 46]].map(([a, b], k) => ({ id: `c${k}`, start: a, end: b, label: "" }));
    const snap = applyOp({ timeline: buildInitialTimeline([], LONG, "clean", [], "v"), name: "e", aspect: "16:9", styleId: "s2" } as never, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips }] } as never, ctx).snap;
    const fplan = planRender({ kind: "final", snapshot: snap, transcript: [], source: src, videoId: "v" });
    const ffiles = { source: join(job, "source"), output: join(job, "out.mp4"), broll: {}, graphics: {}, graphicSeconds: {}, audio: {}, videos: {}, under: {}, looks: {} } as never;
    assert.equal(macPiecesFirst("final", { inputs: 7, scalers: 129 }), true, "the V3 short (129 scalers) goes in pieces on a Mac");
    assert.equal(macPiecesFirst("final", { inputs: 3, scalers: 20 }), false);
    assert.equal(macPiecesFirst("preview", { inputs: 40, scalers: 200 }), false, "previews stay one pass");
    const pr = await macPieceRuns({ plan: fplan, files: ffiles, source: src, dir: job, cpus: 2, audioBitrate: "192k" });
    assert.ok(pr && pr.count >= 2, `in pieces (${pr?.count})`);
    assert.equal(pr!.runs.length, pr!.count + 2, "the sound, each piece, the join");
    const joinArgs = pr!.runs.at(-1)!.args;
    assert.ok(joinArgs.includes("concat") && !joinArgs.includes("-safe"), "joined in FFmpeg's safe mode (names beside the list only)");
    const key = `${PREFIX.tests}mac-${run}/pieces.mp4`;
    keys.push(key);
    const { spec } = await macTaskFor({ renderId: `r6-${run}`, userId, kind: "final", label: "Final v6", dir: job, runs: pr!.runs, outputs: [{ path: join(job, "out.mp4"), key, type: "video/mp4" }] });
    const list = spec.inputs.find((x) => x.name === "pieces.txt");
    assert.equal(Buffer.from(list!.data!, "base64").toString(), Array.from({ length: pr!.count }, (_, n) => `file 'piece-${n}.mov'`).join("\n") + "\n", "the list names the pieces as the Mac makes them");
    const heard: number[] = [];
    const [res, macRes] = await Promise.all([runOnMac(spec, { signal: new AbortController().signal, pollMs: 100, onClaim: () => {}, onDownload: () => {}, onRender: (cmd) => { if (!heard.includes(cmd)) heard.push(cmd); }, onUpload: () => {} }), macTakes()]);
    assert.equal(macRes.ok, true, macRes.error);
    assert.equal(res.ok, true, (res as { why?: string }).why);
    assert.ok([...pr!.at.keys()].some((k) => heard.includes(k)), `the worker heard the pieces render (${heard.join(", ")})`);
    // The Mac's file against one pass of the same edit.
    const fromMac = join(job, "from-mac.mp4");
    await core.downloadFile(key, fromMac);
    const one = ffmpegArgs(fplan, { ...(ffiles as object), output: join(job, "one.mp4") } as never, src, { threads: 2, filterThreads: 2, inputThreads: 4 });
    await writeFile(join(job, "one.txt"), one.filterGraph);
    await sh("ffmpeg", one.args.map((x) => (x === "__FILTER_SCRIPT__" ? join(job, "one.txt") : x)), { maxBuffer: 1 << 26 });
    const { stderr } = await sh("ffmpeg", ["-hide_banner", "-i", fromMac, "-i", join(job, "one.mp4"), "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { maxBuffer: 1 << 26 });
    const psnr = Number((stderr.match(/average:([\d.]+|inf)/) || [])[1]?.replace("inf", "99"));
    assert.ok(psnr > 35, `the same picture (PSNR ${psnr})`);
    const dur = async (f: string) => Number((await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout);
    assert.ok(Math.abs((await dur(fromMac)) - (await dur(join(job, "one.mp4")))) < 0.1, "the same length");
    const probe = (await sh("ffmpeg", ["-hide_banner", "-i", fromMac]).catch((e) => e)).stderr as string;
    assert.match(probe, /Audio: aac/);
    await rm(job, { recursive: true, force: true });
  });

  it("the API: a wrong token or another user's claim gets nothing", async () => {
    const id = await core.createMacTask({ renderId: "x", userId, kind: "preview", label: "x", inputs: [{ name: "source", key: keys[0], size: 10 }], commands: [{ args: ["-version"] }], outputs: [{ name: "out.mp4", key: outKey, type: "video/mp4" }], needs: [] });
    assert.equal(await core.claimMacTask(`someone-else-${run}`, id, null), null);
    const got = await core.claimMacTask(userId, id, null);
    for (const what of ["progress", "done", "failed", "link"]) {
      const r = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/${what}`, headers: { "x-rendrr-task-token": "wrong" }, payload: { name: "source" } });
      assert.equal(r.statusCode, 404, what);
    }
    // A fresh link for one of its files (the one it has was refused mid-way); none for a file it does not have.
    const link = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/link`, headers: { "x-rendrr-task-token": got!.token }, payload: { name: "source" } });
    assert.equal(link.statusCode, 200);
    assert.match(link.json().url, /^https?:\/\//);
    const fetched = await fetch(link.json().url);
    assert.equal(fetched.status, 200, "the fresh link works");
    await fetched.arrayBuffer();
    const none = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/link`, headers: { "x-rendrr-task-token": got!.token }, payload: { name: "other" } });
    assert.equal(none.statusCode, 404);
    // An original in Drive is kept in the Mac's cache by its file, size and when it last changed.
    assert.equal(core.driveKeep({ fileId: "f1", version: "1700000000000" }, 123), "drive:f1#123#1700000000000");
    assert.notEqual(core.driveKeep({ fileId: "f1", version: "1700000000001" }, 123), core.driveKeep({ fileId: "f1", version: "1700000000000" }, 123));
    const ok = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/progress`, headers: { "x-rendrr-task-token": got!.token }, payload: { phase: "render", seconds: 1 } });
    assert.deepEqual(ok.json(), { stop: null });
    await core.stopMacTask(id, "stopped");
    const told = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/progress`, headers: { "x-rendrr-task-token": got!.token }, payload: {} });
    assert.deepEqual(told.json(), { stop: "stopped" });
    // A done without every output is refused.
    const short = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/done`, headers: { "x-rendrr-task-token": got!.token }, payload: { outputs: {} } });
    assert.equal(short.statusCode, 404);
  });
});
