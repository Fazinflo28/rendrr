// Phase 12b in the editor: the transition menu offers the new transitions (with a direction for push, wipe and barn
// doors), and the Color tab adds glow, grain, RGB split, camera shake, mirror and corner pin (its corners set).
//
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/effects12.mjs   (from apps/web)
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
await page.locator(".clip.video").nth(1).click(); await sleep(300);
await page.locator("#tab-clip").click(); await page.locator("#transition-type").waitFor();
const opts = await page.locator("#transition-type option").evaluateAll((os) => os.map((o) => o.textContent));
for (const n of ["Push", "Wipe", "Iris round", "Cross zoom", "Film dissolve", "Clock wipe", "Barn doors", "Iris diamond"]) check(opts.includes(n), `the menu offers ${n}`);
await page.locator("#transition-type").selectOption("wipe"); await sleep(300);
check(await page.locator("#transition-dir").count() === 1, "a wipe has a direction");
await page.locator("#transition-dir").selectOption("up"); await sleep(250);
check(await page.locator("#transition-dir").inputValue() === "up", "wipe up");
await page.locator("#transition-type").selectOption("iris"); await sleep(250);
check(await page.locator("#transition-dir").count() === 0, "an iris has none");
// The Color tab: the new effects.
await page.locator("#tool-back").click(); await sleep(200);
await page.locator("#tab-color").click(); await page.locator("#fx-add-glow").waitFor();
for (const t of ["glow", "grain", "rgbsplit", "pin"]) { await page.locator("#fx-add-" + t).click(); await sleep(200); }
const names = await page.locator("[data-effect] .t-small").evaluateAll((es) => es.map((e) => e.textContent));
// Phase 19: glow, grain and RGB split are shown live too; only the corner pin is marked as drawn in the render.
check(["Glow", "Grain", "RGB split"].every((n) => names.some((x) => x.startsWith(n) && !x.includes("(in the render)"))) && names.some((x) => x.startsWith("Corner pin") && x.includes("(in the render)")), `added; only the corner pin is marked as drawn in the render (${names.filter((x) => x.includes("render")).length})`);
check(await page.locator("#fx-add-shake").isDisabled(), "four effects at most");
check(await page.locator('[id^="fx-pin-"][id$="-0-x"]').count() === 1, "the corner pin's corners have sliders");
const pinId = await page.locator('[id^="fx-pin-"][id$="-0-x"]').getAttribute("id");
const el = page.locator("#" + pinId); await el.focus(); for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight"); await el.blur(); await sleep(250);
check((await page.locator(`[data-val="${pinId}"]`).textContent()) === "15%", "top left corner moved to 15% across");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
