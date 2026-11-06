// Phase 11 in the editor: the Clip tab flips, crops, rounds and shadows a clip (V1 and b-roll), sets slow motion's
// frames, the ramp easing, the anchor point and motion blur (b-roll's card and shadow: shared and render tests).
//
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/phase11.mjs   (from apps/web)
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
await page.locator(".clip.video").first().click(); await sleep(300);
await page.locator("#frame-look").waitFor();
await page.locator("#flip-h").click(); await sleep(300);
check(await page.locator("#flip-h").getAttribute("aria-pressed") === "true", "Flip ↔ on");
await page.locator("#flip-v").click(); await sleep(300);
check(await page.locator("#flip-v").getAttribute("aria-pressed") === "true" && await page.locator("#flip-h").getAttribute("aria-pressed") === "true", "both ways");
await page.locator("#flip-h").click(); await page.locator("#flip-v").click(); await sleep(300);
check(await page.locator("#flip-v").getAttribute("aria-pressed") === "false" && await page.locator("#flip-h").getAttribute("aria-pressed") === "false", "back to as filmed");
const slide = async (id, n, key = "ArrowRight") => { const el = page.locator("#" + id); await el.focus(); for (let i = 0; i < n; i++) await page.keyboard.press(key); await el.blur(); await sleep(250); };
await slide("crop-left", 10);
check((await page.locator('[data-val="crop-left"]').textContent()) === "10%", "crop left 10%");
await slide("card-radius", 8);
check((await page.locator('[data-val="card-radius"]').textContent()) === "8%", "rounded corners 8%");
await page.locator("#card-shadow").check(); await sleep(250);
check(await page.locator("#card-shadow-opacity").count() === 1, "drop shadow on, its strength shown");
// Slow motion frames and ramp easing.
await page.locator("#clip-interp").selectOption("flow"); await sleep(250);
check(await page.locator("#clip-interp").inputValue() === "flow" && await page.locator("#interp-note").count() === 1, "optical flow chosen, the note says the render makes the frames");
await page.locator("#ramp-add").click(); await sleep(250);
check(await page.locator("#ramp-ease").count() === 1, "ramp easing offered once the clip has a ramp");
await page.locator("#ramp-ease").selectOption("in-out"); await sleep(250);
check(await page.locator("#ramp-ease").inputValue() === "in-out", "ramp eased in and out");
// Anchor point and motion blur.
await page.locator('[data-anchor="0,0"]').click(); await sleep(250);
check(await page.locator('[data-anchor="0,0"]').getAttribute("aria-checked") === "true", "anchor at the top left");
if (process.env.SHOT) { await page.locator("#frame-look").scrollIntoViewIfNeeded(); await page.screenshot({ path: "/tmp/p11a.png", clip: { x: 1130, y: 50, width: 300, height: 840 } }); await page.locator("#anchor-row").scrollIntoViewIfNeeded(); await page.screenshot({ path: "/tmp/p11b.png", clip: { x: 1130, y: 50, width: 300, height: 840 } }); }
await slide("motion-blur", 10);
check((await page.locator('[data-val="motion-blur"]').textContent()).startsWith("50"), "motion blur 50 (180° shutter)");
await page.locator('[data-anchor="0.5,0.5"]').click(); await sleep(250);
check(await page.locator('[data-anchor="0.5,0.5"]').getAttribute("aria-checked") === "true", "anchor back in the middle");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
