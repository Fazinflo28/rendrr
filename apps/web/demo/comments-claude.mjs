// Comments made in the Rendrr app in Claude, in the editor: a note shows its picture (opens in a new tab), its link,
// and its drawing (on the picture at its moment, paused); the user's own note can be edited; any comment deleted after
// a second click; a resolved comment has no marks on the bars. Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/comments-claude.mjs   (from apps/web)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
await page.locator("#tab-comments").click(); await sleep(300);

const note = page.locator('[data-comment="cm_claude"]');
check((await note.count()) === 1, "the note from Claude is in the Comments tab");
check((await note.locator("a", { hasText: "https://example.com/ref" }).getAttribute("href")) === "https://example.com/ref" && (await note.locator("a", { hasText: "example.com" }).getAttribute("target")) === "_blank", "its web address is a link that opens in a new tab");
const img = note.locator("img.cmt-img");
check((await img.count()) === 1 && (await img.evaluate((e) => e.complete && e.naturalWidth > 0)) && (await note.locator("a:has(img)").getAttribute("target")) === "_blank", "its picture shows, and opens big in a new tab");
// The drawing: on the picture at its moment, paused.
await note.locator(".cmt-badge", { hasText: "Drawing" }).click(); await sleep(500);
const ink = page.locator("svg.cmt-ink polyline");
check((await ink.count()) === 1 && (await ink.getAttribute("stroke")) === "#ffd60a" && (await ink.getAttribute("points")).startsWith("0.3,0.3 0.45,0.32"), "its drawing shows on the picture");
const where = await page.evaluate(() => { const s = document.querySelector("svg.cmt-ink").getBoundingClientRect(), sc = document.querySelector(".screen").getBoundingClientRect(); return { same: Math.abs(s.width - sc.width) < 2 && Math.abs(s.height - sc.height) < 2 && Math.abs(s.left - sc.left) < 2 }; });
check(where.same, "exactly over the picture");
await page.screenshot({ path: join(here, "dist", "comments-claude.png") });
await page.keyboard.press("Space"); await sleep(400);
check((await page.locator("svg.cmt-ink").count()) === 0, "and goes away when it plays");
await page.keyboard.press("Space"); await sleep(200);
// Edit the note.
await note.locator("button.cmt-act", { hasText: "Edit" }).click();
await page.locator('input[aria-label="Edit comment"]').fill("Logo 20% smaller");
await page.locator('input[aria-label="Edit comment"]').press("Enter"); await sleep(300);
check(/Logo 20% smaller/.test(await note.innerText()) && /edited/.test(await note.innerText()), "the note's words can be edited");
// Done: a resolved comment's marks leave the player's bar and the timeline; reopened, they come back.
const marks = () => page.evaluate(() => ({ bar: document.querySelectorAll(".player .mark, .screen ~ * .mark, .mark").length, ruler: document.querySelectorAll("#timeline .cm").length }));
const before = await marks();
await note.locator("button.cmt-check").click(); await sleep(300);
const doneMarks = await marks();
check(before.bar >= 1 && before.ruler >= 1 && doneMarks.bar === before.bar - 1 && doneMarks.ruler === before.ruler - 1, `a resolved comment's marks leave the bars (player ${before.bar} -> ${doneMarks.bar}, timeline ${before.ruler} -> ${doneMarks.ruler})`);
await page.locator("#cm-filter-all").click(); await sleep(200);
await note.locator("button.cmt-check").click(); await sleep(300);
const back = await marks();
check(back.bar === before.bar && back.ruler === before.ruler, "reopened, they come back");
// Delete asks first.
const del = note.locator('button[aria-label="Delete comment"]');
await del.click(); await sleep(100);
check((await del.innerText()) === "Delete?" && (await note.count()) === 1, "Delete asks once more");
await del.click(); await sleep(300);
check((await page.locator('[data-comment="cm_claude"]').count()) === 0, "and then deletes the note");

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
