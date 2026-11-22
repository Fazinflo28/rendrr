// The overexposure flash rendered by FFmpeg (set_transition flash), read frame by frame: the frames outside its window
// are as a plain cut draws them; it builds over the last frames before the cut, peaks on the cut's first frame (the
// brightest of all, near white, yet not a flat white layer: the darks show as grey), then falls fast and fades out
// softly, as the shared curve says; the player's CSS gives the same values. A white dip at the same cut is a flat white
// frame. Needs ffmpeg and Chromium.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { applyOp, buildInitialTimeline, flashLevel, flashMap, transitionAt, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const SECONDS = 10, W = 640, H = 360;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };

describe("the overexposure flash, rendered", () => {
  let dir = "", src = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "flash-"));
    src = join(dir, "src.mp4");
    // A dim scene (about 70 of 255, like a talking head; dimmed in RGB, so its colours are ones a camera makes) with a
    // black bar and a white patch, moving slowly.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-vf", "format=gbrp,lutrgb=r='val*0.42':g='val*0.42':b='val*0.42',drawbox=x=0:y=300:w=640:h=60:color=black:t=fill,drawbox=x=40:y=40:w=80:h=60:color=white:t=fill,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-shortest", src]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  // Two clips: 1-4 and 6-9 s of the footage; the cut at edit 3 s (frame 90).
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "x", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 4, label: "" }, { id: "b", start: 6, end: 9, label: "" }] }, ...ops] as never }, ctx).snap;
  /** Each frame's average and lowest luma (0-255). */
  const render = async (name: string, ops: Op[]) => {
    const plan = planRender({ kind: "final", snapshot: edit(ops), transcript: [], source, videoId: "v" });
    const pf: PlanFiles = { source: src, output: join(dir, `${name}.mp4`) };
    const { args, filterGraph } = ffmpegArgs(plan, pf, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const out = (await execFileP("ffmpeg", ["-hide_banner", "-i", pf.output, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { maxBuffer: 1 << 26 })).stdout;
    const avg = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1])), low = [...out.matchAll(/YMIN=([\d.]+)/g)].map((m) => Number(m[1]));
    return { plan, avg, low };
  };

  it("blows the picture out on the cut and comes back as the curve says; outside its window it is a plain cut", { timeout: 120_000 }, async () => {
    const cut = await render("cut", []);
    const fl = await render("flash", [{ op: "set_transition", clipId: "b", type: "flash", duration: 0.5 } as Op]);
    const t = fl.plan.transitions![0];
    const k0 = Math.round(t.start * 30), k1 = Math.round(t.end * 30), peak = 90;
    console.log(`frames ${k0 - 1}-${k1}: ${fl.avg.slice(k0 - 1, k1 + 1).map((x) => x.toFixed(0)).join(" ")} (cut: ${cut.avg[peak].toFixed(0)})`);
    assert.equal(fl.avg.length, cut.avg.length);
    for (let k = 0; k < fl.avg.length; k++) if (k < k0 || k >= k1) assert.ok(Math.abs(fl.avg[k] - cut.avg[k]) < 0.6, `frame ${k} is as the cut draws it (${fl.avg[k]} vs ${cut.avg[k]})`);
    // Its first frame (the curve at 0) is the picture as it was.
    assert.ok(Math.abs(fl.avg[k0] - cut.avg[k0]) < 1, `the window's first frame is unchanged (${fl.avg[k0]} vs ${cut.avg[k0]})`);
    // The peak: the cut's first frame, the brightest, near white; the darks (the black bar) a light grey, not white.
    assert.equal(fl.avg.indexOf(Math.max(...fl.avg)), peak, "the peak is the cut's first frame");
    assert.ok(fl.avg[peak] > 195, `near white at the peak (${fl.avg[peak]})`);
    assert.ok(fl.low[peak] > 120 && fl.low[peak] < 225, `the darks come up to grey, not white (${fl.low[peak]})`);
    // Building before it, a fast fall after it, then a soft tail back to the picture.
    for (let k = peak - 3; k < peak; k++) assert.ok(fl.avg[k] > fl.avg[k - 1] - 0.3, `building at frame ${k}`);
    assert.ok(fl.avg[peak - 1] > cut.avg[peak - 1] + 15, "the frame before the cut is already blown out a little");
    const rise = (k: number) => fl.avg[k] - cut.avg[k];
    assert.ok(rise(peak + 1) < rise(peak) * 0.5, `a fast fall (${rise(peak)} then ${rise(peak + 1)})`);
    for (let k = peak + 1; k < k1; k++) assert.ok(rise(k + 1) <= rise(k) + 0.3, `fading at frame ${k}`);
    assert.ok(rise(peak + 3) > 2, "still a little bright three frames on (the soft tail)");
  });

  it("the player's CSS (brightness under a white layer) gives the render's values", { timeout: 60_000 }, async () => {
    const { chromium } = require(require.resolve("playwright-core", { paths: [resolve(import.meta.dirname, "../../web")] }));
    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
    try {
      const page = await browser.newPage({ viewport: { width: 300, height: 60 } });
      for (const p of [0.45, 0.5, 0.6, 0.75]) {
        const f = transitionAt({ type: "flash" }, p, W, H).flash!, m = flashMap(flashLevel(p));
        const greys = [0, 25, 60, 120];
        await page.setContent(`<body style="margin:0">${greys.map((v, i) => `<div style="position:absolute;left:${i * 60}px;top:0;width:60px;height:60px;background:rgb(${v},${v},${v})"></div>`).join("")}<div style="position:absolute;inset:0;backdrop-filter:brightness(${f.bright});background:rgba(255,255,255,${f.lift})"></div></body>`);
        const shot = await page.screenshot({ type: "png" });
        const img = PNG.sync.read(shot);
        greys.forEach((v, i) => {
          const got = img.data[(30 * img.width + i * 60 + 30) * 4], want = Math.min(255, v * m.gain + 255 * m.add);
          assert.ok(Math.abs(got - want) <= 4, `p ${p}, grey ${v}: the player ${got}, the render ${want.toFixed(1)}`);
        });
      }
    } finally { await browser.close(); }
  });

  it("a white dip at the same cut is a flat white frame", { timeout: 120_000 }, async () => {
    const dip = await render("dip", [{ op: "set_transition", clipId: "b", type: "dip-white", duration: 0.5 } as Op]);
    const k = dip.avg.indexOf(Math.max(...dip.avg));
    assert.ok(dip.low[k] > 225, `flat white (${dip.low[k]})`);
  });
});
