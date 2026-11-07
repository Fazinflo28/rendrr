// Recreate opens the New edit window with the gallery video already set as the reference: pick footage from the
// Library, or add new footage right there (the edit waits for it to be prepared), and the editor opens with the
// reference attached. Runs on the demo build (node demo/build.mjs first).   node demo/recreate.mjs   (from apps/web)
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
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));

// Signed in (Recreate asks a visitor to log in first).
await page.goto(base + "/"); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/"));

// 1. Footage already in the Library.
await page.locator(".gcard").first().waitFor();
await page.locator("[data-recreate]").first().click();
const modal = page.locator(".modal");
check(await until(async () => (await modal.locator("#create-project").count()) === 1), "Recreate opens the New edit window");
check(/Recreate this video/i.test(await modal.locator("h2").innerText()), "titled Recreate this video");
const ref = modal.locator("select#np-reference");
const refVal = await ref.inputValue(), refText = await ref.locator("option:checked").innerText();
check(refVal.startsWith("recipe:") && /Gallery video/.test(refText), `the gallery video is the reference (${refText})`);
const name = await modal.locator("#np-name").inputValue();
check(name.startsWith("Recreate: "), `named after it (${name})`);
check(await modal.locator("#create-project").isDisabled(), "Create waits for footage");
await until(async () => (await modal.locator("#np-videos .prow").count()) > 0);
await modal.locator("#np-videos .prow").first().click();
check(!(await modal.locator("#create-project").isDisabled()), "picking footage enables Create");
await modal.locator("#create-project").click();
check(await until(async () => (await page.locator("#edit-tools").count()) === 1), "the editor opens");
check(await until(async () => (await page.locator("#reference-video, #reference-recipe").count()) === 1), "the editor's reference monitor shows the gallery video");
check(await page.locator("#reference-pick").count() === 0, "no reference dropdown under the monitor");
check(await page.locator("#tab-style").count() === 0, "no Reference panel in the editor");

// 2. New footage added from the window: picked at once, the edit waits for it to be prepared.
await page.evaluate(() => globalThis.__rendrrNav.go("/")); await page.locator(".gcard").first().waitFor();
await page.locator("[data-recreate]").first().click();
await until(async () => (await modal.locator("#np-add-footage").count()) === 1);
await until(async () => (await modal.locator("#np-videos .prow").count()) > 0); // the Library list has loaded
await modal.locator("#np-add-footage").click();
await modal.locator("#np-add-local").click();
const before = await modal.locator("#np-videos .prow").count();
await modal.locator('#np-add input[type="file"]').setInputFiles({ name: "My take.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(4096) });
check(await until(async () => (await modal.locator("#np-videos .prow", { hasText: "My take" }).count()) === 1 && (await modal.locator("#np-videos .prow").count()) === before + 1), "the added video shows in the footage list");
const row = modal.locator("#np-videos .prow.on", { hasText: "My take" });
check(await row.count() === 1, "and is picked");
check(await modal.locator("#np-add").count() === 0, "the add panel closes");
await modal.locator("#create-project").click();
check(await until(async () => (await page.locator("#edit-tools").count()) === 1, 60000), "the editor opens once it is prepared");

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
