// Phase 7: graphics longer than 15 s. A 40 s custom graphic (a slow bar, a 0.6 s red flash at 20 s, text changed by
// JS at 30 s) is recorded with sampling and read back from its WebM: the flash, the text change and the bar are where
// the clock puts them, the file is as long as the graphic, and far fewer pictures were taken than frames. Then the
// progress-bar template over a 60 s edit is rendered and is still on screen at 50 s (it used to stop at 15 s).
// Needs ffmpeg and Chromium (CHROMIUM_PATH, /usr/bin/chromium or Playwright's).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, playerGraphicHtml, templateHtml, templateSize, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { PNG } from "pngjs";
import puppeteer from "puppeteer-core";
import { ffmpegArgs, planRender, type SourceInfo } from "@rendrr/shared/renderPlan";
import { probe, run } from "../src/lib/ffmpeg";
import { recordHtml } from "../src/lib/graphics";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 256 << 20 })).stdout as Buffer;
const W = 640, H = 360;

/**
 * The RGBA picture on screen at t (alpha kept: decoded with libvpx). The file has a variable frame rate, so it is put on
 * the 30 fps grid first, as the render's overlay sees it (seeking would give the next picture, not the one showing).
 */
const frameAt = async (file: string, t: number, w = W, h = H) => bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `fps=30,select=eq(n\\,${Math.round(t * 30)}),scale=${w}:${h}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
const count = (px: Buffer, f: (r: number, g: number, b: number, a: number) => boolean) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (f(px[i], px[i + 1], px[i + 2], px[i + 3])) n++; return n; };

describe("graphics longer than 15 s", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "long-graphic-")); });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  it("records a 40 s graphic by sampling, and the file shows each change when the clock says", async () => {
    const html = `<!doctype html><html><head><style>html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
.bar{position:absolute;left:20px;top:300px;height:16px;width:0;background:#fff;animation:grow 40s linear forwards}
@keyframes grow{to{width:600px}}
.flash{position:absolute;left:250px;top:100px;width:100px;height:100px;background:#f00;opacity:0;animation:fl .6s linear 20s}
@keyframes fl{0%,100%{opacity:1}}
#t{position:absolute;left:20px;top:20px;font:bold 40px sans-serif;color:#0f0}</style></head>
<body><div class="bar"></div><div class="flash"></div><div id="t">ONE</div>
<script>window.renderFrame=function(t){document.getElementById("t").textContent=t<30?"ONE":"TWO";};</script></body></html>`;
    const t0 = Date.now();
    let lastP = 0;
    const r = await recordHtml(html, { width: W, height: H, durationSec: 40, transparent: true, dir, onProgress: (p) => { assert.ok(p >= lastP - 1e-9, "progress only goes up"); lastP = p; } });
    const secs = (Date.now() - t0) / 1000;
    const pictures = (r as { pictures?: number }).pictures!, dense = (r as { dense?: number }).dense!;
    console.log(`recorded 40 s (1200 frames) in ${secs.toFixed(1)}s: ${pictures} pictures, ${dense} frames recorded one by one`);
    assert.equal(lastP, 1);
    assert.equal(r.seconds, 40);
    assert.ok(pictures < 400, `${pictures} pictures for 1200 frames`);
    const len = (await probe(r.path)).seconds;
    assert.ok(Math.abs(len - 40) < 0.1, `file is ${len}s`);
    // The flash: on at 20.1-20.5 s, off at 19.8 and 20.8 (recorded frame by frame, so its edges are exact).
    const red = async (t: number) => count(await frameAt(r.path, t), (R, G, B, A) => R > 200 && G < 60 && B < 60 && A > 200);
    for (const t of [20.05, 20.3, 20.55]) assert.ok((await red(t)) > 5000, `flash missing at ${t}s`);
    for (const t of [19.9, 20.65, 25]) assert.equal(await red(t), 0, `flash showing at ${t}s`);
    // The text set by JS: ONE before 30 s, TWO after (the pictures differ there, and only there).
    const textBox = async (t: number) => { const px = await frameAt(r.path, t); let s = ""; for (let y = 20; y < 70; y += 5) for (let x = 20; x < 140; x += 5) s += px[(y * W + x) * 4 + 1] > 128 ? "1" : "0"; return s; };
    const [a, b, c, d] = await Promise.all([textBox(10), textBox(29.9), textBox(30.1), textBox(39)]);
    assert.equal(a, b); assert.equal(c, d); assert.notEqual(b, c);
    // The bar: 15 px per second; a sampled picture is at most half a second old.
    const bar = async (t: number) => { const px = await frameAt(r.path, t); let n = 0; for (let x = 0; x < W; x++) if (px[(308 * W + x) * 4 + 3] > 128) n++; return n; };
    for (const t of [5, 17.3, 33.7]) {
      const got = await bar(t), want = 600 * (t / 40);
      assert.ok(got <= want + 2 && got >= want - 7.5 - 2, `bar at ${t}s: ${got}px, expected about ${want.toFixed(0)}px`);
    }
  });

  it("a template over a 60 s edit is drawn for all of it and stays on screen to the end", async () => {
    const SEC = 60;
    const footage = join(dir, "black.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x202020:s=640x360:r=30:d=${SEC}`, "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-t", String(SEC), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", footage]);
    const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SEC, hasAudio: true };
    const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined, getVideo: () => undefined, getGraphic: (id: string) => (id === "gt_progress_bar" ? { id, name: "Progress bar" } : undefined) } as unknown as EditContext;
    let s: Snapshot = { timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "g", aspect: "16:9", styleId: "s2" };
    s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "add_graphic", graphicId: "gt_progress_bar", start: 0, end: SEC, params: { color: "#ff00ff" } }] as Op[] as never }, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const gr = plan.graphics[0];
    assert.ok(gr && gr.end - gr.start > 59.9, "the graphic spans the edit");
    // As the worker draws it: the template at up to 720p for the clip's length.
    const { width: tw, height: th } = templateSize(plan.width, plan.height);
    const t0 = Date.now();
    const g = await recordHtml(templateHtml("gt_progress_bar", { color: "#ff00ff" }, tw, th, gr.end - gr.start, null), { width: tw, height: th, durationSec: gr.end - gr.start, transparent: true, dir });
    console.log(`progress bar template, ${(gr.end - gr.start).toFixed(1)}s at ${tw}x${th}: recorded in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${(g as { pictures?: number }).pictures} pictures`);
    const files = { source: footage, output: join(dir, "out.mp4"), graphics: { [gr.clipId]: g.path }, graphicSeconds: { [gr.clipId]: g.seconds } };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, "g.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));
    // Magenta bar pixels at 10 s, 30 s and 55 s: present, and growing.
    const magenta = async (t: number) => count(await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", files.output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]), (R, G, B) => R > 180 && G < 90 && B > 180);
    const m = [await magenta(10), await magenta(30), await magenta(55)];
    console.log(`bar pixels at 10/30/55 s: ${m.join(", ")}`);
    assert.ok(m[0] > 0 && m[1] > m[0] * 2 && m[2] > m[1] * 1.5, `bar ${m.join(", ")}`);
  });

  it("the editor's player draws a long template as the recording shows it", async () => {
    // The player's iframe HTML (playerGraphicHtml: the recorder's own HTML and clock) against the recorded file.
    const w = 960, h = 540, dur = 60, params = { color: "#00ffff", label: "Chapter 2" };
    const g = await recordHtml(templateHtml("gt_progress_bar", params, w, h, dur, null), { width: w, height: h, durationSec: dur, transparent: true, dir });
    const exe = ["/usr/bin/chromium", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((x) => require("node:fs").existsSync(x))!;
    const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    try {
      const page = await b.newPage();
      await page.setViewport({ width: w, height: h });
      await page.setContent(playerGraphicHtml("gt_progress_bar", params, w, h, dur), { waitUntil: "load" });
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      for (const t of [17.3, 33.7, 50]) {
        await page.evaluate((x) => window.postMessage({ rendrrT: x }, "*"), t);
        await new Promise((r) => setTimeout(r, 100));
        const shot = PNG.sync.read(Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64")).data;
        const file = await frameAt(g.path, t, w, h);
        // The bar's length in both (cyan pixels on its row), and the mean difference where either shows anything.
        const row = Math.round(h - h * 0.06 - 4);
        const len = (px: Buffer) => { let n = 0; for (let x = 0; x < w; x++) { const i = (row * w + x) * 4; if (px[i + 3] > 128 && px[i + 1] > 180 && px[i] < 90) n++; } return n; };
        let sum = 0, n = 0;
        for (let i = 0; i < shot.length; i += 4) if (shot[i + 3] > 20 || file[i + 3] > 20) { sum += (Math.abs(shot[i] - file[i]) + Math.abs(shot[i + 1] - file[i + 1]) + Math.abs(shot[i + 2] - file[i + 2]) + Math.abs(shot[i + 3] - file[i + 3])) / 4; n++; }
        const [lp, lf] = [len(Buffer.from(shot)), len(file)];
        console.log(`t=${t}: bar ${lp}px in the player, ${lf}px in the file; mean difference ${(sum / Math.max(1, n)).toFixed(1)}/255 over ${n} pixels`);
        // The file's picture is at most half a second old: the bar grows ${845 / 60} px a second.
        assert.ok(lp - lf >= -1 && lp - lf <= (845 / 60) * 0.5 + 2, `bar ${lp} vs ${lf}`);
        assert.ok(sum / Math.max(1, n) < 12, `mean difference ${(sum / n).toFixed(1)}`);
      }
    } finally { await b.close(); }
  });
});
