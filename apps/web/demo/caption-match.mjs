// Checks that the editor draws captions and text layers where the render does (Phase 4). One edit is made with the
// shared code; FFmpeg + libass render a frame of it; the editor's own TextLayers component draws the same moment in a
// browser with the bundled fonts; the boxes (by colour) are compared. Needs ffmpeg and Playwright's Chromium.
//   node demo/caption-match.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "caption-match-"));
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
  b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: "api", namespace: "stub" } : undefined));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const api = {};", loader: "js" }));
} };

// 1. The edit and its plan, made by the shared code (bundled for Node).
writeFileSync(join(tmp, "plan.ts"), `
import { applyOp, buildInitialTimeline, buildTranscript, STYLES } from "@rendrr/shared";
import { planRender, ffmpegArgs } from "@rendrr/shared/renderPlan";
export { ffmpegArgs };
const W = ["Big", "bold", "captions", "in", "yellow", "on", "any", "video", "you", "edit"];
const tr = buildTranscript([W.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 12 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
export const source = { width: 640, height: 360, fps: 30, seconds: 6, hasAudio: false };
export function makePlan(aspect) {
  const ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 6, getStyle: (id) => STYLES.find((s) => s.id === id) };
  let s = { timeline: buildInitialTimeline(tr, 6, "clean", [], "v"), name: "c", aspect, styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [
    { op: "set_caption_style", font: "Montserrat", weight: 900, size: 8, color: "#FFFFFF", highlight: "#FFD400", box: { color: "#FF00FF", opacity: 1, padding: 20 }, wordsAtOnce: 4, wordsPerLine: 2, lines: 2, y: 0.85 },
    { op: "add_text", text: "TITLE HERE\\nsecond line", start: 0.2, end: 5.8, edit: true, preset: "callout", color: "#000000", box: { color: "#00FFFF", opacity: 1, padding: 20 }, y: 0.25, anim: "none" },
    { op: "add_text", text: "Bebas outline", start: 0.2, end: 5.8, edit: true, font: "Bebas Neue", weight: 400, size: 9, color: "#00FF00", stroke: { color: "#000000", width: 6 }, x: 0.3, y: 0.55, align: "left", anim: "none" },
  ] }, ctx).snap;
  return planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
}`);
await build({ entryPoints: [join(tmp, "plan.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "plan.mjs"), nodePaths: [join(web, "node_modules")], logLevel: "warning" });
const { makePlan, ffmpegArgs, source } = await import(pathToFileURL(join(tmp, "plan.mjs")).href);

// 2. The editor's TextLayers component in a page, at output size (scale 1).
writeFileSync(join(tmp, "page.js"), `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { liveFrame } from "@rendrr/shared";
import { TextLayers } from ${JSON.stringify(resolve(web, "src/rendrr/editor.js"))};
const plan = window.__PLAN;
document.getElementById("root").style.width = plan.width + "px"; document.getElementById("root").style.height = plan.height + "px";
createRoot(document.getElementById("root")).render(createElement(TextLayers, { plan, frame: liveFrame(plan, window.__T) }));`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' }, plugins: [stub], logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u.startsWith("/fonts/")) { res.setHeader("content-type", "font/ttf"); res.end(readFileSync(join(web, "public", u))); return; }
  if (u === "/page.bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(tmp, "page.bundle.js"))); return; }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><style>${css}\nbody{margin:0;background:#404040}</style><div id="root" style="position:relative;background:#404040"></div><script>window.__PLAN=${JSON.stringify(globalThis.__plan)};window.__T=${globalThis.__t}</script><script src="/page.bundle.js"></script>`);
}).listen(0);
const port = server.address().port;

const require = (await import("node:module")).createRequire(join(web, "package.json"));
// playwright-core from this app or NODE_PATH (the repo keeps it under node_modules/.pnpm).
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());

const rgbOf = (png, W, H) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "pipe:1"], { input: png, maxBuffer: 64 << 20 });
function bbox(px, W, H, rgb, tol = 50) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0, sx = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (Math.abs(px[i] - rgb[0]) < tol && Math.abs(px[i + 1] - rgb[1]) < tol && Math.abs(px[i + 2] - rgb[2]) < tol) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); n++; sx += x; }
  }
  return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: Math.round(sx / n) } : null;
}

let worst = 0, fails = 0;
for (const aspect of ["16:9", "9:16"]) {
  const plan = makePlan(aspect);
  const W = plan.width, H = plan.height;
  // The render: a gray source with the plan's ASS on it.
  const src = join(tmp, "gray.mp4"), out = join(tmp, `out-${aspect.replace(":", "x")}.mp4`), ass = join(tmp, "c.ass"), graph = join(tmp, "g.txt");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x404040:s=640x360:r=30:d=6`, "-c:v", "libx264", "-preset", "ultrafast", src]);
  writeFileSync(ass, plan.ass);
  const { args, filterGraph } = ffmpegArgs(plan, { source: src, output: out, assPath: ass, fontsDir: join(web, "public/fonts") }, source, { loudnessGainDb: 0 });
  writeFileSync(graph, filterGraph);
  execFileSync("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)));
  for (const c of plan.styledCaptions.slice(0, 2)) {
    // The middle of the second word of the caption (a word is coloured).
    const t = c.lines.flat()[1] ? (c.lines.flat()[1].start + (c.lines.flat()[2]?.start ?? c.end)) / 2 : (c.start + c.end) / 2;
    const fileFrame = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 << 20 });
    globalThis.__plan = plan; globalThis.__t = t;
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector(".tlayers .stage");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const fams = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")));
    const shot = await page.locator("#root").screenshot();
    await page.close();
    const ed = rgbOf(shot, W, H);
    for (const [name, rgb] of [["caption box", [255, 0, 255]], ["text box", [0, 255, 255]], ["spoken word", [255, 212, 0]], ["Bebas text", [0, 255, 0]]]) {
      const a = bbox(fileFrame, W, H, rgb), b = bbox(ed, W, H, rgb);
      if (!a || !b) { console.log(`${aspect} t=${t.toFixed(2)} ${name}: file ${a ? "yes" : "none"}, editor ${b ? "yes" : "none"}`); fails++; continue; }
      const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
      worst = Math.max(worst, d);
      console.log(`${aspect} t=${t.toFixed(2)} ${name}: file ${a.x},${a.y} ${a.w}x${a.h} | editor ${b.x},${b.y} ${b.w}x${b.h} | off by up to ${d}px`);
      if (d > 4) fails++;
    }
    if (!fams.includes("RC Montserrat 900")) { console.log(`fonts loaded: ${fams.join(", ")}`); fails++; }
  }
}
await browser.close(); server.close(); rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `FAIL: ${fails} differences over 4 px (worst ${worst}px)` : `PASS: the editor draws captions and text within ${worst}px of the render`);
process.exit(fails ? 1 : 0);
