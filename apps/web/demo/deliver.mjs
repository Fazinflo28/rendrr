// Phase 12 in the editor: the Export window sets the format, frame rate and bitrate, and saves SRT and WebVTT
// captions from the edit (with captions off too) and copies YouTube chapters once there are chapter marks.
//
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/deliver.mjs   (from apps/web)
//
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
await page.locator("#export-format").selectOption("gif"); await sleep(250);
check((await page.locator("#export-summary").textContent()).includes("GIF"), "format GIF in the summary");
check(await page.locator("#export-bitrate").count() === 0, "no bitrate for a GIF");
await page.locator("#export-format").selectOption("mp4"); await sleep(250);
await page.locator('#export-fps [data-v="25"]').click(); await sleep(250);
check((await page.locator("#export-summary").textContent()).includes("25 fps"), "25 fps in the summary");
await page.locator("#export-bitrate").fill("12"); await page.locator("#export-bitrate").press("Tab"); await sleep(250);
check((await page.locator("#export-summary").textContent()).includes("12 Mbit/s"), "12 Mbit/s in the summary");
await page.locator("#export-format").selectOption("overlay"); await sleep(250);
check(await page.locator("#export-overlay-note").count() === 1, "the overlay export says what it holds");
await page.locator("#export-format").selectOption("mp4"); await sleep(200);
// Captions files from the edit itself.
check(await page.locator("#export-srt").isEnabled(), "SRT can be saved");
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.locator("#export-srt").click()]);
let srt = ""; if (dl) { const p = await dl.path(); srt = p ? (await import("node:fs")).readFileSync(p, "utf8") : ""; }
check(/^1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n\S/.test(srt), `the SRT has timed cues (${srt.split("\n").slice(0, 3).join(" | ")})`);
const [dv] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.locator("#export-vtt").click()]);
check(!!dv && dv.suggestedFilename().endsWith(".vtt"), "WebVTT saved as .vtt");
check(await page.locator("#export-chapters").isDisabled() && (await page.locator("#export-chapters-note").textContent()).includes("chapter marks"), "no chapter marks: the chapters button says where they come from");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
