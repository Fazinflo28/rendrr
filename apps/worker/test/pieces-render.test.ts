// A final made in pieces (what the worker does for a heavy final, or when FFmpeg is killed for running out of memory)
// is the same video as the final made in one pass: an edit with a slowed clip, a dissolve, b-roll, a text box and a
// zoom, rendered whole and in pieces of about 5 s (pieceRanges: cut at joins, never inside the dissolve). The sound is
// made once for the whole edit on its own (sound: "only", no picture read), each piece is picture only (sound: "none",
// drawn from windowPlan), then they are joined under the one sound track (joinPieces). Same length, the same frame at
// every edit time (within the encoder's noise), the same sound, and no gap or click where the pieces meet. Also: best
// quality makes the finer encode and 320k sound, and the best resolution is the footage's own.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, bestResolution, buildInitialTimeline, isBestQuality, qualityLabel, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, pieceRanges, planRender, windowPlan, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { probe, run } from "../src/lib/ffmpeg";
import { joinPieces } from "../src/lib/deliver";

const execFileP = promisify(execFile);
const SECONDS = 30, SW = 160, SH = 90;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("a final made in pieces is the final made in one pass", () => {
  let dir = "", main = "", orange = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "pieces-render-"));
    main = join(dir, "main.mp4"); orange = join(dir, "orange.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `aevalsrc='0.4*sin(2*PI*(220+40*floor(t))*t)':s=48000:d=${SECONDS}`, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0xE07020:s=640x360:r=30:d=8", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", orange]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "orange" ? { id, name: "orange", seconds: 8, ready: true } : undefined) };
  const snap = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [
    { op: "set_captions", on: false },
    { op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 6, label: "" }, { id: "b", start: 10, end: 14, label: "" }, { id: "c", start: 20, end: 25, label: "" }, { id: "d", start: 26, end: 29, label: "" }] },
    { op: "set_speed", clipId: "b", speed: 0.5 },
    { op: "set_transition", clipId: "c", type: "dissolve", duration: 1 },
    { op: "add_broll", videoId: "orange", start: 12.5, end: 14, sourceStart: 0, edit: true },
    { op: "add_text", text: "HELLO", start: 11, end: 14.5, edit: true, x: 0.5, y: 0.3, anim: "none", color: "#000000", box: { color: "#FF00FF", opacity: 1, padding: 20 } },
    { op: "add_zoom", start: 9, end: 13, scale: 1.3, edit: true },
  ] as Op[] } as never, ctx).snap;
  const filesFor = async (plan: RenderPlan, name: string, ext = "mp4") => {
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, `${name}.${ext}`), looks, broll: Object.fromEntries(plan.broll.map((b) => [b.clipId, orange])), assPath: join(dir, `${name}.ass`) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    return files;
  };
  const render = async (plan: RenderPlan, name: string, opts: { sound?: "only" | "none" } = {}) => {
    const files = await filesFor(plan, name, opts.sound === "only" ? "wav" : opts.sound === "none" ? "mov" : "mp4");
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0, ...opts });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { file: files.output, args };
  };
  const frames = async (file: string) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${SW}:${SH}:flags=area,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    const n = raw.length / (SW * SH * 3);
    return Array.from({ length: n }, (_, k) => raw.subarray(k * SW * SH * 3, (k + 1) * SW * SH * 3));
  };
  const diff = (x: Buffer, y: Buffer) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
  const pcm = async (file: string) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  };
  const corr = (x: Float32Array, y: Float32Array) => {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0; const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return (sxy - (sx * sy) / n) / Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
  };

  it("pieces cut at joins, never inside a transition; a short edit is one piece", () => {
    const plan = planRender({ kind: "final", snapshot: snap(), transcript: [], source, videoId: "v", brollSeconds: { orange: 8 } });
    const ps = pieceRanges(plan, 5), d = plan.transitions!.find((x) => x.type === "dissolve")!;
    console.log(`edit ${plan.outputSeconds.toFixed(3)} s; pieces ${ps.map((p) => `${p.a.toFixed(3)}-${p.b.toFixed(3)}`).join(", ")}; joins ${plan.parts.slice(1).map((p) => p.start.toFixed(3)).join(", ")}; dissolve ${d.start.toFixed(3)}-${d.end.toFixed(3)}`);
    assert.ok(ps.length >= 3, "several pieces");
    assert.equal(ps[0].a, 0); assert.ok(Math.abs(ps[ps.length - 1].b - plan.outputSeconds) < 1 / 60);
    for (let i = 1; i < ps.length; i++) assert.equal(ps[i].a, ps[i - 1].b, "the pieces follow on");
    for (const p of ps.slice(1)) {
      assert.ok(!(p.a > d.start - 1e-6 && p.a < d.end + 1e-6), `no cut inside the dissolve (${p.a})`);
      assert.ok(Math.abs(p.a * 30 - Math.round(p.a * 30)) < 1e-6, "cuts on frames");
    }
    assert.ok(ps.slice(1).some((p) => plan.parts.some((x) => Math.abs(x.start - p.a) < 1e-6)), "a cut moved to a join of two clips");
    assert.deepEqual(pieceRanges({ ...plan, outputSeconds: 12 }, 15), [{ a: 0, b: 12 }]);
  });

  it("joined, the pieces are the whole render: length, every frame, the sound, no gap where they meet", async () => {
    const plan = planRender({ kind: "final", snapshot: snap(), transcript: [], source, videoId: "v", brollSeconds: { orange: 8 } });
    const whole = (await render(plan, "whole")).file;
    const ps = pieceRanges(plan, 5), made: string[] = [];
    const sound = await render(plan, "sound", { sound: "only" });
    assert.ok(!sound.args.includes("[vout]") && !/scale=|overlay=/.test(await readFile(join(dir, "sound.txt"), "utf8")), "the sound pass reads and draws no picture");
    for (const [k, p] of ps.entries()) {
      const piece = await render(windowPlan(plan, p.a, p.b), `piece-${k}`, { sound: "none" });
      assert.ok(piece.args.includes("-an") && !piece.args.includes("[aout]"), "a piece is picture only");
      assert.equal((await probe(piece.file)).hasAudio, false);
      made.push(piece.file);
    }
    const joined = join(dir, "joined.mp4");
    await joinPieces(dir, made, joined, "192k", undefined, sound.file);
    const wi = await probe(whole), ji = await probe(joined);
    console.log(`whole ${wi.seconds.toFixed(3)} s, joined ${ji.seconds.toFixed(3)} s (${ps.length} pieces)`);
    assert.ok(Math.abs(wi.seconds - ji.seconds) < 0.05, "the same length");
    const wf = await frames(whole), jf = await frames(joined);
    assert.equal(jf.length, wf.length, `the same frames (${jf.length} and ${wf.length})`);
    const d = jf.map((f, k) => diff(f, wf[k])), worst = Math.max(...d), at = d.indexOf(worst);
    const shifted = Math.max(...jf.slice(1, -1).map((f, k) => Math.min(diff(f, wf[k]), diff(f, wf[k + 2]))));
    console.log(`frames: worst difference ${worst.toFixed(2)} (frame ${at}, ${(at / 30).toFixed(3)} s); one frame off: up to ${shifted.toFixed(2)}`);
    assert.ok(worst < 2, `every frame as the whole render draws it (worst ${worst.toFixed(2)} at ${(at / 30).toFixed(3)} s)`);
    assert.ok(shifted > 3 * worst, "one frame off is further (the comparison sees timing)");
    const ws = await pcm(whole), js = await pcm(joined);
    const c = corr(js, ws);
    console.log(`sound: ${(js.length / 48000).toFixed(3)} s and ${(ws.length / 48000).toFixed(3)} s, correlation ${c.toFixed(4)}`);
    assert.ok(Math.abs(js.length - ws.length) < 48000 * 0.03, "the same sound length");
    assert.ok(c > 0.99, `the same sound (${c.toFixed(4)})`);
    // Where pieces meet: no hole (no run of near silence) and no click (no jump far above the sound's own steps).
    for (const p of ps.slice(1)) {
      const at0 = Math.round(p.a * 48000), win = js.subarray(at0 - 2400, at0 + 2400), ref = ws.subarray(at0 - 2400, at0 + 2400);
      let run0 = 0, longest = 0, jump = 0, jumpRef = 0;
      for (let i = 0; i < win.length; i++) { run0 = Math.abs(win[i]) < 1e-3 ? run0 + 1 : 0; longest = Math.max(longest, run0); if (i) { jump = Math.max(jump, Math.abs(win[i] - win[i - 1])); jumpRef = Math.max(jumpRef, Math.abs(ref[i] - ref[i - 1])); } }
      let rmsRef = 0; for (const x of ref) rmsRef += x * x;
      console.log(`join at ${p.a.toFixed(3)} s: longest near-silence ${longest} samples, biggest step ${jump.toFixed(3)} (whole render ${jumpRef.toFixed(3)})`);
      if (rmsRef / ref.length > 1e-3) assert.ok(longest < 96, `no gap at the join at ${p.a.toFixed(3)} s (${longest} samples)`);
      assert.ok(jump < jumpRef * 1.5 + 0.02, `no click at the join at ${p.a.toFixed(3)} s`);
    }
  });

  it("best quality: a finer encode and 320k sound; the best resolution is the footage's own", () => {
    const plan = planRender({ kind: "final", snapshot: snap(), transcript: [], source, videoId: "v", brollSeconds: { orange: 8 }, best: true });
    assert.equal(plan.best, true);
    const { args } = ffmpegArgs(plan, { source: main, output: join(dir, "b.mp4"), broll: {} }, source, { loudnessGainDb: 0 });
    const at = (k: string) => args[args.indexOf(k) + 1];
    assert.deepEqual([at("-preset"), at("-crf"), at("-b:a")], ["medium", "16", "320k"]);
    const std = ffmpegArgs(planRender({ kind: "final", snapshot: snap(), transcript: [], source, videoId: "v", brollSeconds: { orange: 8 } }), { source: main, output: join(dir, "s.mp4"), broll: {} }, source, { loudnessGainDb: 0 }).args;
    assert.deepEqual([std[std.indexOf("-preset") + 1], std[std.indexOf("-crf") + 1], std[std.indexOf("-b:a") + 1]], ["veryfast", "20", "192k"]);
    assert.equal(bestResolution("9:16", 2160, 3840), "4k", "vertical 4K footage in a vertical edit: 4K");
    assert.equal(bestResolution("9:16", 3840, 2160), "1080p", "landscape 4K cropped to vertical is 1215 px wide: 1080p");
    assert.equal(bestResolution("16:9", 3840, 2160), "4k");
    assert.equal(bestResolution("16:9", 1920, 1080), "1080p");
    assert.equal(qualityLabel({ resolution: "4k", best: true }), "4K best");
    assert.ok(isBestQuality("4K best") && !isBestQuality("4K HEVC"));
  });
});
