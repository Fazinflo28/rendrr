// The Assets page (once Library): a side bar with All assets, Favorites, Trash and the types Videos, Images, Elements,
// Audio, with counts. Elements show on a see-through checkerboard and upload (an SVG is drawn to a PNG first); audio
// plays; the heart adds to Favorites; delete moves to the Trash (Undo, Restore, Delete for good, Empty trash); the
// Videos section is the library as it was. The editor's Media panel lists elements: one click puts one on the edit.
// Runs on the demo build (node demo/build.mjs first).
//   node demo/assets.mjs   (from apps/web)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] }).catch(() => chromium.launch());
const errors = [], fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A small PNG with a transparent half.
const png = (() => {
  const w = 40, h = 30, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([230, 40, 40, x < 20 ? 255 : 0], y * (w * 4 + 1) + 1 + x * 4); }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" rx="12" fill="#bde816"/></svg>`);

async function login(page) {
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
}
const go = (page, p) => page.evaluate((x) => globalThis.__rendrrNav.go(x), p);
const count = (page, id) => page.locator(`[data-count="${id}"]`).textContent().then((t) => Number(t)).catch(() => NaN);

for (const [vp, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, ...(vp === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  // Old links land on Videos; the nav says Assets.
  await page.locator("#assets-page").waitFor({ timeout: 8000 });
  check(await page.locator('[data-section="videos"][aria-current="page"]').count() === 1, `${vp}: /library opens Assets > Videos`);
  check(vp === "phone" ? await page.locator('[data-mtab="Assets"]').count() === 1 : await page.locator('.topnav [data-tip="Assets"]').count() === 1, `${vp}: the nav says Assets`);
  const labels = await page.locator(".as-nav").allTextContents();
  check(["All assets", "Favorites", "Trash", "Videos", "Images", "Elements", "Audio"].every((l) => labels.some((x) => x.startsWith(l))), `${vp}: the side bar has every section`);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(noScroll, `${vp}: no sideways page scroll`);

  // All assets: videos, elements and audio together.
  await go(page, "/assets"); await page.locator("#assets-grid").waitFor();
  const types = new Set(await page.locator("#assets-grid .as-card").evaluateAll((els) => els.map((e) => e.dataset.type)));
  check(types.has("video") && types.has("element") && types.has("audio"), `${vp}: All assets mixes videos, elements and audio (${[...types].join(", ")})`);

  // Elements on a checkerboard; the heart adds to Favorites.
  await go(page, "/assets/elements"); await page.locator("#assets-grid").waitFor();
  check(await page.locator('#assets-grid .as-card[data-type="element"] .as-thumb.checker img').count() === 2, `${vp}: elements sit on a see-through checkerboard`);
  const fav0 = await count(page, "favorites");
  await page.locator('#assets-grid [data-fav="el_sub"]').click(); await sleep(250);
  check(await page.locator('#assets-grid [data-fav="el_sub"][aria-pressed="true"]').count() === 1, `${vp}: the heart turns on`);
  for (let i = 0; i < 30 && (await count(page, "favorites")) !== fav0 + 1; i++) await sleep(100);
  check(await count(page, "favorites") === fav0 + 1, `${vp}: Favorites counts it (${fav0} -> ${await count(page, "favorites")})`);
  await go(page, "/assets/favorites"); await page.locator("#assets-grid").waitFor();
  check(await page.locator('#assets-grid [data-asset="el_sub"]').count() === 1, `${vp}: it shows under Favorites`);
  await page.locator('#assets-grid [data-fav="el_sub"]').click(); await sleep(300);
  check(await page.locator('#assets-grid [data-asset="el_sub"]').count() === 0, `${vp}: un-hearted, it leaves Favorites`);

  // Upload a PNG and an SVG as elements (the SVG goes up as a PNG).
  await go(page, "/assets/elements"); await page.locator("#assets-grid").waitFor();
  await page.locator("#assets-file").setInputFiles([{ name: "logo.png", mimeType: "image/png", buffer: png }, { name: "badge.svg", mimeType: "image/svg+xml", buffer: svg }]);
  await sleep(1200);
  const ups = await page.evaluate(() => (globalThis.__demoUploads || []).slice(-2));
  check(ups.length === 2 && ups.every((u) => u.as === "element"), `${vp}: both upload as elements`);
  check(ups.some((u) => u.name === "badge.png" && u.type === "image/png"), `${vp}: the SVG is drawn to a PNG first (${JSON.stringify(ups.map((u) => u.name + ":" + u.type))})`);
  check(await page.locator('#assets-grid .as-card[data-type="element"]').count() === 4, `${vp}: the new elements show`);

  // Open one: rename it.
  await page.locator('#assets-grid [data-asset="el_logo"]').click(); await page.locator("#asset-view").waitFor();
  check(await page.locator("#asset-view.checker img").count() === 1, `${vp}: the viewer shows it on the checkerboard`);
  await page.locator("#asset-name").fill("Main logo"); await page.locator("#asset-name").press("Enter"); await sleep(250);
  await page.keyboard.press("Escape"); await sleep(250);
  check((await page.locator('#assets-grid [data-asset="el_logo"] .as-meta b').textContent()) === "Main logo", `${vp}: renamed`);

  // Delete moves to the Trash; Undo brings it back; Restore too.
  const tr0 = await count(page, "trash");
  await page.locator('#assets-grid [data-asset="el_sub"]').hover().catch(() => {});
  await page.locator('#assets-grid [data-trash="el_sub"]').click(); await sleep(300);
  check(await page.locator('#assets-grid [data-asset="el_sub"]').count() === 0, `${vp}: deleted, it leaves Elements`);
  check(/moved to the Trash/.test(await page.locator("body").textContent()), `${vp}: a toast says it went to the Trash`);
  for (let i = 0; i < 30 && (await count(page, "trash")) !== tr0 + 1; i++) await sleep(100);
  check(await count(page, "trash") === tr0 + 1, `${vp}: the Trash counts it`);
  await go(page, "/assets/trash"); await page.locator("#trash-list").waitFor();
  const row = page.locator('#trash-list [data-asset="el_sub"]');
  check(/30 days left/.test(await row.textContent()), `${vp}: the Trash says 30 days left`);
  await row.locator("[data-restore]").click(); await sleep(300);
  check(await page.locator('#trash-list [data-asset="el_sub"]').count() === 0, `${vp}: Restore takes it out of the Trash`);

  // Audio plays.
  await go(page, "/assets/audio"); await page.locator("#audio-list").waitFor();
  await page.locator('[data-play="snd_theme"]').click(); await sleep(400);
  check((await page.locator('[data-play="snd_theme"]').getAttribute("aria-label")).startsWith("Pause"), `${vp}: the play button plays (shows Pause)`);
  await page.locator('[data-play="snd_theme"]').click(); await sleep(200);
  check((await page.locator('[data-play="snd_theme"]').getAttribute("aria-label")).startsWith("Play"), `${vp}: and pauses`);

  // Videos: the library as it was; delete moves to the Trash; Delete for good there asks first.
  await go(page, "/assets/videos"); await page.locator(".vcard[data-id]").first().waitFor();
  const vid = await page.locator('.vcard[data-id][data-status="ready"]').first().getAttribute("data-id");
  await page.locator(`.vcard[data-id="${vid}"] [data-fav]`).click(); await sleep(250);
  check(await page.locator(`.vcard[data-id="${vid}"] [data-fav][aria-pressed="true"]`).count() === 1, `${vp}: a video gets a heart`);
  await page.locator(`.vcard[data-id="${vid}"] [data-delete]`).click(); await sleep(400);
  check(await page.locator(`.vcard[data-id="${vid}"]`).count() === 0, `${vp}: a deleted video leaves Videos`);
  await go(page, "/assets/trash"); await page.locator("#trash-list").waitFor();
  check(await page.locator(`#trash-list [data-asset="${vid}"]`).count() === 1, `${vp}: and waits in the Trash`);
  await page.locator(`#trash-list [data-asset="${vid}"] [data-forever]`).click(); await sleep(300);
  check(await page.locator("#confirm-delete-video").count() === 1, `${vp}: Delete for good asks first`);
  await page.keyboard.press("Escape"); await sleep(200);
  await page.locator("#empty-trash").click(); await page.locator("#confirm-empty-trash").click();
  await page.locator("#trash-list").waitFor({ state: "detached", timeout: 5000 }).catch(() => {}); await sleep(200);
  check(await page.locator("#trash-list").count() === 0 && /Trash is empty/.test(await page.locator("#assets-trash").textContent()), `${vp}: Empty trash empties it`);
  await page.close();
}

// The editor's Media panel: elements, one click puts one on V3 at the top right.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await go(page, "/editor/p5"); await page.locator("#timeline").waitFor({ timeout: 10000 }); await sleep(1200);
  const strip = page.locator("#bin-elements");
  if (!(await strip.count())) { await page.locator("#side-media, [data-side='media'], #left-media").first().click().catch(() => {}); await sleep(400); }
  check(await page.locator("#bin-elements [data-element]").count() >= 1, "editor: the Media panel lists elements");
  const before = await page.evaluate(() => document.querySelectorAll("[data-clip]").length);
  await page.locator('#bin-elements [data-element="el_logo"]').click(); await sleep(500);
  check(/Added "Brand logo" at the top right/.test(await page.locator("body").textContent()), "editor: it says the element was added");
  const after = await page.evaluate(() => document.querySelectorAll("[data-clip]").length);
  check(after === before + 1, `editor: one more clip on the timeline (${before} -> ${after})`);
  check(/Brand logo/.test(await page.locator("#inspector-head").textContent().catch(() => "")), "editor: the new clip is selected");
  await page.close();
}

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
