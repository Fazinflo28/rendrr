// Checks that the editor's player shows a custom graphic where the render does when it is placed more than once:
// each placement starts at its own point of the recording (add_graphic from) and plays its own file (a placement
// with its own params has its own recording). The graphic is stored like the recorder stores one: still stretches
// are a single picture. FFmpeg renders the edit; the editor's LiveOverlays shows the same moments in a browser; the
// bar's width is compared. Needs ffmpeg and Playwright's Chromium.   node demo/graphic-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "graphic-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });

// 1. Footage, and a 20 s transparent graphic at 320x180: a bar 10 + 7 px per half second wide on rows 40-140, one
// picture per step (VFR, as the recorder keeps still stretches). The second file is the same in green (its own params).
const SEC = 10;
ff("-f", "lavfi", "-i", `color=0x303030:s=640x360:r=30:d=${SEC}`, "-c:v", "libvpx-vp9", "-g", "15", "-pix_fmt", "yuv420p", join(tmp, "main.webm"));
const bar = (name, r, g) => ff("-f", "lavfi", "-i", "color=black@0:s=320x180:r=30:d=20,format=rgba", "-vf", `geq=r=${r}:g=${g}:b=0:a='255*between(Y,40,139)*lt(X,10+7*floor(2*T))',mpdecimate=hi=1:lo=1:frac=0:max=0`, "-fps_mode", "vfr", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "20", join(tmp, name));
bar("red.webm", 255, 0); bar("green.webm", 0, 255);
const pictures = execFileSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", join(tmp, "red.webm")]).toString().trim();

// 2. The edit: the graphic at 1-4 s from its start, and at 5-8 s from 10 s of it with its own params (the green file).
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs } from "@rendrr/shared/renderPlan";
export { ffmpegArgs };
export const source = { width: 640, height: 360, fps: 30, seconds: ${SEC}, hasAudio: false };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined, getVideo: () => undefined,
  getGraphic: (id) => (id === "gc" ? { id, name: "Bar", durationSec: 20, custom: true, params: { color: "red" } } : undefined) };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null },
    { op: "add_graphic", graphicId: "gc", start: 1, end: 4 },
    { op: "add_graphic", graphicId: "gc", start: 5, end: 8, from: 10, params: { color: "green" } },
  ] }, ctx).snap;
  return planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const plan = makePlan();
const W = plan.width, H = plan.height;
const [g1, g2] = plan.graphics.map((g) => g.clipId);

// 3. The render, each placement with its file.
const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), output: out, graphics: { [g1]: join(tmp, "red.webm"), [g2]: join(tmp, "green.webm") }, graphicSeconds: { [g1]: 20, [g2]: 20 } }, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

// 4. The editor's player: SeqMedia, LiveOverlays with the media the API sends (by clip).
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan);
const pb = { attachGate() {} };
const media = { broll: {}, graphicClips: { ${JSON.stringify(g1)}: { url: "/red.webm" }, ${JSON.stringify(g2)}: { url: "/green.webm" } } };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const f = liveFrame(plan, t, clock);
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h("div", { style: { position: "absolute", inset: 0, overflow: "hidden", background: "#000" } },
      h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb })),
    h(LiveOverlays, { frame: f, clips: [], media, aspect: plan.aspect, playing: false, plan }));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const file = { "/main.webm": "main.webm", "/red.webm": "red.webm", "/green.webm": "green.webm", "/page.bundle.js": "page.bundle.js" }[u];
  if (file) {
    const buf = readFileSync(join(tmp, file)), type = file.endsWith(".js") ? "text/javascript" : "video/webm";
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (range) { const a = +range[1], b = range[2] ? +range[2] : buf.length - 1; res.writeHead(206, { "content-type": type, "content-range": `bytes ${a}-${b}/${buf.length}`, "accept-ranges": "bytes", "content-length": b - a + 1 }); res.end(buf.subarray(a, b + 1)); return; }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": buf.length }); res.end(buf); return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><style>${css}\nbody{margin:0;background:#000}</style><div id="root"></div><script>window.__PLAN=${JSON.stringify(plan)}</script><script src="/page.bundle.js"></script>`);
}).listen(0);

const require = (await import("node:module")).createRequire(join(web, "package.json"));
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("#stage video");

// The bar's width (px at output size) on the middle row, in red or green.
const row = Math.round(H / 2);
const rgbRow = (png) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `crop=${W}:2:0:${row}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: png, maxBuffer: 64 << 20 });
const fileRow = (k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-vf", `select=eq(n\\,${k}),crop=${W}:2:0:${row}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 << 20 });
const width = (px, green) => { let n = 0; for (let x = 0; x < W; x++) { const [r, g] = [px[x * 3], px[x * 3 + 1]]; if (green ? g > 160 && r < 100 : r > 160 && g < 100) n++; } return n; };

const k = W / 320;
const moments = [[1.3, 0, false], [2.2, 0, false], [3.7, 0, false], [5.2, 10, true], [6.6, 10, true], [7.9, 10, true]];
let fails = 0;
const rows = [];
for (const [t0, from, green] of moments) {
  const f = Math.floor(t0 * 30), t = (f + 0.5) / 30;
  await page.evaluate((x) => window.__seek(x), t);
  for (let ok = 0, n = 0; ok < 2 && n < 60; n++) {
    await page.waitForTimeout(100);
    ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0;
  }
  const ed = width(rgbRow(await page.locator("#stage").screenshot()), green), fi = width(fileRow(f), green);
  const placeStart = from ? 5 : 1, gt = from + (t - placeStart), want = Math.round(k * (10 + 7 * Math.floor(2 * gt)));
  rows.push(`${t.toFixed(2)}s (${from ? "second placement, from 10 s, own file" : "first placement"}): bar ${fi}px in the file, ${ed}px in the editor, ${want}px expected`);
  if (Math.abs(ed - fi) > 2 * k || Math.abs(fi - want) > 2 * k || ed === 0) fails++;
}
console.log(`graphic: ${pictures} pictures for 600 frames`);
console.log(rows.join("\n"));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
if (errs.length) { console.log("page errors:", errs); fails++; }
console.log(fails ? `FAIL: ${fails} moments differ` : `PASS: ${moments.length} moments; the editor shows each placement's part of its own file, as the render does`);
process.exit(fails ? 1 : 0);
