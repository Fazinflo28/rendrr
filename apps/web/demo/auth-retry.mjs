// The app opens with a session while Rendrr is out of reach for a moment (a restart: the first looks at the account fail
// as network errors): it keeps the session and asks again, then signs in and (in the Mac app) tells Rendrr it is open.
// Before, one failed look left the page logged out for good and the Mac counted as closed all day. A refused login
// (401) is logged out at once, with no retries. Runs on the demo build (node demo/build.mjs first).
//   node demo/auth-retry.mjs   (from apps/web)
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
const until = async (f, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return true; await sleep(150); } return false; };
const open = async (init) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(init);
  await page.goto(`http://localhost:${server.address().port}/`);
  return { page, errors };
};

// Out of reach for the first two looks: signed in on the third, and the Mac app's ping starts.
{
  const { page, errors } = await open(() => {
    globalThis.__demoSignedIn = true; globalThis.__demoProfileFail = 2;
    Object.defineProperty(window, "rendrrDesktop", { configurable: true, get: () => ({ app: "mac", version: "0.1.20", onWake: () => () => {} }) });
  });
  check(await until(async () => (await page.evaluate(() => globalThis.__demoMacPings || 0)) >= 1, 12000), "after two failed looks it signs in and the Mac app tells Rendrr it is open");
  check(await page.evaluate(() => globalThis.__demoProfileTries) === 3, `the account was asked three times (${await page.evaluate(() => globalThis.__demoProfileTries)})`);
  check(await page.locator('input[type="email"]').count() === 0, "never shown as logged out");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
}
// A refused login: logged out at once, asked once, nothing sent.
{
  const { page, errors } = await open(() => {
    globalThis.__demoSignedIn = true; globalThis.__demoProfileRefuse = true;
    Object.defineProperty(window, "rendrrDesktop", { configurable: true, get: () => ({ app: "mac", version: "0.1.20", onWake: () => () => {} }) });
  });
  await sleep(3500);
  check(await page.evaluate(() => globalThis.__demoProfileTries) === 1, "a refused login is not asked again");
  check(await page.evaluate(() => globalThis.__demoMacPings || 0) === 0, "and nothing is sent");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
}
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
