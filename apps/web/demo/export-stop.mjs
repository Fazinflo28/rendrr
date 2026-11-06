// The export window while it exports: only the bar (with its percent and time left) and "Stop export"; no list of
// steps, no explanation. Stop export ends the export: the button says Stopping…, the window closes, a toast says it
// stopped, and the edit is not marked as having a final. (p6: footage from Drive, so no original to upload first.) Runs on the demo build (node demo/build.mjs first).
//   node demo/export-stop.mjs   (from apps/web)
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

for (const [label, viewport, phone] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await page.waitForTimeout(100); } };
  await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(600);
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.waitForTimeout(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p6")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(800);
  const startFinal = async () => {
    await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
    await page.locator("#export-render").click();
    await page.locator("#export-run").waitFor({ timeout: 5000 });
  };

  await startFinal();
  const modal = page.locator(".modal").filter({ has: page.locator("#export-run") });
  await until(async () => /\d+%/.test(await page.locator("#render-eta").innerText()));
  const text = await modal.innerText();
  check(await modal.locator(".bar").count() === 1, `${label}: the export bar shows`);
  check(await page.locator("#stop-export").isVisible() && /Stop export/.test(await page.locator("#stop-export").innerText()), `${label}: with a Stop export button`);
  check(await modal.locator(".steps, .step").count() === 0, `${label}: no list of steps`);
  check(!/Fetching|Reading timeline|Cutting clips|Burning captions|Encoding|We fetch|takes a little longer/.test(text), `${label}: no step names or explanation (${text.replace(/\s+/g, " ").slice(0, 80)})`);
  check(/\d+% · /.test(await page.locator("#render-eta").innerText()), `${label}: percent and time left by the bar`);
  if (!phone) await modal.screenshot({ path: join(here, "dist", "export-window.png") });

  await page.locator("#stop-export").click();
  check(/Stopping/.test(await page.locator("#stop-export").innerText().catch(() => "")) || (await page.locator("#export-run").count()) === 0, `${label}: the button says Stopping…`);
  check(await until(async () => (await page.locator("#export-run").count()) === 0), `${label}: the window closes`);
  check(await until(async () => /Export stopped/.test(await page.locator(".toast, [role=status]").allInnerTexts().then((t) => t.join(" ")).catch(() => ""))), `${label}: a toast says the export stopped`);
  check(await page.evaluate(() => globalThis.__stopped) === 1, `${label}: the server was asked to stop it once`);
  await page.waitForTimeout(2500);
  check(await page.locator("#render-done").count() === 0, `${label}: no final appears after stopping`);

  // An export left alone still finishes.
  await startFinal();
  check(await until(async () => (await page.locator("#render-done").count()) === 1, 20000), `${label}: an export not stopped finishes`);
  check(errors.length === 0, `${label}: no page errors` + (errors.length ? ": " + errors.join(" | ") : ""));
  await ctx.close();
}
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
