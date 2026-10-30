// Skin retouch in the editor: Color (the whole edit) turns it on with the natural defaults on every V1 clip's face,
// its sliders change it, and turning it off removes it; the same on one clip. (The player's skin pass is compared with
// the render in skin-match.mjs.) Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/skin.mjs   (from apps/web)
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
await page.locator("#tab-color").click(); await page.locator("#skin-panel").waitFor();
check(!(await page.locator("#skin-on").isChecked()) && (await page.locator("#skin-smooth").count()) === 0, "Color has a Skin retouch section, off");

await page.locator("#skin-on").click(); await page.locator("#skin-smooth").waitFor({ timeout: 5000 }); await sleep(800);
const vals = await page.evaluate(() => ["smooth", "blemishes", "even", "brighten"].map((k) => document.querySelector(`[data-val="skin-${k}"]`)?.textContent));
check(JSON.stringify(vals) === JSON.stringify(["35", "40", "35", "off"]), `On: the natural defaults (${vals.join(", ")})`);
check(await page.locator("#skin-face").isChecked(), "on each clip's face");
// Brighten all the way: its value says so.
await page.evaluate(() => { const el = document.querySelector('[data-val="skin-brighten"]').closest("label").querySelector("input[type=range]"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "100"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
await sleep(500);
check((await page.locator('[data-val="skin-brighten"]').textContent()) === "100", "Brighten changes it");
const shader = warns.filter((w) => /look (shader|program)/.test(w));
check(shader.length === 0, "no shader errors");
await page.locator("#skin-on").click(); await sleep(500);
check((await page.locator("#skin-smooth").count()) === 0, "Off removes it");
// One clip: select it on the timeline; its Color page has its own Skin section.
await page.locator("#tool-back").click(); await page.locator(".clip.video").first().click(); await sleep(300);
await page.locator("#tab-color").click(); await page.locator("#skin-panel").waitFor();
await page.locator("#skin-on").click(); await page.locator("#skin-smooth").waitFor({ timeout: 5000 });
check(/^On 1 of \d+ clips|^Done before/.test(await page.locator("#skin-note").textContent()), "a clip gets its own retouch");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
