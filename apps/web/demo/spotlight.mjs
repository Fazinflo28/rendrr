// Phase 3 in the editor: a clip's Color page adds a spotlight (darken outside an ellipse that follows the face, from
// the face measured over the clip), a darken effect, and a mask that follows the face; a moving shape says so and can be
// held still. Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/spotlight.mjs   (from apps/web)
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
const errors = [], warns = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") warns.push(m.text()); });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator(".clip.video").first().click(); await sleep(300);
await page.locator("#tab-color").click(); await page.locator("#effects-panel").waitFor();

await page.locator("#fx-add-spotlight").click(); await page.locator("#fx-0-moving").waitFor({ timeout: 5000 }); await sleep(600);
check((await page.locator('[data-effect="0"] .t-small').first().textContent()) === "Darken", "Spotlight adds a darken effect");
check(/^Follows the face \(\d+ keys\)$/.test((await page.locator("#fx-0-moving .t-small").textContent()).trim()), `its area follows the face (${(await page.locator("#fx-0-moving .t-small").textContent()).trim()})`);
check(await page.locator("#fx-0-follow").isChecked() && await page.locator("#fx-0-invert").isChecked(), "following, outside the face");
check((await page.locator("#fx-0-x").count()) === 0, "no box sliders while it follows");
await page.locator("#fx-0-still").click(); await sleep(500);
check((await page.locator("#fx-0-moving").count()) === 0 && (await page.locator("#fx-0-x").count()) === 1, "Hold still: the box stays, its sliders come back");

await page.locator("#fx-add-darken").click(); await sleep(400);
check((await page.locator('[data-effect="1"] .t-small').first().textContent()) === "Darken", "+ Darken adds one over the whole picture");

await page.locator("#mask-add-ellipse").click(); await sleep(400);
await page.locator("#mask-0-follow").click(); await page.locator("#mask-0-moving").waitFor({ timeout: 5000 }); await sleep(400);
check(/^Follows the face/.test((await page.locator("#mask-0-moving .t-small").textContent()).trim()), "a mask follows the face");
check(warns.filter((w) => /look (shader|program)/.test(w)).length === 0, "no shader errors");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
