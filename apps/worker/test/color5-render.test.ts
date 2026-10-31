// Phase 5 rendered and read back: a grade with Lumetri's tone, vibrance, a wheel, an HSL secondary and Hue vs Sat (all
// in the grade's LUT) equals the shared grade function applied to the same clip rendered plain; a vignette darkens the
// corners by its amount and leaves the middle. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, buildLut, gradeFn, lutSizeFor, sampleLut, type EditContext, type Grade, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 3;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540;

describe("Phase 5 colour, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "color5-render-"));
    main = join(dir, "main.mp4");
    // Smooth ramps of every hue and brightness (no fine detail: the comparison measures colour, not compression).
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SECONDS},format=gbrp,geq=r='128+110*cos(X/640*6.283)*Y/360':g='128+110*cos(X/640*6.283-2.094)*Y/360':b='128+110*cos(X/640*6.283+2.094)*Y/360'`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv444p", "-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", files.output, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  };
  const px = (f: Buffer, x: number, y: number) => { const o = (Math.round(y) * W + Math.round(x)) * 3; return [f[o] / 255, f[o + 1] / 255, f[o + 2] / 255] as [number, number, number]; };
  let plain: Buffer;

  it("the grade: the file equals the shared grade (its LUT, as the player draws it) applied to the plain clip", async () => {
    plain = await render(edit([]), "plain");
    const grade: Grade = { highlights: -40, shadows: 35, whites: 15, blacks: -10, vibrance: 30, wheels: { shadows: { hue: 200, amount: 30 }, highlights: { hue: 40, amount: 20 } }, hsl: [{ hue: 210, range: 60, saturation: 150, hueShift: -15 }], hueSat: [[0, 0.3], [1 / 3, 0.5], [2 / 3, 0.5]] };
    const graded = await render(edit([{ op: "set_grade", all: true, ...grade } as Op]), "graded");
    // The reference: the source itself (near lossless), scaled to the preview's size as the render fits it, so the
    // comparison is not thrown by the plain render's own compression noise (hue-based steps react to it near grey).
    const src = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", main, "-frames:v", "1", "-vf", `scale=${W}:${H}:in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    // The grade as the player draws it: its LUT (49 points for HSL and Hue vs Sat), trilinear, as lut3d reads it.
    const n0 = lutSizeFor(grade), lut = { kind: "3d" as const, size: n0, data: buildLut(grade, null, n0), min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const f = (r: number, g: number, b: number) => sampleLut(lut, r, g, b);
    const exact = gradeFn(grade);
    assert.ok(Math.abs(exact(0.4, 0.5, 0.7)[2] - f(0.4, 0.5, 0.7)[2]) < 0.02, "the LUT is the grade function");
    let worst = 0, sum = 0, n = 0;
    // Each point averaged over 9 x 9 pixels (the function applied to each plain pixel first), so compression noise
    // averages out as it does in the Phase 6 colour test.
    for (let y = 30; y < H - 30; y += 24) for (let x = 20; x < W - 20; x += 24) {
      const want = [0, 0, 0], got = [0, 0, 0];
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const a = f(...px(src, x + dx, y + dy)), b = px(graded, x + dx, y + dy); for (let k = 0; k < 3; k++) { want[k] += a[k] / 81; got[k] += b[k] / 81; } }
      for (let k = 0; k < 3; k++) { const d = Math.abs(want[k] - got[k]) * 255; if (d > worst && process.env.WHERE) console.log(`at ${x},${y} ch ${k}: source ${px(src, x, y).map((v) => Math.round(v * 255))} want ${want.map((v) => Math.round(v * 255))} got ${got.map((v) => Math.round(v * 255))}`); worst = Math.max(worst, d); sum += d; n++; }
    }
    // Any render sits a level or two from the raw source decode (its own scaling and encode): measured on the plain one.
    let base = 0;
    for (let y = 30; y < H - 30; y += 24) for (let x = 20; x < W - 20; x += 24) {
      const a = [0, 0, 0], b = [0, 0, 0];
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const p = px(src, x + dx, y + dy), q = px(plain, x + dx, y + dy); for (let k = 0; k < 3; k++) { a[k] += p[k] / 81; b[k] += q[k] / 81; } }
      for (let k = 0; k < 3; k++) base += Math.abs(a[k] - b[k]) * 255;
    }
    console.log(`grade: mean difference ${(sum / n).toFixed(2)} (a plain render: ${(base / n).toFixed(2)}), largest ${worst.toFixed(1)} of 255 over ${n / 3} points`);
    assert.ok(sum / n < base / n + 1, `mean ${sum / n} against ${base / n} plain`);
    assert.ok(worst < 8, `largest ${worst}`);
  });

  it("the vignette darkens the corners by its amount and leaves the middle", async () => {
    const v = await render(edit([{ op: "set_effects", all: true, effects: [{ type: "vignette", amount: 40 }] } as Op]), "vignette");
    const mid = (f: Buffer) => px(f, W / 2, H / 2), corner = (f: Buffer) => px(f, 6, 6);
    const r = (a: number[], b: number[]) => (a[0] + a[1] + a[2]) / (b[0] + b[1] + b[2]);
    console.log(`vignette: middle ${r(mid(v), mid(plain)).toFixed(3)} of plain, corner ${r(corner(v), corner(plain)).toFixed(3)}`);
    assert.ok(Math.abs(r(mid(v), mid(plain)) - 1) < 0.02, "the middle is left");
    assert.ok(Math.abs(r(corner(v), corner(plain)) - 0.6) < 0.08, "the corner is 40% darker");
  });
});
