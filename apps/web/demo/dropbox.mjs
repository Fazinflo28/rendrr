// Videos and pictures from Dropbox: the Library's Add footage window, the editor's Add clips window and the page an
// AI's link opens (add_footage from: dropbox) each take a Dropbox share link, or files chosen in Dropbox's own window
// once the Dropbox app key is set (not inside the Mac or Windows app, whose popups open in the browser). What is
// coming in is shown, what arrives is listed (and picked in Add clips), and a folder link says to share each file.
// Runs on the demo build (node demo/build.mjs first).   node demo/dropbox.mjs   (from apps/web)
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
const until = async (f, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };
const FILE = "https://www.dropbox.com/scl/fi/abc123/Beach%20walk.mp4?rlkey=xyz&dl=0";
const FOLDER = "https://www.dropbox.com/scl/fo/def456/Shoot%20day?rlkey=xyz&dl=0";

async function open(init, path, w = 1280, h = 860, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
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
const paste = async (scope, url) => { await scope.locator("#dbx-link").fill(url); await scope.locator("#dbx-add").click(); };

// The Library: paste a link (no app key: no Dropbox button), see it coming in, then in the Library; a folder link fails.
for (const [tag, w, h, mobile] of [["desktop", 1280, 860, false], ["phone", 390, 844, true]]) {
  const { ctx, page, errors } = await open(null, "/library", w, h, mobile);
  await page.locator("#upload").click({ timeout: 2000 }).catch(async () => { await page.locator('[data-mtab="Add"]').click(); }); await sleep(300);
  if (!(await page.locator("#src-dropbox").count())) await page.locator('[data-mtab="Add"]').click().catch(() => {});
  await page.locator("#src-dropbox").click();
  check(await page.locator("#dbx-panel").isVisible(), `${tag} Library: the Dropbox tab`);
  check((await page.locator("#dbx-choose").count()) === 0, `${tag} Library: no Dropbox button until the app key is set`);
  await paste(page, FILE);
  check(await until(async () => /Bringing in 1 file/.test(await page.locator("#dbx-pending").innerText())), `${tag} Library: it says the file is coming in`);
  check(await until(async () => (await page.locator("#dbx-arrived [data-dbx-video]", { hasText: "Beach walk" }).count()) === 1), `${tag} Library: then lists it`);
  check(await until(async () => (await page.locator(".toast").allTextContents()).some((t) => /"Beach walk(\.mp4)?" is in your Library/.test(t))), `${tag} Library: and says it is in the Library`);
  await paste(page, FOLDER);
  check(await until(async () => /link to a Dropbox folder, not a file/.test(await page.locator("#dbx-errors").innerText())), `${tag} Library: a folder link says to share each file`);
  check((await page.locator("#dbx-link").inputValue()) === "", `${tag} Library: the link box empties after each`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("#dbx-panel *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag} Library: the panel fits the screen`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `dropbox-library-${tag}.png`) });
  check(errors.length === 0, `${tag} Library: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// With the app key: Choose from Dropbox opens Dropbox's window, and what is chosen comes in (a stand-in Dropbox here).
{
  const init = { f: () => { globalThis.__dropboxKey = "test-key"; window.Dropbox = { choose: (o) => { window.__chooseOpts = o; setTimeout(() => o.success([{ link: "https://dl.dropboxusercontent.com/1/view/aaa/Interview.mov", name: "Interview.mov" }, { link: "https://dl.dropboxusercontent.com/1/view/bbb/Logo.png", name: "Logo.png" }]), 100); } }; } };
  const { ctx, page, errors } = await open(init, "/library");
  await page.locator("#upload").click(); await sleep(300);
  await page.locator("#src-dropbox").click();
  check(await page.locator("#dbx-choose").isVisible(), "with the key: Choose from Dropbox");
  await page.locator("#dbx-choose").click();
  check(await until(async () => (await page.locator("#dbx-arrived [data-dbx-video]").count()) === 2), "both chosen files arrive");
  const opts = await page.evaluate(() => ({ linkType: window.__chooseOpts?.linkType, multi: window.__chooseOpts?.multiselect, ext: window.__chooseOpts?.extensions }));
  check(opts.linkType === "direct" && opts.multi === true && opts.ext?.join() === "video,images", `Dropbox's window takes many videos and pictures (${JSON.stringify(opts)})`);
  const links = await page.evaluate(() => globalThis.__demoLinks || []);
  check(links.length === 2 && links.every((l) => l.startsWith("https://dl.dropboxusercontent.com/")), "their links go to Rendrr to bring in");
  check(errors.length === 0, `with the key: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// Inside the Mac or Windows app the Dropbox window would open in the browser: only the link box.
{
  const init = { f: () => { globalThis.__dropboxKey = "test-key"; window.rendrrDesktop = Object.freeze({ app: "mac", platform: "darwin", version: "9.9.9", openInBrowser() {} }); } };
  const { ctx, page, errors } = await open(init, "/library");
  await page.locator("#upload").click(); await sleep(300);
  await page.locator("#src-dropbox").click();
  check(await page.locator("#dbx-link").isVisible() && (await page.locator("#dbx-choose").count()) === 0, "in the desktop app: the link box, no Dropbox button");
  check(errors.length === 0, "desktop app: no page errors");
  await ctx.close();
}

// The editor's Add clips: what arrives from Dropbox is picked, ready to add.
{
  const { ctx, page, errors } = await open({ f: () => { globalThis.__demoLibSeed = true; } }, "/editor/p5", 1440, 900);
  await page.locator("#timeline").waitFor(); await sleep(800);
  await page.locator("#bin-add-clips").click();
  const modal = page.locator(".modal");
  await modal.locator("#add-src-dropbox").click();
  check(await modal.locator("#add-dropbox #dbx-panel").isVisible(), "Add clips: a Dropbox tab");
  check(await modal.locator("#add-clip-go").isDisabled(), "Add clips: nothing picked yet");
  await paste(modal, FILE);
  check(await until(async () => (await modal.locator("#dbx-arrived [data-dbx-video]").count()) === 1), "Add clips: the file arrives");
  check(await until(async () => (await modal.locator("#add-clip-go").isEnabled()) && /Add video/.test(await modal.locator("#add-clip-go").innerText())), `Add clips: and is picked, ready to add (${await modal.locator("#add-clip-go").innerText().catch(() => "")})`);
  await modal.locator("#add-src-library").click();
  check(await until(async () => (await modal.locator("#add-videos .clip-card.on", { hasText: "Beach walk" }).count()) === 1), "Add clips: the Library list shows it picked");
  check(errors.length === 0, `Add clips: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// The page an AI's link opens, for Dropbox: names Dropbox, takes a link, and Done says the AI can see them.
{
  const init = { f: (s) => { globalThis.__demoPick = s; }, arg: { source: "dropbox", aiName: "Claude", project: { id: "p2", name: "Gym promo reel" } } };
  const { ctx, page, errors } = await open(init, "/add/pk_dbx_1234567890");
  check(/from your Dropbox, for the edit Gym promo reel/.test(await page.locator("#pick-for").innerText()), "pick page: asks for files from your Dropbox");
  check((await page.locator("#pick-drop").count()) === 0 && (await page.locator("#dbx-panel").count()) === 1, "pick page: the Dropbox panel, not the computer drop area");
  await paste(page, FILE);
  check(await until(async () => (await page.locator("#dbx-arrived [data-dbx-video]").count()) === 1), "pick page: the file arrives");
  check(await until(async () => (await page.locator("#pick-done").count()) === 1), "pick page: Done shows");
  await page.locator("#pick-done").click();
  check(await until(async () => /Claude can see them now/.test(await page.locator("#pick-finished").innerText())), "pick page: Done says Claude can see them");
  check((await page.locator("#dbx-panel").count()) === 0, "pick page: and the panel goes");
  check(errors.length === 0, `pick page: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
