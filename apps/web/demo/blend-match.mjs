// Phase 4: the editor's player blends b-roll over the picture as the render does. The picture is four colour bands
// across, the b-roll four bands down; the edit puts the b-roll on in screen (1-3 s), multiply at 70% (4-6 s) and
// normal at 50% (7-9 s). FFmpeg renders it; the editor's SeqMedia and LiveOverlays (CSS mix-blend-mode and opacity)
// show the same moments in a browser; each of the 16 cells is compared. Needs ffmpeg and Playwright's Chromium.
//   node demo/blend-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "blend-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 256 << 20 });

const SEC = 10;
const bands = (cs, across, d) => `${cs.map((c, i) => `color=${c}:s=${across ? "160x360" : "640x90"}:r=30:d=${d}[c${i}]`).join(";")};${cs.map((_, i) => `[c${i}]`).join("")}${across ? "hstack" : "vstack"}=inputs=4,format=yuv444p`;
const vp9 = ["-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "yuv444p", "-g", "15"];
ff("-filter_complex", `${bands(["0x202020", "0x808080", "0xE07020", "0xA0C8F0"], true, SEC)}[v]`, "-map", "[v]", ...vp9, join(tmp, "main.webm"));
ff("-filter_complex", `${bands(["0x181818", "0x606060", "0xC0C0C0", "0x30A050"], false, 4)}[v]`, "-map", "[v]", ...vp9, join(tmp, "leak.webm"));

writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline } from "@rendrr/shared";
import { planRender, ffmpegArgs } from "@rendrr/shared/renderPlan";
export { ffmpegArgs };
export const source = { width: 640, height: 360, fps: 30, seconds: ${SEC}, hasAudio: false };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: ${SEC}, getStyle: () => undefined, getVideo: (id) => (id === "leak" ? { id, name: "bands", seconds: 4, ready: true } : undefined) };
export function makePlan() {
  let s = { timeline: buildInitialTimeline([], ${SEC}, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] }, ctx).snap;
  for (const [start, blend, opacity] of [[1, "screen", 1], [4, "multiply", 0.7], [7, "normal", 0.5]]) {
    s = applyOp(s, { op: "add_broll", videoId: "leak", start, end: start + 2, sourceStart: 0, edit: true }, ctx).snap;
    const id = s.timeline.tracks.v2.at(-1).id;
    s = applyOp(s, { op: "set_blend", clipId: id, blend, opacity }, ctx).snap;
  }
  return planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { leak: 4 } });
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);
const plan = makePlan();
const W = plan.width, H = plan.height;

const out = join(tmp, "out.mp4"), graph = join(tmp, "g.txt");
const { args, filterGraph } = ffmpegArgs(plan, { source: join(tmp, "main.webm"), output: out, broll: Object.fromEntries(plan.broll.map((b) => [b.clipId, join(tmp, "leak.webm")])) }, source, { loudnessGainDb: 0 });
writeFileSync(graph, filterGraph);
execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));

writeFileSync(join(tmp, "page.js"), `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame, sequenceClock } from "@rendrr/shared";
import { SeqMedia, LiveOverlays } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN, clock = sequenceClock(plan);
const pb = { attachGate() {} };
const media = { broll: { leak: { url: "/leak.webm", seconds: 4 } }, graphicClips: {} };
let setT;
function App() {
  const [t, st] = useState(0); setT = st;
  const f = liveFrame(plan, t, clock);
  return h("div", { id: "stage", style: { position: "relative", width: plan.width + "px", height: plan.height + "px", overflow: "hidden", background: "#000" } },
    h("div", { style: { position: "absolute", inset: 0, overflow: "hidden", background: "#000" } },
      h(SeqMedia, { plan, clock, time: t, playing: false, urls: { v: "/main.webm" }, sounds: {}, aspect: plan.aspect, pb, broll: media.broll })),
    h(LiveOverlays, { frame: f, clips: [], media, aspect: plan.aspect, playing: false, plan }));
}
createRoot(document.getElementById("root")).render(h(App));
window.__seek = (t) => setT(t);`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const file = { "/main.webm": "main.webm", "/leak.webm": "leak.webm", "/page.bundle.js": "page.bundle.js" }[u];
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

const rgb = (input) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...input, "-frames:v", "1", "-vf", `scale=${W}:${H}:in_color_matrix=bt709:in_range=tv,format=rgb24`, "-f", "rawvideo", "pipe:1"], { maxBuffer: 64 << 20 });
const cells = (px) => Array.from({ length: 16 }, (_, c) => { const i = c % 4, j = Math.floor(c / 4), x = Math.round((i + 0.5) * W / 4), y = Math.round((j + 0.5) * H / 4), o = (y * W + x) * 3; return [px[o], px[o + 1], px[o + 2]]; });
let fails = 0, worst = 0;
const rows = [];
let plain = 0;
for (const [t0, what] of [[3.5, "between (plain)"], [2, "screen"], [5, "multiply 70%"], [8, "50% opacity"]]) {
  const f = Math.floor(t0 * 30), t = (f + 0.5) / 30;
  await page.evaluate((x) => window.__seek(x), t);
  for (let ok = 0, n = 0; ok < 2 && n < 60; n++) {
    await page.waitForTimeout(100);
    ok = (await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && v.readyState >= 2))) ? ok + 1 : 0;
  }
  const png = await page.locator("#stage").screenshot();
  const ed = cells(execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: png, maxBuffer: 64 << 20 }));
  const fi = cells(rgb(["-i", out, "-vf", `select=eq(n\\,${f})`]).length ? rgb(["-ss", t.toFixed(3), "-i", out]) : []);
  let d = 0;
  for (let c = 0; c < 16; c++) for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(ed[c][k] - fi[c][k]));
  worst = Math.max(worst, d);
  rows.push(`${t.toFixed(2)}s ${what}: largest difference ${d} of 255 over 16 cells (file ${fi[10].join(",")} / editor ${ed[10].join(",")} in cell 2,2)`);
  // The picture with nothing over it already differs a little (the browser decodes the footage, the file is the
  // render's own encode): a blend may add at most 6 to that.
  if (what.startsWith("between")) plain = d;
  else if (d > plain + 6) fails++;
}
console.log(rows.join("\n"));
await browser.close(); server.close(); if (process.env.KEEP) console.log("kept " + tmp); else rmSync(tmp, { recursive: true, force: true });
if (errs.length) { console.log("page errors:", errs); fails++; }
console.log(fails ? `FAIL: ${fails} moments differ` : `PASS: the editor blends as the render does (largest difference ${worst} of 255; ${plain} with nothing over the picture)`);
process.exit(fails ? 1 : 0);
