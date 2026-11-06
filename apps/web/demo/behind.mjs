// Phase 2's controls: "Behind the person" on a text layer (Edit > Text & captions) and on the selected text or graphic
// in Edit > Speed & motion. Ticking it in one shows it ticked in the other (one behind_person / set_text behind on the
// clip); unticking brings it in front again. Runs on the demo build.
//   node demo/behind.mjs   (from apps/web)
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
check(await page.locator("#text-behind").count() === 1, "a new text layer has a Behind the person switch");
check(!(await page.locator("#text-behind").isChecked()), "it starts in front");
await page.locator("#text-behind").check(); await sleep(500);
check(await page.locator("#text-behind").isChecked(), "ticked: it stays behind the person");
// The same clip in Speed & motion shows it.
await page.locator("#tool-back").click({ timeout: 800 }).catch(() => {}); await sleep(200);
check(await page.locator("#clip-behind").count() === 1, "Speed & motion shows the switch for the selected text");
check(await page.locator("#clip-behind").isChecked(), "and it is ticked there too");
await page.locator("#clip-behind").uncheck(); await sleep(500);
check(!(await page.locator("#clip-behind").isChecked()), "unticked: in front again");
await page.locator("#tool-back").click({ timeout: 800 }).catch(() => {}); await sleep(200);
await page.locator("#tab-text").click(); await sleep(300);
check(!(await page.locator("#text-behind").isChecked()), "the Text tab agrees");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
