// In the Mac app, the web app tells Rendrr the app is open, and saves each final the AI exported to this Mac
// (Downloads) as soon as it is done; a failed one is said. Each final is saved once. Runs on the demo build
// (node demo/build.mjs first).   node demo/mac-export.mjs   (from apps/web)
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
const until = async (f, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => {
  // Pretend to be the Mac app once signed in (the login form stays the browser's).
  Object.defineProperty(window, "rendrrDesktop", { configurable: true, get: () => (globalThis.__pretendMac ? { app: "mac", version: "0.1.7" } : null) });
  window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };
  globalThis.__demoMacExports = [
    { renderId: "r1", fileName: "Promo final v3.mp4", url: "https://files.example/promo-v3.mp4" },
    { renderId: "r2", fileName: "Ad 2 final v1.mp4" },
    { renderId: "r3", fileName: "Ad 3 final v1.mp4", failed: "The render ran out of time." },
  ];
});
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
check(await page.evaluate(() => globalThis.__demoMacPings || 0) === 0, "in a browser (not the Mac app) nothing is sent");
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x");
await page.evaluate(() => { globalThis.__pretendMac = true; });
await page.locator('button[type="submit"]').first().click();
check(await until(async () => (await page.evaluate(() => globalThis.__demoMacPings || 0)) >= 1), "signed in in the Mac app: it tells Rendrr the app is open");
check(await until(async () => (await page.evaluate(() => window.__opened.length)) === 1), "a finished export is saved (handed to the app's Downloads)");
check((await page.evaluate(() => window.__opened[0])) === "https://files.example/promo-v3.mp4", "the final's own file");
check(await until(async () => (await page.locator(".toast", { hasText: "saving to Downloads" }).count()) > 0), "it says it is saving to Downloads");
check(await until(async () => (await page.locator(".toast", { hasText: "did not finish" }).count()) > 0), "a failed export is said");
const left = await page.evaluate(() => globalThis.__demoMacExports.map((x) => x.renderId));
check(left.length === 1 && left[0] === "r2", `the one still rendering waits for the next look (${left.join(",")})`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
