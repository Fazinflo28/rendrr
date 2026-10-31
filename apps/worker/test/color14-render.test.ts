// Phase 14 rendered and read back: Hue vs Hue and Luma vs Sat (in the grade's LUT) equal the shared grade function
// applied to the source, as the player draws it; greens turn toward teal and the shadows lose colour in the file.
// Needs ffmpeg.
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

describe("Phase 14 colour curves, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "color14-render-"));
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

  it("Hue vs Hue and Luma vs Sat: the file equals the shared grade applied to the source", async () => {
    const plain = await render(edit([]), "plain");
    const grade: Grade = { hueHue: [[0, 0.5], [1 / 3, 0.5 + 40 / 360], [2 / 3, 0.5]], lumaSat: [[0, 0.15], [0.5, 0.5], [1, 0.5]] };
    const graded = await render(edit([{ op: "set_grade", all: true, ...grade } as Op]), "graded");
    const src = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", main, "-frames:v", "1", "-vf", `scale=${W}:${H}:in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    const n0 = lutSizeFor(grade), lut = { kind: "3d" as const, size: n0, data: buildLut(grade, null, n0), min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const f = (r: number, g: number, b: number) => sampleLut(lut, r, g, b);
    assert.equal(n0, 49);
    let worst = 0, sum = 0, n = 0, base = 0;
    for (let y = 30; y < H - 30; y += 24) for (let x = 20; x < W - 20; x += 24) {
      const want = [0, 0, 0], got = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const s0 = px(src, x + dx, y + dy), w0 = f(...s0), g0 = px(graded, x + dx, y + dy), p0 = px(plain, x + dx, y + dy);
        for (let k = 0; k < 3; k++) { want[k] += w0[k] / 81; got[k] += g0[k] / 81; a[k] += s0[k] / 81; b[k] += p0[k] / 81; }
      }
      for (let k = 0; k < 3; k++) { const d = Math.abs(want[k] - got[k]) * 255; worst = Math.max(worst, d); sum += d; n++; base += Math.abs(a[k] - b[k]) * 255; }
    }
    // Greens turn toward teal: the source's greenest patch (hue near 120°) comes out near 160°.
    const hue = (p: number[]) => { const [r, g, b] = p, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
    let gx = 0, gy = 0, best = 0;
    for (let y = H * 0.7; y < H - 20; y += 10) for (let x = 20; x < W - 20; x += 6) { const p = px(src, x, y), h = hue(p), sat = Math.max(...p) - Math.min(...p); if (Math.abs(h - 120) < 6 && sat > best) { best = sat; gx = x; gy = y; } }
    const greenWas = hue(px(src, gx, gy)), greenNow = hue(px(graded, gx, gy));
    console.log(`curves: mean difference ${(sum / n).toFixed(2)} (a plain render: ${(base / n).toFixed(2)}), largest ${worst.toFixed(1)}; green at ${gx},${gy}: ${greenWas.toFixed(0)}° -> ${greenNow.toFixed(0)}°`);
    assert.ok(sum / n < base / n + 1, `mean ${sum / n} against ${base / n} plain`);
    assert.ok(worst < 9, `largest ${worst}`);
    assert.ok(greenNow - greenWas > 30, "greens turned toward teal");
  });
});
