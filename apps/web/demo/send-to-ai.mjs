// "Send to Claude" in the editor's Comments panel: one click sends the open comments to the connected AI. The AI's
// chat opens with the message ready (claude.ai/new?q=… or chatgpt.com/?q=…), each sent comment says so, the choice
// is remembered, both AIs connected gives a menu, none connected leads to Connect AI. Inside the Mac app the link
// goes to the browser (window.open, which the app hands to the default browser). Runs on the demo build.
//   node demo/build.mjs && node demo/send-to-ai.mjs   (from apps/web)
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
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const errors = [], fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openEditor(vp, w, h, connect, before) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(vp === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  // The AI's chat opens in a new tab: answer it with a blank page instead of going to claude.ai.
  await ctx.route(/^https:\/\/(claude\.ai|chatgpt\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>chat</title>" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(([c, b]) => { globalThis.__demoConnect = c; if (b) localStorage.setItem("rendrr.sendAi", b); }, [connect, before || null]);
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor({ timeout: 10000 }); await sleep(1000);
  await page.locator("#side-comments").click(); await page.locator("#comment-box").waitFor();
  // A note of the user's own, so there is something open to send.
  await page.locator("#comment-input").fill("Cut the cough & tighten here"); await page.locator("#comment-post").click(); await sleep(500);
  return { ctx, page };
}

for (const [vp, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  // Claude connected.
  {
    const { ctx, page } = await openEditor(vp, w, h, { claude: "connected", chatgpt: "disconnected" });
    const btn = page.locator("#ai-send-btn");
    await btn.waitFor({ timeout: 5000 });
    const openN = await page.locator(".cmt:not(.done)").count();
    const label = (await btn.textContent()).trim();
    check(new RegExp(`^Send ${openN} comments? to Claude$`).test(label), `${vp}: the button says what it sends (${label})`);
    check(await page.locator("#ai-send-pick").count() === 0, `${vp}: one AI connected: no menu`);
    // Sizes in CSS pixels (the desktop app is drawn at 80%).
    const box = await btn.evaluate((e) => ({ w: e.offsetWidth, h: e.offsetHeight, pw: document.querySelector("#comments-panel").offsetWidth }));
    check(box.w > box.pw * 0.6 && box.h >= 32, `${vp}: a full-width button (${box.w}x${box.h} in a ${box.pw} panel)`);
    const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }), btn.click()]);
    await tab.waitForURL(/claude\.ai\/new\?q=/, { timeout: 5000 }).catch(() => {});
    const url = tab.url();
    check(url.startsWith("https://claude.ai/new?q="), `${vp}: Claude's chat opens (${url.slice(0, 40)}…)`);
    const q = decodeURIComponent(url.split("?q=")[1] || "");
    check(/^Please work through the \d+ open comments? on my Rendrr edit ".+" \(project p5\)/.test(q), `${vp}: with the message ready`);
    check(q.includes("Cut the cough & tighten here"), `${vp}: the comment's words are in it, & and all`);
    check(/Read them with get_comments/.test(q), `${vp}: and how to read them through Rendrr`);
    check(await tab.evaluate(() => window.opener === null), `${vp}: the chat tab cannot reach back into Rendrr`);
    await sleep(300);
    const sent = await page.locator(".cmt-sent").count();
    check(sent === openN, `${vp}: every open comment says it was sent (${sent}/${openN})`);
    check(/^Sent to Claude · /.test((await page.locator(".cmt-sent").first().textContent()).trim()), `${vp}: "Sent to Claude · …"`);
    check(/Sent \d+ comments? to Claude/.test(await page.locator("body").textContent()), `${vp}: a toast says so`);
    const s = await page.evaluate(() => globalThis.__demoSent?.at(-1));
    check(s?.ai === "claude" && s.count === openN, `${vp}: Rendrr was told (so Claude hears it on its next call)`);
    await ctx.close();
  }
  // Both connected, ChatGPT picked last time: it is the default, and the menu switches.
  {
    const { ctx, page } = await openEditor(vp, w, h, { claude: "connected", chatgpt: "connected" }, "chatgpt");
    await page.locator("#ai-send-btn").waitFor();
    check(/to ChatGPT$/.test((await page.locator("#ai-send-btn").textContent()).trim()), `${vp}: the AI picked last time is the default`);
    await page.locator("#ai-send-pick").click();
    await page.locator("#ai-send-menu").waitFor();
    const mb = await page.locator("#ai-send-menu").boundingBox();
    check(mb.x >= 0 && mb.x + mb.width <= w + 1, `${vp}: the menu fits on screen`);
    const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }), page.locator("#ai-send-claude").click()]);
    await tab.waitForURL(/claude\.ai/, { timeout: 5000 }).catch(() => {});
    check(tab.url().startsWith("https://claude.ai/new?q="), `${vp}: the menu sends to Claude instead`);
    check(await page.evaluate(() => localStorage.getItem("rendrr.sendAi")) === "claude", `${vp}: and remembers it`);
    check(/to Claude$/.test((await page.locator("#ai-send-btn").textContent()).trim()), `${vp}: the button now says Claude`);
    await ctx.close();
  }
  // Nothing connected: the button leads to Connect AI.
  {
    const { ctx, page } = await openEditor(vp, w, h, { claude: "disconnected", chatgpt: "disconnected" });
    await page.locator("#ai-send-connect").waitFor({ timeout: 5000 });
    check(await page.locator("#ai-send-btn").count() === 0, `${vp}: nothing connected: no send button`);
    await page.locator("#ai-send-connect").click();
    check(await page.locator("#mcp-url").waitFor({ timeout: 4000 }).then(() => true, () => false), `${vp}: it opens Connect AI`);
    await ctx.close();
  }
}

// Inside the Mac app: no blank tab first; the link itself is opened (the app gives it to the browser).
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    globalThis.__demoConnect = { claude: "connected", chatgpt: "disconnected" };
    window.rendrrDesktop = { app: "mac", version: "0.1.8", openInBrowser: () => {} };
    window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f]); return null; };
  });
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor({ timeout: 10000 }); await sleep(1000);
  await page.locator("#side-comments").click(); await page.locator("#comment-box").waitFor();
  await page.locator("#comment-input").fill("Mac note"); await page.locator("#comment-post").click(); await sleep(400);
  await page.locator("#ai-send-btn").click(); await sleep(600);
  const opened = await page.evaluate(() => window.__opened.filter((o) => o[0]));
  check(opened.length === 1 && opened[0][0].startsWith("https://claude.ai/new?q="), `Mac app: the chat link itself is opened, once (${opened.length})`);
  check(!(await page.evaluate(() => window.__opened.some((o) => o[0] === ""))), "Mac app: no blank tab first");
  await ctx.close();
}

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
