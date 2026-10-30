// Fonts in graphics: 'Open Sans' 700 draws as the real Open Sans Bold (not a regular face made bolder by the
// browser); a font that is not installed is named in a warning instead of falling back silently (CSS and canvas); a
// font the user added once (add_font) draws by its name and is not reported. Needs Chromium and the worker image's
// fonts; the last test also needs a database and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import { customParamsSchema, GRAPHIC_FONT_WATCH, PREFIX, withClock, wrapGraphicHtml } from "@rendrr/shared";
import puppeteer from "puppeteer-core";
import { recordHtml } from "../src/lib/graphics";

const fontFile = (family: string) => { try { const f = execFileSync("fc-match", ["-f", "%{file}|%{family[0]}", family], { encoding: "utf8" }).split("|"); return f[1] === family ? f[0] : null; } catch { return null; } };
const has = !!fontFile("Open Sans") && !!fontFile("Pacifico");
const exe = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((x) => x && existsSync(x));
const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("fonts in graphics", { skip: (!has || !exe) && "needs the worker image's fonts and Chromium" }, () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "graphic-fonts-")); });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    // The graphic job's progress opened Redis: closed, or the test never ends.
    if (db) { const { redis } = await import("@rendrr/core"); await redis().quit().catch(() => {}); }
  });

  it("'Open Sans' 700 is the real bold: wider letters, unlike a font with one weight made bolder", async () => {
    // A real bold has its own, wider letters; the browser's fake bold (a font with no bold) keeps the regular widths.
    const b = await puppeteer.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    try {
      const page = await b.newPage();
      await page.setContent(withClock(wrapGraphicHtml("<div></div>", 400, 200), GRAPHIC_FONT_WATCH));
      const r = (await page.evaluate(`(() => {
        const c = document.createElement("canvas").getContext("2d");
        const w = (f) => { c.font = f; return c.measureText("Hamburgefonstiv 0123 QWX").width; };
        return { open: w("700 40px 'Open Sans'") / w("400 40px 'Open Sans'"), pacifico: w("700 40px Pacifico") / w("400 40px Pacifico") };
      })()`)) as { open: number; pacifico: number };
      console.log(`bold / regular width: Open Sans ${r.open.toFixed(3)}, Pacifico (one weight) ${r.pacifico.toFixed(3)}`);
      assert.ok(r.open > 1.04, `Open Sans 700 is ${r.open.toFixed(3)}x the regular width: not its real bold`);
      assert.ok(Math.abs(r.pacifico - 1) < 0.01, "the check tells a fake bold apart");
      assert.deepEqual(await page.evaluate("window.__rendrrMissingFonts()"), []);
    } finally { await b.close(); }
  });

  it("names the fonts that are not installed (CSS and canvas), not the installed ones or generic names", async () => {
    const html = `<style>body{margin:0}.a{font:700 40px 'Open Sans'}.b{font-family:"Another Missing",sans-serif}.c{font-family:serif}</style>
<div class="a">Open Sans bold</div><div class="b">fallback here</div><div class="c">generic</div><canvas id="k" width="300" height="80"></canvas>
<script>const g = document.getElementById("k").getContext("2d");
window.renderFrame = (t) => { g.clearRect(0, 0, 300, 80); g.font = t < 0.5 ? "700 30px Montserrat" : "italic 30px 'Nonexistent Brand', Inter"; g.fillStyle = "#fff"; g.fillText("Hi " + t.toFixed(1), 10, 50); };</script>`;
    const r = await recordHtml(html, { width: 320, height: 240, durationSec: 1, transparent: true, dir });
    assert.deepEqual(r.missingFonts, ["Another Missing", "Nonexistent Brand"]);
  });

  it("a font the user added draws by its name, and the graphic's warning names only the missing one", { skip: !db && "needs a database and storage" }, async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, putObject } = await import("@rendrr/core");
    const { graphicJob } = await import("../src/jobs/graphic");
    const { customGraphicHtml } = await import("../src/lib/graphics");
    const userId = (await prisma.user.create({ data: { clerkId: `gfont_${run}`, email: `gfont-${run}@test.rendrr.dev`, name: "Fonts" } })).id;
    try {
      // Pacifico's file, added as "Brand Script".
      const key = `${PREFIX.fonts}${userId}/brand.ttf`;
      await putObject(key, await readFile(fontFile("Pacifico")!), "font/ttf");
      await prisma.font.create({ data: { userId, family: "Brand Script", weight: 400, style: "normal", format: "ttf", key, size: 1 } });
      const code = `<canvas id="k" width="600" height="100"></canvas><style>body{margin:0}</style><script>
const g = document.getElementById("k").getContext("2d");
window.renderFrame = () => { g.clearRect(0, 0, 600, 100); g.font = "40px 'Brand Script'"; window.brand = g.measureText("Hamburgefonstiv").width; g.font = "40px Pacifico"; window.pacifico = g.measureText("Hamburgefonstiv").width; g.font = "40px 'Missing One'"; g.fillText("x", 10, 50); };
</script>`;
      // In the page: Brand Script measures as Pacifico (its file), and only Missing One is reported.
      const b = await puppeteer.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
      try {
        const page = await b.newPage();
        await page.setContent(withClock(wrapGraphicHtml(await customGraphicHtml(code, {}, userId), 600, 100), GRAPHIC_FONT_WATCH));
        await page.evaluate("Promise.all([...document.fonts].map((f) => f.load())).then(() => window.renderFrame(0))");
        const w = (await page.evaluate("({ brand: window.brand, pacifico: window.pacifico })")) as { brand: number; pacifico: number };
        assert.ok(Math.abs(w.brand - w.pacifico) < 0.5, `Brand Script ${w.brand}px, Pacifico ${w.pacifico}px`);
        assert.deepEqual(await page.evaluate("window.__rendrrMissingFonts()"), ["Missing One"]);
      } finally { await b.close(); }
      // The job: the graphic records and keeps the warning for the AI.
      const g = await prisma.graphic.create({ data: { ownerId: userId, name: "Fonts", kind: "custom", code, paramsSchema: customParamsSchema({}), durationSec: 1, width: 600, height: 100, status: "queued" } });
      await graphicJob({ signal: new AbortController().signal, dir, job: { data: { graphicId: g.id } } as unknown as Job, isLastAttempt: true });
      const done = await prisma.graphic.findUniqueOrThrow({ where: { id: g.id } });
      assert.equal(done.status, "ready");
      assert.deepEqual(done.warnings, ["Fonts not installed, drawn with a fallback: Missing One. Use an installed font (create_graphic lists them) or add the file with add_font."]);
    } finally {
      await deletePrefix(`${PREFIX.fonts}${userId}/`).catch(() => {});
      await deletePrefix(`${PREFIX.graphics}${userId}/`).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
