// Video inside text and text cut out of its card (Phase 2b), the editor's player against the render: grey footage; a 2 s
// library video (red, then green) plays inside a big "I" on a yellow card from 0.5 s into it (so it loops); then an "I"
// cut out of a blue card shows the grey footage through it. FFmpeg renders the edit; the editor draws the same layers
// (TextMatte: a canvas measured from the layer's own block). Both are read at the letter's middle and beside it. Needs
// ffmpeg and Playwright's Chromium.
//   node demo/inside-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const fonts = join(web, "public/fonts");
const tmp = mkdtempSync(join(tmpdir(), "inside-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15"];
const SEC = 4, SW = 960, SH = 540;

// 1. The footage and the library video.
ff("-f", "lavfi", "-i", `color=c=0x808080:s=${SW}x${SH}:r=30:d=${SEC}`, ...vp9, "-pix_fmt", "yuv420p", join(tmp, "main.webm"));
ff("-f", "lavfi", "-i", "color=c=0xFF0000:s=320x240:r=30:d=1", "-f", "lavfi", "-i", "color=c=0x00FF00:s=320x240:r=30:d=1", "-filter_complex", "[0][1]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", ...vp9, join(tmp, "wave.webm"));

// 2. The edit and its plan, made by the shared code.
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs } from "@rendrr/shared/renderPlan";
export { ffmpegArgs };
export const source = { width: ${SW}, height: ${SH}, fps: 30, seconds: ${SEC}, hasAudio: false };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined, getVideo: (id) => (id === "br" ? { id, name: "wave", seconds: 2, ready: true } : undefined) };
const letter = { text: "I", edit: true, font: "Anton", size: 25, x: 0.5, y: 0.5, stroke: null, shadow: null, anim: "none" };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null },
    { op: "add_text", ...letter, start: 0.5, end: 2.8, inside: { videoId: "br", from: 0.5 }, card: { color: "#FFFF00", opacity: 1 } },
    { op: "add_text", ...letter, start: 3, end: 4, cutout: true, card: { color: "#0000FF", opacity: 1 } }] }, ctx).snap;
  return planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { br: 2 } });
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const plan = makePlan();
const W = plan.width, H = plan.height;
console.log(plan.operations.filter((l) => /^Inside the letters/.test(l)).join("\n"));

// 3. The render.
const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
const files = { source: join(tmp, "main.webm"), output: out, fontsDir: fonts, textMasks: {}, textDecor: {}, insides: {} };
for (const m of plan.textMattes) {
  files.textMasks[m.clipId] = join(tmp, `${m.clipId}-mask.ass`); writeFileSync(files.textMasks[m.clipId], m.mask);
  if (m.decor) { files.textDecor[m.clipId] = join(tmp, `${m.clipId}-decor.ass`); writeFileSync(files.textDecor[m.clipId], m.decor); }
  if (m.inside) files.insides[m.clipId] = join(tmp, "wave.webm");
}
const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

// 4. The editor's player in a page, at output size, with the library video served like the API's link.
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan);
const media = { broll: { br: { url: "/wave.webm", seconds: 2 } }, graphicClips: {} };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const frame = liveFrame(plan, t, clock);
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb: { attachGate() {} }, broll: {}, luts: {}, mattes: {} }),
    h("div", { style: { position: "absolute", inset: 0 } }, h(LiveOverlays, { frame, clips: [], media, aspect: plan.aspect, playing: false, plan, luts: {} })));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const served = { "/main.webm": join(tmp, "main.webm"), "/wave.webm": join(tmp, "wave.webm"), "/page.bundle.js": join(tmp, "page.bundle.js") };
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  const file = served[path] ?? (path.startsWith("/fonts/") && existsSync(join(fonts, basename(path))) ? join(fonts, basename(path)) : null);
  if (file) {
    const buf = readFileSync(file), type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".ttf") ? "font/ttf" : "video/webm";
    const hd = { "content-type": type, "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (range) { const a = +range[1], b = range[2] ? +range[2] : buf.length - 1; res.writeHead(206, { ...hd, "content-range": `bytes ${a}-${b}/${buf.length}`, "content-length": b - a + 1 }); res.end(buf.subarray(a, b + 1)); return; }
    res.writeHead(200, { ...hd, "content-length": buf.length }); res.end(buf); return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><style>${css}\nbody{margin:0;background:#000}</style><div id="root"></div><script>window.__PLAN=${JSON.stringify(plan)}</script><script src="/page.bundle.js"></script>`);
}).listen(0);

const require = (await import("node:module")).createRequire(join(web, "package.json"));
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") errs.push(m.text()); });
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("#stage video");

const rgb = (input, isFile, k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", isFile ? out : "pipe:0", "-vf", `${isFile ? `select=eq(n\\,${k}),` : ""}scale=${SW}:${SH}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { input, maxBuffer: 64 << 20 });
const at = (px, x, y) => { const i = (y * SW + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
const near = (want) => (got) => got.every((v, i) => Math.abs(v - want[i]) <= 40);
const RED = [255, 0, 0], GREEN = [0, 255, 0], YELLOW = [255, 255, 0], BLUE = [0, 0, 255], GREY = [128, 128, 128];
let fails = 0;
// The layer starts at 0.5 s, 0.5 s into the video: at t the video is at t (mod 2). Times away from its colour change.
for (const [k, inLetter, around, what] of [[21, RED, YELLOW, "0.7 s, 0.7 s in"], [45, GREEN, YELLOW, "1.5 s, 1.5 s in"], [75, RED, YELLOW, "2.5 s, looped to 0.5 s"], [105, GREY, BLUE, "3.5 s, cut out"]]) {
  await page.evaluate((x) => window.__seek(x), (k + 0.5) / 30);
  for (let ok = 0, n = 0; ok < 3 && n < 80; n++) { await page.waitForTimeout(100); ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0; }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const shot = await page.locator("#stage").screenshot();
  if (process.env.DUMP) writeFileSync(`${process.env.DUMP}/inside-${k}.png`, shot);
  const cx = SW / 2, cy = SH / 2;
  for (const [src, px] of [["file", rgb(null, true, k)], ["editor", rgb(shot, false, k)]]) {
    // (The "I" runs from about 245 to 310 down: its middle is a little under the frame's.)
    const inside = [[cx, cy + 7], [cx, cy - 13], [cx, cy + 27]].map(([x, y]) => at(px, x, y)), outside = [[cx - 110, cy], [cx, cy - 115], [30, 30]].map(([x, y]) => at(px, x, y));
    const ok = inside.every(near(inLetter)) && outside.every(near(around));
    console.log(`${ok ? "ok  " : "FAIL"} frame ${k} (${what}), ${src}: in the letter ${JSON.stringify(inside)}, around ${JSON.stringify(outside)}`);
    if (!ok) fails++;
  }
}
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
const pageErrs = errs.filter((e) => !/GPU stall|Automatic fallback|swiftshader/i.test(e));
if (pageErrs.length) { console.log("page errors:", pageErrs); fails++; }
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
