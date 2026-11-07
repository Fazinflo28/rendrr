// Add clips is the Library as it is: its folders (open one, go back, pick the whole folder) and its videos, plus new
// footage from Google Drive or this computer, picked at once and added once prepared. Runs on the demo build
// (node demo/build.mjs first).   node demo/add-clips.mjs   (from apps/web)
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
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => { globalThis.__demoLibSeed = true; });
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);

const modal = page.locator(".modal");
await page.locator("#bin-add-clips").click();
await until(async () => (await modal.locator("#add-videos .clip-card[data-video], #add-videos .clip-folder").count()) > 0);
check(await modal.locator("#add-src-library").getAttribute("aria-selected") === "true" && await modal.locator("#add-src-drive").count() === 1 && await modal.locator("#add-src-local").count() === 1, "Library, Google Drive and This computer");
const folder = modal.locator('#add-videos .clip-folder[data-folder="fd-seed"]');
check(await folder.count() === 1 && /Shoot day/.test(await folder.innerText()), "the Library's folders show as cards");
check(await modal.locator('#add-videos .clip-card[data-video="v3"]').count() === 0, "videos in a folder are inside it, not loose");
await folder.click(); await sleep(300);
check(await until(async () => (await modal.locator('#add-videos .clip-card[data-video="v3"]').count()) === 1 && (await modal.locator('#add-videos .clip-card[data-video="v5"]').count()) === 1), "opening it shows its videos");
check(/Library › Shoot day/.test(await modal.locator("#add-trail").innerText()), "with the path back");
await modal.locator("#add-folder-all").click(); await sleep(200);
check(await modal.locator("#add-videos .clip-card.on").count() === 2, "Pick the whole folder picks its videos");
await modal.locator("#add-up").click(); await sleep(300);
check(await modal.locator('#add-videos .clip-folder[data-folder="fd-seed"]').count() === 1, "Back goes up to the Library");

// New footage from this computer: picked at once, shown while it is prepared.
await modal.locator("#add-src-local").click();
check(await modal.locator("#add-drop").isVisible(), "This computer: drop videos or choose files");
await modal.locator('#add-local input[type="file"]').setInputFiles({ name: "Fresh take.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(4096) });
check(await until(async () => (await modal.locator("#add-src-library").getAttribute("aria-selected")) === "true" && (await modal.locator("#add-videos .clip-card.on", { hasText: "Fresh take" }).count()) === 1), "the new video is in the Library list, picked");
check(/Add 3 videos/.test(await modal.locator("#add-clip-go").innerText()), "with the folder's two: Add 3 videos");
await modal.locator("#add-src-drive").click();
check(await until(async () => (await modal.locator("#add-drive").count()) === 1), "Google Drive: the Drive browser");
await modal.locator("#add-src-library").click();
const before = await page.locator('#timeline .clip[data-track="v1"]').count();
await modal.locator("#add-clip-go").click();
check(await until(async () => (await page.locator(".modal #add-clip-form").count()) === 0, 60000), "Add waits for the new video, then adds them");
check(await until(async () => (await page.locator('#timeline .clip[data-track="v1"]').count()) >= before + 3), `three clips go on the timeline (${before} -> ${await page.locator('#timeline .clip[data-track="v1"]').count()})`);

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
