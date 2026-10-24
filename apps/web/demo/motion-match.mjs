// Checks that the editor's player shows what the render draws (Phase 5): speed, a freeze, reverse, transitions and
// keyframes. One edit is made with the shared ops; FFmpeg renders it; the editor's own SeqMedia and LiveOverlays
// components show the same moments in a browser (VP9 test footage, which the test browser can decode); the frames are
// compared. The footage shows its frame number as two grey levels, so each frame says which source frame it is.
// Needs ffmpeg and Playwright's Chromium.   node demo/motion-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "motion-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });

// 1. Footage (VP9 for the browser, the same file for the render) and a green b-roll.
const SEC = 10;
ff("-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SEC},geq=lum='if(lt(X,320),16+mod(N,50)*4,16+floor(N/50)*30)':cb=128:cr=128`, "-c:v", "libvpx-vp9", "-lossless", "1", "-g", "15", "-pix_fmt", "yuv420p", join(tmp, "main.webm"));
ff("-f", "lavfi", "-i", "color=0x00C000:s=640x360:r=30:d=4", "-c:v", "libvpx-vp9", "-g", "15", "-pix_fmt", "yuv420p", join(tmp, "green.webm"));

// 2. The edit and its plan, made by the shared code.
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs } from "@rendrr/shared/renderPlan";
export { ffmpegArgs };
export const source = { width: 640, height: 360, fps: 30, seconds: ${SEC}, hasAudio: false };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined, getVideo: (id) => (id === "g" ? { id: "g", name: "green", seconds: 4, ready: true } : undefined) };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null },
    { op: "set_clips", track: "v1", clips: [
      { id: "c1", start: 0, end: 1, label: "" }, { id: "c2", start: 1, end: 3, label: "" }, { id: "c3", start: 4, end: 5.5, label: "" },
      { id: "c4", start: 6, end: 7, label: "" }, { id: "c5", start: 7.5, end: 8.5, label: "" }, { id: "c6", start: 2, end: 3, label: "" },
      { id: "c7", start: 8.5, end: 9.5, label: "" }, { id: "c8", start: 0.5, end: 1.5, label: "" }, { id: "c9", start: 3, end: 4, label: "" } ] },
    { op: "set_speed", clipId: "c2", speed: 1.5 },
    { op: "freeze_frame", clipId: "c2", at: 2, length: 0.5 },
    { op: "set_speed", clipId: "c3", reverse: true, speed: 2 },
    { op: "set_transition", clipId: "c4", type: "dissolve", duration: 0.4 },
    { op: "set_transition", clipId: "c5", type: "dip-white", duration: 0.4 },
    { op: "set_keyframes", clipId: "c6", keys: [{ t: 0, scale: 1, rotation: 0, x: 0, opacity: 1, ease: "in-out" }, { t: 0.8, scale: 0.6, rotation: 30, x: 0.15, opacity: 0.5 }] },
    { op: "set_transition", clipId: "c7", type: "whip", duration: 0.4 },
    { op: "set_transition", clipId: "c8", type: "slide", duration: 0.4, dir: "up" },
    { op: "set_transition", clipId: "c9", type: "zoom", duration: 0.4 },
    { op: "add_broll", videoId: "g", start: 8.85, end: 9.55, sourceStart: 0, edit: true },
  ] }, ctx).snap;
  const b = s.timeline.tracks.v2[0].id;
  s = applyOp(s, { op: "set_keyframes", track: "v2", clipId: b, keys: [{ t: 0, scale: 0.35, x: -0.3, y: 0.25, rotation: -10 }, { t: 0.7, scale: 0.45, x: 0.25, y: -0.2, rotation: 15, ease: "out" }] }, ctx).snap;
  return { plan: planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { g: 4 } }), broll: b };
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const { plan, broll } = makePlan();
const W = plan.width, H = plan.height;

// 3. The render.
const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), output: out, broll: { [broll]: join(tmp, "green.webm") } }, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

// 4. The editor's player in a page: SeqMedia inside the zoom container, LiveOverlays on top, at output size.
writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan);
const pb = { attachGate() {} };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const f = liveFrame(plan, t, clock);
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h("div", { style: { position: "absolute", inset: 0, overflow: "hidden", background: "#000", transform: "scale(" + f.zoom + ")", transformOrigin: "50% 40%" } },
      h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb })),
    h(LiveOverlays, { frame: f, clips: [], media: { broll: { g: { url: "/green.webm" } }, graphics: {} }, aspect: plan.aspect, playing: false, plan }));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const file = { "/main.webm": "main.webm", "/green.webm": "green.webm", "/page.bundle.js": "page.bundle.js" }[u];
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

const SW = 96, SH = 54;
const small = (png) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `scale=${SW}:${SH}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: png, maxBuffer: 64 << 20 });
const fileFrame = (k) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-vf", `select=eq(n\\,${k}),scale=${SW}:${SH}:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 << 20 });
// The source frame a frame shows (left half: frame mod 50, right half: frame / 50, in full-range grey).
const shown = (px, xl = 24, xr = 72, y = 27) => { const g = (x) => 16 + (px[(y * SW + x) * 3] * 219) / 255; return 50 * Math.round((g(xr) - 16) / 30) + Math.round((g(xl) - 16) / 4); };
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// Moments: speed, freeze, reverse, inside each transition, the keyframed clip, the moving picture-in-picture.
const plain = (t) => !(plan.transitions || []).some((x) => t >= x.start - 0.05 && t < x.end + 0.05) && !Object.values(plan.clipMotion || {}).some((m) => t >= m.start && t < m.end) && !plan.broll.some((b) => t >= b.start && t < b.end);
const moments = [];
for (let k = 0; k < Math.round(plan.outputSeconds * 30); k += 7) if (plain((k + 0.5) / 30)) moments.push({ k, kind: "frame" });
for (const x of plan.transitions) if (x.end > x.start) for (const f of [0.15, 0.5, 0.8]) moments.push({ k: Math.floor((x.start + f * (x.end - x.start)) * 30), kind: x.type });
for (const m of Object.values(plan.clipMotion)) for (const f of [0.1, 0.5, 0.9]) moments.push({ k: Math.floor((m.start + f * (m.end - m.start)) * 30), kind: "keyframes" });
for (const b of plan.broll) for (const f of [0.1, 0.5, 0.9]) moments.push({ k: Math.floor((b.start + f * (b.end - b.start)) * 30), kind: "b-roll keyframes" });

let fails = 0, worst = 0;
const rows = [];
for (const m of moments) {
  const t = (m.k + 0.5) / 30;
  await page.evaluate((x) => window.__seek(x), t);
  // Settled: no element seeking, every one with its frame, twice in a row 100 ms apart.
  for (let ok = 0, n = 0; ok < 2 && n < 60; n++) {
    await page.waitForTimeout(100);
    ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0;
  }
  const shot = await page.locator("#stage").screenshot();
  const ed = small(shot);
  const fi = fileFrame(m.k);
  if (process.env.DUMP && (m.kind !== "frame" || shown(fi) !== shown(ed))) {
    // Side by side: the render's frame (left) and the editor's (right), for a look.
    const name = `${process.env.DUMP}/${t.toFixed(2)}-${m.kind}`;
    writeFileSync(name + "-ed.png", shot);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-i", name + "-ed.png", "-filter_complex", `[0:v]select=eq(n\\,${m.k}),scale=480:270[a];[1:v]scale=480:270[b];[a][b]hstack`, "-frames:v", "1", name + ".png"]);
  }
  if (m.kind === "frame") {
    const a = shown(fi), b = shown(ed);
    rows.push(`${t.toFixed(2)}s frame: file shows ${a}, editor ${b}`);
    if (a !== b) fails++;
  } else {
    const d = diff(fi, ed);
    worst = Math.max(worst, d);
    rows.push(`${t.toFixed(2)}s ${m.kind}: mean difference ${d.toFixed(1)} / 255`);
    if (d > 8) fails++;
  }
}
console.log(rows.join("\n"));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
if (errs.length) { console.log("page errors:", errs); fails++; }
console.log(fails ? `FAIL: ${fails} moments differ` : `PASS: ${moments.length} moments; every plain frame is the same source frame; transitions and keyframes within ${worst.toFixed(1)}/255 on average`);
process.exit(fails ? 1 : 0);
