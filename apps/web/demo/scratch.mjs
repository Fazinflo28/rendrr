// The New edit window starts an edit from footage or from scratch (no footage: a blank canvas of a length, shape and
// colour, built on with animations, text and music). Runs on the demo build (node demo/build.mjs first).
//   node demo/scratch.mjs   (from apps/web)
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
for (const [w, h, tag] of [[1440, 1000, "desktop"], [390, 844, "phone"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects/f2")); await page.waitForTimeout(800);
  await page.locator("#new-edit").click(); await page.waitForTimeout(400);
  const modal = page.locator(".modal").first();
  check((await modal.innerText()).includes("Tick one video"), `${tag}: from footage by default`);
  await modal.getByRole("tab", { name: "From scratch" }).click(); await page.waitForTimeout(300);
  check(!(await modal.innerText()).includes("Tick one video"), `${tag}: from scratch hides the footage list`);
  check(await page.locator("input#np-seconds").count() === 1 && await page.locator("input#np-color").count() === 1 && await modal.getByRole("tab", { name: "4:5" }).count() === 1, `${tag}: length, shape and colour`);
  check((await page.locator("#create-project").innerText()).includes("Create blank edit") && !(await page.locator("#create-project").isDisabled()), `${tag}: Create blank edit, ready without footage`);
  const box = await page.locator(".modal").first().boundingBox().catch(() => null);
  check(!box || box.width <= w, `${tag}: the window fits the screen`);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/scratch-${tag}.png` });
  check(!errors.length, `${tag}: no page errors` + (errors.length ? ": " + errors.join("; ") : ""));
  await page.close();
}
await browser.close(); server.close();
console.log(fails.length ? `FAIL: ${fails.length}` : "PASS: from scratch in the New edit window");
process.exit(fails.length ? 1 : 0);
