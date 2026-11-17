// Inside an older Mac or Windows app the web app offers the new one: an app with no render engine is told it cannot
// render exports on this computer; an older version is told a new one is out; "Get the new app" opens the download page
// in the browser; closing it keeps it closed for that version. The newest app, or a plain browser, shows nothing.
// Desktop and phone width. Runs on the demo build (node demo/build.mjs first).   node demo/update-bar.mjs   (from apps/web)
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

// desktop: what window.rendrrDesktop looks like in that app (null: a plain browser).
async function open(desktop, w = 1280, h = 860, storage) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(({ desktop, storage }) => {
    globalThis.__opened = [];
    if (storage) for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    if (desktop) {
      const d = { ...desktop, openInBrowser: (u) => globalThis.__opened.push(u) };
      if (desktop.render) d.render = { info: async () => ({ protocol: 1, ready: true, enabled: true, busy: false, cpus: 8, have: [], ffmpeg: "8.0", why: null }), onState: () => () => {} };
      window.rendrrDesktop = Object.freeze(d);
    }
  }, { desktop, storage });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/explore"); await sleep(1200);
  return { ctx, page, errors };
}
const barText = (p) => p.locator("#update-bar").textContent().then((t) => (t || "").replace(/\s+/g, " ").trim()).catch(() => "");

// An old Mac app with no render engine (the one that cannot render exports on the Mac).
{
  const { ctx, page, errors } = await open({ app: "mac", platform: "darwin", version: "0.1.7", device: "Studio Mac" });
  check(await page.locator("#update-bar").isVisible(), "an old Mac app with no render engine shows the update bar");
  check(/Update the Rendrr Mac app to render exports on this Mac\. This version sends them to Rendrr's cloud\./.test(await barText(page)), `it says why (${await barText(page)})`);
  await page.locator("#update-get").click(); await sleep(200);
  check((await page.evaluate(() => globalThis.__opened))[0] === "https://api.rendrr.live/download/mac", "Get the new app opens the Mac download page in the browser");
  const r = await page.locator("#update-bar").boundingBox(), W = await page.evaluate(() => document.documentElement.clientWidth);
  check(r && r.x >= 0 && r.x + r.width <= W + 1, "the bar fits the window");
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, "update-bar.png") });
  await page.locator("#update-close").click(); await sleep(200);
  check((await page.locator("#update-bar").count()) === 0, "closing it hides it");
  await page.reload(); await sleep(1200);
  check((await page.locator("#update-bar").count()) === 0, "and it stays closed for that version");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// A Mac app that renders but is older than the newest: told a new one is out.
{
  const { ctx, page } = await open({ app: "mac", platform: "darwin", version: "0.1.13", device: "Studio Mac", render: true });
  check(/A new Rendrr Mac app \(0\.1\.14\) is out\./.test(await barText(page)), `an older app that renders is told a new one is out (${await barText(page)})`);
  await ctx.close();
}

// A closed bar comes back when an even newer app is out.
{
  const { ctx, page } = await open({ app: "mac", platform: "darwin", version: "0.1.13", device: "Studio Mac", render: true }, 1280, 860, { "rendrr:update-closed:0.1.13": "1" });
  check(await page.locator("#update-bar").isVisible(), "a bar closed for an older version shows again for the newer one");
  await ctx.close();
}

// The newest Mac app, and a plain browser: nothing.
for (const [what, d] of [["the newest Mac app", { app: "mac", platform: "darwin", version: "0.1.14", device: "Studio Mac", render: true }], ["a plain browser", null]]) {
  const { ctx, page } = await open(d);
  check((await page.locator("#update-bar").count()) === 0, `${what} shows no update bar`);
  await ctx.close();
}

// An old Windows app, at phone width: PC wording, the Windows download, and it fits.
{
  const { ctx, page, errors } = await open({ app: "windows", platform: "win32", version: "0.1.1", device: "Gaming PC" }, 390, 844);
  check(/Update the Rendrr Windows app to render exports on this PC\./.test(await barText(page)), `Windows wording (${await barText(page)})`);
  await page.locator("#update-get").click(); await sleep(200);
  check((await page.evaluate(() => globalThis.__opened))[0] === "https://api.rendrr.live/download/windows", "Get the new app opens the Windows download page");
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("#update-bar, #update-bar *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, "the bar fits a narrow window");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
