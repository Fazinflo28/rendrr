// Library folders in the browser: make a folder, put videos in it (the folder button on a card, Select then Move,
// dragging a card onto the folder), open it (its videos in name order), rename it, "Edit this folder" opens the new
// edit with its ready videos in that order, and deleting the folder leaves the videos in the Library. Runs on the demo
// build (node demo/build.mjs first) in Playwright's Chromium.   node demo/library-folders.mjs   (from apps/web)
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
// The demo backend answers after a short wait: look again until it shows (up to 4 s).
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await page.waitForTimeout(100); } };

await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.locator(".vcard").first().waitFor(); await page.waitForTimeout(500);

// 1. No folders yet: the row explains; New folder makes one.
check(await page.locator("#lib-folders").isVisible(), "the Library shows a Folders row");
await page.locator("#new-folder").click(); await page.locator("#folder-name-input").fill("Course parts");
await page.locator("#folder-save").click(); await page.locator(".lfcard").first().waitFor();
check((await page.locator(".lfcard .lfname").allTextContents()).includes("Course parts"), "New folder makes a folder card");
const folderId = await page.locator(".lfcard").first().getAttribute("data-folder");
await page.locator("#new-folder").click(); await page.locator("#folder-name-input").fill("course parts"); await page.locator("#folder-save").click(); await page.waitForTimeout(300);
check(await page.locator('[role="alert"]', { hasText: "already have a folder" }).isVisible(), "a second folder with the same name is refused");
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
if (await page.locator("#folder-name-input").count()) await page.locator(".modal button", { hasText: "Cancel" }).click();

// 2. Put videos in it: the folder button on a card, then Select + Move to folder, then drag a card onto the folder.
const readyIds = await page.locator('.vcard[data-status="ready"]').evaluateAll((els) => els.map((e) => e.dataset.id));
check(readyIds.length >= 3, `at least 3 ready videos in the demo library (${readyIds.length})`);
const [a, b, c] = readyIds;
const before = await page.locator(".vcard").count();
await page.locator(`[data-move="${a}"]`).click(); await page.locator(`[data-move-to="${folderId}"]`).click(); await page.waitForTimeout(400);
check(await until(async () => !(await page.locator(`.vcard[data-id="${a}"]`).count())), "a video moved into the folder leaves the top of the Library");
check(await until(async () => (await page.locator(`.lfcard[data-folder="${folderId}"]`).textContent()).includes("1 video")), "the folder card counts 1 video");
await page.locator("#select-videos").click();
await page.locator(`.vcard[data-id="${b}"]`).click();
await page.locator("#pick-move").click(); await page.locator(`[data-move-to="${folderId}"]`).click(); await page.waitForTimeout(400);
check(await until(async () => !(await page.locator(`.vcard[data-id="${b}"]`).count()) && !(await page.locator("#pick-bar").count())), "Select, then Move to folder, moves the picked video and ends Select");
const dt = await page.evaluateHandle(() => new DataTransfer());
await page.locator(`.vcard[data-id="${c}"]`).dispatchEvent("dragstart", { dataTransfer: dt });
await page.locator(`.lfcard[data-folder="${folderId}"]`).dispatchEvent("dragover", { dataTransfer: dt });
await page.locator(`.lfcard[data-folder="${folderId}"]`).dispatchEvent("drop", { dataTransfer: dt }); await page.waitForTimeout(500);
check(await until(async () => !(await page.locator(`.vcard[data-id="${c}"]`).count())), "dragging a card onto the folder moves it in");
check(await until(async () => (await page.locator(`.lfcard[data-folder="${folderId}"]`).textContent()).includes("3 videos")), "the folder card counts 3 videos");
check((await page.locator(".vcard").count()) === before - 3, "the top of the Library shows the videos in no folder");

// 3. Open the folder: its videos in name order; the actions.
await page.locator(`.lfcard[data-folder="${folderId}"]`).click(); await page.locator("#folder-title").waitFor();
check((await page.locator("#folder-title").textContent()).includes("Course parts"), "opening the folder shows its name as the title");
const inside = await page.locator(".vcard .meta b.t-label").allTextContents();
const sorted = [...inside].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }));
check(inside.length === 3 && JSON.stringify(inside) === JSON.stringify(sorted), `the folder lists its 3 videos in name order (${inside.join(" | ")})`);
check(await page.locator("#folder-edit").isVisible() && await page.locator("#folder-add").isVisible(), "Edit this folder and Add videos are there");
await page.locator("#folder-add").click(); await page.waitForTimeout(300);
check((await page.locator("#add-into-folder").textContent()).includes("Course parts"), "Add videos says they go in the folder");
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
if (await page.locator("#add-into-folder").count()) await page.locator(".modal [aria-label='Close']").first().click().catch(() => {});

await page.screenshot({ path: join(here, "dist", "library-folders-open.png") });
// 4. Rename.
await page.locator("#folder-rename").click(); await page.locator("#folder-name-input").fill("Course: module 1"); await page.locator("#folder-save").click();
check(await until(async () => (await page.locator("#folder-title").textContent()).includes("Course: module 1")), "Rename changes the folder's name");

// 5. Edit this folder: the new edit lists the folder's ready videos in name order, named after the folder.
await page.locator("#folder-edit").click(); await page.locator("#np-videos-order").waitFor();
const order = await page.locator("#np-videos-order .vorow .vname").allTextContents();
check(JSON.stringify(order) === JSON.stringify(sorted), `the new edit has the folder's videos in name order (${order.join(" | ")})`);
check((await page.locator("#np-name").inputValue()) === "Course: module 1", "the edit is named after the folder");
check((await page.locator("#create-project").textContent()).includes("3 videos"), "the button makes one edit from 3 videos");
await page.locator("#create-project").click();
await page.locator("#timeline").waitFor({ timeout: 8000 }); await page.waitForTimeout(600);
check(await page.locator("#timeline").isVisible(), "creating it opens the editor");

// 6. Back in the Library (the folder is still open): delete the folder, the videos stay.
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.locator("#folder-title").waitFor();
check(true, "the Library comes back to the open folder");
await page.locator("#folder-delete").click(); await page.locator("#folder-delete-ok").click();
check(await until(async () => !(await page.locator(".lfcard").count()) && (await page.locator(".vcard").count()) === before), "deleting the folder leaves its videos in the Library");

// 7. Phone width: the folder row fits.
await page.setViewportSize({ width: 390, height: 844 }); await page.locator("#new-folder").click(); await page.locator("#folder-name-input").fill("Interviews"); await page.locator("#folder-save").click(); await page.waitForTimeout(400);
await until(async () => (await page.locator(".lfcard").count()) === 1); await page.locator('input[aria-label="Find footage"]').scrollIntoViewIfNeeded();
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check(fits, "at phone width the Library has no sideways scroll");
await page.screenshot({ path: join(here, "dist", "library-folders-phone.png") });

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
