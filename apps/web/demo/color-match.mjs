// Checks that the editor's player shows the colour the render draws (Phase 6): a grade with curves, an imported LUT,
// a mask, pixelate with a blurred area, a green screen keyed over b-roll laid under V1. One edit is made with the shared
// ops; FFmpeg renders it; the editor's own SeqMedia and LiveOverlays (the WebGL look canvas) show the same moments in a
// browser; the pictures are compared. A plain clip gives the baseline (two decoders, two scalers, the encoder).
// Needs ffmpeg and Playwright's Chromium.   node demo/color-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "color-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

// 1. Footage (VP9 for the browser, the same files for the render): colour ramps, a green screen with an orange square,
// a checkerboard. Made in BT.709 TV range, as phones record.
const SEC = 4;
const to709 = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
ff("-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SEC},format=gbrp,geq=r='30+X*0.3':g='40+Y*0.5':b='200-X*0.2',${to709}`, ...vp9, join(tmp, "main.webm"));
ff("-f", "lavfi", "-i", "color=0x00B140:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "color=0xE6782A:s=200x200:r=30:d=2", "-filter_complex", `[0][1]overlay=220:80,${to709}`, ...vp9, join(tmp, "gs.webm"));
ff("-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=2,format=gray,geq=lum='if(mod(floor(X/8)+floor(Y/8),2),235,16)',${to709}`, ...vp9, join(tmp, "pat.webm"));
const CUBE = ["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${(1 - r).toFixed(3)} ${(0.2 + 0.6 * g).toFixed(3)} ${(0.5 * b + 0.25).toFixed(3)}`)))].join("\n");
writeFileSync(join(tmp, "lut.cube"), CUBE);

// 2. The edit and its plan, made by the shared code.
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline, parseCube } from "@rendrr/shared";
import { planRender, ffmpegArgs, lookFileData } from "@rendrr/shared/renderPlan";
export { ffmpegArgs, lookFileData };
export const source = { width: 640, height: 360, fps: 30, seconds: ${SEC}, hasAudio: false };
export const luts = { mylut: parseCube(${JSON.stringify(CUBE)}) };
const vids = { gs: { id: "gs", name: "green screen", seconds: 2, ready: true }, pt: { id: "pt", name: "checkerboard", seconds: 2, ready: true }, br: { id: "br", name: "ramps", seconds: ${SEC}, ready: true } };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined, getVideo: (id) => vids[id], getLut: (id) => (id === "mylut" ? { id, name: "My LUT" } : undefined) };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null },
    { op: "set_clips", track: "v1", clips: [{ id: "plain", start: 0, end: 1, label: "" }, { id: "graded", start: 1, end: 2, label: "" }, { id: "lut", start: 2, end: 3, label: "" }, { id: "masked", start: 0.5, end: 1.5, label: "" }] },
    { op: "add_clip", videoId: "pt", from: 0, to: 1, index: 4 }, { op: "add_clip", videoId: "gs", from: 0.5, to: 1.5, index: 5 },
    { op: "set_grade", clipId: "graded", exposure: 0.6, contrast: 25, temperature: 35, tint: -10, saturation: 140, curves: { master: [[0.25, 0.18], [0.75, 0.85]], b: [[0.5, 0.42]] } },
    { op: "set_grade", clipId: "lut", lut: { id: "mylut", amount: 0.8 }, exposure: -0.3 },
    { op: "set_masks", clipId: "masked", masks: [{ shape: "ellipse", x: 0.2, y: 0.15, w: 0.6, h: 0.7, feather: 0.06 }, { shape: "rect", x: 0.45, y: 0.4, w: 0.1, h: 0.2, mode: "subtract" }] },
  ] }, ctx).snap;
  const v1 = s.timeline.tracks.v1, pt = v1.find((c) => c.sourceVideoId === "pt").id, gs = v1.find((c) => c.sourceVideoId === "gs").id;
  s = applyOp(s, { op: "batch", ops: [
    { op: "set_effects", clipId: pt, effects: [{ type: "pixelate", amount: 20 }, { type: "blur", amount: 30, area: { shape: "rect", x: 0, y: 0, w: 0.5, h: 1, feather: 0.05 } }] },
    { op: "set_key", clipId: gs, color: "#00B140", similarity: 0.25, blend: 0.1, spill: 0.6 },
    { op: "add_broll", videoId: "br", start: 5, end: 6, sourceStart: 1, edit: true },
  ] }, ctx).snap;
  s = applyOp(s, { op: "set_under", clipId: s.timeline.tracks.v2[0].id, under: true }, ctx).snap;
  const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", sources: { gs: { ...source, seconds: 2 }, pt: { ...source, seconds: 2 } }, brollSeconds: { br: ${SEC} }, luts });
  return { plan, ids: { pt, gs } };
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, lookFileData, source, luts } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const { plan } = makePlan();
const W = plan.width, H = plan.height;
console.log(plan.operations.filter((l) => /^(Color|Key|Masks|Blur|Under)/.test(l)).join("\n"));

// 3. The render, with its look files.
const looks = {};
for (const [n, spec] of Object.entries(plan.lookFiles)) { looks[n] = join(tmp, n); writeFileSync(looks[n], lookFileData(spec, plan, luts)); }
const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), videos: { gs: join(tmp, "gs.webm"), pt: join(tmp, "pat.webm") }, output: out, looks, under: { [plan.under[0].clipId]: join(tmp, "main.webm") } }, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

// 4. The editor's player in a page, at output size.
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, parseCube, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan), luts = { mylut: parseCube(window.__CUBE) };
const pb = { attachGate() {} };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const f = liveFrame(plan, t, clock);
  const broll = { br: { url: "/main.webm" } };
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h("div", { style: { position: "absolute", inset: 0, overflow: "hidden", background: "#000" } },
      h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm", gs: "/gs.webm", pt: "/pat.webm" }, sounds: {}, aspect: plan.aspect, pb, broll, luts })),
    h(LiveOverlays, { frame: f, clips: [], media: { broll, graphics: {} }, aspect: plan.aspect, playing: false, plan, luts }));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const files = { "/main.webm": "main.webm", "/gs.webm": "gs.webm", "/pat.webm": "pat.webm", "/page.bundle.js": "page.bundle.js" };
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const file = files[u];
  if (file) {
    const buf = readFileSync(join(tmp, file)), type = file.endsWith(".js") ? "text/javascript" : "video/webm";
    const h = { "content-type": type, "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (range) { const a = +range[1], b = range[2] ? +range[2] : buf.length - 1; res.writeHead(206, { ...h, "content-range": `bytes ${a}-${b}/${buf.length}`, "content-length": b - a + 1 }); res.end(buf.subarray(a, b + 1)); return; }
    res.writeHead(200, { ...h, "content-length": buf.length }); res.end(buf); return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><style>${css}\nbody{margin:0;background:#000}</style><div id="root"></div><script>window.__PLAN=${JSON.stringify(plan)};window.__CUBE=${JSON.stringify(CUBE)}</script><script src="/page.bundle.js"></script>`);
}).listen(0);

const require = (await import("node:module")).createRequire(join(web, "package.json"));
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") errs.push(m.text()); });
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("#stage video");

const SW = 192, SH = 108;
const small = (png) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `scale=${SW}:${SH}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"], { input: png, maxBuffer: 64 << 20 });
const fileFrame = (k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-vf", `select=eq(n\\,${k}),scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp,scale=${SW}:${SH}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 64 << 20 });
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// One moment in the middle of each clip.
const kinds = { plain: "plain (baseline)", graded: "grade + curves", lut: "imported LUT", masked: "masks (ellipse minus rectangle, feathered)" };
const moments = plan.parts.map((p) => ({ k: Math.floor(((p.start + p.end) / 2) * 30), kind: kinds[p.clipIds[0]] || (p.videoId === "pt" ? "pixelate + blurred area" : "key + despill over b-roll under V1") }));
let fails = 0; const rows = [];
const limit = (kind) => (kind.startsWith("pixelate") ? 7 : 4);
let base = 0;
for (const m of moments) {
  const t = (m.k + 0.5) / 30;
  await page.evaluate((x) => window.__seek(x), t);
  for (let ok = 0, n = 0; ok < 3 && n < 80; n++) {
    await page.waitForTimeout(100);
    ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0;
  }
  const shot = await page.locator("#stage").screenshot();
  const d = diff(fileFrame(m.k), small(shot));
  if (m.kind.startsWith("plain")) base = d;
  rows.push(`${t.toFixed(2)}s ${m.kind}: mean difference ${d.toFixed(2)} / 255`);
  if (process.env.DUMP) {
    const name = `${process.env.DUMP}/${t.toFixed(2)}`;
    writeFileSync(name + "-ed.png", shot);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-i", name + "-ed.png", "-filter_complex", `[0:v]select=eq(n\\,${m.k}),scale=480:270[a];[1:v]scale=480:270[b];[a][b]hstack`, "-frames:v", "1", name + ".png"]);
  }
  if (d > limit(m.kind)) fails++;
}
const looksDrawn = await page.evaluate(() => [...document.querySelectorAll("canvas[data-look]")].map((c) => `${c.dataset.look}:${c.dataset.drawn || 0}`));
console.log(rows.join("\n"));
console.log("look canvases (look:draws): " + looksDrawn.join(", "));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
const pageErrs = errs.filter((e) => !/GPU stall|Automatic fallback|swiftshader/i.test(e));
if (pageErrs.length) { console.log("page errors:", pageErrs); fails++; }
if (!looksDrawn.some((x) => x.startsWith("1:") && !x.endsWith(":0"))) { console.log("no look canvas drew"); fails++; }
console.log(fails ? `FAIL: ${fails} moments differ` : `PASS: ${moments.length} moments within their limits (baseline ${base.toFixed(2)}/255)`);
process.exit(fails ? 1 : 0);
