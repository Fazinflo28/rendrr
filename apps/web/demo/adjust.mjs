// Phase 9 in the editor: the Color tab with no clip selected lists adjustment layers; "+ Adjustment layer here" puts
// one on V3 at the playhead and opens it; its sliders change it (the player previews it as a backdrop filter over the
// picture, under the text); Remove takes it away.
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/adjust.mjs   (from apps/web)
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

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator("#tab-color").click(); await page.locator("#adjust-list").waitFor();
const v3Before = await page.locator('.clip[data-track="v3"]').count().catch(() => 0);
check(await page.locator("[data-adjust-item]").count() === 0, "no adjustment layers yet");
await page.locator("#adjust-add").click(); await page.locator("#adjust-panel").waitFor({ timeout: 3000 }).catch(() => {});
check(await page.locator("#adjust-panel").count() === 1, "+ Adjustment layer here opens the new layer");
const v3After = await page.locator('.clip[data-track="v3"]').count().catch(() => 0);
check(v3After === v3Before + 1, `a clip on V3 (${v3Before} -> ${v3After})`);
// Drag the exposure slider down with the keyboard: live, one undo step.
const exp = page.locator("#adjust-exposure");
await exp.focus(); for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowLeft"); await page.keyboard.up("ArrowLeft"); await exp.blur(); await sleep(400);
const shown = await page.locator('[data-val="adjust-exposure"]').textContent();
check(/^-1\.00 stops$/.test(shown), `exposure set: ${shown}`);
const sat = page.locator("#adjust-saturation");
await sat.focus(); for (let i = 0; i < 50; i++) await page.keyboard.press("ArrowLeft"); await sat.blur(); await sleep(400);
const blur = page.locator("#adjust-blur");
await blur.focus(); for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight"); await blur.blur(); await sleep(400);
// The player previews it while the playhead is inside it (it starts at the playhead).
const f = await page.evaluate(() => { const el = document.querySelector("[data-adjust]"); return el ? getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter : null; });
check(!!f && /brightness\(0\.73\d*\)/.test(f) && /saturate\(0\.5\)/.test(f) && /blur\(/.test(f), `the player previews it: ${f}`);
// The preview sits under the text layers (it is drawn before them).
const order = await page.evaluate(() => { const a = document.querySelector("[data-adjust]"); if (!a) return null; const after = []; let n = a.nextElementSibling; while (n) { after.push(n.className || n.tagName); n = n.nextElementSibling; } return after.length; });
check(order !== null, "the preview is in the player's overlay");
// Picked on the timeline: the Color page opens it; the Clip tab says where to change it.
await page.locator("#adjust-back").click(); await page.locator("[data-adjust-item]").first().waitFor();
const adjId = await page.locator("[data-adjust-item]").first().getAttribute("data-adjust-item");
const adjClip = page.locator(`.clip[data-clip="${adjId}"]`);
await adjClip.scrollIntoViewIfNeeded(); await adjClip.click(); await sleep(300);
check(await page.locator("#adjust-panel").count() === 1, "picked on V3, the Color page opens the layer");
await page.locator("#tool-back").click(); await sleep(200);
await page.locator("#tab-clip").click(); await sleep(300);
check((await page.locator("#adjust-hint").textContent().catch(() => "")).includes("Color tab"), "the Clip tab points to the Color tab");
await page.locator("#tool-back").click(); await sleep(200);
await page.locator("#tab-color").click(); await page.locator("#adjust-panel").waitFor({ timeout: 3000 }).catch(() => {});
// Back to the whole edit: it is listed; open it again from the list.
await page.locator("#adjust-back").click(); await page.locator("#adjust-list").waitFor();
check(await page.locator("[data-adjust-item]").count() === 1, "listed in the whole-edit panel");
await page.locator("[data-adjust-item]").first().click(); await page.locator("#adjust-panel").waitFor();
check(/^-1\.00 stops$/.test(await page.locator('[data-val="adjust-exposure"]').textContent()), "opened again with its exposure");
await page.locator("#adjust-delete").click(); await sleep(400);
check(await page.locator("[data-adjust-item]").count() === 0 && await page.locator("[data-adjust]").count() === 0, "removed: gone from the list and the player");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
