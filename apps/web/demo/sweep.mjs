// UI sweep: every screen of the app (and each editor tool, the export and samples windows, comments) on a desktop, a
// laptop and a phone, looking for what a person would trip over: page errors, the page scrolling sideways, things
// sticking out of the screen, buttons on top of each other, and tap targets too small on a phone. Screenshots go to
// SWEEP_DIR (default /tmp/sweep). Runs on the demo build (node demo/build.mjs first).
//   node demo/sweep.mjs   (from apps/web)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const out = process.env.SWEEP_DIR || "/tmp/sweep";
mkdirSync(out, { recursive: true });
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [["desktop", 1440, 900], ["laptop", 1280, 720], ["phone", 390, 844]];
const PAGES = ["/explore", "/styles", "/library", "/projects", "/connect", "/usage", "/billing", "/settings", "/review/demo"];
const TOOLS = ["transcript", "clip", "text", "audio", "color", "multicam", "style", "ai"];
const report = [];

/** What is wrong on the page as it stands (run in the page). */
const inspect = (phone) => {
  const W = innerWidth, H = innerHeight, issues = [];
  // Shown: a size, not hidden, not in a closed <details>, not the preview build's own "demo data" banner.
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && !e.closest("details:not([open]) > :not(summary)") && !e.closest("[data-demo-banner], .demo-banner") && !/Preview with demo data/.test(e.parentElement?.textContent || ""); };
  const fixedOf = (e) => { for (let p = e; p && p !== document.body; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === "fixed" || ps === "sticky") return p; } return null; };
  // The area a tap reaches: the box, grown by an absolutely placed ::after with a negative inset (a touch hit area).
  const hitBox = (e) => { const r = e.getBoundingClientRect(), a = getComputedStyle(e, "::after"); if (a.content && a.content !== "none" && a.position === "absolute") { const g = (v) => Math.max(0, -parseFloat(v) || 0); return { width: r.width + g(a.left) + g(a.right), height: r.height + g(a.top) + g(a.bottom) }; } return r; };
  const name = (e) => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")) + (e.textContent?.trim() ? ` "${e.textContent.trim().slice(0, 24)}"` : e.getAttribute("aria-label") ? ` [${e.getAttribute("aria-label")}]` : "");
  // Clipped by a scroll or hidden-overflow ancestor (a scrolling strip, a timeline): not sticking out.
  const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflow)) return true; } return false; };
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > W + 1) issues.push(`the page scrolls sideways (${sw}px wide in ${W}px)`);
  const hits = [...document.querySelectorAll("button, a, input, select, textarea, [role=button], [role=tab]")].filter(vis);
  for (const e of hits) { const r = e.getBoundingClientRect(); if ((r.right > W + 2 || r.left < -2) && !clipped(e) && r.top < H * 3) issues.push(`sticks out of the screen: ${name(e)} (${Math.round(r.left)}-${Math.round(r.right)})`); }
  // Buttons on top of each other (neither inside the other; over a third of the smaller one covered).
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    const a = hits[i], b = hits[j];
    if (a.contains(b) || b.contains(a)) continue;
    // A bar fixed on the screen over the page scrolling under it is not an overlap (the end of the page is checked below).
    if (!!fixedOf(a) !== !!fixedOf(b)) continue;
    // An inline link wrapping onto two lines: its box spans both; its line boxes are what is there.
    const boxOf = (e) => { const rs = [...e.getClientRects()]; return rs.length > 1 ? rs : [e.getBoundingClientRect()]; };
    if (boxOf(a).length > 1 || boxOf(b).length > 1) continue;
    const p = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    const ix = Math.max(0, Math.min(p.right, q.right) - Math.max(p.left, q.left)), iy = Math.max(0, Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top));
    if (ix * iy > Math.min(p.width * p.height, q.width * q.height) * 0.34) {
      // The one on top (what a click there reaches) decides whether it is a real overlap.
      const cx = Math.max(p.left, q.left) + ix / 2, cy = Math.max(p.top, q.top) + iy / 2, top = document.elementFromPoint(cx, cy);
      if (top && (a.contains(top) || b.contains(top)) && cy > 0 && cy < H) issues.push(`overlap: ${name(a)} and ${name(b)}`);
    }
  }
  if (phone) {
    const small = hits.filter((e) => { const r = hitBox(e); return r.width < 24 && r.height < 24 && e.tagName !== "INPUT"; });
    if (small.length) issues.push(`${small.length} tap targets under 24px: ${small.slice(0, 5).map(name).join(", ")}`);
  }
  // Button text cut off (no room and no ellipsis).
  for (const e of hits.filter((x) => x.tagName === "BUTTON")) { const s = getComputedStyle(e); if (e.scrollWidth > e.clientWidth + 3 && s.textOverflow !== "ellipsis" && s.overflow !== "visible" && e.textContent.trim().length > 2) issues.push(`text cut off: ${name(e)}`); }
  return Array.from(new Set(issues)).slice(0, 25);
};
/** Scrolled to the end: nothing the page holds stays under a bar fixed at the bottom of the screen. */
const endCovered = () => {
  const bars = [...document.querySelectorAll("body *")].filter((e) => getComputedStyle(e).position === "fixed" && e.getBoundingClientRect().top > innerHeight * 0.7 && e.getBoundingClientRect().height > 30 && e.getBoundingClientRect().width > innerWidth * 0.8 && !/Preview with demo data/.test(e.textContent || ""));
  if (!bars.length) return [];
  const top = Math.min(...bars.map((b) => b.getBoundingClientRect().top));
  const under = [...document.querySelectorAll("button, a, input, select, textarea")].filter((e) => !bars.some((b) => b.contains(e)) && !/Preview with demo data/.test(e.parentElement?.textContent || "")).filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top >= top - 2 && r.top < innerHeight; });
  return under.length ? [`at the end of the page ${under.length} controls stay under the bottom bar: ${under.slice(0, 3).map((e) => e.id || e.textContent?.trim().slice(0, 20) || e.tagName).join(", ")}`] : [];
};

for (const [vp, w, h] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, ...(vp === "phone" ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
  const look = async (label) => {
    // The galleries' cards animate in: measured once they have landed.
    await sleep(/explore|styles/.test(label) ? 2500 : 500);
    const issues = await page.evaluate(inspect, vp === "phone");
    if (vp === "phone") {
      await page.evaluate(() => { for (const el of [document.scrollingElement, ...document.querySelectorAll(".main, .page, .panel .pb")]) if (el) el.scrollTop = el.scrollHeight; });
      await sleep(300);
      issues.push(...(await page.evaluate(endCovered)));
      await page.evaluate(() => { for (const el of [document.scrollingElement, ...document.querySelectorAll(".main, .page, .panel .pb")]) if (el) el.scrollTop = 0; });
    }
    const errs = errors.splice(0);
    report.push({ vp, label, issues: [...errs.map((e) => "page error: " + e), ...issues] });
    await page.screenshot({ path: join(out, `${vp}-${label.replace(/[^a-z0-9]+/gi, "_")}.png`) }).catch(() => {});
  };
  for (const p of PAGES) { await page.evaluate((x) => globalThis.__rendrrNav.go(x), p); await look(p); }
  // A footage page and a folder: from the first card.
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(600);
  const card = page.locator("[data-video], .vcard, .card.video").first();
  if (await card.count()) { await card.click().catch(() => {}); await sleep(600); if ((await page.evaluate(() => globalThis.__rendrrNav.path())).startsWith("/library/")) await look("footage page"); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(600);
  const folder = page.locator("[data-folder], .fcard, .card.folder").first();
  if (await folder.count()) { await folder.click().catch(() => {}); await sleep(600); if ((await page.evaluate(() => globalThis.__rendrrNav.path())).startsWith("/projects/")) await look("folder page"); }
  // The editor, each tool, comments, the export and samples windows.
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor({ timeout: 8000 }).catch(() => {}); await sleep(1200);
  await look("editor");
  await page.locator(".clip.video").first().click().catch(() => {}); await sleep(300);
  for (const t of TOOLS) {
    const b = page.locator("#tab-" + t);
    if (!(await b.count())) { report.push({ vp, label: "editor " + t, issues: ["no button for this tool"] }); continue; }
    await b.click().catch(() => {}); await look("editor " + t);
    await page.locator("#tool-back").click({ timeout: 800 }).catch(() => {}); await sleep(200);
  }
  await page.locator("#tab-comments").click().catch(() => {}); await look("editor comments");
  await page.locator("#tab-media").click({ timeout: 800 }).catch(() => {});
  for (const [id, label] of [["#render-final", "export window"], ["#samples-btn", "samples window"]]) {
    const b = page.locator(id).first();
    if (await b.count() && await b.isVisible()) { await b.click().catch(() => {}); await sleep(600); await look(label); await page.keyboard.press("Escape"); await sleep(300); }
    else report.push({ vp, label, issues: [`${id} not visible`] });
  }
  await page.close();
}
await browser.close(); server.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
let n = 0;
for (const r of report) if (r.issues.length) { n += r.issues.length; console.log(`\n[${r.vp}] ${r.label}`); for (const i of r.issues) console.log("  - " + i); }
console.log(`\n${report.length} screens, ${n} issues; screenshots in ${out}`);
