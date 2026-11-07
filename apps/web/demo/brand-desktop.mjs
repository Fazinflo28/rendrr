// The Rendrr logo as the web app's icons, and the web app inside the Mac app (desktop/): the tab icon, Apple icon and
// home-screen icons exist at the right sizes and the manifest points at them; with html.desktop the top bars leave
// room for the Mac window buttons, drag the window, and keep their buttons clickable. Runs on the demo build
// (node demo/build.mjs first) in Playwright's Chromium.   node demo/brand-desktop.mjs   (from apps/web)
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

// ---- Icons ----
const png = (p) => { const b = readFileSync(p); return b.toString("ascii", 1, 4) === "PNG" ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null; };
const app = join(web, "src", "app");
const svg = readFileSync(join(app, "icon.svg"), "utf8");
check(/viewBox="0 0 1000 1000"/.test(svg) && /fill="#bde815"/.test(svg) && /fill="#0b0c0e"/.test(svg), "the tab icon is the lime mark on the dark square");
check(!existsSync(join(app, "icon.png")), "only one tab icon file (icon.svg)");
const ico = readFileSync(join(app, "favicon.ico"));
check(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 3, "favicon.ico holds 3 sizes (16, 32, 48)");
const apple = png(join(app, "apple-icon.png"));
check(apple && apple.w === 180 && apple.h === 180, "the Apple icon is 180 x 180");
const manifest = readFileSync(join(app, "manifest.ts"), "utf8");
const srcs = [...manifest.matchAll(/src: "([^"]+)", sizes: "(\d+)x(\d+)"/g)];
check(srcs.length === 3, "the manifest lists 3 icons");
for (const [, src, w, h] of srcs) {
  const f = png(join(web, "public", src));
  check(f && f.w === +w && f.h === +h, `${src} is there at ${w} x ${h}`);
}
check(/purpose: "maskable"/.test(manifest) && /background_color: "#0b0c0e"/.test(manifest), "a maskable icon and the dark background");
check(/themeColor: "#0b0c0e"/.test(readFileSync(join(app, "layout.tsx"), "utf8")), "the browser bar takes the dark colour");

// ---- Inside the Mac app ----
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
const region = (sel) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region") || getComputedStyle(e).getPropertyValue("app-region"));
const left = (sel) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().left);
await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) {
  // The login window shows the app icon, not the word.
  const li = await page.locator(".hform .logo svg.appicon").first().evaluate((e) => ({ w: e.getAttribute("width") + "px", label: e.getAttribute("aria-label") })).catch(() => null);
  check(li && li.w === "56px" && li.label === "Rendrr", `the login window shows the Rendrr app icon (${li ? li.w : "none"})`);
  await page.screenshot({ path: join(here, "dist", "brand-login.png"), clip: { x: 0, y: 0, width: 1280, height: 400 } }); await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await page.locator("header.top").waitFor(); await page.waitForTimeout(300);
// The top bar: the app icon alone (the lime mark on the dark square), like Higgsfield's; no wordmark.
const icon = await page.locator("header.top .logo svg.appicon").evaluate((e) => ({ w: e.getAttribute("width") + "px", h: e.getAttribute("height") + "px", rect: e.querySelector("rect")?.getAttribute("fill"), mark: e.querySelector("path")?.getAttribute("fill") })).catch(() => null);
check(icon && icon.w === "36px" && icon.h === "36px" && icon.rect === "#0b0c0e" && icon.mark === "#bde815", "the top bar shows the app icon: lime mark on the dark square (36 px, about 29 on screen at the app's 80%)");
check((await page.locator("header.top .logo").innerText()).trim() === "" && !(await page.locator(".wordmark").count()), "no word next to it");
await page.screenshot({ path: join(here, "dist", "brand-top.png"), clip: { x: 0, y: 0, width: 1280, height: 70 } });
await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(200);
check(await page.locator("header.top .logo svg.appicon").evaluate((e) => e.getBoundingClientRect().width) === 26, "on a phone the icon is 26 px");
await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(200);
const plainLeft = await left("header.top .logo");
check(plainLeft < 60, `in a browser the logo stays at the left (${Math.round(plainLeft)}px)`);
check((await region("header.top")) !== "drag", "in a browser nothing drags");

await page.evaluate(() => document.documentElement.classList.add("desktop"));
const macLeft = await left("header.top .logo");
check(macLeft >= 84, `in the Mac app the logo moves past the window buttons (${Math.round(macLeft)}px)`);
check((await region("header.top")) === "drag", "the top bar drags the window");
check((await region("header.top .logo")) === "no-drag" && (await region("header.top .nav")) === "no-drag", "its buttons stay clickable");
await page.locator("header.top .nav").first().click(); await page.waitForTimeout(300);
check(errors.length === 0, "a top-bar button still works");
await page.evaluate(() => document.documentElement.classList.add("desktop-full"));
check((await left("header.top .logo")) < 60, "full screen (no window buttons): the logo goes back to the left");
await page.evaluate(() => document.documentElement.classList.remove("desktop-full"));

// The editor's top bar too (the window buttons end about 70 screen pixels in).
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(800);
const inEditor = (await page.locator(".ed-top").count()) > 0;
check(inEditor, "the editor opens");
if (inEditor) {
  const backLeft = await page.locator(".ed-top button").first().evaluate((e) => e.getBoundingClientRect().left);
  check(backLeft >= 84, `the editor's Back button sits past the window buttons (${Math.round(backLeft)}px)`);
  check((await region(".editor .ed-top")) === "drag" && (await region("#project-name")) === "no-drag", "the editor bar drags; the name box types");
  await page.screenshot({ path: join(here, "dist", "desktop-editor.png"), clip: { x: 0, y: 0, width: 1280, height: 120 } });
}
check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
