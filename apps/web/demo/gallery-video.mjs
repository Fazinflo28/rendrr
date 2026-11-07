// A published video plays its real export in Explore: the tile shows its still and plays muted while the pointer is
// on it; opening it plays the video with controls. Videos with no export yet keep the style preview. Runs on the
// demo build (node demo/build.mjs first) in Playwright's Chromium.   node demo/gallery-video.mjs   (from apps/web)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const dir = mkdtempSync(join(tmpdir(), "gallery-video-"));
// WebM: the test browser (Chromium without H.264) plays it; real Chrome and Safari play the H.264 exports.
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=4", "-c:v", "libvpx-vp9", "-b:v", "300k", "-deadline", "realtime", join(dir, "v.webm")]);
execFileSync("ffmpeg", ["-v", "error", "-i", join(dir, "v.webm"), "-frames:v", "1", join(dir, "p.jpg")]);
const files = { "/v.webm": ["video/webm", readFileSync(join(dir, "v.webm"))], "/p.jpg": ["image/jpeg", readFileSync(join(dir, "p.jpg"))] };
const server = createServer((req, res) => {
  const f = files[req.url.split("?")[0]];
  if (!f) { res.setHeader("content-type", "text/html"); return res.end(html); }
  const [type, body] = f, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  res.setHeader("content-type", type); res.setHeader("accept-ranges", "bytes");
  if (range) { const a = +range[1], b = range[2] ? +range[2] : body.length - 1; res.writeHead(206, { "content-range": `bytes ${a}-${b}/${body.length}`, "content-length": b - a + 1 }); return res.end(body.subarray(a, b + 1)); }
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript((b) => { globalThis.__demoGalleryVideo = { video: b + "/v.webm", poster: b + "/p.jpg" }; }, base);
await page.goto(base + "/"); await page.locator(".gcard").first().waitFor(); await sleep(800);
const tile = page.locator(".gcard video.gvid").first();
check(await tile.count() === 1, "the published video's tile is its real video");
check((await tile.getAttribute("poster"))?.endsWith("/p.jpg"), "it shows the still");
check(await page.locator(".gcard .sv").count() > 0, "videos with no export yet keep the style preview");
const box = await tile.boundingBox();
check(box && Math.abs(box.height / box.width - 16 / 9) < 0.05, `the tile has the video's shape (${box && (box.height / box.width).toFixed(2)})`);
await tile.hover(); await sleep(1200);
const t = await tile.evaluate((v) => ({ time: v.currentTime, paused: v.paused, muted: v.muted }));
check(!t.paused && t.time > 0.2 && t.muted, `it plays muted while the pointer is on it (${t.time.toFixed(2)} s)`);
await page.mouse.move(5, 5); await sleep(300);
check(await tile.evaluate((v) => v.paused && v.currentTime === 0), "it stops when the pointer leaves");
await tile.click(); await sleep(1200);
const big = page.locator(".modal video.gvid.big");
check(await big.count() === 1 && await big.evaluate((v) => v.controls), "opening it plays the video with controls");
const st = await big.evaluate((v) => ({ t: v.currentTime, paused: v.paused, muted: v.muted, rs: v.readyState }));
check(st.t > 0.1 && !st.paused, `the window's video plays (${st.t.toFixed(2)} s${st.muted ? ", muted: the browser wants a tap for sound" : ", with sound"})`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close(); rmSync(dir, { recursive: true, force: true });
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
