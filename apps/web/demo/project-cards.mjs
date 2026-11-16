// Project cards show the pictures of their newest edits: one fills the card, two side by side, three or four a 2x2 grid
// (never more than four); a project with no edits keeps its grey cover. The name stays readable on top. Desktop and
// phone. Runs on the demo build (node demo/build.mjs first).   node demo/project-cards.mjs   (from apps/web)
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

async function login(page) {
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
}

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  // Projects with 4 pictures, none (grey), 1, 6 (four shown) and 3, in turn.
  await ctx.addInitScript(() => { globalThis.__demoFolderPics = [4, 0, 1, 6, 3]; });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600); await login(page);
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.locator(".fcard[data-folder]").first().waitFor({ timeout: 8000 });
  await sleep(500);
  const cards = await page.$$eval(".fcard[data-folder]", (els) => els.map((el) => {
    const cover = el.querySelector(".cover"), imgs = [...el.querySelectorAll(".fpics img")];
    const r = cover.getBoundingClientRect();
    const name = el.querySelector(".ftxt b"), nr = name.getBoundingClientRect();
    return { pics: imgs.length, loaded: imgs.every((i) => i.complete && i.naturalWidth > 0), grey: !cover.classList.contains("pics"), cols: getComputedStyle(el.querySelector(".fpics") || cover).gridTemplateColumns.split(" ").length,
      inside: imgs.every((i) => { const b = i.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1; }),
      nameOnTop: name && getComputedStyle(name.closest(".ftxt")).zIndex === "1" || !imgs.length, nameShown: nr.width > 0 && nr.bottom <= r.bottom + 1 };
  }));
  const counts = cards.map((c) => c.pics);
  check(cards.length >= 5, `${tag}: the projects page lists the projects (${cards.length})`);
  check(cards.some((c) => c.pics === 4) && cards.some((c) => c.pics === 1) && cards.some((c) => c.pics === 3) && cards.some((c) => c.grey && c.pics === 0), `${tag}: cards show 4, 1 and 3 pictures, and a project with no edits stays grey (${counts.join(", ")})`);
  check(Math.max(...counts) <= 4, `${tag}: never more than 4 pictures on a card (a project with 6 edits shows 4)`);
  check(cards.every((c) => c.loaded && c.inside), `${tag}: every picture loads and stays inside its card`);
  check(cards.filter((c) => c.pics === 1).every((c) => c.cols === 1) && cards.filter((c) => c.pics >= 3).every((c) => c.cols === 2), `${tag}: one picture fills the card; three or four make a 2x2 grid`);
  check(cards.every((c) => c.nameShown && c.nameOnTop), `${tag}: the project's name stays on the card, over the pictures`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll(".fcard *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag}: the cards fit the screen`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `project-cards-${tag}.png`) });
  // A card still opens its project.
  await page.locator(".fcard[data-folder]").first().click();
  const opened = await page.locator(".folder").first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  check(opened, `${tag}: a card still opens its project`);
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
