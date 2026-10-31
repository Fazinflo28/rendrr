// Phase 6 in the editor: a clip's Audio page sets pan, the EQ bands, reverb and its room, adds volume keys at the
// playhead and changes them, and the whole edit takes a crossfade at every cut. Runs on the demo build (node
// demo/build.mjs first) in Playwright's Chromium.
//   node demo/audio6.mjs   (from apps/web)
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
await page.locator("#tab-audio").click(); await page.locator("#clip-sound").waitFor();
const val = (id) => page.locator(`[data-val="${id}"]`).textContent();
const slide = async (id, v) => { await page.evaluate(([id, v]) => { const el = document.getElementById(id); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); }, [id, v]); await sleep(250); };

await slide("clip-pan", -0.3);
check(await val("clip-pan") === "L 30%", `Pan sets the balance (${await val("clip-pan")})`);
await slide("clip-eq-low", 4); await slide("clip-eq-high", -3);
check(await val("clip-eq-low") === "+4 dB" && await val("clip-eq-high") === "-3 dB" && await val("clip-eq-mid") === "0 dB", "the EQ bands change one by one");
check(await page.locator("#clip-reverb-size").isDisabled(), "Room waits for Reverb");
await slide("clip-reverb-amount", 35);
check(await val("clip-reverb-amount") === "35" && !(await page.locator("#clip-reverb-size").isDisabled()), "Reverb on, Room can be set");
await slide("clip-reverb-size", 80);
check(await val("clip-reverb-size") === "2.1 s", `the room's length (${await val("clip-reverb-size")})`);

await page.locator("#clip-key-add").click(); await sleep(300);
check(await page.locator('#clip-keys [data-key="0"]').count() === 1, "+ Key adds a volume key at the playhead");
await slide("clip-key-0", -9);
check(await val("clip-key-0") === "-9 dB", "the key's level changes");
check(await page.locator("#clip-key-add").isDisabled(), "a second key cannot go on the same moment");
await page.locator("#clip-key-del-0").click(); await sleep(300);
check(await page.locator('#clip-keys [data-key="0"]').count() === 0, "the key can be removed");

await page.locator("#audio-fine summary").click(); await sleep(200);
await slide("audio-crossfade", 60);
check(await val("audio-crossfade") === "60 ms (in the render)", `Crossfade at every cut (${await val("audio-crossfade")})`);
check(/pan, EQ, reverb and crossfades are heard in the rendered preview/.test(await page.locator("#audio-note").textContent()), "the note says what the player plays");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
