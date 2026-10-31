// Samples in the editor: the Samples button opens a window to pick moments at the playhead (a frame, a 4 s clip from
// it), render them, see each one big with the set's strip, and go to one in the player. Runs on the demo build (node
// demo/build.mjs first) in Playwright's Chromium; the demo has no renderer, so each sample is a picture naming it.
//   node demo/samples.mjs   (from apps/web)
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
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);

// Move the playhead 5 s on (L), then open Samples.
await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press("l"); await sleep(300);
const btn = page.locator("#samples-btn");
check(await btn.count() === 1 && /Samples/.test(await btn.innerText()), "the top bar has a Samples button");
await btn.click(); await sleep(400);
check(await page.locator('[role="dialog"][aria-label="Samples"]').count() === 1, "it opens the Samples window");
check(await page.locator("#samples-empty").count() === 1, "an edit with no samples says how to make them");
const frameBtn = page.locator("#samples-add-frame"), clipBtn = page.locator("#samples-add-clip");
const fl = await frameBtn.innerText();
check(/Frame at 0:05\.0/.test(fl), `a frame at the playhead (${fl})`);
await frameBtn.click(); await sleep(150);
await clipBtn.click(); await sleep(150);
const chips = await page.locator("#samples-ask .chip").allInnerTexts();
check(chips.length === 2 && /Frame 0:05\.0/.test(chips[0]) && /Clip 0:05\.0-0:09\.0/.test(chips[1]), `the moments picked are listed (${chips.join(" | ").replace(/\s+/g, " ")})`);
await frameBtn.click(); await sleep(150);
check((await page.locator("#samples-ask .chip").count()) === 2, "the same moment is not added twice");
check(/Render 2 samples/.test(await page.locator("#samples-render").innerText()), "the render button counts them");
await page.locator("#samples-render").click();
await page.locator("#sample-big img").waitFor({ timeout: 8000 });
const strip = await page.locator(".sample-thumb").count();
check(strip === 2 && (await page.locator(".sample-thumb.on").count()) === 1, "once rendered: the first big, the set in a strip");
check(/1\/2 · Frame 0:05\.0/.test(await page.locator("#sample-big .tag").innerText()), "the big one says which sample it is");
check((await page.locator("#samples-ask .chip").count()) === 0, "the list of moments empties after rendering");
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await page.locator(".sample-thumb").nth(1).click(); await sleep(150);
check(/2\/2 · Clip 0:05\.0-0:09\.0/.test(await page.locator("#sample-big .tag").innerText()) && /▶ 4s/.test(await page.locator(".sample-thumb").nth(1).innerText()), "picking the clip shows it; its thumbnail says its length");
// Go there: the window closes, the player is at the sample's moment.
await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.dataset.before = String(v.currentTime); });
await page.locator("#sample-go").click(); await sleep(400);
check(await page.locator('[role="dialog"][aria-label="Samples"]').count() === 0, "Go to closes the window");
const tc = await page.evaluate(() => (document.querySelector("#timecode, .timecode, .tc")?.textContent || "").trim());
check(/0?0:05/.test(tc) || tc === "", `the player is at the sample's moment (${tc || "no timecode shown"})`);
// Open again: the set made is listed (and Claude's would be).
await page.locator("#samples-btn").click(); await sleep(400);
check((await page.locator(".sample-set").count()) === 1 && /Latest · v1 · 2 samples/.test(await page.locator(".sample-set").first().innerText()), "opening again lists the latest set");
await page.keyboard.press("Escape"); await sleep(200);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
