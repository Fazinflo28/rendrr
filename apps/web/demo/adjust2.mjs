// Phase 16 in the editor: an adjustment layer's strength, fades and masks. Strength sets the player's preview opacity;
// a fade in makes it start from nothing at the layer's start; a mask (+ Ellipse) limits the preview to the shape (a CSS
// mask picture) and is outlined on the player; invert and remove work.
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/adjust2.mjs   (from apps/web)
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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(100); } return v; };
const keys = async (id, key, n) => { const el = page.locator("#" + id); await el.focus(); for (let i = 0; i < n; i++) await page.keyboard.press(key); await el.blur(); await sleep(300); };
const layer = () => page.evaluate(() => { const el = document.querySelector("[data-adjust]"); if (!el) return null; const cs = getComputedStyle(el); return { strength: el.dataset.strength, masked: el.dataset.masked || null, opacity: cs.opacity, mask: cs.maskImage || cs.webkitMaskImage || "" }; });

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator("#tab-color").click(); await page.locator("#adjust-list").waitFor();
await page.locator("#adjust-add").click(); await page.locator("#adjust-panel").waitFor({ timeout: 3000 });
await keys("adjust-exposure", "ArrowLeft", 20);
check(await page.locator("#adjust-where").count() === 1, "the layer page has Strength and fades, and Masks");
check(((await page.locator("#adjust-mask-note").textContent()) || "").includes("whole frame"), "no masks: on the whole frame");
let l = await layer();
check(l && l.strength === "1.000" && l.opacity === "1" && !l.masked, `full strength, no mask at first (${JSON.stringify(l)})`);

// Strength: 60%.
await keys("adjust-opacity", "ArrowLeft", 40);
check((await page.locator('[data-val="adjust-opacity"]').textContent()) === "60%", "strength slider at 60%");
l = await until(async () => { const x = await layer(); return x?.strength === "0.600" ? x : null; });
check(l && l.strength === "0.600" && Math.abs(Number(l.opacity) - 0.6) < 1e-3, `the preview at 60% (${JSON.stringify(l)})`);

// A fade in: at the layer's start (the playhead) it is at nothing; taken off, back to 60%.
await keys("adjust-fadein", "ArrowRight", 5);
check((await page.locator('[data-val="adjust-fadein"]').textContent()) === "0.5 s", "fade in 0.5 s");
l = await until(async () => { const x = await layer(); return x?.strength === "0.000" ? x : null; });
check(l?.strength === "0.000", `at the layer's start a fade in starts from nothing (${l?.strength})`);
await keys("adjust-fadein", "ArrowLeft", 5);
l = await until(async () => { const x = await layer(); return x?.strength === "0.600" ? x : null; });
check(l?.strength === "0.600", "fade off: 60% again");

// A mask: + Ellipse limits the preview to it and outlines it on the player.
await page.locator("#adjust-mask-ellipse").click(); await sleep(400);
check(await page.locator("[data-adjust-mask]").count() === 1, "an ellipse mask added");
l = await until(async () => { const x = await layer(); return x?.masked ? x : null; });
check(l?.masked === "1" && /url\(/.test(l.mask), `the preview is masked (${(l?.mask || "").slice(0, 40)}…)`);
check(await page.locator("#mask-overlay ellipse").count() === 1, "the ellipse is outlined on the player");
// The mask picture: inside the ellipse opaque, its corner clear.
const px = await page.evaluate(async () => {
  const el = document.querySelector("[data-adjust]"); const u = (getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage).match(/url\("?(.*?)"?\)/)[1];
  const img = new Image(); img.src = u; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  return [x.getImageData(Math.round(img.width / 2), Math.round(img.height / 2), 1, 1).data[3], x.getImageData(1, 1, 1, 1).data[3]];
});
check(px[0] > 250 && px[1] < 5, `mask picture: middle ${px[0]}, corner ${px[1]}`);
const before = (await layer()).mask;
await keys("adjust-mask-0-w", "ArrowLeft", 20); await sleep(200);
check((await layer()).mask !== before, "narrower: the mask picture changes");
await page.locator("#adjust-mask-0-invert").check(); await sleep(400);
const inv = await page.evaluate(async () => {
  const el = document.querySelector("[data-adjust]"); const u = (getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage).match(/url\("?(.*?)"?\)/)[1];
  const img = new Image(); img.src = u; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  return [x.getImageData(Math.round(img.width / 2), Math.round(img.height / 2), 1, 1).data[3], x.getImageData(1, 1, 1, 1).data[3]];
});
check(inv[0] < 5 && inv[1] > 250, `inverted: middle ${inv[0]}, corner ${inv[1]}`);
check(await page.locator("#mask-overlay ellipse").evaluate((e) => e.style.strokeDasharray !== "" && e.style.strokeDasharray !== "none"), "inverted outline is dashed");
await page.locator("#adjust-mask-del-0").click(); await sleep(400);
l = await layer();
check(!l.masked && await page.locator("[data-adjust-mask]").count() === 0, "mask removed: the whole frame again");

// Kept when the layer is opened again.
await page.locator("#adjust-back").click(); await page.locator("[data-adjust-item]").first().click(); await page.locator("#adjust-panel").waitFor();
check((await page.locator('[data-val="adjust-opacity"]').textContent()) === "60%", "opened again: 60% strength kept");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
