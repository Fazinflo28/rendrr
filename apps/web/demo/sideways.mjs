// Footage filmed sideways, in the browser: when Rendrr measured the footage as sideways (faces upright when turned),
// the editor offers to turn it; nothing turns until the user clicks, "Keep as is" hides the offer, and once the
// clips are turned the offer goes away. Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/sideways.mjs   (from apps/web)
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }

// 1. Upright footage: no offer.
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1200);
check(!(await page.locator("#sideways").count()), "upright footage: no offer");

// 2. Footage measured sideways: the offer, and nothing turned yet.
await page.evaluate(() => { globalThis.__rendrrDemoSideways = 90; globalThis.__rendrrNav.go("/library"); }); await page.waitForTimeout(400);
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1200);
check(await page.locator("#sideways").isVisible(), "sideways footage: the editor offers to turn it");
check((await page.locator("#sideways").textContent()).includes("turned 90° clockwise"), "it says which way");
check(!(await page.locator("#rotate").getAttribute("data-tip")).includes("(now"), "nothing is turned before the user clicks");

// 3. Keep as is hides it; Turn it upright turns every clip of that footage and the offer goes away.
await page.getByRole("button", { name: "Keep as is" }).click(); await page.waitForTimeout(200);
check(!(await page.locator("#sideways").count()), "Keep as is hides the offer");
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(400);
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1200);
await page.locator("#turn-upright").click(); await page.waitForTimeout(400);
check(!(await page.locator("#sideways").count()), "after turning, the offer is gone");
check((await page.locator("#rotate").getAttribute("data-tip")).includes("(now 90°)"), `the footage is turned 90° (${await page.locator("#rotate").getAttribute("data-tip")})`);

check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
