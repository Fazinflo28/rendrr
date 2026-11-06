// Screenshots of every main screen on a computer and a phone (for a look over by eye), plus page errors and how far
// things move while a page loads (layout shift). Runs on the demo build.   node demo/shots.mjs <out dir> [routes...]
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const out = process.argv[2] || "/tmp/shots"; mkdirSync(out, { recursive: true });
const routes = process.argv.slice(3).length ? process.argv.slice(3) : ["/explore", "/projects", "/projects/f1", "/library", "/library/v1", "/usage", "/billing", "/settings", "/connect", "/editor/p1"];
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const report = [];
for (const [label, viewport, phone] of [["d", { width: 1440, height: 900 }, false], ["m", { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
  for (const r of routes) {
    await page.evaluate(() => { globalThis.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) globalThis.__cls += e.value; }).observe({ type: "layout-shift", buffered: false }); } catch {} });
    await page.evaluate((p) => globalThis.__rendrrNav.go(p), r);
    await page.waitForTimeout(120); const name = `${label}${r.replace(/\//g, "-")}`;
    await page.screenshot({ path: join(out, `${name}-early.png`) });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const cls = await page.evaluate(() => globalThis.__cls || 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    report.push(`${name}: shift ${cls.toFixed(3)}${overflow ? " HORIZONTAL OVERFLOW" : ""}`);
  }
  if (errors.length) report.push(`${label} errors: ${[...new Set(errors)].slice(0, 6).join(" | ")}`);
  await ctx.close();
}
console.log(report.join("\n"));
await browser.close(); server.close();
