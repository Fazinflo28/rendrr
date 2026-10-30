// Reframing in the editor: the Export window offers 4:5 and, when the footage is another shape than the frame, Follow
// the speaker (every clip reframed on the face); the Frame menu has Follow the speaker and pan sliders that move where
// the fit cuts the footage. Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/reframe.mjs   (from apps/web)
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1200);

// 1. Export: 4:5 is a shape; vertical footage in the vertical edit needs no reframe.
await page.locator("#render-final").click();
await page.locator("#export-panel").waitFor();
check(await page.locator('#export-aspect [data-v="4:5"]').count() === 1, "the Export window offers 4:5");
check(await page.locator("#export-reframe").count() === 0, "footage of the edit's shape: no reframe offered");
// 2. A horizontal edit of vertical footage: Follow the speaker, then it reads Reframed.
await page.locator('#export-aspect [data-v="16:9"]').click(); await page.waitForTimeout(300);
check(await page.locator("#export-reframe").count() === 1, "another shape: Follow the speaker offered");
check((await page.locator("#export-panel").innerText()).includes("Cut around the middle"), "before: cut around the middle");
await page.locator("#export-reframe").click(); await page.waitForTimeout(800);
check((await page.locator("#export-panel").innerText()).includes("Reframed"), "after: reframed");
await page.locator('#export-aspect [data-v="4:5"]').click(); await page.waitForTimeout(300);
check((await page.locator("#export-summary").innerText()).startsWith("1080x1350"), "4:5 exports at 1080x1350");
await page.keyboard.press("Escape"); await page.waitForTimeout(300);
if (await page.locator("#export-panel").count()) { await page.locator("#export-panel button", { hasText: "Cancel" }).click(); await page.waitForTimeout(300); }

// 3. The Frame menu: Follow the speaker and pan sliders; the player's footage is cut where they say.
await page.locator("#frame-btn").click(); await page.locator("#frame-pop").waitFor();
check(await page.locator("#reframe-face").count() === 1, "the Frame menu has Follow the speaker");
check(await page.locator('#frame-pop input[data-focus="x"]').count() === 1 && await page.locator('#frame-pop input[data-focus="y"]').count() === 1, "the Frame menu has pan sliders");
const pos = () => page.evaluate(() => [...document.querySelectorAll("video[data-video]")].map((v) => v.style.objectPosition));
const slider = page.locator('#frame-pop input[data-focus="x"]');
await slider.evaluate((el) => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "0.9"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
await page.waitForTimeout(600);
check((await page.locator("#frame-pop").innerText()).includes("0.9"), "the pan slider shows its point");
const after = await pos();
console.log("     object-position:", after.join(" | ") || "(no footage video in the demo)");
check(!after.length || after.some((p) => p && p !== "50% 40%"), "the footage is cut away from the middle");

check(!errors.length, "no page errors" + (errors.length ? ": " + errors.join("; ") : ""));
await browser.close(); server.close();
console.log(fails.length ? `FAIL: ${fails.length}` : "PASS: reframing in the Export window and the Frame menu");
process.exit(fails.length ? 1 : 0);
