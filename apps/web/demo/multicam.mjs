// Phase 10 in the editor: the Multicam page adds a camera (synced by the server), shows a monitor per camera,
// cuts to a camera from the playhead when its monitor is clicked, switches the sound and removes the camera.
//
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/multicam.mjs   (from apps/web)
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
await page.locator("#tab-multicam").click(); await page.locator("#multicam-panel").waitFor();
check((await page.locator("#multicam-angles").textContent()).includes("No other cameras yet"), "no cameras yet");
const opts = await page.locator("#multicam-add-select option").evaluateAll((os) => os.map((o) => [o.value, o.textContent]).filter(([v]) => v));
check(opts.length > 0, `the library's other videos are offered (${opts.length})`);
const [camId, camName] = opts[0];
await page.locator("#multicam-add-select").selectOption(camId);
await page.locator("#multicam-add").click();
await page.locator(`[data-angle-row="${camId}"]`).waitFor({ timeout: 5000 }).catch(() => {});
const sync = await page.locator(`[data-sync="${camId}"]`).textContent().catch(() => "");
check(sync === "+1.234 s · sync 87%", `added and synced: ${camName} ${sync}`);
check(await page.locator(".mc-mon").count() === 2, "a monitor per camera (main and the new one)");
check(await page.locator('.mc-mon[data-angle="main"].on').count() === 1, "the main camera is on at the playhead");
// Cut to the new camera at the playhead: the V1 clip there now shows it.
await page.locator(`.mc-mon[data-angle="${camId}"]`).click(); await sleep(400);
if (process.env.SHOT) await page.screenshot({ path: "/tmp/multicam.png" });
check(await page.locator(`.mc-mon[data-angle="${camId}"].on`).count() === 1, "clicked: that camera is on at the playhead");
const labels = await page.locator('.clip.video').evaluateAll((cs) => cs.map((c) => c.getAttribute("title") || c.textContent));
check(labels.some((l) => l.includes(camName.slice(0, 12))), "the V1 clip says its camera");
// Phase 13: number keys cut live (1 = main, 2 = the new camera), and Cut to whoever speaks.
check(JSON.stringify(await page.locator(".mc-mon .mc-key").allTextContents()) === JSON.stringify(["1", "2"]), "each monitor shows its number key");
await page.locator("#multicam-keys-hint").click(); // focus on the panel, not a field
await page.keyboard.press("1"); await sleep(400);
check(await page.locator('.mc-mon[data-angle="main"].on').count() === 1, "key 1: the main camera at the playhead");
await page.keyboard.press("2"); await sleep(400);
check(await page.locator(`.mc-mon[data-angle="${camId}"].on`).count() === 1, "key 2: the new camera at the playhead");
const before = await page.locator('.clip.video').count();
await page.locator("#multicam-auto-min").selectOption("3");
await page.locator("#multicam-auto").click(); await sleep(900);
const autoLabels = await page.locator('.clip.video').evaluateAll((cs) => cs.map((c) => c.getAttribute("title") || c.textContent));
const onCam = autoLabels.filter((l) => l.includes(camName.slice(0, 12))).length;
check(autoLabels.length > before && onCam > 0 && onCam < autoLabels.length, `Cut to whoever speaks: the main camera's clips split and shared between both cameras (${onCam} of ${autoLabels.length} on ${camName})`);
check(errors.length === 0, "no page errors after the auto cut");
// Its offset by hand.
await page.locator(`#mc-offset-${camId}`).fill("2.5"); await page.locator(`#mc-offset-${camId}`).press("Enter"); await page.locator(`#mc-offset-${camId}`).blur(); await sleep(300);
check((await page.locator(`[data-sync="${camId}"]`).textContent()) === "+2.500 s · set by hand", "offset set by hand");
await page.locator("#multicam-audio").selectOption("follow"); await sleep(200);
check(await page.locator("#multicam-audio").inputValue() === "follow", "sound: each camera's own");
await page.locator(`[aria-label="Remove ${camName}"]`).click(); await sleep(300);
check(await page.locator(".mc-mon").count() === 0 && (await page.locator("#multicam-angles").textContent()).includes("No other cameras yet"), "removed");
const after = await page.locator('.clip.video').evaluateAll((cs) => cs.map((c) => c.getAttribute("title") || c.textContent));
check(!after.some((l) => l.includes(camName.slice(0, 12))), "its clips back on the main camera");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
