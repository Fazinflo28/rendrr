// What your AI adds shows on the timeline as layers you can see and change, as in Premiere: your own sound file
// (set_voice) on a VO row under the dialogue (which shows muted), the background behind the picture on a BG row,
// and an fx badge on clips with effects. Selecting one opens its settings in the right panel. Runs on the demo build
// (node demo/build.mjs first).   node demo/layers.mjs   (from apps/web)
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
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => { globalThis.__demoVoice = true; });
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(400);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);

// 1. Your own sound file.
const voice = page.locator('#timeline .clip.voice');
check(await voice.count() === 1 && /Voiceover/.test(await voice.innerText()), "your sound file is a clip on the timeline");
check((await page.locator(".tl-labels").innerText()).includes("VO"), "on its own VO row");
const a1 = await page.$$eval('#timeline .clip[data-track="a1"]', (cs) => cs.map((c) => c.classList.contains("muted")));
check(a1.length > 0 && a1.every(Boolean), "the dialogue it replaces shows muted");
await voice.click(); await sleep(300);
check(await page.locator("#side-clip").getAttribute("aria-selected") === "true" && await page.locator("#voice-inspector").count() === 1, "selecting it opens its settings in the right panel");
const box = await voice.boundingBox();
await page.mouse.move(box.x + 30, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 130, box.y + box.height / 2, { steps: 6 }); await page.mouse.up(); await sleep(500);
const start = Number(await page.locator("#voice-start").inputValue());
check(start > 0.5, `dragging it moves where it starts (${start} s)`);
check(await page.locator("#undo").isEnabled(), "and it can be undone");
await page.locator("#voice-off").click(); await sleep(500);
check(await page.locator('#timeline .clip.voice').count() === 0 && !(await page.locator(".tl-labels").innerText()).includes("VO"), "Use the clips' own sound takes it off the timeline");

// 2. The background behind the picture, and the fx badge on a clip with effects.
await page.locator('#timeline .clip[data-track="v1"]').first().click(); await sleep(200);
await page.locator("#tab-color").click(); await sleep(300);
await page.locator("#bg-on").check(); await sleep(500);
const first = await page.locator('#timeline .clip[data-track="v1"]').first().getAttribute("data-clip");
const fx = page.locator(`#timeline .fxb[data-fx="${first}"]`);
check(await until(async () => (await fx.count()) === 1), "a clip with an effect shows an fx badge");
check(/no background/.test(await fx.getAttribute("title")), `it names the effect (${await fx.getAttribute("title")})`);
await page.locator("#tab-media").click(); await sleep(200);
await fx.click(); await sleep(300);
check(await page.locator("#tab-color").getAttribute("aria-selected") === "true", "clicking fx opens Color for that clip");
await page.locator("#bg-behind").selectOption("gradient"); await sleep(500);
const bg = page.locator('#timeline .clip[data-track="bg"]');
check(await until(async () => (await bg.count()) === 1), "the background is a layer on its own BG row");
await bg.click(); await sleep(300);
check(await page.locator("#background-inspector").count() === 1, "selecting it opens its settings");
await page.locator("#background-off").click(); await sleep(500);
check(await page.locator('#timeline .clip[data-track="bg"]').count() === 0, "Remove takes the background off");

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
