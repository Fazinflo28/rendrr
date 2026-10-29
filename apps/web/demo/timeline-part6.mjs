// Engine Part 6 in the browser: the dialogue track shows a real waveform drawn from the 10 ms peaks (loud where the
// words are, quiet between), only the part on screen, at any zoom up to the 10 ms frames; marks are thin coloured
// lines with a note on hover, a toggle hides them (and is remembered); the footage page shows no measurements; tool
// names are not on any screen. Runs on the demo build (node demo/build.mjs first) in Playwright's Chromium.
//   node demo/timeline-part6.mjs   (from apps/web)
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

await page.goto(`http://localhost:${server.address().port}/`); await page.waitForTimeout(800);
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(500);
const email = page.locator('input[type="email"]').first();
if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(800); }

await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1500);

// 1. The waveform: a canvas on A1 with ink where the words are (the demo's peaks are loud on words, quiet between).
const wave = page.locator(".track.a1 canvas.wave");
check((await wave.count()) === 1, "A1 has a waveform canvas");
const inkAt = () => page.evaluate(() => {
  const cv = document.querySelector(".track.a1 canvas.wave"); const g = cv.getContext("2d");
  const d = g.getImageData(0, 0, cv.width, cv.height).data, cols = cv.width, rows = cv.height, h = [];
  for (let x = 0; x < cols; x++) { let n = 0; for (let y = 0; y < rows; y++) if (d[(y * cols + x) * 4 + 3] > 40) n++; h.push(n / rows); }
  return { cols, tall: h.filter((v) => v > 0.5).length, short: h.filter((v) => v > 0 && v < 0.15).length, any: h.filter((v) => v > 0).length };
});
const w1 = await inkAt();
check(w1.any > w1.cols * 0.3 && w1.tall > 10 && w1.short > 5, `the waveform is drawn, tall on words and low between (${JSON.stringify(w1)})`);
check(await page.evaluate(() => { const cv = document.querySelector(".track.a1 canvas.wave"); const sc = document.querySelector(".tl-scroll"); return Math.abs(cv.offsetWidth - sc.clientWidth) < 2; }), "the waveform canvas is the viewport's width");
check((await page.locator(".track.a1").evaluate((e) => e.offsetHeight)) === 56 && (await page.locator(".track.v1").evaluate((e) => e.offsetHeight)) === 34, "the dialogue track is taller for its waveform");

// 2. Zoom in to the 10 ms frames: the slider's top is 600 px a second; the waveform redraws for the new zoom.
await page.locator("#tl-zoom").fill("1000"); await page.waitForTimeout(500);
const canvasW = await page.locator("#timeline").evaluate((e) => e.offsetWidth);
check(canvasW > 600 * 20, `zoomed to 600 px a second (timeline ${canvasW} px wide)`);
check(await page.evaluate(() => document.querySelector(".track.a1 canvas.wave").offsetWidth * 5 < document.querySelector("#timeline").offsetWidth), "only the part on screen is drawn (not the whole 600 px a second timeline)");
const w2 = await inkAt();
check(w2.any > 0 && JSON.stringify(w2) !== JSON.stringify(w1), `the waveform is redrawn at the new zoom (${JSON.stringify(w2)})`);
// Scrolled to the middle: still drawn (the canvas follows the scroll).
await page.locator(".tl-scroll").evaluate((e) => { e.scrollLeft = e.scrollWidth / 2; }); await page.waitForTimeout(400);
const w3 = await inkAt();
const left = await page.evaluate(() => parseFloat(document.querySelector(".track.a1 canvas.wave").style.left));
check(left > 1000 && w3.any > 0, `scrolled: the canvas follows (left ${Math.round(left)} px) and draws there`);
await page.locator("#zoom-fit").click(); await page.waitForTimeout(400);

// 3. Marks: short coloured ticks on the ruler (no lines through the tracks) with a note; the toggle hides them and is
// remembered.
const marks = page.locator(".tl-mark");
const n = await marks.count();
check(n >= 3, `marks are on the timeline (${n})`);
const title = await marks.last().getAttribute("title");
check(/^(Silence|Filler word|Note)/.test(title || "") && /\(\d/.test(title || ""), `a mark has a note on hover: "${title}"`);
const ai = await page.locator('.tl-mark[title*="from your AI"]').getAttribute("title");
check(!!ai && /^Note: Hook ends · Cut here for the short version \(\d+:\d\d\.\d\) · from your AI$/.test(ai) && ai.endsWith(" · from your AI"), `the AI's mark says it is the AI's: "${ai}"`);
const colours = await marks.evaluateAll((els) => Array.from(new Set(els.map((e) => e.style.getPropertyValue("--mk")))));
check(colours.length >= 2, `marks are coloured by kind (${colours.join(" ")})`);
const lineW = await marks.first().evaluate((e) => getComputedStyle(e, "::after").width);
check(parseFloat(lineW) <= 2.01, `the tick is thin (${lineW})`);
check(await page.evaluate(() => [...document.querySelectorAll(".tl-mark")].every((m) => m.closest(".ruler") && m.getBoundingClientRect().height <= 8)), "marks sit on the ruler only, no lines through the tracks");
await page.locator("#marks-toggle").click(); await page.waitForTimeout(200);
check((await page.locator(".tl-mark").count()) === 0 && (await page.locator("#marks-toggle").getAttribute("aria-pressed")) === "false", "the toggle hides them");
await page.evaluate(() => globalThis.__rendrrNav.go("/library")); await page.waitForTimeout(300);
await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p5")); await page.locator("#timeline").waitFor(); await page.waitForTimeout(1200);
check((await page.locator(".tl-mark").count()) === 0, "hidden marks stay hidden when the editor opens again");
await page.locator("#marks-toggle").click(); await page.waitForTimeout(200);
check((await page.locator(".tl-mark").count()) === n, "and come back with the toggle");
await page.screenshot({ path: join(here, "dist", "timeline-part6.png") });

// 4. Not shown: measurements on the footage page, the hidden library, style files, tool names.
const vid = await page.evaluate(async () => (await globalThis.__rendrrApi?.listVideos?.())?.[0]?.id ?? null).catch(() => null);
await page.evaluate((id) => globalThis.__rendrrNav.go(id ? "/library/" + id : "/library"), vid); await page.waitForTimeout(1200);
if (!vid) { const first = page.locator("a[href^='/library/'], [data-video]").first(); if (await first.count()) { await first.click(); await page.waitForTimeout(1200); } }
const body = await page.locator("body").innerText();
check(!/What Claude sees|Video code|Frames Claude reads|Cuts per minute/.test(body), "the footage page shows no measurements");
for (const route of ["/library", "/projects", "/editor/p5", "/styles", "/settings"]) {
  await page.evaluate((r) => globalThis.__rendrrNav.go(r), route); await page.waitForTimeout(700);
  const t = await page.locator("body").innerText();
  check(!/\b(apply_edits|render_preview|get_footage|add_library_item|list_library|analyze_reference|search_icons|lib_[a-z_]+|style file)\b/i.test(t), `${route}: no tool names, library or style files`);
}

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); server.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
