// Text behind the person (Phase 2), the editor's player against the render: a red box (the "person") that jumps 30 px
// every frame over grey, its matte (a white box in the same place, one 10 s block, as the worker keeps it), and a text
// layer with a full-frame blue card behind the person. FFmpeg renders the edit; the editor shows its footage, the layers
// behind the person (the card), then the person laid back over them (PersonLayer: the footage's own <video> through the
// look canvas with the matte as alpha). Both show the box red to its edges and blue right outside them. Needs ffmpeg
// and Playwright's Chromium.
//   node demo/behind-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "behind-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15"];
const SEC = 4, SW = 960, SH = 540;
// The box: 160 x 240 at y 160, its left edge at 60 + 30 px x ((frame + 1) mod 20) (overlay's n counts from 1 here).
const boxOver = (color) => `color=c=${color}:s=160x240:r=30[box];[0][box]overlay=x='60+30*mod(n\\,20)':y=160:eval=frame:shortest=1`;
const boxX = (n) => 60 + 30 * ((n + 1) % 20);

// 1. Footage and its matte (one block: the clip is 4 s).
ff("-f", "lavfi", "-i", `color=c=0x808080:s=${SW}x${SH}:r=30:d=${SEC}`, "-filter_complex", `${boxOver("0xFF0000")},format=yuv420p[v]`, "-map", "[v]", ...vp9, "-pix_fmt", "yuv420p", join(tmp, "main.webm"));
ff("-f", "lavfi", "-i", `color=c=black:s=${SW}x${SH}:r=30:d=${SEC}`, "-filter_complex", `${boxOver("white")},format=gray[v]`, "-map", "[v]", ...vp9, "-pix_fmt", "yuv420p", join(tmp, "matte.webm"));
writeFileSync(join(tmp, "matte.txt"), `file '${join(tmp, "matte.webm")}'\n`);

// 2. The edit and its plan, made by the shared code.
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs, lookFileData } from "@rendrr/shared/renderPlan";
export { ffmpegArgs, lookFileData };
export const source = { width: ${SW}, height: ${SH}, fps: 30, seconds: ${SEC}, hasAudio: false };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "add_text", text: ".", start: 0, end: ${SEC}, edit: true, behind: true, size: 2, y: 0.98, anim: "none", card: { color: "#0000FF", opacity: 1 } }] }, ctx).snap;
  return planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, lookFileData, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const plan = makePlan();
const W = plan.width, H = plan.height, name = Object.keys(plan.mattes)[0];
console.log(plan.operations.filter((l) => /^Behind the person/.test(l)).join("\n"));

// 3. The render.
const looks = {};
for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { looks[n] = join(tmp, n); writeFileSync(looks[n], lookFileData(spec, plan, {})); }
const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
writeFileSync(join(tmp, "behind.ass"), plan.assBehind);
const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), output: out, looks, mattes: { [name]: join(tmp, "matte.txt") }, assBehindPath: join(tmp, "behind.ass") }, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

// 4. The editor's player in a page, at output size, with the matte's block served like the API's link.
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays, PersonLayer } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan);
const mattes = { ${JSON.stringify(name)}: { urls: { 0: "/matte.webm" }, block: 10, missing: 0 } };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const frame = liveFrame(plan, t, clock);
  // As the editor stacks them: the footage, then the overlays (the layers behind the person, the person, the rest).
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb: { attachGate() {} }, broll: {}, luts: {}, mattes: {} }),
    h("div", { style: { position: "absolute", inset: 0 } }, h(LiveOverlays, { frame, clips: [], media: { broll: {}, graphicClips: {} }, aspect: plan.aspect, playing: false, plan, luts: {}, person: h(PersonLayer, { plan, frame, mattes, zoom: 1, luts: {} }) })));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const files = { "/main.webm": "main.webm", "/matte.webm": "matte.webm", "/page.bundle.js": "page.bundle.js" };
const server = createServer((req, res) => {
  const file = files[decodeURIComponent(req.url.split("?")[0])];
  if (file) {
    const buf = readFileSync(join(tmp, file)), type = file.endsWith(".js") ? "text/javascript" : "video/webm";
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

// Frames as RGB at the source's size (the render and the stage are W x H: scaled to 960 x 540).
const rgb = (input, isFile, k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", isFile ? out : "pipe:0", "-vf", `${isFile ? `select=eq(n\\,${k}),` : ""}scale=${SW}:${SH}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { input, maxBuffer: 64 << 20 });
const at = (px, x, y) => { const i = (y * SW + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
const red = ([r, g, b]) => r > 160 && g < 100 && b < 100, green = ([r, g, b]) => b > 160 && r < 100 && g < 100; // "green": the card's blue here
let fails = 0;
for (const k of [15, 46, 77, 100]) {
  await page.evaluate((x) => window.__seek(x), (k + 0.5) / 30);
  for (let ok = 0, n = 0; ok < 3 && n < 80; n++) { await page.waitForTimeout(100); ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0; }
  await page.waitForTimeout(400);
  const shot = await page.locator("#stage").screenshot();
  if (process.env.DUMP) writeFileSync(`${process.env.DUMP}/matte-${k}.png`, shot);
  const x0 = boxX(k), pts = { inside: [[x0 + 16, 280], [x0 + 144, 280]], outside: [[Math.max(4, x0 - 16), 280], [Math.min(SW - 5, x0 + 176), 280], [x0 + 80, 120]] };
  for (const [what, px] of [["file", rgb(null, true, k)], ["editor", rgb(shot, false, k)]]) {
    const inside = pts.inside.map(([x, y]) => at(px, x, y)), outside = pts.outside.map(([x, y]) => at(px, x, y));
    const ok = inside.every(red) && outside.every(green);
    console.log(`${ok ? "ok  " : "FAIL"} frame ${k}, ${what}: inside ${JSON.stringify(inside)}, outside ${JSON.stringify(outside)}`);
    if (!ok) fails++;
  }
}
const drawn = await page.evaluate(() => [...document.querySelectorAll("[data-person] canvas")].map((c) => `person layer drawn ${c.dataset.drawn || 0} times, matte block ${c.dataset.matte ?? "none"}`));
console.log(drawn.join(", ") || "no person layer");
if (!drawn.length) fails++;
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
// The text layers ask for the editor's fonts at /fonts/, which this page does not serve (the card needs none).
const pageErrs = errs.filter((e) => !/GPU stall|Automatic fallback|swiftshader|decode downloaded font|OTS parsing/i.test(e));
if (pageErrs.length) { console.log("page errors:", pageErrs); fails++; }
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
