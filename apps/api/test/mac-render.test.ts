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

  it("the API: a wrong token or another user's claim gets nothing", async () => {
    const id = await core.createMacTask({ renderId: "x", userId, kind: "preview", label: "x", inputs: [], commands: [{ args: ["-version"] }], outputs: [{ name: "out.mp4", key: outKey, type: "video/mp4" }], needs: [] });
    assert.equal(await core.claimMacTask(`someone-else-${run}`, id, null), null);
    const got = await core.claimMacTask(userId, id, null);
    for (const what of ["progress", "done", "failed"]) {
      const r = await app.inject({ method: "POST", url: `/desktop/tasks/${id}/${what}`, headers: { "x-rendrr-task-token": "wrong" }, payload: {} });
      assert.equal(r.statusCode, 404, what);
    }
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
