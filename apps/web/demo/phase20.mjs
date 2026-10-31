// Phase 20 in the editor: the transition picker on a V1 clip offers Iris box, Iris cross, Venetian blinds (with a
// direction), Checker wipe and Wedge wipe, and they stay picked; the Export window offers GIFs up to ten minutes.
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/phase20.mjs   (from apps/web)
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
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(100); } return v; };
const slide = async (id, n, key = "ArrowRight") => { const el = page.locator("#" + id); await el.focus(); for (let i = 0; i < n; i++) await page.keyboard.press(key); await el.blur(); await sleep(250); };
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
// A short tone as the demo videos' file, so the b-roll has something to play.
await page.evaluate(() => {
  const rate = 8000, n = rate * 40, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  globalThis.__rendrrDemoMedia = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
});
await page.evaluate(() => {
  const rate = 8000, n = rate * 40, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  globalThis.__rendrrDemoMedia = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
});
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);

const clips = page.locator(".clip.video");
await clips.nth(1).click(); await sleep(300);
await page.locator("#tab-clip").click(); await page.locator("#transition-type").waitFor({ timeout: 3000 });
const opts = await page.locator("#transition-type option").allInnerTexts();
check(["Iris box", "Iris cross", "Venetian blinds", "Checker wipe", "Wedge wipe"].every((n) => opts.includes(n)), `the five new wipes are offered (${opts.slice(-5).join(", ")})`);
await page.locator("#transition-type").selectOption("blinds"); await sleep(400);
check(await page.locator("#transition-dir").count() === 1, "Venetian blinds: a direction");
await page.locator("#transition-dir").selectOption("left"); await sleep(300);
check(await page.locator("#transition-dir").inputValue() === "left", "vertical blinds picked");
await page.locator("#transition-type").selectOption("checker"); await sleep(400);
check(await page.locator("#transition-type").inputValue() === "checker" && await page.locator("#transition-dir").count() === 0, "Checker wipe: no direction");
// (The player's shapes are checked against the render's in apps/worker/test/wipes20-render.test.ts: the demo has no
// footage lengths, so it plans no transition windows to draw.)
await page.locator("#transition-type").selectOption("box"); await sleep(300);
check(await page.locator("#transition-type").inputValue() === "box", "Iris box picked");
await page.locator("#tool-back").click(); await sleep(200);
// The Export window: GIF up to ten minutes.
const exp = page.locator("button", { hasText: "Export final" }).first();
await exp.click(); await sleep(500);
const fmt = await page.evaluate(() => Array.from(document.querySelectorAll("option, label, button")).map((e) => e.textContent).find((t) => /GIF \(up to/.test(t || "")) || "");
check(/GIF \(up to 10 min\)/.test(fmt), `Export offers GIFs up to ten minutes ("${fmt}")`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
