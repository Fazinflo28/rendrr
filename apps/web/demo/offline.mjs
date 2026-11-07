// No internet: the whole window shows the Rendrr icon and "You're offline" (as the Mac app's offline page does), and
// it goes away by itself when the connection is back, leaving the page as it was. Runs on the demo build
// (node demo/build.mjs first).   node demo/offline.mjs   (from apps/web)
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
const shot = process.argv[2];

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${server.address().port}/`); await page.locator(".gcard").first().waitFor(); await sleep(500);
check(await page.locator("#offline").count() === 0, "online: no offline screen");
await ctx.setOffline(true); await sleep(400);
check(await page.locator("#offline").isVisible(), "the connection drops: the offline screen covers the window");
check(/You're offline/.test(await page.locator("#offline").innerText()), "it says You're offline");
check(await page.locator("#offline .offline-tile svg").count() === 1, "with the Rendrr icon");
if (shot) await page.screenshot({ path: shot });
await ctx.setOffline(false); await sleep(400);
check(await page.locator("#offline").count() === 0 && await page.locator(".gcard").first().isVisible(), "back online: it goes away and the page is as it was");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
