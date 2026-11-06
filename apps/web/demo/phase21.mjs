// Phase 21 in the editor: Stabilize (Warp Stabilizer) is offered on b-roll, and on V1 clips at another speed, where
// the note says it is smoothed through the speed changes; it stays on. Runs on the demo build (node demo/build.mjs
// first) in Playwright's Chromium.
//   node demo/phase21.mjs   (from apps/web)
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

// A V1 clip slowed to half speed: Stabilize says it smooths through the speed change.
await page.locator(".clip.video").first().click(); await sleep(300);
await page.locator("#speed-panel").waitFor({ timeout: 3000 });
await page.locator("#clip-speed").fill("0.5").catch(async () => { await slide("clip-speed", 10, "ArrowLeft"); });
await page.locator("#clip-speed").blur().catch(() => {}); await sleep(400);
await page.locator("#clip-stabilize").check(); await sleep(400);
check(await page.locator("#clip-stabilize").isChecked(), "Stabilize stays on for a clip at another speed");
const n1 = (await page.locator("#stabilize-note").textContent()) || "";
check(/through its speed changes/.test(n1), `the note says it is smoothed through the speed changes ("${n1.trim()}")`);
await page.locator("#tool-back").click({ timeout: 800 }).catch(() => {}); await sleep(200);

// The b-roll: Stabilize offered, from its own footage.
const br = page.locator('.clip[data-clip="b1"]');
await br.scrollIntoViewIfNeeded();
const bb = await br.boundingBox(), tl = await page.locator("#timeline").boundingBox();
await page.mouse.click(bb.x + bb.width / 2, tl.y + 6); await sleep(300);
await br.click(); await sleep(300);
await page.locator("#frame-look").waitFor({ timeout: 3000 });
check(await page.locator("#stabilize-panel").count() === 1, "b-roll has the Stabilize control");
await page.locator("#clip-stabilize").check(); await sleep(400);
check(await page.locator("#clip-stabilize").isChecked() && await page.locator("#clip-stabilize-smooth").count() === 1, "on, with its smoothness");
const n2 = (await page.locator("#stabilize-note").textContent()) || "";
check(/from the b-roll's own footage/.test(n2), `the note says it uses the b-roll's own footage ("${n2.trim()}")`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
