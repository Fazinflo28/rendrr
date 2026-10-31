// Comments like Higgsfield: a centred empty state, and a composer with the moment (a clock chip), drawing on the
// picture (pen colours, undo, clear), emoji, pictures (picked, pasted or dropped; up to 4) and a round send button that
// lights up once there is something to post. A comment with only a drawing posts too, and shows its drawing and
// picture in the list. Runs on the demo build (node demo/build.mjs first).
//   node demo/comments-compose.mjs   (from apps/web)
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
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }).catch(() => chromium.launch());
const errors = [], fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A small red PNG to attach.
const png = (() => {
  const w = 40, h = 30, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([230, 40, 40], y * (w * 3 + 1) + 1 + x * 3); }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();

for (const [vp, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, ...(vp === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
  await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
  // An edit with no comments: the empty state sits in the middle of the list.
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p1")); await page.locator("#timeline").waitFor({ timeout: 8000 }).catch(() => {}); await sleep(1000);
  await page.locator("#tab-comments").click(); await sleep(300);
  if (await page.locator("#comments-empty").count()) {
    const c = await page.evaluate(() => { const e = document.querySelector("#comments-empty"), l = document.querySelector("#comment-list"); const a = e.getBoundingClientRect(), b = l.getBoundingClientRect(); return { dx: Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2), dy: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2), lh: b.height }; });
    check(c.dx < 4 && c.dy < 30, `${vp}: the empty state is centred in the list (off by ${c.dx.toFixed(0)}, ${c.dy.toFixed(0)} px)`);
  } else check(true, `${vp}: (this edit has comments; empty state not shown)`);
  // The composer on the demo edit with a comment.
  await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);
  await page.locator("#tab-comments").click(); await page.locator("#comment-box").waitFor();
  check(await page.locator("#comment-time").count() === 1 && /\d\d:\d\d/.test(await page.locator("#comment-time").textContent()), `${vp}: a clock chip with the moment`);
  check(await page.locator("#comment-post").isDisabled(), `${vp}: the round send button waits for something to post`);
  const sb = await page.locator("#comment-post").boundingBox();
  check(Math.abs(sb.width - sb.height) < 1 && sb.width >= 26, `${vp}: it is round (${sb.width.toFixed(0)}x${sb.height.toFixed(0)})`);
  // Draw on the picture.
  await page.locator("#comment-draw").click(); await sleep(200);
  check(await page.locator("#comment-draw-bar").count() === 1 && await page.locator("#comment-draw-layer").count() === 1, `${vp}: Draw opens pen colours and a layer on the picture`);
  await page.locator(".cbox-pen").nth(1).click();
  await sleep(600); // the editor brings the picture into view when Draw is on (a phone's comments sit below it)
  const L = await page.locator("#comment-draw-layer").boundingBox();
  console.log(`     (${vp}: drawing layer at ${L.x.toFixed(0)},${L.y.toFixed(0)} ${L.width.toFixed(0)}x${L.height.toFixed(0)}; top element there: ${await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.tagName + "." + e.className) : "none"; }, [L.x + L.width * 0.4, L.y + L.height * 0.4])})`);
  await page.mouse.move(L.x + L.width * 0.3, L.y + L.height * 0.3); await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(L.x + L.width * (0.3 + k * 0.03), L.y + L.height * (0.3 + k * 0.02));
  await page.mouse.up(); await sleep(200);
  const lines = await page.locator("#comment-draw-layer polyline").count();
  check(lines >= 1, `${vp}: a stroke is drawn (${lines})`);
  check((await page.locator("#comment-draw-layer polyline").first().getAttribute("stroke")) === "#ffd60a", `${vp}: in the picked colour`);
  check(!(await page.locator("#comment-post").isDisabled()), `${vp}: a drawing alone can be posted`);
  await page.locator("#comment-draw-done").click(); await sleep(200);
  check(/Drawing/.test(await page.locator("#comment-attached").textContent()), `${vp}: the drawing waits above the box`);
  // Emoji and a picture.
  await page.locator("#comment-input").fill("Logo here ");
  await page.locator("#comment-emoji").click(); await page.locator("#comment-emoji-pop").waitFor();
  await page.locator(".cbox-em").first().click(); await sleep(150);
  check((await page.locator("#comment-input").inputValue()).includes("👍"), `${vp}: an emoji goes into the text`);
  await page.locator("#comment-file").setInputFiles({ name: "ref.png", mimeType: "image/png", buffer: png }); await sleep(500);
  check(await page.locator(".cbox-thumb").count() === 1, `${vp}: a picture is attached`);
  const before = await page.locator("[data-comment]").count();
  await page.locator("#comment-post").click(); await sleep(700);
  check(await page.locator("[data-comment]").count() === before + 1, `${vp}: posted`);
  const last = page.locator("[data-comment]").last();
  const txt = (await page.locator("[data-comment]").evaluateAll((els) => els.map((e) => e.textContent).join("|")));
  check(/Logo here 👍/.test(txt) && await page.locator("[data-comment] .cmt-img").count() >= 2 && /Drawing/.test(txt), `${vp}: it shows its text, drawing and picture`);
  check(await page.locator("#comment-attached").count() === 0 && (await page.locator("#comment-input").inputValue()) === "", `${vp}: the box is empty again`);
  void last;
  await page.close();
}
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
