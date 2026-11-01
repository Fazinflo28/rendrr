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

// 6b. Folders inside folders: Course > Module 1, a video in the inner one, the path at the top, the counts, editing
// the outer folder takes the inner one's videos, moving a folder (drag and the Move window), deleting the outer one.
const make = async (name) => { await page.locator("#new-folder").click(); await page.locator("#folder-name-input").fill(name); await page.locator("#folder-save").click(); await until(async () => !(await page.locator("#folder-name-input").count())); };
await make("Course");
const courseId = await page.locator(".lfcard", { hasText: "Course" }).getAttribute("data-folder");
await page.locator(`.lfcard[data-folder="${courseId}"]`).click(); await page.locator("#folder-title").waitFor();
check((await page.locator("#new-folder").textContent()).includes("New folder here"), "inside a folder the button makes a folder here");
await make("Module 1");
const modId = await page.locator(".lfcard", { hasText: "Module 1" }).getAttribute("data-folder");
check(await until(async () => (await page.locator(".lfcard").count()) === 1), "the new folder shows inside Course");
await page.locator("#folder-back").click(); await page.locator(".vcard").first().waitFor();
const [v1, v2] = await page.locator('.vcard[data-status="ready"]').evaluateAll((els) => els.slice(0, 2).map((e) => e.dataset.id));
await page.locator(`[data-move="${v1}"]`).click();
check(await page.locator(`#move-list [data-move-to="${modId}"]`).isVisible(), "the Move window lists the folder inside Course");
const indent = await page.evaluate(([a, b]) => parseFloat(getComputedStyle(document.querySelector(`[data-move-to="${b}"]`)).paddingLeft) - parseFloat(getComputedStyle(document.querySelector(`[data-move-to="${a}"]`)).paddingLeft), [courseId, modId]);
check(indent > 10, `a folder inside a folder is indented under it (${indent}px)`);
await page.locator(`#move-list [data-move-to="${modId}"]`).click();
await page.locator(`[data-move="${v2}"]`).click(); await page.locator(`#move-list [data-move-to="${courseId}"]`).click();
check(await until(async () => (await page.locator(`.lfcard[data-folder="${courseId}"]`).textContent()).includes("2 videos · 1 folder")), "Course counts its own video and its folder's, and its folder");
await page.locator(`.lfcard[data-folder="${courseId}"]`).click(); await page.locator(`.lfcard[data-folder="${modId}"]`).click();
check(await until(async () => (await page.locator("#folder-title").textContent()).includes("Module 1")), "opening the inner folder");
const crumbText = (await page.locator("#folder-crumbs").innerText()).replace(/\s+/g, " ").trim();
check(crumbText === "Library / Course /", `the path at the top: Library / Course / (${crumbText})`);
check((await page.locator(".vcard").count()) === 1, "the inner folder shows its one video");
await page.locator(`#folder-crumbs [data-crumb="${courseId}"]`).click(); await until(async () => (await page.locator("#folder-title").textContent()).includes("Course"));
await page.waitForTimeout(400); await page.screenshot({ path: join(here, "dist", "library-subfolders.png") });
await page.locator("#folder-edit").click(); await page.locator("#np-videos-order").waitFor();
const ord = await page.locator("#np-videos-order .vorow").evaluateAll((els) => els.map((e) => e.dataset.order));
check(JSON.stringify(ord) === JSON.stringify([v2, v1]), "Edit this folder takes Course's own video, then its folder's");
check((await page.locator(".modal").textContent()).includes("and its folders"), "the window says it takes the videos in its folders too");
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
if (await page.locator("#np-videos-order").count()) await page.locator(".modal button", { hasText: "Cancel" }).click();
// Move Module 1 to the top with the Move window, then drag it back onto Course.
await page.locator(`.lfcard[data-folder="${modId}"]`).click(); await until(async () => (await page.locator("#folder-title").textContent()).includes("Module 1"));
await page.locator("#folder-move").click();
check(!(await page.locator(`#move-folder-list [data-move-to="${modId}"]`).count()), "a folder cannot be moved into itself (it is not in the list)");
await page.locator("#move-folder-top").click();
check(await until(async () => (await page.locator("#folder-crumbs").innerText()).replace(/\s+/g, " ").trim() === "Library /"), `Move to the top of the Library (${(await page.locator("#folder-crumbs").innerText()).trim()})`);
await page.locator("#folder-back").click(); await page.locator(`.lfcard[data-folder="${modId}"]`).waitFor();
const dt2 = await page.evaluateHandle(() => new DataTransfer());
await page.locator(`.lfcard[data-folder="${modId}"]`).dispatchEvent("dragstart", { dataTransfer: dt2 });
await page.locator(`.lfcard[data-folder="${courseId}"]`).dispatchEvent("dragover", { dataTransfer: dt2 });
await page.locator(`.lfcard[data-folder="${courseId}"]`).dispatchEvent("drop", { dataTransfer: dt2 });
check(await until(async () => !(await page.locator(`.lfcard[data-folder="${modId}"]`).count()) && (await page.locator(`.lfcard[data-folder="${courseId}"]`).textContent()).includes("1 folder")), "dragging a folder onto another puts it inside");
// Delete Course: its video and Module 1 move up to the top.
await page.locator(`.lfcard[data-folder="${courseId}"]`).click(); await page.locator("#folder-title").waitFor();
await page.locator("#folder-delete").click();
check((await page.locator(".modal").textContent()).includes("videos and folders move up into the Library"), "deleting says what is in it moves up");
await page.locator("#folder-delete-ok").click();
check(await until(async () => (await page.locator(`.lfcard[data-folder="${modId}"]`).count()) === 1 && !(await page.locator(`.lfcard[data-folder="${courseId}"]`).count())), "after deleting Course, Module 1 is at the top");
check(await until(async () => (await page.locator(`.vcard[data-id="${v2}"]`).count()) === 1), "Course's own video is back in the Library");
check(await until(async () => !(await page.locator(".modal").count())), "the delete window closes");

// 6c. Import a whole Google Drive folder: open it in the picker, Import this folder; the Library opens on a folder
// named after it, its Drive folders inside, no video picked one by one.
await page.locator("#upload").click(); await page.locator("#src-drive").click();
if (await page.locator("#connect-drive").count()) { await page.locator("#connect-drive").click(); }
await page.locator("#drive-list").waitFor(); await page.waitForTimeout(300);
check(await page.locator("#drive-import-hint").isVisible() && !(await page.locator("#drive-import-folder").count()), "at the top of My Drive there is nothing to import, and a hint says how");
await page.locator('[data-folder-id="fd2"]').click();
await page.locator("#drive-import-folder").waitFor();
check((await page.locator("#drive-import-bar").innerText()).includes("Client footage"), "inside a Drive folder: Import this folder, naming it");
await page.locator("#drive-import-folder").click();
check(await until(async () => (await page.locator("#folder-title").count()) && (await page.locator("#folder-title").innerText()).toLowerCase().includes("client footage"), 6000), "the Library opens on the imported folder");
check(await until(async () => (await page.locator(".lfcard", { hasText: "BFS Health" }).count()) === 1), "its Drive folder comes in as a folder inside it");
// It stays linked to Drive: it says so, and Sync now takes in a video put in the Drive folder since.
check(/Linked to its Google Drive folder: new videos put there come in by themselves/.test(await page.locator("#folder-drive").innerText()), "the folder says it is linked to Google Drive");
const vBefore = await page.locator(".vcard").count();
await page.evaluate(() => { globalThis.__rendrrDriveNew = "df7"; }); // a video put in the Drive folder after the import
await page.locator("#folder-sync").click();
check(await until(async () => (await page.locator(".toast", { hasText: "1 new video from Google Drive" }).count()) > 0, 4000), "Sync now: a video put in the Drive folder later comes in");
check(await until(async () => (await page.locator(".vcard").count()) === vBefore + 1, 4000), "and shows in the folder");
await page.locator("#folder-sync").click();
check(await until(async () => (await page.locator(".toast", { hasText: "Nothing new in the Google Drive folder" }).count()) > 0, 4000), "nothing new: it says so");
await page.locator(".lfcard", { hasText: "BFS Health" }).click();
check(await until(async () => (await page.locator(".vcard").count()) > 0), "the videos from the Drive folder are in it, without picking them");
await page.screenshot({ path: join(here, "dist", "library-drive-import.png") });
await page.locator("#folder-back").click(); await page.locator("#lib-folders").waitFor();

// 6d. A whole folder from the computer: Choose a folder; the Library makes the same folders and opens the top one; only
// the videos come in (a text file in it is left out).
const tmp = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "lf-"));
const fsx = await import("node:fs");
fsx.mkdirSync(join(tmp, "Shoot", "Day 1"), { recursive: true });
fsx.writeFileSync(join(tmp, "Shoot", "Intro.mp4"), "x"); fsx.writeFileSync(join(tmp, "Shoot", "notes.txt"), "x");
fsx.writeFileSync(join(tmp, "Shoot", "Day 1", "Take 1.mp4"), "x"); fsx.writeFileSync(join(tmp, "Shoot", "Day 1", "Take 2.mov"), "x");
const beforeVids = await page.evaluate(async () => (await (await import("rendrr-fake-api").catch(() => ({ api: null }))).api?.listVideos?.())?.length ?? -1).catch(() => -1);
await page.locator("#upload").click(); await page.locator("#src-local").click();
check(await page.locator("#local-choose-folder").isVisible(), "From your computer offers Choose a folder");
await page.locator("#local-folder-input").setInputFiles(join(tmp, "Shoot"));
check(await until(async () => (await page.locator("#folder-title").count()) > 0 && (await page.locator("#folder-title").innerText()).toLowerCase().includes("shoot"), 6000), "the Library opens on a folder named after the one picked");
check(await until(async () => (await page.locator(".lfcard", { hasText: "Day 1" }).count()) === 1), "its folder inside comes in as a folder");
check(await until(async () => (await page.locator(".vcard").count()) === 1), "the top folder holds its one video (the text file is left out)");
await page.locator(".lfcard", { hasText: "Day 1" }).click();
check(await until(async () => (await page.locator(".vcard").count()) === 2), "the inner folder holds its two videos");
await page.locator("#folder-back").click(); await page.locator("#lib-folders").waitFor();
fsx.rmSync(tmp, { recursive: true, force: true }); void beforeVids;

// 6e. Several Drive folders at once: tick them (ticking does not open the folder), Select all folders ticks every one
// here, a folder ticked inside a ticked one is not brought in twice, and one button imports them all.
await page.locator("#upload").click(); await page.locator("#src-drive").click();
await page.locator("#drive-list").waitFor(); await until(async () => (await page.locator('[data-pick-folder="fd1"]').count()) === 1);
check(await page.locator('[data-folder-id="fd1"] input[type="checkbox"]').isVisible(), "each Drive folder has a tick box");
await page.locator('[data-pick-folder="fd1"]').check();
check((await page.locator("#drive-crumbs").innerText()).trim() === "My Drive", "ticking a folder does not open it");
check((await page.locator("#drive-count").innerText()) === "1 folder selected" && (await page.locator("#drive-add").innerText()).includes("Import 1 folder"), "the button says it imports the folder");
await page.locator("#drive-select-folders").click();
check((await page.locator("#drive-count").innerText()) === "3 folders selected" && (await page.locator("#drive-select-folders").innerText()) === "Unselect these folders", "Select all folders ticks every folder here");
await page.locator("#drive-select-folders").click();
check(!(await page.locator("#drive-count").count()), "and unticks them again");
await page.locator('[data-pick-folder="fd1"]').check(); await page.locator('[data-pick-folder="fd2"]').check(); await page.locator('[data-pick-folder="fd3"]').check();
await page.locator('[data-folder-id="fd2"] b').click(); await until(async () => (await page.locator('[data-pick-folder="fdB"]').count()) === 1);
check((await page.locator("#drive-crumbs").innerText()).includes("Client footage"), "a click on the folder's name still opens it");
await page.locator('[data-pick-folder="fdB"]').check();
// A video from somewhere else in the Drive (Shared with me) ticked too: the folders stay ticked.
await page.locator('[data-place="shared"]').click(); await until(async () => (await page.locator('[data-folder-id="fdS"]').count()) === 1);
await page.locator('[data-folder-id="fdS"] b').click(); await until(async () => (await page.locator('input[data-file-id="df2"]').count()) === 1);
await page.locator('input[data-file-id="df2"]').check();
check((await page.locator("#drive-count").innerText()) === "4 folders, 1 video selected" && (await page.locator("#drive-add").innerText()).includes("Add 1 video and 4 folders"), "folders and videos ticked together: one button for all");
check(await page.locator("#drive-picked-subs").isChecked(), "With their folders is on");
await page.locator("#drive-add").click();
const toasts = []; for (let i = 0; i < 120 && !toasts.length; i++) { await page.waitForTimeout(150); for (const t of await page.locator(".toast").allInnerTexts()) if (/Imported/.test(t)) toasts.push(t); } console.log("  toast:", toasts.join(" | "));
check(toasts.some((t) => t.includes("Imported 3 folders")), "the three folders come in (BFS Health inside Client footage comes with it, not twice)");
check(await until(async () => !(await page.locator(".modal").count())), "the window closes");
check(await until(async () => !(await page.locator("#folder-title").count()) && (await page.locator(".lfcard", { hasText: "Podcast raw" }).count()) === 1 && (await page.locator(".lfcard", { hasText: "B-roll" }).count()) === 1), "the Library opens at its top with each folder in it");
check((await page.locator(".lfcard", { hasText: "BFS Health" }).count()) === 0, "BFS Health is not also at the top");
await page.screenshot({ path: join(here, "dist", "library-drive-multi.png") });
// At phone width the ticks, the count and the button fit.
await page.setViewportSize({ width: 390, height: 844 });
await page.locator("#upload").click().catch(async () => { await page.locator('[data-mtab="Add"]').click(); });
if (!(await page.locator("#src-drive").count())) await page.locator('[data-mtab="Add"]').click();
await page.locator("#src-drive").click(); await until(async () => (await page.locator('[data-pick-folder="fd1"]').count()) === 1);
await page.locator('[data-pick-folder="fd1"]').check(); await page.locator('[data-pick-folder="fd3"]').check();
const tick = await page.locator('[data-folder-id="fd1"] .dcheck').boundingBox();
const btn = await page.locator("#drive-add").boundingBox();
check(tick && tick.width >= 30 && tick.height >= 30, `at phone width a folder's tick is big enough to tap (${tick && Math.round(tick.width)}x${tick && Math.round(tick.height)})`);
console.log("  btn:", JSON.stringify(btn), await page.locator("#drive-add").innerText().catch(() => "-"));
check(btn && btn.x >= 0 && btn.x + btn.width <= 391 && (await page.locator("#drive-add").innerText()).includes("Import 2 folders"), "at phone width the Import button fits the screen");
await page.screenshot({ path: join(here, "dist", "library-drive-multi-phone.png") });
await page.keyboard.press("Escape"); await until(async () => !(await page.locator(".modal").count()));
if (await page.locator(".modal").count()) await page.locator(".modal [aria-label='Close']").first().click().catch(() => {});
await page.setViewportSize({ width: 1440, height: 1000 });

// 7. Phone width: the folder row fits.
await page.setViewportSize({ width: 390, height: 844 }); await page.locator("#new-folder").click(); await page.locator("#folder-name-input").fill("Interviews"); await page.locator("#folder-save").click(); await page.waitForTimeout(400);
await until(async () => (await page.locator(".lfcard", { hasText: "Interviews" }).count()) === 1); await page.locator('input[aria-label="Find footage"]').scrollIntoViewIfNeeded();
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check(fits, "at phone width the Library has no sideways scroll");
await page.screenshot({ path: join(here, "dist", "library-folders-phone.png") });

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
