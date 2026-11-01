// Windows on a phone and a computer: drawn over the whole app (not inside the page, where on iPhones the top bar and
// the tab bar covered them), a small one (New project, a folder name) in the middle of the screen with its button
// uncovered, a big one (Add footage) a sheet from the bottom; on a computer the backdrop covers the whole window.
// Runs on the demo build (node demo/build.mjs first).   node demo/modal-phone.mjs   (from apps/web)
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

for (const [label, viewport, phone] of [["iPhone 390", { width: 390, height: 844 }, true], ["small phone 360", { width: 360, height: 640 }, true], ["desktop", { width: 1440, height: 900 }, false]]) {
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await page.waitForTimeout(100); } };
  await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.waitForTimeout(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
  // What sits on top at the middle of an element (the element itself, or something inside it).
  const onTop = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && (at === el || el.contains(at)); }, sel);
  const small = async (what, okSel) => {
    await page.locator(".modal").waitFor();
    const r = await page.evaluate(() => { const m = document.querySelector(".modal"), s = m.closest(".scrim"); const b = m.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, inPage: !!m.closest(".main"), parent: s.parentElement.id, vvh: s.style.getPropertyValue("--vvh") }; });
    const mid = (r.top + r.bottom) / 2;
    check(!r.inPage && r.parent === "root", `${label}, ${what}: drawn over the whole app, not inside the page`);
    check(r.top >= 0 && r.bottom <= viewport.height && r.left >= 0 && r.right <= viewport.width + 1, `${label}, ${what}: fits the screen`);
    check(Math.abs(mid - viewport.height / 2) < 40, `${label}, ${what}: in the middle (centre ${Math.round(mid)} of ${viewport.height / 2})`);
    check(await onTop(okSel), `${label}, ${what}: its button is not covered by the tab bar or anything else`);
    check(await onTop(".modal input"), `${label}, ${what}: its name box is not covered`);
    if (phone) check(!!r.vvh, `${label}, ${what}: it follows the space the keyboard leaves (${r.vvh})`);
  };

  await page.locator("#new-project").click(); await small("New project", "#create-folder");
  await page.locator("#fname").fill("BFS Health & Performance");
  await page.screenshot({ path: join(here, "dist", `modal-new-project-${label.split(" ")[0]}.png`) });
  if (!phone) {
    const covers = await page.evaluate(() => { const a = document.elementFromPoint(3, innerHeight - 3), b = document.elementFromPoint(innerWidth - 3, 3); return !!a?.closest(".scrim") && !!b?.closest(".scrim"); });
    check(covers, `${label}: the backdrop covers the whole window, corner to corner`);
  }
  await page.locator("#create-folder").click();
  check(await until(async () => !(await page.locator(".modal").count())), `${label}: Create project works and the window closes`);

  // A folder name in the Library.
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.locator(".vcard").first().waitFor();
  await page.locator("#new-folder").click(); await small("New folder", "#folder-save");
  await page.locator("#folder-name-input").fill("Interviews"); await page.locator("#folder-save").click();
  check(await until(async () => !(await page.locator(".modal").count())), `${label}: Make folder works`);

  // A big window stays a sheet from the bottom on a phone.
  if (phone) {
    await page.locator('[data-mtab="Add"]').click(); await page.locator(".modal.wide").waitFor(); await page.waitForTimeout(400);
    const b = await page.locator(".modal.wide").boundingBox();
    check(Math.abs(b.y + b.height - viewport.height) < 2 && b.width >= viewport.width - 1, `${label}: Add footage is a sheet from the bottom, full width`);
    check(await page.evaluate(() => { const m = document.querySelector(".modal.wide").getBoundingClientRect(); const at = document.elementFromPoint(m.left + m.width / 2, m.bottom - 10); return !at?.closest(".mnav"); }), `${label}: the tab bar is not over the sheet`);
    await page.keyboard.press("Escape");
  }
  check(errors.length === 0, `${label}: no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  await ctx.close();
}
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
