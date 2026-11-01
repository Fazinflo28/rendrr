// The client review page (/review/:token, the link sent to clients) on a phone and a desktop: nothing wider than
// the screen (no sideways scroll, so the phone does not zoom the page out), the video and cards use the full width,
// the version picker fits however many versions there are, Approve and Request changes sit inside their card.
// Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium; screenshots go to SHOTS (optional).
//   node demo/review-phone.mjs   (from apps/web)
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

for (const [tag, w, h, mobile] of [["phone", 390, 844, true], ["small phone", 360, 740, true], ["desktop", 1440, 900, false]]) {
  for (const versions of [2, 22]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((n) => { globalThis.__demoVersions = n; }, versions);
    await page.goto(`http://localhost:${server.address().port}/`); await sleep(600);
    await page.evaluate(() => globalThis.__rendrrNav.go("/review/x3p8q1")); await page.locator("#rv-approve").waitFor(); await sleep(900);
    const m = await page.evaluate(() => {
      // A page wider than the screen makes the phone zoom out (window.innerWidth then grows): measure against the screen.
      const W = screen.width, r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const wide = [...document.querySelectorAll(".rv *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > W + 1 || b.left < -1) && !e.closest("[data-scroll-x]"); }).map((e) => e.id || e.className || e.tagName).slice(0, 4);
      const card = document.querySelector("#rv-approve").closest(".card").getBoundingClientRect();
      const inCard = ["#rv-approve", "#rv-changes"].every((s) => { const b = r(s); return b.left >= card.left - 0.5 && b.right <= card.right + 0.5; });
      const body = r(".rv-body"), player = r(".rv-stage .player") || r(".rv-stage");
      return { scrollW: document.documentElement.scrollWidth, W, zoomed: window.innerWidth > W, wide, inCard, bodyW: Math.round(body.width), playerW: Math.round(player.width), playerH: Math.round(player.height), picker: r("#rv-version") ? Math.round(r("#rv-version").right) : null };
    });
    const label = `${tag} ${w}px, ${versions} versions`;
    check(m.scrollW <= m.W && !m.zoomed, `${label}: no sideways scroll, not zoomed out (page ${m.scrollW} px wide)`);
    check(m.wide.length === 0, `${label}: nothing past the screen edge${m.wide.length ? " (" + m.wide.join(", ") + ")" : ""}`);
    check(m.inCard, `${label}: Approve and Request changes inside their card`);
    if (mobile) check(m.bodyW >= w - 40, `${label}: the page uses the screen's width (${m.bodyW} of ${w} px)`);
    if (mobile) check(m.playerH >= h * 0.5, `${label}: the video is big (${m.playerW}x${m.playerH})`);
    check(errors.length === 0, `${label}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `review-${tag.replace(" ", "-")}-${versions}.png`), fullPage: true });
    if (versions === 2) {
      // The comment box is there without doing anything (the client never has to find it), inside the screen.
      check(await page.locator("#rv-comment").isVisible() || (await page.locator("#rv-comment").scrollIntoViewIfNeeded().then(() => page.locator("#rv-comment").isVisible())), `${label}: the comment box is on the page`);
      // Tapping or clicking the video pauses it and puts the cursor in the box.
      const vid = page.locator(".rv-stage .player");
      if (mobile) await vid.tap({ position: { x: 60, y: 120 } }); else await vid.click({ position: { x: 60, y: 120 } });
      await sleep(400);
      const box = await page.evaluate(() => { const f = document.querySelector("#rv-comment")?.getBoundingClientRect(); return f && { l: Math.round(f.left), r: Math.round(f.right), w: Math.round(f.width), focused: document.activeElement?.id === "rv-comment" }; });
      check(!!box && box.l >= 0 && box.r <= w && box.w >= 180, `${label}: the comment box fits the screen with room to type (${box?.l}-${box?.r})`);
      check(!!box?.focused, `${label}: a ${mobile ? "tap" : "click"} on the video puts the cursor in the comment box`);
      // Writing and sending adds the comment at that moment.
      const before = await page.locator(".rv .panel .li").count();
      await page.locator("#rv-comment").fill("Make the logo bigger here");
      await page.locator("#rv-send").click(); await sleep(500);
      check((await page.locator(".rv .panel .li").count()) === before + 1 && /Make the logo bigger here/.test(await page.locator(".rv .panel .list").innerText()), `${label}: the comment is added to the list`);
      check((await page.locator("#rv-comment").inputValue()) === "", `${label}: the box is empty again`);
    }
    await ctx.close();
  }
  // A review with a password: the form fits the screen.
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
  const page = await ctx.newPage();
  await page.addInitScript(() => { globalThis.__demoLocked = true; });
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(600);
  await page.evaluate(() => globalThis.__rendrrNav.go("/review/x3p8q1")); await page.locator("#rv-pw").waitFor(); await sleep(500);
  const f = await page.evaluate(() => { const b = document.querySelector("#rv-pw").closest("form").getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), sw: document.documentElement.scrollWidth, zoomed: window.innerWidth > screen.width, W: screen.width }; });
  check(f.l >= 0 && f.r <= f.W && f.sw <= f.W && !f.zoomed, `${tag} ${w}px: the password form fits the screen (${f.l}-${f.r})`);
  await ctx.close();
}
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
