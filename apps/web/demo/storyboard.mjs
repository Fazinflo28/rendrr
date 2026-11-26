// Storyboard mode in the editor: the top bar's menu opens the Storyboard; an edit with none offers to make one; the
// board shows one big preview card pinned at the top (in the video's shape) with previous and next, every frame as a
// small picture under it (a tap opens it above), and the style sheet one tap away; a drawing and a comment go on the
// big card's frame together (at the frame's moment, on this board), the board counts it; picture frames only offers to
// add the video frames; approving it offers to render the whole video, which starts the preview; Claude's link
// (?storyboard=<id>) opens that board straight away. Runs on the demo build (node demo/build.mjs first) in Playwright's
// Chromium.
//   node demo/storyboard.mjs   (from apps/web)   SHOT=<file.png> also saves a picture of the board.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await sleep(100); } };
await page.goto(`http://localhost:${server.address().port}/`); await sleep(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(800); }
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(1200);

// The top bar's "…" menu has the Storyboard; an edit with none offers to make one.
await page.locator("#editor-more").click(); await sleep(200);
const btn = page.locator("#storyboard-btn");
check(await btn.count() === 1 && /Storyboard/.test(await btn.innerText()), "the top bar's menu has Storyboard");
await btn.click();
check(await until(async () => (await page.locator("#sb-empty").count()) === 1), "an edit with no storyboard offers to make one (and to skip it)");
check(/edit straight away/.test(await page.locator("#sb-empty").innerText()), "it says the storyboard is optional");

// Rendrr picks the panels: six, numbered, with their words; the style sheet beside them.
await page.locator("#sb-make").click();
check(await until(async () => (await page.locator("#sb-grid .sb-thumb").count()) === 6), "every frame as a small picture under the big card");
// The big card on top, in the video's own shape (this board is 16:9), the whole frame shown; the small frames under it.
const stageBox = await page.locator("#sb-stage").boundingBox(), gridBox = await page.locator("#sb-grid").boundingBox();
check(!!stageBox && !!gridBox && stageBox.y < gridBox.y, "the big card is above the small frames");
const bigImg = await page.locator("#sb-one img").boundingBox();
check(!!bigImg && Math.abs(bigImg.width / bigImg.height - 16 / 9) < 0.03, `the big card shows the frame in the video's shape (${bigImg && (bigImg.width / bigImg.height).toFixed(3)})`);
const thumbs = await page.locator("#sb-grid .sb-thumb .sb-pic").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
check(thumbs.every((c) => Math.abs(c.w / c.h - 16 / 9) < 0.03) && thumbs[0].w < (bigImg?.width || 0), `small frames in the video's shape (${thumbs.map((c) => (c.w / c.h).toFixed(3)).join(", ")})`);
const tops = await page.locator("#sb-grid .sb-thumb").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
const rows = tops.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
check(Object.values(rows).every((n) => n === 2) && Object.keys(rows).length === 3, `small frames two to a row (${Object.values(rows).join(", ")})`);
check(await page.locator("#sb-grid .sb-thumb .sb-pic img").first().evaluate((el) => getComputedStyle(el).objectFit) === "contain", "the whole frame shows, nothing cropped");
check(await page.locator("#sb-stage").evaluate((el) => getComputedStyle(el).position) === "sticky", "the big card stays pinned at the top");
check(await page.locator("#sb-style").count() === 0, "the frames come first; the style sheet is one tap away");
await page.locator("#sb-style-toggle").click(); await sleep(150);
check(await page.locator("#sb-title").innerText() === "Fontora launch", "the board's title");
check(/In review/.test(await page.locator("#sb-meta").innerText()), "it is in review");
check(/1 \/ 6/.test(await page.locator("#sb-count").innerText()) && await page.locator("#sb-one-title").innerText() === "Opening", "the big card opens on frame 1");
check(/STILL DOWNLOADING ICONS/.test(await page.locator("#sb-stage").innerText()), "with the words on screen");
check(/▶ 4s/.test(await page.locator('[data-panel="3"]').innerText()), "a video frame shows its length in the strip");
check(/3 words at a time, the spoken word lit in #34C759/.test(await page.locator("#sb-cap-anim").innerText()), "the style sheet: how captions come on");
const cap = await page.locator("#sb-captions .sb-cap").evaluate((el) => ({ font: getComputedStyle(el).fontFamily, weight: getComputedStyle(el).fontWeight, upper: getComputedStyle(el).textTransform }));
check(/Inter/.test(cap.font) && cap.weight === "700" && cap.upper === "uppercase", `the captions drawn in their font and case (${JSON.stringify(cap)})`);
check(/Inter 700[\s\S]*captions[\s\S]*Poppins 600[\s\S]*titles and text/.test(await page.locator("#sb-fonts").innerText()), "the fonts, with what each is for");
check(/#34C759[\s\S]*brand green/.test(await page.locator("#sb-colors").innerText()), "the colours, with what each is for");
check(/cleanup studio/.test(await page.locator("#sb-facts").innerText()), "the rest: look, music, sound, pacing");
await page.locator("#sb-style-toggle").click(); await sleep(150);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });

// Previous and next step through the frames; a tap on a small frame opens it in the big card.
await page.locator("#sb-next").click(); await sleep(150);
check(/2 \/ 6/.test(await page.locator("#sb-count").innerText()) && await page.locator('[data-panel="1"].on').count() === 1, "next opens frame 2 in the big card");
await page.keyboard.press("ArrowRight"); await sleep(150);
check(/3 \/ 6/.test(await page.locator("#sb-count").innerText()), "the right arrow key steps on");
await page.locator("#sb-prev").click(); await sleep(150);
await page.locator('[data-panel="5"]').click(); await sleep(150);
check(/6 \/ 6/.test(await page.locator("#sb-count").innerText()) && await page.locator("#sb-next").isDisabled(), "a tap on a small frame opens it above");
await page.locator('[data-panel="1"]').click(); await sleep(150);
check(await page.locator("#sb-one-title").innerText() === "Meet Fontora", "frame 2 in the big card, with its title");

// Draw on the big card and say what to change; both go on the board at the frame's moment.
await page.locator("#sb-draw").click(); await sleep(150);
const box = await page.locator("#sb-draw-layer").boundingBox();
const img = await page.locator(".sb-big img").boundingBox();
check(!!box && !!img && Math.abs(box.x - img.x) < 2 && Math.abs(box.width - img.width) < 2 && Math.abs(box.height - img.height) < 2, "the pen covers exactly the picture");
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4); await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * 0.4, { steps: 2 });
await page.mouse.up(); await sleep(150);
check(await page.locator("#sb-draw-layer polyline").count() >= 1, "the stroke is drawn on the frame");
await page.locator("#sb-comment").fill("Make the title bigger and move it up");
await page.keyboard.press("ArrowRight"); await sleep(100);
check(/2 \/ 6/.test(await page.locator("#sb-count").innerText()), "typing the comment does not change the frame");
check(/with drawing/.test(await page.locator("#sb-add").innerText()), "the button says the drawing goes with it");
await page.locator("#sb-add").click();
check(await until(async () => (await page.locator("#sb-changes [data-comment]").count()) === 1), "the change is listed on the frame");
const sent = await page.evaluate(() => globalThis.__rendrrLastComment);
check(sent && Math.abs(sent.time - 4.5) < 1e-6 && sent.drawing?.strokes?.length === 1 && sent.drawing.strokes[0].p[0] > 0.25 && sent.drawing.strokes[0].p[0] < 0.35, `it went at the frame's moment with the drawing in shares of the picture (${JSON.stringify(sent && { t: sent.time, s: sent.drawing?.strokes?.length })})`);
check(/1/.test(await page.locator('[data-panel="1"] .sb-cm').innerText().catch(() => "")), "the small frame shows it has a change");
check(/1 change asked/.test(await page.locator("#sb-meta").innerText()) && await page.locator("#sb-send").count() === 1, "and offers to send it to Claude");

// Approve: then render the whole video (the editor's preview starts).
await page.locator("#sb-approve").click();
check(await until(async () => /Approved/.test(await page.locator("#sb-state").innerText())), "approved");
check(await page.locator("#sb-render").count() === 1 && await page.locator("#sb-unapprove").count() === 1, "it offers to render the video, or go back to review");
const sb = await page.locator("#storyboard").getAttribute("data-render");
await page.locator("#sb-render").click(); await sleep(400);
check(await page.locator("#storyboard").count() === 0, "rendering the video closes the board");
check(await until(async () => (await page.evaluate(() => globalThis.__demoRenders || [])).includes("renderPreview"), 3000), "the whole video's preview render starts");

// Claude's link opens that board straight away (another page load, as from the chat).
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await sleep(500);
await page.evaluate((x) => { history.pushState({}, "", "/editor/p5?storyboard=" + x); globalThis.__rendrrNav.go("/editor/p5?storyboard=" + x); }, sb); await sleep(1500);
check(!!sb && await until(async () => (await page.locator("#storyboard").getAttribute("data-render").catch(() => null)) === sb), "Claude's link (?storyboard=) opens that board");
check(await until(async () => /Approved/.test(await page.locator("#sb-state").innerText().catch(() => ""))), "still approved");
await page.locator("#sb-close").click(); await sleep(300);
check(!(await page.evaluate(() => location.search)).includes("storyboard"), "closing it takes the link's ?storyboard= off");
// Picture frames only: no video frames; the board offers to add them, which makes the clips again as video frames.
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await sleep(800);
await page.locator("#editor-more").click(); await sleep(200); await page.locator("#storyboard-btn").click(); await sleep(600);
await page.locator("#sb-again").waitFor();
await page.evaluate(async () => { await globalThis.__rendrrDemoApi?.renderStoryboard?.("p5", { frames: "images", panels: [{ at: 1, title: "Hook" }, { at: 4, end: 7, title: "Reveal" }] }); });
await page.locator("#sb-close").click(); await sleep(300);
await page.locator("#editor-more").click(); await sleep(200); await page.locator("#storyboard-btn").click(); await sleep(800);
{
  check(await until(async () => /pictures/.test(await page.locator("#sb-meta").innerText().catch(() => ""))), "a board of picture frames says so");
  check(await page.locator("#sb-grid .sb-thumb .sb-len").count() === 0, "and has no video frames");
  await page.locator("#sb-video").click();
  check(await until(async () => /1 video/.test(await page.locator("#sb-meta").innerText().catch(() => ""))), "Add video frames makes the clip panel a video frame again");
}
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
