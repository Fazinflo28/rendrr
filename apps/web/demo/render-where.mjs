// Where a render runs and where finals go, in the web app: the Export window says the render runs on Rendrr's cloud
// server (not this computer) and the final was made there; Connect AI says renders run in the cloud and where the AI's
// finals go (this Mac when the Rendrr Mac app is open, by name; else Google Drive); the Mac app sends its name.
// Runs on the demo build (node demo/build.mjs first).   node demo/render-where.mjs   (from apps/web)
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
const text = (page, sel) => page.locator(sel).first().innerText().then((t) => t.trim()).catch(() => "");

async function login(page) {
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
}

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600); await login(page);

  // Connect AI with the Mac app closed: renders in the cloud, finals to Google Drive.
  await page.evaluate(() => globalThis.__rendrrNav.go("/connect")); await page.locator("#exports-card #mac-status").waitFor({ timeout: 8000 });
  check(/Renders run on Rendrr's cloud server/.test(await text(page, "#exports-card")) && /never on your computer/.test(await text(page, "#exports-card")), `${tag}: Connect AI says renders run on Rendrr's cloud server, never on your computer`);
  check((await text(page, "#mac-status")) === "Mac app closed" && /go to Google Drive/.test(await text(page, "#exports-to")), `${tag}: with the Mac app closed, the AI's finals go to Google Drive`);

  // The Mac app opens on "Studio Mac": refresh shows it connected, by name.
  await page.evaluate(() => { globalThis.__demoMac = { online: true, device: "Studio Mac", version: "0.2.0", seenAt: Date.now() }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.locator('#exports-card button[aria-label="Refresh"]').click(); await sleep(500);
  check((await text(page, "#mac-status")) === "Mac connected" && (await text(page, "#exports-to")) === "Finals from your AI go to Studio Mac" && /saves them to Downloads/.test(await text(page, "#exports-card")), `${tag}: with the Mac app open, finals go to that Mac by name (${await text(page, "#exports-to")})`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("#exports-card *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag}: the card fits the screen`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `render-where-connect-${tag}.png`) });

  // The Export window: while it runs it says where; when done, that it was made in the cloud.
  if (!mobile) {
    await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p6")); await page.locator("#timeline").waitFor({ timeout: 8000 }); await sleep(800);
    await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
    await page.locator("#export-render").click(); await page.locator("#export-run").waitFor({ timeout: 6000 });
    check((await text(page, "#render-where")) === "Rendering on Rendrr's cloud server, not on this computer", `${tag}: the Export window says it renders on Rendrr's cloud server, not this computer`);
    await page.locator("#render-done").waitFor({ timeout: 30000 }).catch(() => {});
    check((await text(page, "#render-made")) === "Made on Rendrr's cloud server", `${tag}: the finished final says it was made on Rendrr's cloud server`);
  }
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// The Mac app: its name goes with the ping.
const mctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await mctx.addInitScript(() => { window.rendrrDesktop = Object.freeze({ app: "mac", platform: "darwin", version: "0.2.0", device: "Studio Mac", openInBrowser: () => {} }); });
const mp = await mctx.newPage();
await mp.goto(base + "/"); await sleep(600); await login(mp); await sleep(800);
const ping = await mp.evaluate(() => globalThis.__demoMacPing);
check(ping && ping.device === "Studio Mac" && ping.version === "0.2.0", `the Mac app sends its name with its ping (${JSON.stringify(ping)})`);
await mctx.close();

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
