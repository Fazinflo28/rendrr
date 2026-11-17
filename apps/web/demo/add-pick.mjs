// The page the user opens from their AI's link (/add/<pick>): add videos and pictures from this computer for the AI.
// It names the AI and the edit, takes videos and pictures (other files are left out and said), lists what arrived with
// its state, reports it for the AI, and Done says the AI can see them. A link for another account, or one that
// expired, says so and takes nothing. Desktop and phone. Runs on the demo build (node demo/build.mjs first).
//   node demo/add-pick.mjs   (from apps/web)
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
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
const png = (() => {
  const w = 8, h = 8, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([40, 200, 90, 255], y * (w * 4 + 1) + 1 + x * 4);
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();

async function open(seed, w = 1280, h = 860, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript((s) => { globalThis.__demoPick = s; }, seed);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600);
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
  await page.evaluate(() => globalThis.__rendrrNav.go("/add/pk_demo_1234567890")); await sleep(900);
  return { ctx, page, errors };
}
const text = (p, sel) => p.locator(sel).first().textContent().then((t) => (t || "").replace(/\s+/g, " ").trim()).catch(() => "");

for (const [tag, w, h, mobile] of [["desktop", 1280, 860, false], ["phone", 390, 844, true]]) {
  const { ctx, page, errors } = await open({ source: "computer", aiName: "Claude", project: { id: "p2", name: "Gym promo reel" } }, w, h, mobile);
  check(/Add files for Claude/.test(await text(page, "#add-pick h1")), `${tag}: the page names the AI`);
  check(/from this computer, for the edit Gym promo reel/.test(await text(page, "#pick-for")), `${tag}: and the edit it is for (${await text(page, "#pick-for")})`);
  check(await page.locator("#pick-drop").isVisible(), `${tag}: a place to drop or choose files`);
  await page.locator("#pick-input").setInputFiles([
    { name: "Long interview.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(8192) },
    { name: "Product shot.png", mimeType: "image/png", buffer: png },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
  ]);
  await page.locator("#pick-list").waitFor({ timeout: 6000 }).catch(() => {});
  await sleep(600);
  const rows = await page.locator("[data-pick-video]").count();
  check(rows === 2, `${tag}: the video and the picture arrive; the text file does not (${rows})`);
  const reported = await page.evaluate(() => (globalThis.__demoPickReports || []).flat().length);
  check(reported === 2, `${tag}: both are reported for the AI (${reported})`);
  const toasts = await page.locator(".toast").allTextContents();
  check(toasts.some((t) => /1 file was left out: only videos and pictures come in/.test(t)), `${tag}: the left-out file is said`);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("#add-pick *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag}: the page fits the screen`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `add-pick-${tag}.png`) });
  await page.locator("#pick-done").click(); await sleep(400);
  check(/Claude can see them now/.test(await text(page, "#pick-finished")), `${tag}: Done says the AI can see them`);
  check((await page.locator("#pick-drop").count()) === 0, `${tag}: and the drop area goes`);
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// A link for another account, and one that expired.
for (const [what, seed, title] of [["another account's link", { other: true }, "This link is for another account"], ["an expired link", { expired: "gone" }, "This link has expired"]]) {
  const { ctx, page, errors } = await open(seed);
  const t = await page.locator(".page").first().textContent().catch(() => "");
  check(t.includes(title), `${what}: says "${title}"`);
  check((await page.locator("#pick-drop").count()) === 0, `${what}: takes nothing`);
  check(errors.length === 0, `${what}: no page errors`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
