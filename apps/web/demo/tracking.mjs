// Object tracking in the editor: drag a box round something on the picture (Color tab, Tracking), Rendrr follows it
// (the preview's stand-in tracker), the object is listed with where it was followed and lost, its box is outlined at
// the playhead and moves with it, "Blur it" adds a blur that follows it, a mask can follow it, and a text layer is
// pinned to it in the Text tab (it gets keyframes). Runs on the demo build (node demo/build.mjs first).
//   node demo/tracking.mjs   (from apps/web)
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
await page.locator("#tab-color").click(); await page.locator("#objects-panel").waitFor();
check(/Draw a box round/.test((await page.locator("#objects-panel").textContent()) || ""), "the Tracking section says what it does");
// A box round something on the left of the picture.
await page.locator("#track-add").click(); await sleep(200);
check((await page.locator("#mask-overlay").getAttribute("data-mode")) === "box", "Track an object: the picture takes a box");
const ov = await page.locator("#mask-overlay").boundingBox();
await page.mouse.move(ov.x + ov.width * 0.2, ov.y + ov.height * 0.3); await page.mouse.down();
await page.mouse.move(ov.x + ov.width * 0.3, ov.y + ov.height * 0.4, { steps: 4 });
check(await page.locator("#track-box").count() === 1, "the box is drawn while dragging");
await page.mouse.move(ov.x + ov.width * 0.35, ov.y + ov.height * 0.5, { steps: 4 }); await page.mouse.up();
await page.locator('[data-object="o1"]').waitFor({ timeout: 5000 }).catch(() => {});
check(await page.locator('[data-object="o1"]').count() === 1, "the object is listed once it is followed");
const txt = (await page.locator("#obj-text-0").textContent()) || "";
check(/Followed [\d.]+-[\d.]+s; lost [\d.]+-[\d.]+s/.test(txt), `where it was followed and lost (${txt.trim()})`);
// Its box at the playhead, and a little further right 2 s later.
const boxX = () => page.evaluate(() => { const r = [...document.querySelectorAll("#mask-overlay rect")].find((e) => e.getAttribute("style")?.includes("251, 146, 60") || e.getAttribute("style")?.includes("#fb923c")); return r ? Number(r.getAttribute("x")) : null; });
const x0 = await boxX();
check(x0 != null && Math.abs(x0 - 0.2) < 0.02, `its box is outlined where it was drawn (${x0})`);
await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press("l"); await sleep(400);
await page.locator("#tab-color").click().catch(() => {});
await page.locator(".clip.video").first().click(); await sleep(300);
const x1 = await boxX();
check(x1 != null && x1 > x0, `the box moves with the object (${x0} -> ${x1})`);
// Name it, blur it, and make a mask follow it.
await page.locator("#obj-label-0").fill("logo"); await page.locator("#obj-label-0").press("Tab"); await sleep(300);
check((await page.locator("#obj-label-0").inputValue()) === "logo", "named");
await page.locator("#obj-blur-0").click(); await sleep(400);
const fx = (await page.locator('[data-effect]').last().textContent()) || "";
check(/Blur/.test(fx) && /Follows logo \(\d+ keys\)/.test(fx), `Blur it: a blur that follows it (${fx.replace(/\s+/g, " ").slice(0, 80)})`);
await page.locator("#mask-add-rect").click(); await sleep(300);
await page.locator("#mask-0-follow-object").selectOption("o1"); await sleep(300);
check(/Follows logo/.test((await page.locator("#mask-0-moving").textContent()) || ""), "a mask set to follow it moves with it");
// Pin a text layer to it.
await page.locator("#tool-back").click(); await sleep(200);
await page.locator("#tab-text").click(); await page.locator("#text-layers").waitFor();
await page.locator("#add-text-callout").click(); await sleep(400);
await page.locator("#text-pin-object").waitFor();
const opt = await page.locator("#text-pin-object option").nth(1).getAttribute("value");
await page.locator("#text-pin-object").selectOption(opt); await sleep(400);
check((await page.locator("#text-pin-object").inputValue()) === opt, "the text is pinned to it");
check(await page.locator("#text-pin-scale").count() === 1, "and can grow with it");
const keyed = await page.evaluate(() => [...document.querySelectorAll(".clip")].some((c) => c.querySelector(".kf, .keys, [data-keys]")));
console.log(`     (keyframe marks on the timeline: ${keyed})`);
// Stop tracking it: the blur keeps its path, the text is unpinned.
await page.locator("#tool-back").click(); await sleep(200);
await page.locator(".clip.video").first().click(); await sleep(300);
await page.locator("#tab-color").click(); await page.locator("#objects-panel").waitFor();
await page.locator("#obj-del-0").click(); await sleep(400);
check(await page.locator('[data-object]').count() === 0, "stop tracking it");
check(/Moves \(\d+ keys/.test((await page.locator('[data-effect]').last().textContent()) || ""), "the blur keeps its path as plain keyframes");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
