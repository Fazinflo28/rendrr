// Phase 6 rendered and read back: a grade, an imported LUT, a green-screen clip keyed over b-roll laid under V1, a
// mask, pixelate and an area blur, and an HDR final. Each frame of the file is compared with the shared maths (the
// same numbers the editor's player uses) applied to the same clip rendered without its look. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, gradeFn, keyAlpha, maskPicture, parseCube, pixelBlock, sdrToHdr, type EditContext, type Grade, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;

const SECONDS = 6;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540; // the preview's size
const INV = ["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)))].join("\n");

describe("colour and compositing, rendered", () => {
  let dir = "", main = "", gs = "", pat = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "color-render-"));
    main = join(dir, "main.mp4"); gs = join(dir, "gs.mp4"); pat = join(dir, "pat.mp4");
    // A checkerboard of 8-pixel squares (12 at the preview's size), for pixelate and blur.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=2,format=gray,geq=lum='if(mod(floor(X/8)+floor(Y/8),2),235,16)'", "-f", "lavfi", "-i", "sine=f=440:d=2:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", pat]);
    // Smooth colour ramps (no fine detail, so the comparison measures colour, not compression) with a 440 Hz tone.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SECONDS},format=gbrp,geq=r='30+X*0.3':g='40+Y*0.5':b='200-X*0.2'`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-vf", "scale=out_color_matrix=bt709:out_range=tv", "-c:a", "aac", "-shortest", main]);
    // A green screen with an orange square in the middle.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0x00B140:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "color=0xE6782A:s=200x200:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3:sample_rate=48000", "-filter_complex", "[0][1]overlay=220:80,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-c:a", "aac", "-shortest", gs]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "gs" ? { id: "gs", name: "green screen", seconds: 3, ready: true } : id === "br" ? { id: "br", name: "ramps", seconds: SECONDS, ready: true } : id === "pt" ? { id: "pt", name: "checkerboard", seconds: 2, ready: true } : undefined), getLut: (id) => (id === "inv" ? { id, name: "Invert" } : undefined) };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  async function render(plan: RenderPlan, name: string, files: Partial<PlanFiles> = {}, src: SourceInfo = source, mainFile = main) {
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, { inv: parseCube(INV) })); looks[n] = p; }
    const all: PlanFiles = { source: mainFile, output: join(dir, `${name}.mp4`), videos: { gs, pt: pat }, looks, ...files };
    const { args, filterGraph } = ffmpegArgs(plan, all, src);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    const t0 = Date.now();
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    console.log(`${name}: rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return all.output;
  }
  /** The frame at t as RGB bytes at W x H (BT.709, TV range), decoded exactly as a browser's GPU does (through planar
   *  RGB: swscale's direct path to packed RGB is up to 2 levels off). */
  const rgbAt = (file: string, t: number) => bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  /** Mean of each 16 x 16 block (compression noise averages out; colour remains). */
  const blocks = (px: Buffer | number[], f?: (r: number, g: number, b: number) => [number, number, number]) => {
    const out: number[] = [];
    for (let by = 0; by < H; by += 18) for (let bx = 0; bx < W; bx += 16) {
      const s = [0, 0, 0];
      for (let y = by; y < by + 16; y++) for (let x = bx; x < bx + 16; x++) {
        const i = (y * W + x) * 3;
        const v = f ? f(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255).map((q) => q * 255) : [px[i], px[i + 1], px[i + 2]];
        for (let c = 0; c < 3; c++) s[c] += v[c];
      }
      out.push(s[0] / 256, s[1] / 256, s[2] / 256);
    }
    return out;
  };
  const diff = (a: number[], b: number[]) => { let m = 0, worst = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); m += d; worst = Math.max(worst, d); } return { mean: m / a.length, worst }; };

  // V1: a graded clip, a clip through the imported LUT, the green screen keyed over b-roll laid under V1, a masked clip,
  // a pixelated clip with a blurred area. Plain copies of the same footage come first, for reference.
  const GRADE: Grade = { exposure: 0.5, contrast: 20, temperature: 30, saturation: 130, curves: { r: [[0.5, 0.6]], master: [[0.25, 0.2]] } };
  const OPS: Op[] = [
    { op: "set_clips", track: "v1", clips: [{ id: "plain", start: 0, end: 1, label: "" }, { id: "graded", start: 0, end: 1, label: "" }, { id: "lut", start: 0, end: 1, label: "" }, { id: "masked", start: 0, end: 1, label: "" }] } as Op,
    { op: "add_clip", videoId: "pt", from: 0, to: 1, index: 4 } as Op,
    { op: "add_clip", videoId: "gs", from: 1, to: 2, index: 5 } as Op,
    { op: "set_grade", clipId: "graded", ...GRADE } as Op,
    { op: "set_grade", clipId: "lut", lut: { id: "inv" } } as Op,
    { op: "set_masks", clipId: "masked", masks: [{ shape: "ellipse", x: 0.25, y: 0.2, w: 0.5, h: 0.6 }] } as Op,
  ];
  const FX: Op = { op: "set_effects", clipId: "", effects: [{ type: "pixelate", amount: 20 }, { type: "blur", amount: 40, area: { shape: "rect", x: 0, y: 0, w: 0.5, h: 1 } }] } as Op;
  let plan: RenderPlan, file = "", plain: Buffer;
  it("renders each look, to the planned length", async () => {
    let s = edit(OPS);
    const v1 = s.timeline.tracks.v1 as { id: string; sourceVideoId: string }[];
    const gsClip = v1.find((c) => c.sourceVideoId === "gs")!.id, ptClip = v1.find((c) => c.sourceVideoId === "pt")!.id;
    s = applyOp(s, { op: "batch", ops: [{ ...FX, clipId: ptClip }, { op: "set_key", clipId: gsClip, color: "#00B140", similarity: 0.25, blend: 0.1, spill: 0.5 }, { op: "add_broll", videoId: "br", start: 5, end: 6, sourceStart: 0, edit: true }] as never }, ctx).snap;
    s = applyOp(s, { op: "set_under", clipId: s.timeline.tracks.v2[0].id, under: true }, ctx).snap;
    plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", sources: { gs: { width: 640, height: 360, fps: 30, seconds: 3, hasAudio: true }, pt: { width: 640, height: 360, fps: 30, seconds: 2, hasAudio: true } }, brollSeconds: { br: SECONDS }, luts: { inv: parseCube(INV) } });
    assert.equal(plan.outputSeconds, 6);
    console.log(plan.operations.filter((l) => /^(Color|Key|Masks|Blur|Under)/.test(l)).join("\n"));
    file = await render(plan, "looks", { under: { [plan.under![0].clipId]: main } });
    plain = await rgbAt(file, 0.5);
  });

  it("the grade: the file equals the shared grade function applied to the plain clip", async () => {
    const want = blocks(plain, gradeFn(GRADE)), got = blocks(await rgbAt(file, 1.5));
    const d = diff(got, want);
    console.log(`grade: mean ${d.mean.toFixed(2)}, worst ${d.worst.toFixed(2)} of 255`);
    assert.ok(d.mean < 1.5 && d.worst < 6, `grade within 1.5/255 on average (mean ${d.mean.toFixed(2)}, worst ${d.worst.toFixed(2)})`);
  });

  it("the imported LUT: the plain clip inverted", async () => {
    const d = diff(blocks(await rgbAt(file, 2.5)), blocks(plain, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    assert.ok(d.mean < 1.5 && d.worst < 6, `LUT within 1.5/255 (mean ${d.mean.toFixed(2)}, worst ${d.worst.toFixed(2)})`);
  });

  it("the mask: the picture inside the ellipse, black outside, the edge at half", async () => {
    const got = await rgbAt(file, 3.5), m = maskPicture([{ shape: "ellipse", x: 0.25, y: 0.2, w: 0.5, h: 0.6 }], W, H);
    let off = 0, n = 0;
    for (let y = 2; y < H; y += 7) for (let x = 2; x < W; x += 7) {
      const a = m[y * W + x] / 255, i = (y * W + x) * 3;
      if (a > 0.05 && a < 0.95) continue; // the 1-pixel edge
      for (let c = 0; c < 3; c++) { off += Math.abs(got[i + c] - plain[i + c] * a); n++; }
    }
    assert.ok(off / n < 3, `masked picture within 3/255 (${(off / n).toFixed(2)})`);
  });

  it("pixelate: each 11 x 11 block is one colour, the mean of the checkerboard there; the blurred half is flat", async () => {
    const got = await rgbAt(file, 4.5), B = pixelBlock(20, W, H);
    assert.equal(B, 11);
    const src = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", pat, "-frames:v", "1", "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"]);
    const grey = (buf: Buffer, x: number, y: number) => buf[(y * W + x) * 3 + 1];
    // Right half (pixelate only): blocks on the 11-pixel grid from the top left; inside each one colour (its middle
    // 7 x 7, away from the chroma edges), equal to the mean of the checkerboard's block.
    let spread = 0, off = 0, n = 0;
    for (let by = 22; by + B <= H - 22; by += B) for (let bx = 539; bx + B <= W - 22; bx += B) {
      let s0 = 0, lo = 255, hi = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) s0 += 16 + (src[y * W + x] * 219) / 255;
      for (let y = by + 2; y < by + B - 2; y++) for (let x = bx + 2; x < bx + B - 2; x++) { const v = grey(got, x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const want = ((s0 / (B * B) - 16) * 255) / 219;
      spread += hi - lo; off += Math.abs(grey(got, bx + 5, by + 5) - want); n++;
    }
    assert.ok(spread / n < 8, `blocks are one colour (spread ${(spread / n).toFixed(1)})`);
    assert.ok(off / n < 6, `block colour = the checkerboard's mean there (${(off / n).toFixed(1)} off)`);
    // Left half (pixelated, then blurred with sigma 10.8): no squares and no blocks left.
    let lo = 255, hi = 0;
    for (let y = 150; y < 390; y += 3) for (let x = 120; x < 360; x += 3) { const v = grey(got, x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    assert.ok(hi - lo < 30, `blurred half nearly flat (${lo}-${hi}; the checkerboard is 0-255)`);
  });

  it("the key: the green goes and the b-roll under V1 shows; the orange square stays", async () => {
    const got = await rgbAt(file, 5.5), under = plain; // the under b-roll is the same ramps, from its first second
    const gsPx = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", gs, "-frames:v", "1", "-vf", `scale=${W}:${H},scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp,format=rgb24`, "-f", "rawvideo", "pipe:1"]);
    let green = 0, gn = 0, orange = 0, on = 0;
    for (let y = 10; y < H; y += 9) for (let x = 10; x < W; x += 9) {
      const i = (y * W + x) * 3, a = keyAlpha(gsPx[i], gsPx[i + 1], gsPx[i + 2], { color: "#00B140", similarity: 0.25, blend: 0.1, spill: 0.5 });
      if (a === 0) { for (let c = 0; c < 3; c++) green += Math.abs(got[i + c] - under[i + c]); gn += 3; }
      else if (a === 255 && x > 360 && x < 600 && y > 140 && y < 400) { for (let c = 0; c < 3; c++) orange += Math.abs(got[i + c] - gsPx[i + c]); on += 3; }
    }
    assert.ok(gn > 1000 && on > 300, "both areas sampled");
    assert.ok(green / gn < 4, `keyed area shows the b-roll under V1 (${(green / gn).toFixed(2)})`);
    assert.ok(orange / on < 4, `the subject keeps its colour (${(orange / on).toFixed(2)})`);
  });

  it("HDR: a final of PQ footage stays PQ, 10-bit HEVC, BT.2020; SDR b-roll sits at SDR white (203 nits)", async () => {
    const pq = join(dir, "pq.mp4");
    // HDR footage: ramps in PQ, BT.2020, 10-bit.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=2,format=gbrp,geq=r='X*0.4':g='Y*0.7':b='120',format=gbrpf32le,zscale=tin=bt709:t=linear:npl=203,zscale=pin=bt709:p=bt2020:t=smpte2084:npl=203:m=bt2020nc:r=tv,format=yuv420p10le", "-f", "lavfi", "-i", "sine=f=440:d=2:sample_rate=48000", "-c:v", "libx265", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-c:a", "aac", "-shortest", pq]);
    const white = join(dir, "white.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=white:s=640x360:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", white]);
    const src: SourceInfo = { ...source, seconds: 2, hdr: true, transfer: "pq" };
    const hctx = { ...ctx, duration: 2, getVideo: (id: string) => (id === "w" ? { id: "w", name: "white", seconds: 2, ready: true } : undefined) };
    let s = applyOp({ timeline: buildInitialTimeline([], 2, "clean", [], "v"), name: "h", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "add_broll", videoId: "w", start: 1, end: 2, sourceStart: 0 }] as never }, hctx).snap;
    const p = planRender({ kind: "final", snapshot: s, transcript: [], source: src, videoId: "v", brollSeconds: { w: 2 } });
    assert.equal(p.hdr?.transfer, "pq");
    const out = await render(p, "hdr", { broll: { [p.broll[0].clipId]: white } }, src, pq);
    const info = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries,color_space", "-of", "json", out])).stdout).streams[0];
    assert.deepEqual(info, { codec_name: "hevc", pix_fmt: "yuv420p10le", color_space: "bt2020nc", color_transfer: "smpte2084", color_primaries: "bt2020" });
    // 10-bit luma: the HDR picture passes through (no tone-map), the white b-roll is PQ of 203 nits.
    const y10 = async (f: string, t: number) => { const b = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", f, "-frames:v", "1", "-vf", `scale=${W}:${H}:flags=area,format=yuv420p10le`, "-f", "rawvideo", "pipe:1"]); return (x: number, y: number) => b.readUInt16LE((y * W + x) * 2); };
    const a = await y10(out, 0.5), o = await y10(pq, 0.5);
    let d = 0; for (const [x, y] of [[100, 100], [480, 270], [900, 500]]) d = Math.max(d, Math.abs(a(x, y) - o(x, y)));
    assert.ok(d <= 6, `HDR picture kept (10-bit luma within ${d})`);
    const w = (await y10(out, 1.5))(480, 270), want = Math.round(64 + sdrToHdr(1, 1, 1, "pq")[0] * 876);
    assert.ok(Math.abs(w - want) <= 6, `SDR white at ${w}, PQ 203 nits is ${want}`);
  });
});
