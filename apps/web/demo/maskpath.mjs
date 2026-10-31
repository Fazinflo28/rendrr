// Mask path keyframes in the editor: draw a path mask, key its shape at one moment, move the playhead and draw it
// again there: it becomes a second key, the mask says it changes shape, and the outline on the player is the shape at
// the playhead (between the keys, in between). Runs on the demo build (node demo/build.mjs first).
//   node demo/maskpath.mjs   (from apps/web)
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
await page.locator("#tab-color").click(); await page.locator("#masks-panel").waitFor();
const overlay = page.locator("#mask-overlay");
const drawAt = async (pts) => { const b = await overlay.boundingBox(); for (const [x, y] of pts) { await page.mouse.click(b.x + x * b.width, b.y + y * b.height); await sleep(80); } };
// A triangle on the left.
await page.locator("#mask-add-path").click(); await sleep(200);
await drawAt([[0.1, 0.2], [0.3, 0.5], [0.1, 0.8]]);
await page.locator("#path-done").click(); await sleep(400);
check(await page.locator('[data-mask="0"]').count() === 1, "a path mask drawn");
await page.locator("#mask-0-key-shape").click(); await sleep(400);
const k1 = (await page.locator("#mask-0-pathkeys-list").textContent()) || "";
check(/Shape keys at [\d.]+s/.test(k1), `its shape keyed at the playhead (${k1.trim()})`);
// 5 s later (L), drawn again as a square on the right: a second key.
await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press("l"); await sleep(400);
await page.locator("#tab-color").click().catch(() => {});
await page.locator("#mask-0-redraw").click(); await sleep(200);
await drawAt([[0.5, 0.1], [0.9, 0.1], [0.9, 0.9], [0.5, 0.9]]);
const done = await page.locator("#path-done").textContent();
check(/Key at [\d.]+s/.test(done || ""), `the drawing becomes a key there ("${(done || "").trim()}")`);
await page.locator("#path-done").click(); await sleep(400);
const k2 = (await page.locator("#mask-0-pathkeys-list").textContent()) || "";
check((k2.match(/s/g) || []).length >= 2 && /,/.test(k2), `two shape keys (${k2.trim()})`);
check(/Changes shape \(2 keys/.test((await page.locator("#mask-0-moving").textContent()) || ""), "the mask says it changes shape");
// The outline on the player is the shape at the playhead: at the second key, the square (4 points).
const pts = await page.evaluate(() => { const p = document.querySelector("#mask-overlay polygon"); return p ? p.getAttribute("points").trim().split(/\s+/).length : 0; });
check(pts === 4, `the player's outline is the shape at the playhead (${pts} points)`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
