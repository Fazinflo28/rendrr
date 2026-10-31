// Phase 7 in the editor: a V1 clip's Speed & motion page turns Warp Stabilizer on, sets its smoothness and turns it off.
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/stabilize.mjs   (from apps/web)
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], warns = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") warns.push(m.text()); });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator(".clip.video").first().click(); await sleep(300);
await page.locator("#tab-clip").click(); await page.locator("#stabilize-panel").waitFor();
check(!(await page.locator("#clip-stabilize").isChecked()) && (await page.locator("#clip-stabilize-smooth").count()) === 0, "a clip starts as filmed");
await page.locator("#clip-stabilize").check(); await page.locator("#clip-stabilize-smooth").waitFor({ timeout: 4000 });
check((await page.locator('[data-val="clip-stabilize-smooth"]').textContent()) === "50", "on: smoothness 50");
await page.evaluate(() => { const el = document.getElementById("clip-stabilize-smooth"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); set.call(el, "80"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
await sleep(300);
check((await page.locator('[data-val="clip-stabilize-smooth"]').textContent()) === "80", "smoothness changes");
check(/player shows the footage as filmed/.test(await page.locator("#stabilize-panel").textContent()), "it says the player shows the footage as filmed");
await page.locator("#clip-stabilize").uncheck(); await sleep(300);
check((await page.locator("#clip-stabilize-smooth").count()) === 0, "off: as filmed again");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
