// The editor's right panel, like Higgsfield's: two tabs (Edit, Comments); Edit lists the tools in two cards, each tool
// opens on its own page under a back arrow, its icon and name; a comment pin on the timeline opens Comments; no tool
// page is wider than the panel, on a desktop or a phone. Runs on the demo build (node demo/build.mjs first) in
// Playwright's Chromium.
//   node demo/panel.mjs   (from apps/web)
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
const TOOLS = { transcript: "Transcript", clip: "Speed & motion", text: "Text & captions", audio: "Audio", color: "Color", multicam: "Multicam", style: "Reference", ai: "What your AI did" };

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
  return { page, errors };
}
// Anything in the panel wider than the panel itself (a row cut off at the right edge).
const overflow = (page) => page.evaluate(() => {
  const p = document.querySelector(".ed-body > .panel").getBoundingClientRect();
  return [...document.querySelectorAll(".ed-body > .panel *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > p.right + 1; }).map((e) => e.id || e.className || e.tagName).slice(0, 3);
});

for (const [tag, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const { page, errors } = await open(w, h);
  const tabs = await page.locator(".panel > .tabs [role=tab]").allInnerTexts();
  check(tabs.length === 2 && /^Edit/.test(tabs[0].trim()) && /^Comments/.test(tabs[1].trim()), `${tag}: two tabs, Edit and Comments (${tabs.map((t) => t.trim()).join(" | ")})`);
  check(await page.locator("#tab-edit").getAttribute("aria-selected") === "true", `${tag}: it opens on Edit`);
  const cards = await page.locator("#edit-tools .rp-card-h").allInnerTexts();
  check(cards.join("|").toUpperCase() === "EDIT VIDEO|YOUR AI", `${tag}: the tools sit in two cards (${cards.join(", ")})`);
  const rows = await page.locator("#edit-tools .rp-row .grow").allInnerTexts();
  check(rows.join("|") === Object.values(TOOLS).join("|"), `${tag}: every tool is listed once (${rows.join(", ")})`);
  check((await overflow(page)).length === 0, `${tag}: the Edit list fits the panel`);
  for (const [k, label] of Object.entries(TOOLS)) {
    await page.locator("#tab-" + k).click(); await sleep(250);
    const head = (await page.locator("#tool-head b").innerText()).trim();
    const gone = await page.locator(".panel > .tabs").count() === 0;
    const wide = await overflow(page);
    check(head === label && gone && wide.length === 0, `${tag}: ${label} opens on its own page under a back arrow, nothing cut off${wide.length ? " (" + wide.join(", ") + ")" : ""}`);
    await page.locator("#tool-back").click(); await sleep(200);
    if (await page.locator("#edit-tools").count() !== 1) { check(false, `${tag}: back from ${label} returns to the list`); break; }
  }
  check(await page.locator("#edit-tools").count() === 1, `${tag}: the back arrow returns to the list`);
  if (tag === "desktop") {
    await page.locator("#tab-audio").click(); await sleep(200);
    await page.locator("#timeline .cm").first().click(); await sleep(300);
    check(await page.locator("#tab-comments").getAttribute("aria-selected") === "true" && await page.locator("#comment-list .cmt").count() > 0, `${tag}: a comment pin on the timeline opens Comments, even from a tool's page`);
    check(/1/.test(await page.locator("#tab-comments .n").innerText()), `${tag}: the Comments tab counts the open comments`);
  }
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
