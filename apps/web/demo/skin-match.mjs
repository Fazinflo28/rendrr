// Skin retouch, the editor's player against the render: the astronaut fixture twice side by side with grain, a plain
// clip and a retouched one (the natural defaults, whole picture). FFmpeg renders the edit; the editor's SeqMedia and
// LiveOverlays (the WebGL look canvas, its skin pass) show the same moments; the face's fine texture drops in both by a
// similar amount, the colour matches the file, and the shader compiles. Needs ffmpeg and Playwright's Chromium.
//   node demo/skin-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "skin-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

// 1. Footage: two copies of the portrait (480 x 480, 30 px down) on 960 x 540 with luma grain, BT.709 TV range.
const SEC = 2;
ff("-loop", "1", "-i", resolve(web, "../worker/test/fixtures/astronaut.jpg"), "-filter_complex", `[0:v]scale=480:480:flags=lanczos,split[a][b];[a][b]hstack,pad=960:540:0:30:color=0x303030,noise=c0s=14:c0f=t,fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, "-t", String(SEC), ...vp9, join(tmp, "main.webm"));
const CUBE = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1";

// 2. The edit and its plan, made by the shared code: a plain clip, then the same footage retouched.
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs, lookFileData } from "@rendrr/shared/renderPlan";
export { ffmpegArgs, lookFileData };
export const source = { width: 960, height: 540, fps: 30, seconds: ${SEC}, hasAudio: false };
export const luts = {};
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null },
    { op: "set_clips", track: "v1", clips: [{ id: "plain", start: 0, end: 1, label: "" }, { id: "skin", start: 0, end: 1, label: "" }] },
    { op: "retouch_skin", clipId: "skin", area: "frame" },
  ] }, ctx).snap;
  return { plan: planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" }) };
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, lookFileData, source, luts } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const { plan } = makePlan();
const W = plan.width, H = plan.height;
console.log(plan.operations.filter((l) => /^Skin/.test(l)).join("\n"));

// 3. The render.
const looks = {};
for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { looks[n] = join(tmp, n); writeFileSync(looks[n], lookFileData(spec, plan, luts)); }
const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), output: out, looks }, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

// 4. The editor's player in a page, at output size.
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, parseCube, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan), luts = {};
const pb = { attachGate() {} };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const f = liveFrame(plan, t, clock);
  const broll = {};
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h("div", { style: { position: "absolute", inset: 0, overflow: "hidden", background: "#000" } },
      h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb, broll, luts })),
    h(LiveOverlays, { frame: f, clips: [], media: { broll, graphicClips: {} }, aspect: plan.aspect, playing: false, plan, luts }));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const files = { "/main.webm": "main.webm", "/page.bundle.js": "page.bundle.js" };
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

const fileFull = (k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-vf", `select=eq(n\\,${k}),scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 64 << 20 });
const full = (png) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1"], { input: png, maxBuffer: 64 << 20 });
// A box (pixels) of a W x H frame: its mean colour and fine texture (luma minus its 5 x 5 mean).
const box = (px, [x0, y0, x1, y1]) => {
  const L = (x, y) => { const i = (y * W + x) * 3; return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; };
  const m = [0, 0, 0]; let n = 0, tex = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; for (let c = 0; c < 3; c++) m[c] += px[i + c]; n++; let s = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += L(x + dx, y + dy); tex += (L(x, y) - s / 25) ** 2; }
  return { mean: m.map((v) => v / n), tex: Math.sqrt(tex / n) };
};
const FACE = [175, 112, 240, 168], DARK = [700, 515, 940, 535];
let fails = 0; const rows = [], got = {};
for (const [name, k] of [["plain", 15], ["skin", 45]]) {
  await page.evaluate((x) => window.__seek(x), (k + 0.5) / 30);
  for (let ok = 0, n = 0; ok < 3 && n < 80; n++) { await page.waitForTimeout(100); ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0; }
  await page.waitForTimeout(300);
  const shot = await page.locator("#stage").screenshot();
  if (process.env.DUMP) writeFileSync(`${process.env.DUMP}/${name}-ed.png`, shot);
  got[name] = { file: box(fileFull(k), FACE), ed: box(full(shot), FACE), fileDark: box(fileFull(k), DARK), edDark: box(full(shot), DARK) };
}
const p = got.plain, s = got.skin;
rows.push(`face texture: plain ${p.file.tex.toFixed(2)} (file) ${p.ed.tex.toFixed(2)} (editor); retouched ${s.file.tex.toFixed(2)} (file) ${s.ed.tex.toFixed(2)} (editor)`);
rows.push(`face colour: file ${s.file.mean.map((v) => v.toFixed(1))} editor ${s.ed.mean.map((v) => v.toFixed(1))}`);
if (s.file.tex > p.file.tex * 0.75) { fails++; rows.push("FAIL the render does not smooth the face"); }
if (s.ed.tex > p.ed.tex * 0.75) { fails++; rows.push("FAIL the editor does not smooth the face"); }
const drop = (x) => 1 - x.skin / x.plain, df = drop({ skin: s.file.tex, plain: p.file.tex }), de = drop({ skin: s.ed.tex, plain: p.ed.tex });
rows.push(`texture drop: ${(df * 100).toFixed(0)}% in the file, ${(de * 100).toFixed(0)}% in the editor`);
if (Math.abs(df - de) > 0.2) { fails++; rows.push("FAIL the editor smooths by a different amount"); }
if (s.ed.mean.some((v, c) => Math.abs(v - s.file.mean[c]) > 4)) { fails++; rows.push("FAIL the editor's face colour differs from the file"); }
const looksDrawn = await page.evaluate(() => [...document.querySelectorAll("canvas[data-look]")].map((c) => `${c.dataset.look}:${c.dataset.drawn || 0}`));
console.log(rows.join("\n"));
console.log("look canvases (look:draws): " + looksDrawn.join(", "));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
const pageErrs = errs.filter((e) => !/GPU stall|Automatic fallback|swiftshader/i.test(e));
if (pageErrs.length) { console.log("page errors:", pageErrs); fails++; }
if (!looksDrawn.some((x) => x.startsWith("1:") && !x.endsWith(":0"))) { console.log("no look canvas drew"); fails++; }
console.log(fails ? `FAIL: ${fails}` : "PASS: the editor retouches the skin as the render does");
process.exit(fails ? 1 : 0);
