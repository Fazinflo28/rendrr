// A whole project shared with one link (/review/:token of a folder): every video in it as a card (its picture, length,
// name) in a row that scrolls sideways, the picked one plays, no version switch (each video shows its newest version),
// and nothing wider than the screen on a phone. Made from the folder page's Share button, as a user does.
// Runs on the demo build (node demo/build.mjs first); screenshots go to SHOTS (optional).
//   node demo/review-folder.mjs   (from apps/web)
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

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(600);
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.locator("[data-folder]").first().waitFor({ timeout: 8000 }); await sleep(400);
  // The project folder with the most videos: open it, Share, make the link.
  const fid = await page.evaluate(() => { const fs = [...document.querySelectorAll(".fcard[data-folder]")].map((e) => ({ id: e.dataset.folder, n: Number((/(\d+) edits?/.exec(e.textContent) || [])[1] || 0) })); fs.sort((a, b) => b.n - a.n); return fs[0].id; });
  await page.locator(`.fcard[data-folder="${fid}"]`).click(); await page.locator("#share-folder").waitFor({ timeout: 8000 }); await sleep(400);
  const names = await page.$$eval("[data-asset]", (els) => [...new Set(els.map((e) => e.dataset.asset))]);
  await page.locator("#share-folder").click(); await sleep(400);
  await page.locator("#make-link").click(); await page.locator("#made-link code").waitFor({ timeout: 8000 });
  const link = (await page.locator("#made-link code").textContent()).trim();
  check(!!link, `${tag}: the folder's Share makes a link (${link || "none"})`);
  if (!link) { await ctx.close(); continue; }
  await page.evaluate((p) => globalThis.__rendrrNav.go(p), new URL(link).pathname); await page.locator("#rv-items").waitFor({ timeout: 8000 }); await sleep(800);
  const m = await page.evaluate(() => {
    const W = screen.width, cards = [...document.querySelectorAll("#rv-items .rv-item")];
    const wide = [...document.querySelectorAll(".rv *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > W + 1 || b.left < -1) && !e.closest("#rv-items"); }).map((e) => e.id || e.className || e.tagName).slice(0, 4);
    return { n: cards.length, names: cards.map((c) => c.querySelector(".rv-name").textContent), on: cards.filter((c) => c.classList.contains("on")).length, version: !!document.querySelector("#rv-version") || !!document.querySelector(".rv-top .seg"), head: document.querySelector(".rv-top .muted")?.textContent || "", scrollW: document.documentElement.scrollWidth, W, wide, thumbH: Math.round(cards[0]?.querySelector(".rv-thumb").getBoundingClientRect().height || 0) };
  });
  check(m.n >= 2 && m.n === names.length, `${tag}: every video of the project is a card (${m.n}: ${m.names.join(", ")})`);
  check(m.on === 1, `${tag}: one card is picked`);
  check(!m.version, `${tag}: no version switch (each video shows its newest version)`);
  check(/\d+ videos?/.test(m.head), `${tag}: the header says the project and how many videos (${m.head})`);
  check(await page.locator(".rv-top svg.appicon").count() === 1, `${tag}: the header shows the Rendrr app icon`);
  check(m.thumbH >= 100, `${tag}: the cards show a picture area (${m.thumbH} px tall)`);
  check(m.scrollW <= m.W && m.wide.length === 0, `${tag}: nothing wider than the screen (${m.wide.join(", ") || "ok"})`);
  // Pick the second video: it is the one picked and the one playing.
  await page.locator("#rv-items .rv-item").nth(1).click(); await sleep(400);
  const picked = await page.evaluate(() => [...document.querySelectorAll("#rv-items .rv-item")].findIndex((c) => c.classList.contains("on")));
  check(picked === 1, `${tag}: tapping a card picks that video`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `review-folder-${tag}.png`), fullPage: true });
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
