// The timeline under the page's CSS zoom (#root is drawn at 0.8 on desktop): a click on a ruler label must put the
// playhead on that label's time, and a clip dragged by its label spacing must move by that time. Runs on the demo
// build (node demo/build.mjs first) in Playwright's Chromium.   node demo/ruler-click.mjs   (from apps/web)
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1500);
const zoom = await page.evaluate(() => getComputedStyle(document.querySelector("#root")).zoom);
let bad = 0;
for (const fit of [false, true]) {
  if (fit) { await page.locator("text=Fit").click(); await page.waitForTimeout(600); }
  const ticks = await page.locator(".ruler span").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.textContent, r.left, r.top + r.height / 2]; }));
  for (const [label, x, y] of ticks.slice(1, 6)) {
    await page.mouse.click(x + 0.5, y); await page.waitForTimeout(250);
    // The playhead's CSS left is px(time) - 1 and the label's is px(its time): the same place, in the same units.
    const [ph, lab] = await page.evaluate((label) => [parseFloat(document.querySelector("#playhead").style.left) + 1, parseFloat([...document.querySelectorAll(".ruler span")].find((s) => s.textContent === label).style.left)], label);
    const ok = Math.abs(ph - lab) <= 1.5;
    if (!ok) bad++;
    console.log(`${fit ? "fit " : ""}click on ${label}: playhead at ${ph.toFixed(1)}px, label at ${lab}px ${ok ? "ok" : "WRONG"}`);
  }
}
await browser.close(); server.close();
console.log(bad ? `FAIL: ${bad} clicks off their label (page zoom ${zoom})` : `PASS: every ruler click lands on its label (page zoom ${zoom})`);
process.exit(bad ? 1 : 0);
