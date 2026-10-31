// Phase 18 in the editor: a b-roll clip picked, the Color tool has Remove background for it (the picture under it shows
// round the person; no "Behind the person" choice, which is for V1); on, its edge and softness show and the server
// is asked for its matte; off again. (The whole edit's Remove background taking V1 clips only: demo/background.mjs.)
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/phase18.mjs   (from apps/web)
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
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);

const br = page.locator('.clip[data-clip="b1"]');
await br.scrollIntoViewIfNeeded();
const bb = await br.boundingBox(), tl = await page.locator("#timeline").boundingBox();
await page.mouse.click(bb.x + bb.width / 2, tl.y + 6); await sleep(300);
await br.click(); await sleep(300);
await page.locator("#tab-color").click(); await page.locator("#bg-panel").waitFor({ timeout: 3000 });
check(await page.locator("#bg-on").isEnabled(), "a b-roll clip has Remove background");
check(((await page.locator("#bg-panel").innerText()) || "").includes("b-roll"), "it says it is for this b-roll");
check(await page.locator("#skin-panel, #skin-on").count() === 0, "no skin retouch for b-roll (V1 only)");
await page.locator("#bg-on").check(); await sleep(600);
check(await page.locator("#bg-on").isChecked(), "on");
check(await page.locator("#bg-edge").count() === 1 && await page.locator("#bg-soft").count() === 1, "its edge and softness");
check(await page.locator("#bg-behind").count() === 0, "no Behind the person choice (the picture under it shows)");
const note = await until(async () => { const t = await page.locator("#bg-note").innerText().catch(() => ""); return /picture under the b-roll/.test(t) ? t : null; });
check(!!note, `the note says what shows round the person ("${(note || "").slice(0, 100)}")`);
await page.locator("#bg-on").uncheck(); await sleep(500);
check(!(await page.locator("#bg-on").isChecked()) && await page.locator("#bg-edge").count() === 0, "off again");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
