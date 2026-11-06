// The editor laid out like Instagram Edits' desktop app: a rail of tools (two groups) opens each tool in the panel
// beside it, under its icon and name, with an X that closes it (the player gets the room); the inspector on the
// right shows the selected clip's settings (a clip: speed, motion and its sound; a text: its style) and "Select a clip"
// with nothing selected; the top bar has the aspect ratio and quality menus and Search tools; the timeline's tools sit
// in one bar above it, with undo and redo; a comment pin opens Comments. Nothing in a panel is wider than the panel,
// on a desktop or a phone. Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
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
const RAIL = ["Media", "Audio", "Text", "Captions", "Color", "Multicam", "Transcript"], RAIL_AI = ["Reference", "Your AI", "Comments"];

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
// Anything in a panel wider than the panel itself (a row cut off at the right edge).
const overflow = (page, sel) => page.evaluate((sel) => {
  const box = document.querySelector(sel); if (!box) return ["(no " + sel + ")"];
  const p = box.getBoundingClientRect();
  return [...box.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > p.right + 1 && !e.closest("[aria-hidden=true]"); }).map((e) => e.id || e.className || e.tagName).slice(0, 3);
}, sel);

for (const [tag, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const { page, errors } = await open(w, h);
  const groups = await page.$$eval("#edit-tools .rail-group", (gs) => gs.map((g) => [...g.querySelectorAll(".rail-l")].map((x) => x.textContent.trim())));
  check(groups.length === 2 && groups[0].join("|") === RAIL.join("|") && groups[1].join("|") === RAIL_AI.join("|"), `${tag}: the rail has the tools in two groups (${groups.map((g) => g.join(", ")).join(" / ")})`);
  check((await page.locator("#tool-head b").innerText()).trim() === "Media" && await page.locator("#tab-media").getAttribute("aria-selected") === "true", `${tag}: it opens on Media`);
  if (tag === "phone") {
    const tops = await page.$$eval("#edit-tools .rail-btn", (bs) => [...new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top)))]);
    check(tops.length === 1, `${tag}: the rail is one row that scrolls (${tops.length} rows)`);
  }
  for (const label of [...RAIL, ...RAIL_AI]) {
    const k = await page.locator(`#edit-tools .rail-btn[aria-label="${label}"]`).getAttribute("id");
    if ((await page.locator("#" + k).getAttribute("aria-selected")) !== "true") await page.locator("#" + k).click();
    await sleep(250);
    const headTxt = (await page.locator("#tool-head b").innerText()).trim();
    const wide = await overflow(page, "#lib-panel");
    check(headTxt === label && wide.length === 0, `${tag}: ${label} opens in the panel under its name, nothing cut off${wide.length ? " (" + wide.join(", ") + ")" : ""}`);
  }
  // The open tool's button, or the X, closes the panel; the player gets its room.
  const playerW = async () => page.$eval(".ed-work > .center", (e) => e.getBoundingClientRect().width);
  const w0 = await playerW();
  await page.locator("#tool-back").click(); await sleep(250);
  check(await page.locator("#lib-panel").count() === 0, `${tag}: the X closes the panel`);
  if (tag === "desktop") {
    check(await playerW() > w0 + 120, `${tag}: the player takes the room (${Math.round(w0)} -> ${Math.round(await playerW())} px)`);
    // Like Edits: the rail shows the tools' names while no tool is open, icons only while one is; no coloured background.
    check(await page.locator("#tab-media .rail-l").isVisible(), `${tag}: with no tool open the rail shows the names`);
    await page.locator("#tab-media").click(); await sleep(200);
    check(!(await page.locator("#tab-media .rail-l").isVisible()), `${tag}: with a tool open it shows icons only`);
    const bg = await page.$eval("#tab-media", (e) => getComputedStyle(e).backgroundColor);
    check(/rgba\(0, 0, 0, 0\)|transparent/.test(bg), `${tag}: the open tool has no coloured background (${bg})`);
    await page.locator("#tool-back").click(); await sleep(200);
  }
  // Inspector: nothing selected, a clip, a text.
  check((await page.locator("#inspector").innerText()).trim() === "Select a clip", `${tag}: with nothing selected the inspector only says "Select a clip"`);
  check((await overflow(page, "#inspector")).length === 0, `${tag}: the empty inspector fits`);
  await page.locator(".clip.video").nth(1).click(); await sleep(300);
  check(await page.locator("#inspector #clip-panel").count() === 1 && await page.locator("#inspector #audio-inspector").count() === 1, `${tag}: a clip shows its speed, motion and sound in the inspector`);
  const wideI = await overflow(page, "#inspector");
  check(wideI.length === 0, `${tag}: the clip's settings fit the inspector${wideI.length ? " (" + wideI.join(", ") + ")" : ""}`);
  await page.locator("#tab-text").click(); await sleep(200);
  await page.locator("#add-text-title").click(); await sleep(400);
  const textSel = await page.locator("#inspector #text-inspector").count();
  if (!textSel) { const t = page.locator(".clip.title").last(); await t.click(); await sleep(300); }
  check(await page.locator("#inspector #text-inspector #text-content").count() === 1 && await page.locator("#lib-panel #text-content").count() === 0, `${tag}: a text's style is in the inspector, not twice`);
  await page.locator("#inspector-clear").click(); await sleep(200);
  check(/Select a clip/.test(await page.locator("#inspector").innerText()), `${tag}: clearing the selection empties the inspector`);
  if (tag === "desktop") {
    // Top bar: aspect ratio, quality, search tools.
    await page.locator("#aspect-btn").click(); await sleep(200);
    const shapes = await page.$$eval("#aspect-menu [data-aspect]", (bs) => bs.map((b) => b.dataset.aspect));
    check(shapes.join(",") === "9:16,16:9,4:5,1:1", `${tag}: the aspect menu lists the shapes (${shapes.join(", ")})`);
    const before = (await page.locator("#aspect-btn").innerText()).trim();
    const pick = before === "9:16" ? "16:9" : "9:16";
    await page.locator(`#aspect-menu [data-aspect="${pick}"]`).click(); await sleep(400);
    check((await page.locator("#aspect-btn").innerText()).trim() === pick, `${tag}: picking ${pick} changes the edit's shape (${before} -> ${pick})`);
    check(await page.locator("#undo").isEnabled(), `${tag}: undo is in the timeline's bar`);
    await page.locator("#undo").click(); await sleep(400);
    check((await page.locator("#aspect-btn").innerText()).trim() === before, `${tag}: undo brings the shape back`);
    await page.locator("#quality-btn").click(); await sleep(200);
    await page.locator('#quality-res [data-v="4k"]').click(); await sleep(300);
    check(/^4K/.test((await page.locator("#quality-btn").innerText()).trim()), `${tag}: the quality menu sets 4K (${(await page.locator("#quality-btn").innerText()).trim()})`);
    await page.mouse.click(700, 300); await sleep(100);
    await page.locator("#tool-search").click(); await page.keyboard.type("comm"); await sleep(150);
    check(await page.locator("#tool-search-menu .tb-found").count() >= 1, `${tag}: search tools finds Comments`);
    await page.keyboard.press("Enter"); await sleep(300);
    check(await page.locator("#tab-comments").getAttribute("aria-selected") === "true", `${tag}: Enter opens it`);
    // The timeline's tools are in its bar.
    check(await page.locator(".tl-bar #tool-select").count() === 1 && await page.locator(".tl-bar #tool-razor").count() === 1 && await page.locator(".tl-bar #snap").count() === 1, `${tag}: the timeline's tools sit in one bar above it`);
    await page.locator("#tab-audio").click(); await sleep(200);
    await page.locator("#timeline .cm").first().click(); await sleep(300);
    check(await page.locator("#tab-comments").getAttribute("aria-selected") === "true" && await page.locator("#comment-list .cmt").count() > 0, `${tag}: a comment pin on the timeline opens Comments`);
    check(/1/.test(await page.locator("#tab-comments .n").innerText()), `${tag}: the Comments button counts the open comments`);
  }
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
