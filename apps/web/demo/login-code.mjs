// Logging in with a code from email (no password): "Log in with a code from email instead" in the login window asks
// for the email, sends a code, and the code logs in. An email with no account, a wrong code and the way back are said
// plainly; Forgot password is still there. Desktop and phone. Inside the Mac or Windows app it is offered too.
// Runs on the demo build (node demo/build.mjs first).   node demo/login-code.mjs   (from apps/web)
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
const text = (p, sel) => p.locator(sel).first().textContent().then((t) => (t || "").replace(/\s+/g, " ").trim()).catch(() => ""); // as written (headings show in capitals)
const alertText = (p) => p.locator('.hform [role="alert"]').first().innerText().catch(() => "");

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/login"); await page.locator("#email").waitFor();
  check(await page.locator("#code-login").isVisible() && /Forgot password\?/.test(await text(page, ".hform")), `${tag}: the login offers a code from email, and Forgot password is still there`);

  await page.locator("#code-login").click(); await sleep(200);
  check((await text(page, ".hform h1")) === "Log in with a code" && (await page.locator("#password").count()) === 0 && (await page.locator("#google").count()) === 0 && (await text(page, "#submit")) === "Email me a code", `${tag}: the code window asks only for the email (${await text(page, ".hform h1")})`);

  // An email with no account: said, nothing sent.
  await page.locator("#email").fill("nobody@example.com"); await page.locator("#submit").click(); await sleep(600);
  check(/no Rendrr account with that email/.test(await alertText(page)) && (await page.locator("#login-code").count()) === 0, `${tag}: an email with no account is said plainly (${await alertText(page)})`);

  // The account's email: a code is sent and asked for.
  await page.locator("#email").fill("you@example.com"); await page.locator("#submit").click();
  await page.locator("#login-code").waitFor({ timeout: 4000 }).catch(() => {});
  check((await page.locator("#login-code").count()) === 1 && /We sent a code to you@example\.com/.test(await text(page, "#code-sent")) && (await text(page, "#submit")) === "Log in", `${tag}: the code is sent and asked for`);

  // A wrong code: said; then a new code, and the right one logs in.
  await page.locator("#login-code").fill("000000"); await page.locator("#submit").click(); await sleep(600);
  check(/expired or is not right/.test(await alertText(page)), `${tag}: a wrong code is said (${await alertText(page)})`);
  const sentBefore = await page.evaluate(() => globalThis.__demoCodesSent || 0);
  await page.locator("#code-resend").click(); await sleep(600);
  check((await page.evaluate(() => globalThis.__demoCodesSent || 0)) === sentBefore + 1 && (await page.locator("#login-code").count()) === 1, `${tag}: "send a new code" sends another`);
  await page.locator("#login-code").fill("123 456"); await page.locator("#submit").click(); await sleep(1200);
  check((await page.locator(".hform").count()) === 0 && (await page.locator("#profile").count()) === 1, `${tag}: the right code logs in`);

  // Back to log in from the code window.
  await page.locator("#profile").click(); await page.locator("#logout").click(); await sleep(400);
  await page.evaluate(() => globalThis.__rendrrNav.go("/login")); await page.locator("#email").waitFor();
  await page.locator("#code-login").click(); await page.locator("#back-to-login").click(); await sleep(200);
  check((await text(page, ".hform h1")) === "Welcome back" && (await page.locator("#password").count()) === 1, `${tag}: Back to log in returns to the password login`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll(".hform *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag}: the login window fits the screen`);
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// Inside the Mac or Windows app: the code is offered next to "Log in with your browser" (no trip to the browser needed).
const actx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await actx.addInitScript(() => { window.rendrrDesktop = Object.freeze({ app: "windows", platform: "win32", version: "0.1.4", device: "Gaming PC", openInBrowser: () => {} }); });
const ap = await actx.newPage();
await ap.goto(base + "/login"); await ap.locator("#email").waitFor();
check((await ap.locator("#browser-login").count()) === 1 && (await ap.locator("#code-login").isVisible()), "in the desktop app: the code from email is offered next to Log in with your browser");
await actx.close();

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
