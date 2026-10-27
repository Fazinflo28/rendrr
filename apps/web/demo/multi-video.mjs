// Several videos into one edit, in the browser: the Library's Select mode numbers the videos in the order clicked,
// "Make one edit" opens the new edit with them in that order (reorder, leave one out), and the editor's Add videos
// puts several whole videos into the sequence one after another. Runs on the demo build (node demo/build.mjs first)
// in Playwright's Chromium.   node demo/multi-video.mjs   (from apps/web)
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

await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.locator(".vcard").first().waitFor(); await page.waitForTimeout(500);

// 1. Select mode: the bar explains, clicks number the ready videos in order, a video still processing is refused.
await page.locator("#select-videos").click();
check(await page.locator("#pick-bar").isVisible(), "Select shows the selection bar");
const readyIds = await page.locator('.vcard[data-status="ready"]').evaluateAll((els) => els.map((e) => e.dataset.id));
const busy = page.locator('.vcard:not([data-status="ready"])').first();
check(readyIds.length >= 3, `at least 3 ready videos in the demo library (${readyIds.length})`);
const [a, b, c] = readyIds;
for (const id of [b, a, c]) await page.locator(`.vcard[data-id="${id}"]`).click();
const nums = await page.evaluate((ids) => ids.map((id) => document.querySelector(`.vcard[data-id="${id}"] .vpick`)?.textContent), [a, b, c]);
check(JSON.stringify(nums) === JSON.stringify(["2", "1", "3"]), `numbers follow the click order (${nums.join(",")})`);
check((await page.locator("#pick-count").textContent()) === "3 selected", "the bar counts 3 selected");
if (await busy.count()) { await busy.click(); await page.waitForTimeout(300); check(await page.locator("text=is not ready yet").first().isVisible(), "a video still processing is refused with a message"); }
await page.locator(`.vcard[data-id="${c}"]`).click(); await page.locator(`.vcard[data-id="${c}"]`).click(); // off and on again: it goes to the end
check((await page.locator(`.vcard[data-id="${c}"] .vpick`).textContent()) === "3", "a video picked again goes to the end");

// 2. Make one edit: the modal lists them in that order; move one up, leave one out.
await page.locator("#pick-make").click(); await page.locator("#np-videos-order").waitFor();
const names = async () => page.locator("#np-videos-order .vorow .vname").allTextContents();
const first = await names();
check(first.length === 3, `the new edit lists 3 videos in order (${first.join(" | ")})`);
check((await page.locator("#create-project").textContent()).includes("3 videos"), "the button says it makes an edit from 3 videos");
await page.locator("#np-videos-order .vorow").nth(1).locator("button.up").click();
const moved = await names();
check(moved[0] === first[1] && moved[1] === first[0], "moving the second video up swaps the first two");
await page.locator("#np-videos-order .vorow").nth(2).locator('button[aria-label^="Leave out"]').click();
check((await names()).length === 2, "leaving one out leaves 2");
await page.locator("#create-project").click();
await page.locator("#timeline").waitFor({ timeout: 8000 }); await page.waitForTimeout(800);
check(/\/editor\//.test(await page.evaluate(() => location.pathname + location.hash)) || await page.locator("#timeline").isVisible(), "creating it opens the editor");

// 3. The editor's Add videos: several whole videos, in order, at the end.
const before = await page.locator(".track-v1 .clip, [data-track='v1'] .clip").count().catch(() => 0);
await page.locator("#add-clip").click(); await page.locator("#add-videos").waitFor();
const rows = page.locator("#add-videos .prow");
await rows.nth(2).waitFor();
check((await rows.count()) >= 3, `Add videos lists the ready videos (${await rows.count()})`);
await rows.nth(1).locator("input").check(); await rows.nth(2).locator("input").check();
check((await page.locator("#add-clip-go").textContent()).includes("Add 2 videos"), "the button says Add 2 videos");
await page.locator("#add-clip-go").click(); await page.waitForTimeout(1200);
const toasts = await page.locator(".toast").allTextContents().catch(() => []);
check(toasts.some((t) => t.includes("Added 2 videos, one after another")), `the editor says it added 2 videos (${toasts.join(" | ")})`);
const after = await page.locator(".track-v1 .clip, [data-track='v1'] .clip").count().catch(() => 0);
if (before) check(after >= before + 2, `V1 has 2 more clips (${before} > ${after})`);

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `FAIL: ${fails.length} checks` : "PASS: several videos become one edit, in the order picked");
process.exit(fails.length ? 1 : 0);
