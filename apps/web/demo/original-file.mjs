// Export final on footage from this computer: the original is asked for once, and the button always gets it.
// 1. The browser remembers the file (a drop in Chrome): "Upload original and export" opens it and the final runs,
//    with the Export window's choice (Best) kept.
// 2. The browser can no longer open it: the window says so and offers "Pick the original file", which works.
//
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/original-file.mjs   (from apps/web)
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
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The demo's footage "gym-promo-broll.mp4" is 610 MB; a stand-in with that name and size (its bytes are never read).
const remember = (how) => page.evaluate((how) => {
  const f = new File([""], "gym-promo-broll.mp4", { type: "video/mp4" });
  Object.defineProperty(f, "size", { value: 610000000 });
  globalThis.__demoRemembered = { v2: how === "file" ? f : "denied" };
}, how);

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }

// 1. Remembered file: one click uploads it and runs the final (Best kept).
await remember("file");
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
await page.locator('#export-quality [data-v="best"]').click(); await sleep(200);
await page.locator("#export-render").click();
await page.locator("#need-original").waitFor({ timeout: 5000 });
check(await page.locator("#upload-original").count() === 1, "a remembered file: Upload original and export");
check(await page.locator("#pick-other").count() === 1, "and a way to pick the file instead");
await page.locator("#upload-original").click();
const step = await page.locator("#render-step").textContent({ timeout: 3000 }).catch(() => "");
check(/Uploading original/.test(step || ""), `the original uploads (${step})`);
await page.locator("#render-done").waitFor({ timeout: 20000 }).catch(() => {});
check(await page.locator("#render-done").count() === 1, "the final is made");
check(await page.evaluate(() => globalThis.__lastRenderOpts?.best === true), "the final keeps Best from the Export window");
await page.locator("#render-done").locator("xpath=ancestor::*[contains(@class,'state')]").getByText("Close").click().catch(() => {}); await sleep(300);

// 2. The browser can no longer open it: say so and offer the picker; the picked file works.
await remember("denied");
await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
await page.locator("#export-render").click();
await page.locator("#need-original").waitFor({ timeout: 5000 });
await page.locator("#upload-original").click(); await sleep(400);
check(/Pick the original file/.test((await page.locator("#original-error").textContent().catch(() => "")) || ""), "a file it cannot open: the window says to pick it");
check(await page.locator("#pick-original").count() === 1, "and shows Pick the original file");
// Picking a different file is refused by name; the right one goes through.
await page.locator("#original-file").setInputFiles({ name: "other.mp4", mimeType: "video/mp4", buffer: Buffer.from("x") }); await sleep(400);
check(/not the same file/.test((await page.locator("#original-error").textContent().catch(() => "")) || ""), "a different file is refused with its name");
await page.evaluate(() => {
  const i = document.getElementById("original-file");
  const f = new File([""], "gym-promo-broll.mp4", { type: "video/mp4" }); Object.defineProperty(f, "size", { value: 610000000 });
  const dt = new DataTransfer(); dt.items.add(f); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.locator("#render-done").waitFor({ timeout: 20000 }).catch(() => {});
check(await page.locator("#render-done").count() === 1, "the picked file makes the final");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
