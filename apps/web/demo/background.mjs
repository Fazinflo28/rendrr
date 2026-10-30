// The editor's Remove background section (Edit > Color): on for the clip, edge, softness and invert send
// remove_background, "Behind the person" sets the edit's background (and shows what is set), and the note says the
// cut-out is being made (the demo has no worker: every block is still being made). Runs on the demo build.
//   node demo/background.mjs   (from apps/web)
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
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(400);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator("#tab-color").click(); await sleep(300);
check(await page.locator("#bg-panel").count() === 1, "the Color tool has a Remove background section");
await page.locator("#bg-on").check(); await sleep(600);
check(await page.locator("#bg-edge").count() === 1 && await page.locator("#bg-soft").count() === 1, "turned on: edge and softness sliders");
const note = await page.locator("#bg-note").innerText();
check(/Cutting out the person on the server: \d+ parts? of 10 s left/.test(note), `the note says the cut-out is being made ("${note.slice(0, 90)}")`);
await page.locator("#bg-behind").selectOption("gradient"); await sleep(500);
// (The demo's player has no video, so it draws no background layer: matte-match.mjs checks the real player's.)
check(await page.locator("#bg-behind").inputValue() === "gradient", "Behind the person: a gradient is set and stays picked");
await page.locator("#bg-behind").selectOption("color"); await sleep(400);
check(await page.locator("#bg-color").count() === 1, "a colour behind: its colour control shows");
await page.locator("#bg-invert").check(); await sleep(300);
check(await page.locator("#bg-invert").isChecked(), "invert stays on");
await page.locator("#bg-on").uncheck(); await sleep(400);
check(await page.locator("#bg-edge").count() === 0, "turned off: the sliders go");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
