// The web app reads a picked video's length from the file itself (src/rendrr/local.ts fileLength): the browser's
// reading of its header. Used to accept a renamed or re-saved copy of local footage as its original.
// Bundles the real module and runs it in Playwright's Chromium on files FFmpeg makes here.
//   node demo/file-length.mjs   (from apps/web)
//
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "len-"));
const make = (name, args) => { execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=7.4", "-f", "lavfi", "-i", "sine=d=7.4", ...args, join(dir, name)]); return readFileSync(join(dir, name)); };
const files = { "clip.webm": make("clip.webm", ["-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus"]), "clip.mp4": make("clip.mp4", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]) };
const bundle = (await build({ stdin: { contents: `import { fileLength } from "./src/rendrr/local"; globalThis.fileLength = fileLength;`, resolveDir: web, loader: "ts" }, bundle: true, format: "iife", platform: "browser", write: false, logLevel: "error", external: ["/ffmpeg/index.js"], define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' } })).outputFiles[0].text;
const server = createServer((req, res) => {
  const name = req.url.slice(1);
  if (files[name]) { res.setHeader("content-type", name.endsWith("webm") ? "video/webm" : "video/mp4"); return res.end(files[name]); }
  res.setHeader("content-type", "text/html"); res.end(`<meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`);
}).listen(0);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${server.address().port}/`);
const lengthOf = (name) => page.evaluate(async (name) => {
  const b = await (await fetch("/" + name)).blob();
  const t = performance.now();
  const s = await globalThis.fileLength(new File([b], name, { type: b.type }));
  return { s, ms: Math.round(performance.now() - t) };
}, name);
const w = await lengthOf("clip.webm");
check(w.s != null && Math.abs(w.s - 7.4) < 0.1, `a WebM's length is read from the file (${w.s?.toFixed(2)} s in ${w.ms} ms)`);
const m = await lengthOf("clip.mp4");
// Chrome reads MP4 itself; a browser build without its codecs falls back to FFmpeg, or says it can't (null), never a wrong length.
check(m.s == null || Math.abs(m.s - 7.4) < 0.1, `an MP4's length is right or unknown, never wrong (${m.s == null ? "unknown here" : m.s.toFixed(2) + " s"} in ${m.ms} ms)`);
const bad = await page.evaluate(() => globalThis.fileLength(new File([new Uint8Array(1000)], "broken.mp4", { type: "video/mp4" })));
check(bad == null, "a file that is not a video has no length");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close(); rmSync(dir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
