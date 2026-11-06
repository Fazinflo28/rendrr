// Phase 17 in the editor: a text layer's anchor point (the 3x3 grid, its alignment point lit by default) and motion
// blur in Speed & motion; with a turn key, a new anchor moves where the player draws the text. A b-roll card's Border
// (colour, width) and the player draws it over the b-roll.
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/phase17.mjs   (from apps/web)
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

// A text layer: Speed & motion has the anchor grid and motion blur.
await page.locator("#tab-text").click(); await sleep(300);
await page.locator("#add-text-title").click(); await sleep(500);
await page.locator("#tool-back").click({ timeout: 800 }).catch(() => {}); await sleep(200);
await page.locator("#keys-panel").waitFor({ timeout: 3000 });
check(await page.locator("#anchor-row").count() === 1, "a text layer has the anchor grid");
check(await page.locator('[data-anchor="0.5,0.5"]').getAttribute("aria-checked") === "true", "centred text: its middle is lit (its alignment point)");
check(await page.locator("#motion-blur").count() === 1, "and motion blur");
// A turn key at the playhead (the layer's start): 90 degrees.
const block = () => page.evaluate(() => { const el = document.querySelector("[data-text] .tblock"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; });
await page.locator("#key-rotation").fill("90"); await page.locator("#key-rotation").blur(); await sleep(300);
const turned = await until(async () => { const b = await block(); return b && b.h > b.w ? b : null; });
check(!!turned, `turned a quarter (${JSON.stringify(turned)})`);
await page.locator('[data-anchor="0,0.5"]').click(); await sleep(400);
check(await page.locator('[data-anchor="0,0.5"]').getAttribute("aria-checked") === "true", "anchor at its left edge's middle");
const moved = await until(async () => { const b = await block(); return b && Math.abs(b.y - turned.y) > 5 ? b : null; });
check(!!moved && moved.y > turned.y + 5 && Math.abs(moved.x - turned.x) > 5, `turned about the left edge, the text swings down and left (${JSON.stringify(moved)})`);
await slide("motion-blur", 10);
check((await page.locator('[data-val="motion-blur"]').textContent()).startsWith("50"), "motion blur 50 on the text");
await page.locator('[data-anchor="0.5,0.5"]').click(); await sleep(400);
const back = await until(async () => { const b = await block(); return b && Math.abs(b.y - turned.y) < 2 && Math.abs(b.x - turned.x) < 2 ? b : null; });
check(!!back, "its alignment point again: back where it turned before");

// A b-roll card: a border, drawn in the player.
await page.locator("#tool-back").click({ timeout: 800 }).catch(() => {}); await sleep(200);
const br = page.locator('.clip[data-clip="b1"]');
await br.scrollIntoViewIfNeeded();
// The playhead into the b-roll (a click on the timeline's top row at its middle), then the b-roll picked.
const bb = await br.boundingBox(), tl = await page.locator("#timeline").boundingBox();
await page.mouse.click(bb.x + bb.width / 2, tl.y + 6); await sleep(300);
await br.click(); await sleep(300);
await page.locator("#frame-look").waitFor({ timeout: 3000 });
await slide("crop-left", 20);
await page.locator("#card-border").check(); await sleep(300);
check(await page.locator("#card-border-width").count() === 1 && await page.locator("#card-border-color").count() === 1, "Border on: its colour and width");
await slide("card-border-width", 12);
check((await page.locator('[data-val="card-border-width"]').textContent()) === "2.0%", `border width 2.0% (${await page.locator('[data-val="card-border-width"]').textContent()})`);
const drawn = await until(() => page.evaluate(() => !!document.querySelector("[data-border] canvas[data-card=border]")), 4000);
check(drawn, "the player draws the border over the b-roll");
await page.locator("#card-border").uncheck(); await sleep(400);
check(await page.locator("[data-border]").count() === 0, "Border off: gone from the player");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
