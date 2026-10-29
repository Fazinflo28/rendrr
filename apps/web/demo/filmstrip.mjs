// The timeline's filmstrip: a V1 clip shows its own footage, a frame per tile at its place in the clip, drawn in the
// browser from the preview copy (served from another origin, with CORS, like the storage). The footage is one solid
// colour a second, so each tile's colour says which moment it shows.   node demo/filmstrip.mjs   (from apps/web)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "filmstrip-"));
const COLORS = [["red", [255, 0, 0]], ["lime", [0, 255, 0]], ["blue", [0, 0, 255]], ["yellow", [255, 255, 0]], ["white", [255, 255, 255]], ["magenta", [255, 0, 255]]];
const inputs = COLORS.flatMap(([c]) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=30:d=1`]);
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `${COLORS.map((_, i) => `[${i}:v]`).join("")}concat=n=${COLORS.length}:v=1:a=0,format=yuv420p`, "-c:v", "libvpx-vp9", "-b:v", "400k", "-g", "15", join(tmp, "src.webm")]);

writeFileSync(join(tmp, "page.js"), `
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { Filmstrip } from ${JSON.stringify(resolve(web, "src/rendrr/filmstrip.js"))};
const url = window.__SRC;
// Three clips: 0.0-1.0 s (red), 2.0-4.0 s (blue then yellow), 4.0-6.0 s at a wider zoom (white, magenta).
createRoot(document.getElementById("root")).render(h("div", null,
  h("div", { id: "c1", className: "clip video", style: { position: "relative", width: "46px", height: "26px" } }, h(Filmstrip, { url, from: 0, to: 1, width: 46 })),
  h("div", { id: "c2", className: "clip video", style: { position: "relative", width: "92px", height: "26px", marginTop: "8px" } }, h(Filmstrip, { url, from: 2, to: 4, width: 92 })),
  h("div", { id: "c3", className: "clip video", style: { position: "relative", width: "92px", height: "26px", marginTop: "8px" } }, h(Filmstrip, { url, from: 4, to: 6, width: 92 }))));`);
await build({ entryPoints: [join(tmp, "page.js")], bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "page.bundle.js"), nodePaths: [join(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
const css = readFileSync(join(web, "src/rendrr/styles.css"), "utf8");
// The video from another origin with CORS (as the storage serves previews).
const media = createServer((req, res) => {
  const buf = readFileSync(join(tmp, "src.webm"));
  const hd = { "content-type": "video/webm", "accept-ranges": "bytes", "access-control-allow-origin": "*" };
  const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (r) { const a = +r[1], b = r[2] ? +r[2] : buf.length - 1; res.writeHead(206, { ...hd, "content-range": `bytes ${a}-${b}/${buf.length}`, "content-length": b - a + 1 }); return res.end(buf.subarray(a, b + 1)); }
  res.writeHead(200, { ...hd, "content-length": buf.length }); res.end(buf);
}).listen(0, "127.0.0.1");
const page0 = createServer((req, res) => {
  if (req.url === "/page.bundle.js") { res.setHeader("content-type", "text/javascript"); return res.end(readFileSync(join(tmp, "page.bundle.js"))); }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><style>${css}\nbody{margin:20px;background:#111}</style><div id="root"></div><script>window.__SRC="http://127.0.0.1:${media.address().port}/src.webm"</script><script src="/page.bundle.js"></script>`);
}).listen(0, "localhost");
await new Promise((r) => setTimeout(r, 200));

const { createRequire } = await import("node:module");
const require = createRequire(join(web, "package.json"));
const { chromium } = require(require.resolve("playwright-core", { paths: [web] }));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 400, height: 200 } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`http://localhost:${page0.address().port}/`);
await page.waitForFunction(() => [...document.querySelectorAll(".strip i")].every((i) => i.style.backgroundImage.startsWith("url(")), null, { timeout: 15000 }).catch(() => {});
const tiles = await page.evaluate(async () => {
  const out = [];
  for (const clip of ["c1", "c2", "c3"]) for (const i of document.querySelectorAll(`#${clip} .strip i`)) {
    const src = i.style.backgroundImage.slice(5, -2);
    if (!src) { out.push([clip, null]); continue; }
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement("canvas"); c.width = 8; c.height = 8; const g = c.getContext("2d"); g.drawImage(img, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0; for (let k = 0; k < d.length; k += 4) { r += d[k]; gg += d[k + 1]; b += d[k + 2]; }
    out.push([clip, [r / 64, gg / 64, b / 64].map(Math.round)]);
  }
  return out;
});
await page.screenshot({ path: join(tmp, "strip.png") });
let fails = 0;
const want = { c1: ["red"], c2: ["blue", "yellow"], c3: ["white", "magenta"] };
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 40);
for (const [clip, names] of Object.entries(want)) {
  const got = tiles.filter(([c]) => c === clip).map(([, rgb]) => rgb);
  const ok = got.length === names.length && got.every((rgb, i) => rgb && near(rgb, COLORS.find(([n]) => n === names[i])[1]));
  console.log(`${ok ? "ok  " : "FAIL"} ${clip}: ${got.length} tiles ${JSON.stringify(got)} want ${names.join(", ")}`);
  if (!ok) fails++;
}
if (errs.length) { console.log("page errors:", errs); fails++; }
await browser.close(); media.close(); page0.close(); rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `FAIL: ${fails}` : "PASS: each tile shows its own moment of the footage");
process.exit(fails ? 1 : 0);
