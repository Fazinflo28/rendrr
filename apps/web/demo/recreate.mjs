// Recreate opens the editor at once, with no window: the edit waits for its footage (the gallery video attached as its
// reference, playing in the monitor; nothing on the timeline; Export off). The first video added becomes the footage,
// and when its shape is not the edit's the editor frames it by itself (follows the speaker). Runs on the demo build
// (node demo/build.mjs first).   node demo/recreate.mjs   (from apps/web)
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
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/")); await page.locator(".gcard").first().waitFor();

// 1. Recreate: straight into the editor.
await page.locator("[data-recreate]").first().click();
check(await until(async () => (await page.locator("#edit-tools").count()) === 1), "Recreate opens the editor");
check(await page.locator("#create-project").count() === 0, "with no window to fill in");
check(await page.locator("#waiting-footage").isVisible(), "the edit asks for your footage where the player is");
check(await page.locator("#timeline .clip").count() === 0, "nothing on the timeline yet");
check(await until(async () => (await page.locator("#reference-video, #reference-recipe").count()) === 1), "the gallery video is the reference in the monitor");
check(await page.locator("#render-final").isDisabled(), "Export waits for the footage");
const shape = (await page.locator("#aspect-btn").innerText()).trim();
check(/^(9:16|16:9|1:1|4:5)$/.test(shape), `the edit has the gallery video's shape (${shape})`);

// 2. The first video added becomes the footage; a different shape is framed by itself.
await page.locator("#add-footage-first").click();
await until(async () => (await page.locator("#add-videos .clip-card:not(.clip-sk)").count()) > 0);
check(await page.locator("#add-videos .badge-in").count() === 0 && await page.locator('input[name="add-mode"]').count() === 0, "the picker shows only your videos, no options");
const pick = shape === "9:16" ? "v1" : "v2"; // a Landscape video for a vertical edit, a Portrait one otherwise
await page.locator(`#add-videos .clip-card[data-video="${pick}"]`).click();
check(/Use this video/.test(await page.locator("#add-clip-go").innerText()), "the button says Use this video");
await page.locator("#add-clip-go").click();
check(await until(async () => (await page.locator("#waiting-footage").count()) === 0 && (await page.locator('#timeline .clip[data-track="v1"]').count()) > 0), "the video becomes the edit's footage on the timeline");
check(await until(async () => (await page.locator(".toast", { hasText: "Framing it for" }).count()) > 0, 5000), "a different shape is framed by itself (it follows the speaker)");
check(await until(async () => await page.locator("#undo").isEnabled(), 5000), "the framing is an edit you can undo");
check((await page.locator("#aspect-btn").innerText()).trim() === shape, "the edit keeps the gallery video's shape");
const monitor = await page.locator("#source-monitor").innerText().catch(() => "(no monitor)");
check(await until(async () => (await page.locator("#reference-video, #reference-recipe").count()) === 1, 5000), `and its reference (${monitor.replace(/\s+/g, " ").slice(0, 60)})`);
check(!(await page.locator("#render-final").isDisabled()), "Export is on");

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
