// Phase 2b's control: "Inside the letters" on a text layer (Edit > Text & captions). A video: a library video plays in
// the letters, and the video and its start can be changed; cut out of
// the card: the layer gets a card and the player cuts the letters out of it; their colour: back to plain letters.
// Runs on the demo build.
//   node demo/inside.mjs   (from apps/web)
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
await page.locator("#tab-text").click(); await sleep(300);
await page.locator("#add-text-title").click(); await sleep(500);
const mode = page.locator("#text-inside-mode");
check(await mode.count() === 1, "a new text layer has an Inside the letters choice");
check(await mode.inputValue() === "color", "it starts with the letters' own colour");
const videoOpt = page.locator('#text-inside-mode option[value="video"]');
check(!(await videoOpt.isDisabled()), "a video can be picked (the library has ready videos)");
await mode.selectOption("video"); await sleep(800);
check(await mode.inputValue() === "video", "picked: a video inside");
const vids = await page.locator("#text-inside-video option").count();
check(vids >= 1, `the video list shows the library's ready videos (${vids})`);
await page.locator("#text-inside-from").fill("1.5"); await page.locator("#text-inside-from").press("Tab"); await sleep(500);
check(await page.locator("#text-inside-from").inputValue() === "1.5", "its start in the video can be set");
// The demo's library videos have no playable copy: the player keeps the plain letters, as a render would without the
// video (the drawing itself is checked against the render in inside-match.mjs).
check(await page.locator("canvas[data-matte]").count() === 0, "no playable copy of that video here: plain letters, nothing half drawn");
await mode.selectOption("cutout"); await sleep(600);
check(await mode.inputValue() === "cutout", "cut out of the card");
check(await page.locator("#txt-card").isChecked(), "it gets a card (the letters are cut out of it)");
check(await page.locator("#text-inside-video").count() === 0, "no video choice for a cut-out");
check(await page.locator("canvas[data-matte]").count() === 1, "the player cuts the letters out of the card");
await mode.selectOption("color"); await sleep(600);
check(await mode.inputValue() === "color", "back to their colour");
check(await page.locator("canvas[data-matte]").count() === 0, "plain letters again in the player");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
