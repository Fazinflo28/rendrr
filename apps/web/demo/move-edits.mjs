// Moving videos (edits) into another project from a project's page: "Move to project" in a card's menu, or Move for
// the selected ones. The window lists the other projects (this one says "Here now") and makes a new one on the spot.
// Moved edits leave the page at once and Undo brings them back. Desktop and phone.
// Runs on the demo build (node demo/build.mjs first).   node demo/move-edits.mjs   (from apps/web)
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
const cards = (page) => page.$$eval(".acard[data-asset]", (els) => els.map((e) => e.dataset.asset));

async function login(page) {
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
}
async function openProject(page, id) {
  await page.evaluate((x) => globalThis.__rendrrNav.go("/projects/" + x), id);
  await page.locator(".acard[data-asset]").first().waitFor({ timeout: 8000 }); await sleep(300);
}

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600); await login(page);

  // "Engine Room PT" (f2) holds three edits.
  await openProject(page, "f2");
  const before = await cards(page);
  check(before.length === 3, `${tag}: the project shows its 3 edits (${before.length})`);
  const first = before[0];

  // One edit: the card's menu.
  await page.locator(`.acard[data-asset="${first}"] [aria-label="More"]`).click();
  const item = page.locator(`[data-move-edit="${first}"]`);
  check(await item.isVisible(), `${tag}: the card's menu has Move to project`);
  await item.click();
  await page.locator("#move-project-list").waitFor({ timeout: 4000 }); await sleep(500);
  const rows = await page.$$eval("[data-move-project]", (els) => els.map((e) => e.dataset.moveProject));
  const hereNow = await page.locator("#move-project-list .lfrow.on").textContent();
  check(rows.length === 4 && !rows.includes("f2") && /Engine Room PT/.test(hereNow) && /Here now/.test(hereNow), `${tag}: the window lists the 4 other projects; this one says Here now (${rows.join(", ")})`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll(".modal *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag}: the window fits the screen`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `move-edits-${tag}.png`) });
  await page.locator('[data-move-project="f4"]').click(); await sleep(700);
  const after = await cards(page);
  const toast = await page.locator(".toast").last().textContent().catch(() => "");
  check(after.length === 2 && !after.includes(first), `${tag}: the moved edit leaves the page at once (${after.length} left)`);
  check(/Moved to Founder Stories/.test(toast), `${tag}: the toast says where it went (${toast})`);
  check((await page.evaluate(() => globalThis.__demoMoves.at(-1))).folderId === "f4", `${tag}: the move is sent with the project picked`);

  // Undo brings it back here.
  await page.locator('.toast [data-toast-action="Undo"]').last().click(); await sleep(1000);
  const back = await cards(page);
  check(back.length === 3 && back.includes(first), `${tag}: Undo brings it back (${back.length})`);
  check((await page.evaluate(() => globalThis.__demoMoves.at(-1))).folderId === "f2", `${tag}: Undo moves it back to this project`);

  // Two selected ones into a new project.
  const two = back.slice(0, 2);
  for (const id of two) await page.locator(`.acard[data-asset="${id}"] .acheck`).click();
  await page.locator("#move-selected").click();
  await page.locator("#move-project-name").waitFor({ timeout: 4000 });
  const title = await page.locator(".modal h2, .modal .t-title, .modal h3").first().textContent().catch(() => "");
  check(/Move 2 videos/.test(title), `${tag}: the window is for the 2 selected (${title})`);
  const name = `Client ${tag}`;
  await page.locator("#move-project-name").fill(name); await page.locator("#move-project-new").click();
  await page.waitForFunction(() => document.querySelectorAll(".acard[data-asset]").length === 1, null, { timeout: 5000 }).catch(() => {});
  const left = await cards(page);
  check(left.length === 1 && !two.some((id) => left.includes(id)), `${tag}: both leave the page (${left.length} left)`);
  check(new RegExp(`2 videos moved to ${name}`).test(await page.locator(".toast").last().textContent().catch(() => "")), `${tag}: the toast says 2 moved into the new project`);
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.locator(".fcard[data-folder]").first().waitFor({ timeout: 8000 }); await sleep(500);
  const made = await page.$$eval(".fcard[data-folder]", (els, n) => els.filter((e) => e.textContent.includes(n)).map((e) => e.dataset.folder), name);
  check(made.length === 1, `${tag}: the new project is on the Projects page`);
  if (made.length) { await openProject(page, made[0]); check((await cards(page)).length === 2, `${tag}: the new project holds the 2 moved videos`); }
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
