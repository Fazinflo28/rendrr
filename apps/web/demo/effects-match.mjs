// Phase 19, the editor's player against the render for the newer effects: glow, RGB split, camera shake, mirror and
// grain, one clip each of the same test pattern after a plain clip. FFmpeg renders the edit; the editor's SeqMedia (the
// WebGL look canvas) shows the same frames. For each effect the player's frame is close to the file's (much closer
// than the effect's own change); for grain, the noise has the same strength. Needs ffmpeg and Playwright's Chromium.
//   node demo/effects-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "effects-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

// 1. Footage: FFmpeg's test pattern (bars, a gradient, moving shapes) with a bright disc for the glow, 960 x 540.
const SEC = 2;
ff("-f", "lavfi", "-i", `testsrc2=s=960x540:r=30:d=${SEC}`, "-vf", "drawbox=x=380:y=170:w=200:h=200:color=0x202020:t=fill,geq=lum='if(lt(hypot(X-480,Y-270),60),250,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", ...vp9, join(tmp, "main.webm"));
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
    { op: "set_clips", track: "v1", clips: ["plain", "glow", "rgbsplit", "shake", "mirror", "grain"].map((id) => ({ id, start: 0, end: 1, label: "" })) },
    { op: "set_effects", clipId: "glow", effects: [{ type: "glow", amount: 60 }] },
    { op: "set_effects", clipId: "rgbsplit", effects: [{ type: "rgbsplit", amount: 60 }] },
    { op: "set_effects", clipId: "shake", effects: [{ type: "shake", amount: 70 }] },
    { op: "set_effects", clipId: "mirror", effects: [{ type: "mirror", amount: 100 }] },
    { op: "set_effects", clipId: "grain", effects: [{ type: "grain", amount: 50 }] },
  ] }, ctx).snap;
  return { plan: planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" }) };
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, lookFileData, source, luts } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const { plan } = makePlan();
const W = plan.width, H = plan.height;
console.log(plan.operations.filter((l) => /^Effects/.test(l)).join("\n"));

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
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
/** The noise's strength: the deviation of (frame - plain) over a flat-ish box, per channel averaged. */
const noise = (a, b) => { let s = 0, s2 = 0, n = 0; for (let y = 40; y < 140; y++) for (let x = 40; x < 300; x++) for (let c = 0; c < 3; c++) { const i = (y * W + x) * 3 + c, d = a[i] - b[i]; s += d; s2 += d * d; n++; } return Math.sqrt(s2 / n - (s / n) ** 2); };
const shot = async (k) => {
  await page.evaluate((x) => window.__seek(x), (k + 0.5) / 30);
  for (let ok = 0, n = 0; ok < 3 && n < 80; n++) { await page.waitForTimeout(100); ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0; }
  await page.waitForTimeout(350);
  const png = await page.locator("#stage").screenshot();
  if (process.env.DUMP) writeFileSync(`${process.env.DUMP}/fx-${k}.png`, png);
  return full(png);
};
let fails = 0; const rows = [];
const F = 15, filePlain = fileFull(F), edPlain = await shot(F);
rows.push(`plain: player against file ${mad(edPlain, filePlain).toFixed(2)} (the baseline: decoding and scaling)`);
const base = mad(edPlain, filePlain);
for (const [i, name] of ["glow", "rgbsplit", "shake", "mirror"].map((n, j) => [j + 1, n])) {
  const k = i * 30 + F, file = fileFull(k), ed = await shot(k);
  const change = mad(file, filePlain), off = mad(ed, file);
  rows.push(`${name}: the effect changes the frame by ${change.toFixed(2)}; player against file ${off.toFixed(2)}`);
  if (change < 2) { fails++; rows.push(`FAIL ${name}: the render shows no change`); }
  if (off > Math.max(base + 1.5, change * 0.3)) { fails++; rows.push(`FAIL ${name}: the player differs from the file`); }
}
{
  // The file's grain is softened by its H.264 encode; the render's own noise filter (alls 40) is measured on the same
  // frame before encoding: FFmpeg's noise on the plain frame, uncompressed.
  const k = 5 * 30 + F, file = fileFull(k), ed = await shot(k);
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", "pipe:0", "-vf", "format=gbrp,noise=alls=40:allf=t,format=rgb24", "-f", "rawvideo", "pipe:1"], { input: filePlain, maxBuffer: 64 << 20 });
  const nr = noise(raw, filePlain), nf = noise(file, filePlain), ne = noise(ed, edPlain);
  rows.push(`grain: noise ${nr.toFixed(2)} from FFmpeg's filter (before the encode), ${nf.toFixed(2)} in the encoded file, ${ne.toFixed(2)} in the player`);
  if (nf < 3) { fails++; rows.push("FAIL grain: no noise in the render"); }
  if (ne < nr * 0.8 || ne > nr * 1.25) { fails++; rows.push("FAIL grain: the player's noise is not the render's strength"); }
}
console.log(rows.join("\n"));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
const pageErrs = errs.filter((e) => !/GPU stall|Automatic fallback|swiftshader/i.test(e));
if (pageErrs.length) { console.log("page errors:", pageErrs); fails++; }
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
