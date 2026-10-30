// Skin retouch rendered and read back, on a real face (the astronaut fixture, twice side by side, with grain added): the
// face's fine texture drops, its tone stays, what is not skin (the flag's blue) is untouched, an area keeps it to one
// face, and a 1080p final (worked at 540p, the change added to the full picture) retouches the same way. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;
const SECONDS = 2;
const source: SourceInfo = { width: 1280, height: 720, fps: 30, seconds: SECONDS, hasAudio: true };
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "astronaut.jpg");

describe("skin retouch, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "skin-render-"));
    main = join(dir, "faces.mp4");
    // Two copies of the portrait (640 x 640 each, 40 px down) on 1280 x 720, with luma grain as skin texture.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", FIXTURE, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", `[0:v]scale=640:640:flags=lanczos,split[a][b];[a][b]hstack,pad=1280:720:0:40:color=0x303030,noise=c0s=14:c0f=t,fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`,
      "-map", "[v]", "-map", "1:a", "-t", String(SECONDS), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  const plan_ = (snapshot: Snapshot, kind: "preview" | "final") => planRender({ kind, snapshot, transcript: [], source, videoId: "v" });
  async function render(plan: RenderPlan, name: string) {
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan)); looks[n] = p; }
    const all: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks };
    const { args, filterGraph } = ffmpegArgs(plan, all, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    const t0 = Date.now();
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    console.log(`${name}: rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return all.output;
  }
  /** The middle frame as RGB bytes at w x h. */
  const frame = (file: string, w: number, h: number) => bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1.0", "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}:in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp,format=rgb24`, "-f", "rawvideo", "pipe:1"]);
  /** A box (shares of the frame) of a w x h picture: its mean colour, and its fine texture (luma minus its 5 x 5 mean). */
  function box(px: Buffer, w: number, h: number, [x0, y0, x1, y1]: number[]) {
    const X0 = Math.round(x0 * w), Y0 = Math.round(y0 * h), X1 = Math.round(x1 * w), Y1 = Math.round(y1 * h);
    const luma = (x: number, y: number) => { const i = (y * w + x) * 3; return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; };
    const mean = [0, 0, 0]; let n = 0, tex = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const i = (y * w + x) * 3; mean[0] += px[i]; mean[1] += px[i + 1]; mean[2] += px[i + 2]; n++;
      let s = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += luma(x + dx, y + dy);
      tex += (luma(x, y) - s / 25) ** 2;
    }
    return { mean: mean.map((v) => v / n), texture: Math.sqrt(tex / n) };
  }
  // In shares of the 16:9 frame: the left and right faces' cheeks and forehead, and the flag's blue on the left copy.
  const FACE_L = [231 / 1280, 150 / 720, 320 / 1280, 215 / 720], FACE_R = FACE_L.map((v, i) => (i % 2 ? v : v + 0.5));
  const BLUE = [8 / 1280, 60 / 720, 70 / 1280, 140 / 720];
  const RETOUCH: Op = { op: "retouch_skin", area: "frame", smooth: 60, blemishes: 60, even: 50 } as Op;

  it("the preview: the face smoother, its tone kept, the flag untouched", async () => {
    // Both through the same RGB look (a grade of next to nothing), so only the retouch differs.
    const NEUTRAL = { op: "set_grade", all: true, exposure: 0.001 } as Op;
    const plain = await render(plan_(edit([NEUTRAL]), "preview"), "plain");
    const plan = plan_(edit([NEUTRAL, RETOUCH]), "preview");
    assert.match(plan.operations.join("\n"), /Skin: \S+ smooth 60, blemishes 60, even 50, brighten 0, whole picture/);
    const done = await render(plan, "skin");
    const [w, h] = [plan.width, plan.height];
    const a = await frame(plain, w, h), b = await frame(done, w, h);
    for (const f of [FACE_L, FACE_R]) {
      const p = box(a, w, h, f), r = box(b, w, h, f);
      console.log(`face texture ${p.texture.toFixed(2)} -> ${r.texture.toFixed(2)}; mean ${p.mean.map((v) => v.toFixed(1))} -> ${r.mean.map((v) => v.toFixed(1))}`);
      assert.ok(r.texture < p.texture * 0.7, `the face's fine texture drops by 30% or more (${p.texture.toFixed(2)} -> ${r.texture.toFixed(2)})`);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(r.mean[c] - p.mean[c]) < 4, `the skin's tone is kept (channel ${c}: ${p.mean[c].toFixed(1)} -> ${r.mean[c].toFixed(1)})`);
    }
    // The encoder's noise differs a level or two everywhere once anything changes, so what is not skin is compared by
    // its colour and texture.
    const bp = box(a, w, h, BLUE), br = box(b, w, h, BLUE);
    console.log(`flag blue ${bp.mean.map((v) => v.toFixed(1))} -> ${br.mean.map((v) => v.toFixed(1))}, texture ${bp.texture.toFixed(2)} -> ${br.texture.toFixed(2)}`);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(br.mean[c] - bp.mean[c]) < 0.6, `what is not skin keeps its colour (channel ${c})`);
    assert.ok(Math.abs(br.texture / bp.texture - 1) < 0.04, `and its texture (${bp.texture.toFixed(2)} -> ${br.texture.toFixed(2)})`);
  });

  it("HDR footage: the final stays PQ, 10-bit HEVC; the retouched clip is worked in SDR (as the editor shows it) and its face is smoother", async () => {
    const pq = join(dir, "faces-pq.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", main, "-vf", "scale=in_color_matrix=bt709:in_range=tv,format=gbrpf32le,zscale=tin=bt709:t=linear:npl=203,zscale=pin=bt709:p=bt2020:t=smpte2084:npl=203:m=bt2020nc:r=tv,format=yuv420p10le",
      "-c:v", "libx265", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-c:a", "aac", pq]);
    const src: SourceInfo = { ...source, hdr: true, transfer: "pq" };
    const planFor = (ops: Op[]) => planRender({ kind: "final", snapshot: edit(ops), transcript: [], source: src, videoId: "v" });
    const plan = planFor([RETOUCH]), plainPlan = planFor([]);
    assert.equal(plan.hdr?.transfer, "pq");
    assert.match(plan.operations.join("\n"), /graded, keyed or retouched in SDR/);
    const renderFrom = async (p: RenderPlan, name: string) => {
      const looks: Record<string, string> = {};
      for (const [n, spec] of Object.entries(p.lookFiles ?? {})) { const f = join(dir, `${name}-${n}`); await writeFile(f, lookFileData(spec, p)); looks[n] = f; }
      const out = join(dir, `${name}.mp4`), { args, filterGraph } = ffmpegArgs(p, { source: pq, output: out, looks } as PlanFiles, src);
      await writeFile(join(dir, `${name}.txt`), filterGraph);
      await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
      return out;
    };
    const done = await renderFrom(plan, "skin-hdr"), plain = await renderFrom(plainPlan, "plain-hdr");
    const info = JSON.parse((await bin("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,color_transfer", "-of", "json", done])).toString()).streams[0];
    assert.deepEqual(info, { codec_name: "hevc", pix_fmt: "yuv420p10le", color_transfer: "smpte2084" });
    const [w, h] = [960, 540];
    const r = box(await frame(done, w, h), w, h, FACE_L), p0 = box(await frame(plain, w, h), w, h, FACE_L);
    console.log(`HDR face texture ${p0.texture.toFixed(2)} -> ${r.texture.toFixed(2)}; mean ${p0.mean.map((v) => v.toFixed(1))} -> ${r.mean.map((v) => v.toFixed(1))}`);
    assert.ok(r.texture < p0.texture * 0.8, `the face is smoother (${p0.texture.toFixed(2)} -> ${r.texture.toFixed(2)})`);
  });

  it("an area keeps it to one face; a 1080p final retouches the same way", async () => {
    const snap = edit([{ ...RETOUCH, area: { shape: "rect", x: 0.5, y: 0, w: 0.5, h: 1 } } as Op, { op: "set_export", resolution: "1080p" } as Op]);
    const plainSnap = edit([{ op: "set_export", resolution: "1080p" } as Op]);
    const plan = plan_(snap, "final"), plainPlan = plan_(plainSnap, "final");
    assert.equal(plan.width, 1920);
    const done = await render(plan, "skin-final"), plain = await render(plainPlan, "plain-final");
    const [w, h] = [960, 540];
    const a = await frame(plain, w, h), b = await frame(done, w, h);
    // Any look takes a clip through RGB (its colour resampled at edges), so the face outside is compared by its texture
    // and colour, which that leaves alone.
    const left = box(b, w, h, FACE_L), leftPlain = box(a, w, h, FACE_L), right = box(b, w, h, FACE_R), rightPlain = box(a, w, h, FACE_R);
    console.log(`left texture ${leftPlain.texture.toFixed(2)} -> ${left.texture.toFixed(2)}; right texture ${rightPlain.texture.toFixed(2)} -> ${right.texture.toFixed(2)}`);
    assert.ok(left.texture > leftPlain.texture * 0.95, `the face outside the area keeps its texture (${leftPlain.texture.toFixed(2)} -> ${left.texture.toFixed(2)})`);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(left.mean[c] - leftPlain.mean[c]) < 1, `and its colour (channel ${c}: ${leftPlain.mean[c].toFixed(1)} -> ${left.mean[c].toFixed(1)})`);
    assert.ok(right.texture < rightPlain.texture * 0.75, `the face inside it is smoother (${rightPlain.texture.toFixed(2)} -> ${right.texture.toFixed(2)})`);
  });
});
