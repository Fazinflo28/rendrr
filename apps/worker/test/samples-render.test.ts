// Samples rendered and read back: an edit with a slowed clip, a dissolve, b-roll, a text layer and a zoom, rendered
// whole and as a 4.5 s sample (windowPlan) over the dissolve, the b-roll and the text. Every frame of the sample is the
// whole render's frame at the same edit time (within the encoders' noise; one frame off is much further), and its sound
// is the whole render's sound over the same seconds. Needs ffmpeg with libass.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, windowPlan, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 30, SW = 160, SH = 90;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("samples: a few seconds drawn as the whole render draws them", () => {
  let dir = "", main = "", orange = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "samples-render-"));
    main = join(dir, "main.mp4"); orange = join(dir, "orange.mp4");
    // A moving test picture and a tone that steps up every second (so a sound read from the wrong place differs).
    // In the middle, a flat block whose grey says the footage frame (7 levels a frame, clear of black), read even in a JPEG.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `color=black:s=160x90:r=30:d=${SECONDS},geq=lum='40+mod(N*7\\,180)':cb=128:cr=128`, "-f", "lavfi", "-i", `aevalsrc='0.4*sin(2*PI*(220+40*floor(t))*t)':s=48000:d=${SECONDS}`, "-filter_complex", "[0:v][1:v]overlay=240:135,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-b:a", "256k", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0xE07020:s=640x360:r=30:d=8", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", orange]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "orange" ? { id, name: "orange", seconds: 8, ready: true } : undefined) };
  const snap = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [
    { op: "set_captions", on: false },
    { op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 6, label: "" }, { id: "b", start: 10, end: 14, label: "" }, { id: "c", start: 20, end: 25, label: "" }] },
    { op: "set_speed", clipId: "b", speed: 0.5 },
    { op: "set_transition", clipId: "c", type: "dissolve", duration: 1 },
    { op: "add_broll", videoId: "orange", start: 12.5, end: 14, sourceStart: 0, edit: true },
    { op: "add_text", text: "HELLO", start: 11, end: 14.5, edit: true, x: 0.5, y: 0.3, anim: "none", color: "#000000", box: { color: "#FF00FF", opacity: 1, padding: 20 } },
    { op: "add_zoom", start: 9, end: 13, scale: 1.3, edit: true },
  ] as Op[] } as never, ctx).snap;
  const render = async (plan: RenderPlan, name: string, still = false) => {
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, `${name}.${still ? "jpg" : "mp4"}`), looks, broll: Object.fromEntries(plan.broll.map((b) => [b.clipId, orange])), assPath: join(dir, `${name}.ass`) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0, still });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return files.output;
  };
  const frames = async (file: string) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${SW}:${SH}:flags=area,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    const n = raw.length / (SW * SH * 3);
    return Array.from({ length: n }, (_, k) => raw.subarray(k * SW * SH * 3, (k + 1) * SW * SH * 3));
  };
  /** The block's grey (the footage frame it shows), in the middle of the picture. */
  const block = (f: Buffer) => { let sum = 0, n = 0; for (let y = 39; y < 52; y++) for (let x = 67; x < 94; x++) { sum += f[(y * SW + x) * 3]; n++; } return sum / n; };
  const diff = (x: Buffer, y: Buffer) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
  const pcm = async (file: string) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  };
  const corr = (x: Float32Array, y: Float32Array) => {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0; const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return (sxy - (sx * sy) / n) / Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
  };

  it("every frame and the sound match the whole render's over the same seconds", async () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: [], source, videoId: "v", brollSeconds: { orange: 8 } });
    const t = plan.transitions!.find((x) => x.type === "dissolve")!;
    assert.ok(Math.abs(t.at - 12) < 1e-6, `the dissolve is on the cut at 0:12 (${t.at})`);
    const sample = windowPlan(plan, 10.5, 15);
    assert.deepEqual(sample.window, { from: 10.5, to: 15 });
    assert.equal(sample.parts.length, 2, "the slowed clip's end and the next clip's start");
    const fullF = await frames(await render(plan, "full")), outS = await render(sample, "sample"), sampF = await frames(outS);
    const k0 = Math.round(10.5 * 30), n = Math.round(4.5 * 30);
    assert.equal(sampF.length, n, `the sample is 4.5 s of frames (${sampF.length})`);
    const same = sampF.map((f, k) => diff(f, fullF[k0 + k]));
    const off = sampF.slice(1, -1).map((f, k) => Math.min(diff(f, fullF[k0 + k]), diff(f, fullF[k0 + k + 2])));
    const worst = Math.max(...same), at = same.indexOf(worst);
    const offMax = Math.max(...off);
    console.log(`frames: worst difference ${worst.toFixed(2)} (frame ${at}, edit ${(10.5 + at / 30).toFixed(3)} s), one frame off: up to ${offMax.toFixed(2)}`);
    assert.ok(worst < 1.5, `every frame as the whole render draws it (worst ${worst.toFixed(2)} at frame ${at})`);
    assert.ok(offMax > 4 * worst, "one frame off is much further (the comparison sees the timing)");
    // The b-roll, the text box and the dissolve are in it, at their times.
    const px = (f: Buffer, x: number, y: number) => [0, 1, 2].map((c) => f[(Math.round(y * SH) * SW + Math.round(x * SW)) * 3 + c]);
    const orangeAt = px(sampF[Math.round((13 - 10.5) * 30)], 0.5, 0.8);
    assert.ok(orangeAt[0] > 190 && orangeAt[2] < 80, `the b-roll at 0:13 (${orangeAt})`);
    const s = await pcm(outS), w = await pcm(join(dir, "full.mp4"));
    const len = Math.round(4.5 * 16000), a0 = Math.round(10.5 * 16000), edge = 3200;
    const c = corr(s.subarray(edge, len - edge), w.subarray(a0 + edge, a0 + len - edge));
    const shifted = corr(s.subarray(edge, len - edge), w.subarray(a0 + edge + 800, a0 + len - edge + 800));
    console.log(`sound: ${(s.length / 16000).toFixed(3)} s, correlation with the whole render's ${c.toFixed(4)} (50 ms off: ${shifted.toFixed(4)})`);
    assert.ok(Math.abs(s.length / 16000 - 4.5) < 0.03, "the sound is the sample's length");
    assert.ok(c > 0.995 && c - shifted > 0.02, `the same sound as the whole render over those seconds (${c.toFixed(4)})`);
    // Stills (picture only, a JPEG): on the slowed clip's second showing of a frame and in the dissolve, the picture
    // within JPEG noise of the whole render's frame, and the middle block's grey (which footage frame) the same.
    for (const t of [11 + 1 / 30, 12.1]) {
      const k = Math.round(t * 30), w = windowPlan(plan, t, t);
      const [f] = await frames(await render(w, `still-${k}`, true));
      const d = diff(f, fullF[k]), g = block(f), want = block(fullF[k]), others = [k - 2, k + 2].map((j) => block(fullF[j]));
      console.log(`still at ${t.toFixed(3)} s: difference ${d.toFixed(2)}; block ${g.toFixed(1)}, the render's ${want.toFixed(1)} (two frames away ${others.map((x) => x.toFixed(1)).join(", ")})`);
      assert.ok(d < 6, `the still at ${t.toFixed(3)} s is the whole render's frame (${d.toFixed(2)})`);
      assert.ok(Math.abs(g - want) < 2.5 && others.every((x) => Math.abs(x - g) > Math.abs(want - g) + 3), `the still at ${t.toFixed(3)} s shows the same footage frame (${g.toFixed(1)} vs ${want.toFixed(1)})`);
    }
  });

  it("a reversed clip cut at both ends by the window: every frame as the whole render shows it", async () => {
    const s = applyOp(snap(), { op: "set_speed", clipId: "b", speed: 1, reverse: true } as Op, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { orange: 8 } });
    const b = plan.parts.find((x) => x.clipIds[0] === "b")!;
    assert.ok(b.rate! < 0, "b plays backwards");
    const from = b.start + 1 + 1 / 30, to = b.end - 1;
    const sample = windowPlan(plan, from, to);
    assert.equal(sample.parts.length, 1);
    const fullF = await frames(await render(plan, "rfull")), sampF = await frames(await render(sample, "rsample"));
    const k0 = Math.round(from * 30);
    const same = sampF.map((f, k) => diff(f, fullF[k0 + k])), worst = Math.max(...same);
    const off = sampF.slice(1, -1).map((f, k) => Math.min(diff(f, fullF[k0 + k]), diff(f, fullF[k0 + k + 2]))), offMax = Math.max(...off);
    console.log(`reversed: ${sampF.length} frames, worst difference ${worst.toFixed(2)}, one frame off: up to ${offMax.toFixed(2)}`);
    assert.equal(sampF.length, Math.round((to - from) * 30));
    assert.ok(worst < 1.5 && offMax > 4 * worst, `every frame as the whole render draws it (worst ${worst.toFixed(2)})`);
  });
});
