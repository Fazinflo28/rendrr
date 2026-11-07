// The Mac app logs in through the browser (Google refuses to sign in inside apps). In the app, the login shows
// "Log in with your browser" instead of Google; it opens /desktop-login?c=… in the browser; there, logged in, Allow
// hands back rendrr://auth?grant=…; the app opens /desktop-login?grant=… and is logged in. A grant works once and only
// for the app that started it. Runs on the demo build (node demo/build.mjs first).   node demo/desktop-login.mjs
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
const errors = [];
const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
const until = async (p, fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await p.waitForTimeout(100); } };

// One browser profile: the Mac app's window and the browser share the site's storage here, like the demo's fake
// server needs; the app half is marked by the bridge the app's preload gives (window.rendrrDesktop).
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const opened = [];
await ctx.exposeBinding("__openInBrowser", (_src, url) => { opened.push(url); });

// ---- In a plain browser: Google as before ----
const plain = await ctx.newPage(); watch(plain);
await plain.goto(base + "/login"); await plain.locator("#email").waitFor();
check(await plain.locator("#google").count() === 1 && await plain.locator("#browser-login").count() === 0, "in a browser the login offers Google, as before");
await plain.close();

// ---- In the first Mac app (0.1.1, no openInBrowser): it says so right under the button ----
const oldApp = await ctx.newPage(); watch(oldApp);
await oldApp.addInitScript(() => { window.rendrrDesktop = Object.freeze({ app: "mac", platform: "darwin", version: "0.1.1" }); });
await oldApp.goto(base + "/login"); await oldApp.locator("#email").waitFor();
await oldApp.locator("#browser-login").click();
const oldNote = oldApp.locator("#browser-login-old");
check(await until(oldApp, () => oldNote.isVisible()), "an app too old to open the browser says so");
const nb = await oldNote.boundingBox(), bb = await oldApp.locator("#browser-login").boundingBox();
check(nb && bb && nb.y > bb.y && nb.y - (bb.y + bb.height) < 40, "right under the button, where it is seen");
check(/releases\/latest/.test(await oldNote.locator("a").getAttribute("href")), "with a link to the new app");
await oldApp.close();

// ---- In the Mac app: the browser instead of Google ----
const app = await ctx.newPage(); watch(app);
await app.addInitScript(() => { window.rendrrDesktop = Object.freeze({ app: "mac", platform: "darwin", version: "0.1.2", openInBrowser: (u) => window.__openInBrowser(u) }); });
await app.goto(base + "/login"); await app.locator("#email").waitFor();
check(await app.locator("#google").count() === 0, "in the app there is no Google button (Google blocks it there)");
await app.locator("#browser-login").click();
check(await until(app, async () => opened.length === 1), "Log in with your browser opens the browser");
const url = new URL(opened[0] || base);
check(url.pathname === "/desktop-login" && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("c") || ""), `on the Allow page with a challenge (${url.pathname})`);
check(await app.locator("#browser-login-wait").isVisible(), "the app says to click Allow in the browser");
check(await app.locator("#browser-login-copy").isVisible(), "and offers the link to copy if no browser opened");
const verifier = await app.evaluate(() => JSON.parse(localStorage.getItem("rendrr:desktop-login")).v);
check(/^[A-Za-z0-9_-]{43}$/.test(verifier) && (await app.evaluate((v) => globalThis.__desktopLogin.s256(v), verifier)) === url.searchParams.get("c"), "the challenge is the S256 of the app's secret, which stays in the app");
check(await app.evaluate(() => globalThis.__desktopLogin.s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")) === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "S256 in the page matches RFC 7636 (and the API)");

// ---- In the browser: log in first, then Allow ----
const tab = await ctx.newPage(); watch(tab);
await tab.goto(url.toString());
await tab.locator("#dl-login").waitFor();
check(/Log in to the Rendrr app/.test(await tab.locator("#desktop-login").innerText()), "logged out in the browser: it asks to log in first");
check(await tab.locator("#desktop-login svg.appicon").count() === 1, "the page shows the Rendrr app icon");
await tab.locator("#dl-login").click();
await tab.locator("#email").fill("you@example.com"); await tab.locator("#password").fill("x"); await tab.locator("#submit").click();
await tab.locator("#dl-allow").waitFor();
const askText = await tab.locator("#desktop-login").innerText();
check(/Log in to the Rendrr app\?/.test(askText) && /Only click Allow/.test(askText), "logged in: it asks to allow, with a warning");
await tab.screenshot({ path: join(here, "dist", "desktop-login-allow.png") });
await tab.locator("#dl-allow").click();
await tab.locator("#dl-open").waitFor();
const link = await tab.locator("#dl-open").getAttribute("href");
const grant = new URL(link).searchParams.get("grant");
check(/^rendrr:\/\/auth\?grant=[A-Za-z0-9_-]{32}$/.test(link), `Allow hands the app a rendrr:// link (${link?.slice(0, 26)}…)`);
check(/Go back to the Rendrr app/.test(await tab.locator("#desktop-login").innerText()), "the browser says to go back to the app");

// ---- Back in the app: the link opens /desktop-login?grant=… and logs in ----
await app.goto(base + "/desktop-login?grant=" + grant);
check(await until(app, async () => (await app.evaluate(() => globalThis.__rendrrNav.path())) === "/projects", 6000), `the app is logged in and on Projects (${await app.evaluate(() => globalThis.__rendrrNav.path())})`);
check(await app.locator("header.top").count() === 1, "the app shows Rendrr, logged in");
check(await app.evaluate(() => localStorage.getItem("rendrr:desktop-login")) === null, "the app forgets its secret once used");

// ---- The same grant again, or in an app that did not start it: nothing ----
const other = await ctx.newPage(); watch(other);
await other.addInitScript(() => { window.rendrrDesktop = { app: "mac", platform: "darwin", version: "0.1.2", openInBrowser() {} }; });
await other.goto(base + "/desktop-login?grant=" + grant);
check(await until(other, async () => /Not logged in/.test(await other.locator("#desktop-login").innerText().catch(() => ""))), "a used grant does not log in again");
await other.evaluate(() => localStorage.setItem("rendrr:desktop-login", JSON.stringify({ v: "x".repeat(43), at: Date.now() })));
const g2 = await tab.evaluate(async (c) => (await globalThis.__desktopLogin.approve(c)).grant, url.searchParams.get("c"));
{
  await other.goto(base + "/desktop-login?grant=" + g2);
  check(await until(other, async () => /Not logged in/.test(await other.locator("#desktop-login").innerText().catch(() => ""))), "an app with a different secret gets nothing for someone else's grant");
}
await tab.goto(base + "/desktop-login?c=short");
check(/This link is not right/.test(await tab.locator("#desktop-login").innerText()), "a broken link says so");

check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
