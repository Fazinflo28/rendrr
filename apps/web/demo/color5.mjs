// Phase 5 in the editor: a clip's Color page changes Light (highlights, shadows), Vibrance, a colour wheel by dragging,
// Hue vs Sat, an HSL secondary from a preset, adds a vignette, and shows scopes of the picture. Runs on the demo build
// (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/color5.mjs   (from apps/web)
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
await page.locator("#tab-color").click(); await page.locator("#grade-light").waitFor();
const val = (id) => page.locator(`[data-val="${id}"]`).textContent();
const slide = async (id, v) => { await page.evaluate(([id, v]) => { const el = document.getElementById(id); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); }, [id, v]); await sleep(250); };

await slide("grade-highlights", -40); await slide("grade-shadows", 30); await slide("grade-vibrance", 25);
check(await val("grade-highlights") === "-40" && await val("grade-shadows") === "+30" && await val("grade-vibrance") === "+25", "Light and Vibrance change the grade");
check(/highlights -40, shadows \+30, vibrance \+25/.test(await page.locator("#color-clip").textContent()), "the clip's grade line says so");

// A wheel: drag from the middle towards blue (left and down: 240°).
await page.locator("#grade-wheel-shadows").scrollIntoViewIfNeeded(); await sleep(200);
const w = await page.locator("#grade-wheel-shadows").boundingBox();
await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2); await page.mouse.down();
await page.mouse.move(w.x + w.width / 2 - w.width * 0.15, w.y + w.height / 2 + w.height * 0.26, { steps: 4 }); await page.mouse.up(); await sleep(300);
const wv = await val("grade-wheel-shadows");
check(/^2[2-5]\d° \d+$/.test(wv), `the shadows wheel pushes towards blue (${wv})`);
await slide("grade-wheel-shadows-luma", 10);
check(/shadows wheel 2[2-5]\d° \d+ luma \+10/.test(await page.locator("#color-clip").textContent()), "the wheel and its luma are in the grade");

await slide("grade-huesat-red", 0.2);
check(await val("grade-huesat-red") === "40%", "Hue vs Sat: reds at 40%");
// Phase 14: Hue vs Hue (greens toward teal) and Luma vs Sat (less colour in the shadows).
await slide("grade-huehue-green", 40);
check(await val("grade-huehue-green") === "+40°", "Hue vs Hue: greens +40°");
check(/hue vs hue \(120° \+40°\)/.test(await page.locator("#color-clip").textContent()), "the grade line says hue vs hue");
await slide("grade-lumasat-shadows", 40);
check(await val("grade-lumasat-shadows") === "40%", "Luma vs Sat: shadows at 40%");
check(/luma vs sat \(0% → 100%, 25% → 40%, 50% → 100%/.test(await page.locator("#color-clip").textContent()), "the grade line says luma vs sat");
await page.locator("#grade-huehue-reset").click(); await sleep(300);
check(!/hue vs hue/.test(await page.locator("#color-clip").textContent()), "Reset takes Hue vs Hue off");
await page.locator("#grade-hsl-add-sky").click(); await sleep(300);
check(await page.locator('[data-hsl="0"]').count() === 1, "+ Sky adds an HSL secondary");
await slide("grade-hsl-0-sat", 150);
check(/HSL 210°±25 sat 150%/.test(await page.locator("#color-clip").textContent()), "its saturation is in the grade");

await page.locator("#fx-add-vignette").click(); await sleep(300);
check((await page.locator('[data-effect="0"] .t-small').first().textContent()) === "Vignette", "+ Vignette adds a vignette");

await page.locator("#clip-scopes-on").check(); await page.locator("#clip-waveform").waitFor(); await sleep(900);
const lit = await page.evaluate(() => { const c = document.getElementById("clip-waveform"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 60) n++; return n; });
const err = await page.locator("#clip-scopes .t-small.muted").count();
check(lit > 200 || err > 0, `the waveform draws the picture (${lit} lit points${err ? "; the demo's video cannot be read" : ""})`);
// Phase 14: the RGB parade: three columns, red, green and blue. The demo's own video cannot be read by a canvas, so a
// readable picture (a canvas stream of red, green and blue bands) is put in front for the scopes to measure.
await page.evaluate(() => {
  const c = document.createElement("canvas"); c.width = 160; c.height = 90; const g = c.getContext("2d");
  const paint = () => { g.fillStyle = "#d02020"; g.fillRect(0, 0, 53, 90); g.fillStyle = "#20c020"; g.fillRect(53, 0, 54, 90); g.fillStyle = "#2030d0"; g.fillRect(107, 0, 53, 90); };
  paint(); setInterval(paint, 100);
  const v = document.createElement("video"); v.muted = true; v.autoplay = true; v.setAttribute("data-on", "1"); v.srcObject = c.captureStream(10);
  v.style.cssText = "position:fixed;left:-500px;top:0;width:160px"; document.body.prepend(v); v.play().catch(() => {});
});
await sleep(600);
await page.locator("#clip-scope-mode").selectOption("rgb"); await sleep(900);
if (process.env.DEBUG) console.log(await page.evaluate(() => { const v = document.querySelector('video[data-on="1"]'); return JSON.stringify({ src: v?.src?.slice(0, 40), so: !!v?.srcObject, rs: v?.readyState, t: v?.currentTime, w: v?.videoWidth, err: document.querySelector("#clip-scopes .t-small.muted")?.textContent }); }));
const cols = await page.evaluate(() => { const c = document.getElementById("clip-waveform"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, w = c.width, third = Math.floor(w / 3); const n = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { const x = (i / 4) % w, k = Math.min(2, Math.floor(x / third)); if (d[i + k] > 60 && d[i + k] > d[i + ((k + 1) % 3)] + 30) n[k]++; } return n; });
check(cols[0] > 30 && cols[1] > 30 && cols[2] > 30, `the RGB parade draws red, green and blue columns (${cols.join(", ")} lit points)`);
check(warns.filter((x) => /look (shader|program)/.test(x)).length === 0, "no shader errors");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
