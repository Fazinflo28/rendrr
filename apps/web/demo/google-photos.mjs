// Videos and pictures from Google Photos: the Library's Add footage window, the editor's Add clips window and the page an
// AI's link opens (add_footage from: google_photos) each have a Google Photos tab. It asks to connect Google Photos once,
// then opens Google Photos' own page (in a window opened on the click, so browsers do not block it; in the Mac or
// Windows app, in the browser), says to choose there, then shows what is coming in, what arrived and what could not
// (a video Google is still processing). An expired choice says so and offers to choose again. Runs on the demo build
// (node demo/build.mjs first).   node demo/google-photos.mjs   (from apps/web)
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
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };
// window.open stands in for the browser's: it records what was opened and where that window was sent.
const stubOpen = () => { window.__opened = []; window.open = (url, name) => { const w = { url, name, closed: false, location: { href: url }, close() { this.closed = true; } }; window.__opened.push(w); return w; }; };

async function open(init, path, w = 1280, h = 860, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(stubOpen);
  if (init) await ctx.addInitScript(init.f, init.arg);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
  await page.evaluate((p) => globalThis.__rendrrNav.go(p), path); await sleep(900);
  return { ctx, page, errors };
}
const openedTo = (page) => page.evaluate(() => (window.__opened || []).map((w) => w.location.href));
const choose = async (page, names) => { await page.evaluate((n) => { globalThis.__demoPhotosChosen = n; }, names); };

// The Library: Connect once, then choose in Google Photos' page; what was chosen comes in, a processing video says so.
for (const [tag, w, h, mobile] of [["desktop", 1280, 860, false], ["phone", 390, 844, true]]) {
  const { ctx, page, errors } = await open(null, "/library", w, h, mobile);
  await page.locator("#upload").click({ timeout: 2000 }).catch(async () => { await page.locator('[data-mtab="Add"]').click(); }); await sleep(300);
  await page.locator("#src-gphotos").click();
  check(await until(async () => await page.locator("#gph-connect").isVisible()), `${tag} Library: Google Photos asks to connect first`);
  check((await page.locator("#gph-choose").count()) === 0, `${tag} Library: and offers no choosing before that`);
  await page.locator("#gph-connect").click();
  check(await until(async () => await page.locator("#gph-choose").isVisible()), `${tag} Library: once connected, Choose from Google Photos`);
  await page.locator("#gph-choose").click();
  check(await until(async () => (await openedTo(page)).includes("https://photos.google.com/picker/demo1/autoclose")), `${tag} Library: Google Photos' page opens in the window opened on the click (${(await openedTo(page)).join(", ")})`);
  check((await page.evaluate(() => window.__opened[0]?.url)) === "about:blank", `${tag} Library: that window was opened at once, before Rendrr answered`);
  check(await until(async () => /Choose in the Google Photos window/.test(await page.locator("#gph-waiting").innerText())), `${tag} Library: it says to choose there`);
  check((await page.locator("#gph-again").getAttribute("href")) === "https://photos.google.com/picker/demo1/autoclose", `${tag} Library: with a link to open it again`);
  await choose(page, ["IMG_0001.jpg", "Clip 1.mp4", "Clip 2 processing.mov"]);
  check(await until(async () => /Bringing in \d files?/.test(await page.locator("#gph-pending").innerText())), `${tag} Library: once chosen, it says they are coming in`);
  check(await until(async () => (await page.locator("#gph-arrived [data-gph-video]").count()) === 2), `${tag} Library: the photo and the video arrive`);
  check(await until(async () => /still processing this video/.test(await page.locator("#gph-errors").innerText())), `${tag} Library: a video Google is still processing says so`);
  check(await until(async () => (await page.locator(".toast").allTextContents()).some((t) => /is in your Library|files are in your Library/.test(t))), `${tag} Library: and says they are in the Library`);
  check(await until(async () => /Choose more/.test(await page.locator("#gph-choose").innerText())), `${tag} Library: then Choose more`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("#gph-panel *, .srcpick *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag} Library: the tab fits the screen`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `gphotos-library-${tag}.png`) });
  check(errors.length === 0, `${tag} Library: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// Inside the Mac or Windows app Google Photos opens in the browser; an expired choice offers to choose again.
{
  const init = { f: () => { globalThis.__demoPhotosOk = true; window.__inBrowser = []; window.rendrrDesktop = Object.freeze({ app: "mac", platform: "darwin", version: "9.9.9", openInBrowser: (u) => window.__inBrowser.push(u) }); } };
  const { ctx, page, errors } = await open(init, "/library");
  await page.locator("#upload").click(); await sleep(300);
  await page.locator("#src-gphotos").click();
  await page.locator("#gph-choose").click();
  check(await until(async () => (await page.evaluate(() => window.__inBrowser)).includes("https://photos.google.com/picker/demo1/autoclose")), "desktop app: Google Photos opens in the browser");
  check((await openedTo(page)).length === 0, "desktop app: no window inside the app");
  await page.evaluate(() => { globalThis.__demoPhotosExpire = true; });
  check(await until(async () => /has expired\. Choose again/.test(await page.locator("#gph-error").innerText())), "an expired choice says so");
  check(await until(async () => /Choose again/.test(await page.locator("#gph-choose").innerText())), "and offers Choose again");
  await page.locator("#gph-choose").click();
  check(await until(async () => (await page.evaluate(() => window.__inBrowser)).includes("https://photos.google.com/picker/demo2/autoclose")), "which makes a new choice");
  check(errors.length === 0, `desktop app: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// The editor's Add clips: what arrives from Google Photos is picked, ready to add.
{
  const { ctx, page, errors } = await open({ f: () => { globalThis.__demoLibSeed = true; globalThis.__demoPhotosOk = true; } }, "/editor/p5", 1440, 900);
  await page.locator("#timeline").waitFor(); await sleep(800);
  await page.locator("#bin-add-clips").click();
  const modal = page.locator(".modal");
  await modal.locator("#add-src-gphotos").click();
  check(await until(async () => await modal.locator("#add-gphotos #gph-choose").isVisible()), "Add clips: a Google Photos tab");
  await modal.locator("#gph-choose").click();
  check(await until(async () => (await modal.locator("#gph-waiting").count()) === 1), "Add clips: choosing in Google Photos");
  await choose(page, ["Sunset.mp4"]);
  check(await until(async () => (await modal.locator("#gph-arrived [data-gph-video]").count()) === 1), "Add clips: the video arrives");
  check(await until(async () => (await modal.locator("#add-clip-go").isEnabled()) && /Add video/.test(await modal.locator("#add-clip-go").innerText())), "Add clips: and is picked, ready to add");
  check(errors.length === 0, `Add clips: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// The page an AI's link opens, for Google Photos: names it, connects, chooses, and Done says the AI can see them.
{
  const init = { f: (s) => { globalThis.__demoPick = s; }, arg: { source: "google_photos", aiName: "Claude", project: { id: "p2", name: "Gym promo reel" } } };
  const { ctx, page, errors } = await open(init, "/add/pk_gph_1234567890", 390, 844, true);
  check(/from your Google Photos, for the edit Gym promo reel/.test(await page.locator("#pick-for").innerText()), "pick page: asks for files from your Google Photos");
  check((await page.locator("#pick-drop").count()) === 0 && (await page.locator("#gph-panel").count()) === 1, "pick page: the Google Photos panel, not the computer drop area");
  check(await until(async () => await page.locator("#gph-connect").isVisible()), "pick page: connect first");
  await page.locator("#gph-connect").click();
  await until(async () => await page.locator("#gph-choose").isVisible());
  await page.locator("#gph-choose").click();
  check(await until(async () => (await openedTo(page)).some((u) => u.endsWith("/autoclose"))), "pick page: Google Photos opens");
  await choose(page, ["Product shot.jpg"]);
  check(await until(async () => (await page.locator("#gph-arrived [data-gph-video]").count()) === 1), "pick page: the file arrives");
  check(await until(async () => (await page.locator("#pick-done").count()) === 1), "pick page: Done shows");
  await page.locator("#pick-done").click();
  check(await until(async () => /Claude can see them now/.test(await page.locator("#pick-finished").innerText())), "pick page: Done says Claude can see them");
  check(errors.length === 0, `pick page: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
