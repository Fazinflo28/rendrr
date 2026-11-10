// The AI connector's login page (/oauth/consent, Supabase's OAuth server sends Claude or ChatGPT here): logged out it
// asks to log in first; logged in it names the app and the account; Allow and Deny send the browser back to the app
// with the answer; a request already allowed goes straight back; a bad link says so. Runs on the demo build.
//   node demo/build.mjs && node demo/oauth-consent.mjs   (from apps/web)
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
const errors = [], fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = `http://localhost:${server.address().port}`;

async function page(setup) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/^https:\/\/claude\.ai\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>back in Claude</title>" }));
  const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message));
  if (setup) await p.addInitScript(setup);
  return { ctx, p };
}
// Opens the consent page by its URL (with the request id), logged out, and logs in from its own button.
async function openConsent(p, query) {
  await p.goto(origin + "/oauth/consent" + query); await p.locator("#oauth-consent").waitFor();
  const btn = p.locator("#oauth-login");
  if (await btn.count()) {
    check(/Log in to connect/.test(await p.locator("#oauth-consent").innerText()), "logged out: it asks to log in first");
    await btn.click(); await sleep(400);
    await p.locator('input[type="email"]').first().fill("you@example.com"); await p.locator('input[type="password"]').first().fill("x"); await p.locator('form.hform button[type="submit"]').first().click(); await sleep(800);
  }
}

// Logged in: names the app and the account; Allow goes back to Claude with a code.
{
  const { ctx, p } = await page();
  await openConsent(p, "?authorization_id=a1");
  await p.locator("#oauth-allow").waitFor({ timeout: 4000 }).catch(() => {});
  const text = await p.locator("#oauth-consent").innerText();
  check(/Connect Claude to Rendrr\?/.test(text), `names the app (${text.split("\n")[0]})`);
  check(text.includes("you@example.com"), "and the account it connects to");
  const top = await p.evaluate(() => !document.querySelector(".top"));
  check(top, "a page of its own (no app bar)");
  await Promise.all([p.waitForURL(/claude\.ai/, { timeout: 5000 }).catch(() => {}), p.locator("#oauth-allow").click()]);
  check(/claude\.ai\/api\/mcp\/auth_callback\?code=demo/.test(p.url()), `Allow goes back to Claude with the code (${p.url().slice(0, 60)})`);
  await ctx.close();
}
// Deny goes back with access_denied; ChatGPT is named.
{
  const { ctx, p } = await page(() => { globalThis.__demoOAuth = { name: "ChatGPT" }; });
  await openConsent(p, "?authorization_id=a2"); await p.locator("#oauth-deny").waitFor({ timeout: 4000 });
  check(/Connect ChatGPT to Rendrr\?/.test(await p.locator("#oauth-consent").innerText()), "names ChatGPT");
  await Promise.all([p.waitForURL(/claude\.ai/, { timeout: 5000 }).catch(() => {}), p.locator("#oauth-deny").click()]);
  check(/error=access_denied/.test(p.url()), "Deny goes back with the refusal");
  await ctx.close();
}
// Already allowed: straight back. A bad link: says so. No id: says how to start.
{
  const { ctx, p } = await page(() => { globalThis.__demoOAuth = { done: true, redirect: "https://claude.ai/api/mcp/auth_callback?code=again" }; });
  await Promise.all([p.waitForURL(/claude\.ai/, { timeout: 8000 }).catch(() => {}), openConsent(p, "?authorization_id=a3").catch(() => {})]);
  check(/code=again/.test(p.url()), "a request already allowed goes straight back");
  await ctx.close();
}
{
  const { ctx, p } = await page();
  await openConsent(p, "?authorization_id=bad"); await sleep(600);
  check(/expired/.test(await p.locator("#oauth-consent").innerText()), "an expired request says so");
  await p.goto(origin + "/oauth/consent"); await p.locator("#oauth-consent").waitFor(); await sleep(300);
  check(/not right/.test(await p.locator("#oauth-consent").innerText()), "no request id: says how to start again");
  await ctx.close();
}
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
