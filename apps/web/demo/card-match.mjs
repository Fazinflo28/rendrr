// Checks that the editor's player shows the card and the background the render draws: a talking head shrunk and placed
// (set_framing), drawn as a card (set_card: rounded corners, drop shadow, border) on a gradient, then on the footage
// itself blurred, then cropped on a library video (set_background). Each edit is made with the shared ops; FFmpeg
// renders it; the editor's own SeqMedia shows the same moment in a browser; the pictures are compared.
// Needs ffmpeg and Playwright's Chromium.   node demo/card-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "card-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

// 1. Footage: smooth colour ramps (no fine detail), and a library video of other ramps for the background.
const SEC = 3;
const to709 = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
ff("-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SEC},format=gbrp,geq=r='30+X*0.3':g='40+Y*0.5':b='200-X*0.2',${to709}`, ...vp9, join(tmp, "main.webm"));
ff("-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SEC},format=gbrp,geq=r='200-Y*0.3':g='60+X*0.1':b='40+Y*0.2',${to709}`, ...vp9, join(tmp, "bg.webm"));

// 2. The edits and their plans, made by the shared code.
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs, lookFileData } from "@rendrr/shared/renderPlan";
export { ffmpegArgs, lookFileData };
export const source = { width: 640, height: 360, fps: 30, seconds: ${SEC}, hasAudio: false };
const vids = { bg: { id: "bg", name: "ramps", seconds: ${SEC}, ready: true } };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined, getVideo: (id) => vids[id] };
const base = [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_aspect", aspect: "9:16" }];
export function makePlans() {
  const one = (ops) => planRender({ kind: "preview", snapshot: applyOp({ timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [...base, ...ops] }, ctx).snap, transcript: [], source, videoId: "v", brollSeconds: { bg: ${SEC} } });
  return {
    gradient: one([{ op: "set_framing", scale: 0.62, y: 0.16 }, { op: "set_card", radius: 0.1, shadow: { opacity: 0.55, blur: 0.03, y: 0.02 }, border: { color: "#FFFFFF", width: 0.012 } }, { op: "set_background", gradient: { from: "#FF5FA2", to: "#FFE4F1", angle: 165 } }]),
    blur: one([{ op: "set_framing", scale: 0.7, y: -0.05 }, { op: "set_card", radius: 0.06, shadow: {} }, { op: "set_background", blur: 50 }]),
    video: one([{ op: "set_card", crop: { left: 0.15, right: 0.15, top: 0.05, bottom: 0.3 }, radius: 0.2 }, { op: "set_framing", scale: 0.8 }, { op: "set_background", videoId: "bg" }]),
  };
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlans, ffmpegArgs, lookFileData, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const plans = makePlans();

// 3. The renders.
for (const [name, plan] of Object.entries(plans)) {
  const looks = {};
  for (const [n, spec] of Object.entries(plan.lookFiles)) { looks[n] = join(tmp, `${name}-${n}`); writeFileSync(looks[n], lookFileData(spec, plan)); }
  const graph = join(tmp, `${name}.txt`);
  const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), output: join(tmp, `${name}.mp4`), looks, background: join(tmp, "bg.webm") }, source, { loudnessGainDb: 0 });
  writeFileSync(graph, filterGraph);
  execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));
}

// 4. The editor's player in a page, at output size.
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { sequenceClock } from "@rendrr/shared";
import { SeqMedia } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const pb = { attachGate() {} };
let set;
function App() {
  const [s, st] = useState({ name: null, t: 0 }); set = st;
  if (!s.name) return null;
  const plan = window.__PLANS[s.name], clock = sequenceClock(plan);
  return h("div", { id: "stage", key: s.name, style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h(SeqMedia, { plan, clock, time: s.t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb, broll: { bg: { url: "/bg.webm", seconds: ${SEC} } }, luts: {} }));
}
createRoot(document.getElementById("root")).render(h(App));
window.__show = (name, t) => set({ name, t });`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const files = { "/main.webm": "main.webm", "/bg.webm": "bg.webm", "/page.bundle.js": "page.bundle.js" };
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
  res.end(`<!doctype html><style>${css}\nbody{margin:0;background:#000}</style><div id="root"></div><script>window.__PLANS=${JSON.stringify(plans)}</script><script src="/page.bundle.js"></script>`);
}).listen(0);

const require = (await import("node:module")).createRequire(join(web, "package.json"));
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const { width: W, height: H } = plans.gradient;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") errs.push(m.text()); });
await page.goto(`http://localhost:${server.address().port}/`);

const SW = 108, SH = 192;
const small = (png) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `scale=${SW}:${SH}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"], { input: png, maxBuffer: 64 << 20 });
const fileFrame = (file, k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${k}),scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp,scale=${SW}:${SH}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 64 << 20 });
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

const LIMIT = { gradient: 4, blur: 6, video: 4 };
const kinds = { gradient: "card with shadow and border on a gradient", blur: "card on the footage blurred", video: "cropped rounded card on a library video" };
let fails = 0; const rows = [];
for (const name of Object.keys(plans)) {
  const k = 45, t = (k + 0.5) / 30;
  await page.evaluate(([n, x]) => window.__show(n, x), [name, t]);
  await page.waitForSelector("#stage video");
  for (let ok = 0, n = 0; ok < 3 && n < 80; n++) {
    await page.waitForTimeout(100);
    ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0;
  }
  await page.waitForTimeout(300);
  const shot = await page.locator("#stage").screenshot();
  const d = diff(fileFrame(join(tmp, `${name}.mp4`), k), small(shot));
  rows.push(`${kinds[name]}: mean difference ${d.toFixed(2)} / 255 (limit ${LIMIT[name]})`);
  if (process.env.DUMP) {
    writeFileSync(`${process.env.DUMP}/${name}-ed.png`, shot);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(tmp, `${name}.mp4`), "-i", `${process.env.DUMP}/${name}-ed.png`, "-filter_complex", `[0:v]select=eq(n\\,${k}),scale=270:480[a];[1:v]scale=270:480[b];[a][b]hstack`, "-frames:v", "1", `${process.env.DUMP}/${name}.png`]);
  }
  if (d > LIMIT[name]) fails++;
}
console.log(rows.join("\n"));
const drawn = await page.evaluate(() => [...document.querySelectorAll("[data-back], canvas[data-card]")].map((e) => e.dataset.back || e.dataset.card));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
const pageErrs = errs.filter((e) => !/GPU stall|Automatic fallback|swiftshader/i.test(e));
if (pageErrs.length) { console.log("page errors:", pageErrs); fails++; }
console.log(fails ? `FAIL: ${fails} pictures differ` : `PASS: ${Object.keys(plans).length} pictures within their limits`);
process.exit(fails ? 1 : 0);
