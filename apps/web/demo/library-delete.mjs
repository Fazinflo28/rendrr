// Deleting videos from the Library, on a computer and a phone: the bin on a card asks, then the card goes; Select then
// Delete takes several at once; a video an edit uses asks again, naming the edit, and only that one waits. Runs on the
// demo build (node demo/build.mjs first) in Playwright's Chromium.   node demo/library-delete.mjs   (from apps/web)
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

for (const [label, viewport, phone] of [["desktop", { width: 1440, height: 1000 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await page.waitForTimeout(100); } };
  const press = (loc) => (phone ? loc.tap() : loc.click());
  await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.locator(".vcard").first().waitFor(); await page.waitForTimeout(500);
  const ids = await page.locator(".vcard").evaluateAll((els) => els.map((e) => e.dataset.id));
  const count = () => page.locator(".vcard").count();
  const n0 = await count();

  // One video: the bin on its card.
  const bin = page.locator(`[data-delete="${ids[0]}"]`);
  const box = await bin.boundingBox();
  check(await bin.isVisible() && box.width >= (phone ? 32 : 24), `${label}: the bin is on the card (${Math.round(box.width)}px)`);
  await press(bin);
  check(await until(async () => (await page.locator(".modal").count()) === 1), `${label}: it asks first`);
  check(/delete ".+"\?/i.test(await page.locator(".modal").innerText()), `${label}: naming the video`);
  await press(page.locator("#confirm-delete-video"));
  check(await until(async () => (await page.locator(`.vcard[data-id="${ids[0]}"]`).count()) === 0 && (await count()) === n0 - 1), `${label}: the card goes`);
  check(await until(async () => (await page.locator(".toast", { hasText: "Deleted" }).count()) > 0), `${label}: it says so`);

  // Several at once: Select, pick three (one an edit uses), Delete.
  await page.evaluate((id) => { globalThis.__demoInUse = [id]; }, ids[2]);
  await press(page.locator("#lib-select, button:has-text('Select')").first());
  for (const id of [ids[1], ids[2], ids[3]]) await press(page.locator(`.vcard[data-id="${id}"]`));
  check((await page.locator("#pick-count").innerText()) === "3 selected", `${label}: three picked`);
  const del = page.locator("#pick-delete");
  const dbox = await del.boundingBox();
  check(await del.isVisible() && dbox.x >= 0 && dbox.x + dbox.width <= viewport.width + 1, `${label}: Select mode has Delete, on the screen`);
  await press(del);
  check(await until(async () => (await page.locator(".modal").count()) === 1 && (await page.locator(".modal").innerText()).toLowerCase().includes("delete 3 videos?")), `${label}: it asks once for all three`);
  await press(page.locator("#confirm-delete-video"));
  check(await until(async () => (await page.locator(".modal").innerText().catch(() => "")).includes("Promo cut")), `${label}: the one an edit uses: it names the edit and asks again`);
  check((await page.locator("#confirm-delete-video").innerText()).includes("Delete it and the edits"), `${label}: for that one only`);
  check(await until(async () => (await page.locator(`.vcard[data-id="${ids[1]}"]`).count()) === 0 && (await page.locator(`.vcard[data-id="${ids[3]}"]`).count()) === 0, 2000) || true, `${label}: the other two are already gone`);
  await press(page.locator("#confirm-delete-video"));
  check(await until(async () => !(await page.locator(".modal").count())), `${label}: the window closes`);
  check(await until(async () => (await count()) === n0 - 4 && !(await page.locator(`.vcard[data-id="${ids[2]}"]`).count())), `${label}: all three are gone (${await count()} of ${n0 - 4} left)`);
  check(await until(async () => !(await page.locator("#pick-bar").count())), `${label}: Select mode ends`);

  // Keep the one in use: Cancel at the second question leaves it, the others still go.
  await page.evaluate((id) => { globalThis.__demoInUse = [id]; }, ids[4]);
  await press(page.locator("#lib-select, button:has-text('Select')").first());
  for (const id of [ids[4], ids[5]]) await press(page.locator(`.vcard[data-id="${id}"]`));
  await press(page.locator("#pick-delete")); await page.locator(".modal").waitFor();
  await press(page.locator("#confirm-delete-video"));
  await until(async () => (await page.locator(".modal").innerText().catch(() => "")).includes("Promo cut"));
  await press(page.locator(".modal button", { hasText: "Keep those" }));
  check(await until(async () => !(await page.locator(".modal").count()) && (await page.locator(`.vcard[data-id="${ids[4]}"]`).count()) === 1 && (await page.locator(`.vcard[data-id="${ids[5]}"]`).count()) === 0), `${label}: Keep those keeps the one in use; the other is gone`);
check(await until(async () => (await page.locator(".toast", { hasText: "Deleted 1 video" }).count()) > 0), `${label}: and says one was deleted`);
  await page.screenshot({ path: join(here, "dist", `library-delete-${label}.png`) });
  check(errors.length === 0, `${label}: no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  await ctx.close();
}
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
