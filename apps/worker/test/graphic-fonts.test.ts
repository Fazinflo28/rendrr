// Every font family the create_graphic docs promise (GRAPHIC_FONTS) draws in the graphics browser as itself, and
// common names (Arial, Georgia…) draw as their stand-ins. A family is there when text in "Family, serif" and
// "Family, monospace" has the same width (a missing one falls back to two different fonts). Needs Chromium and the
// worker image's fonts (scripts/fetch-fonts.mjs, fonts.conf); skipped on a machine without them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { GRAPHIC_FONT_ALIASES, GRAPHIC_FONTS } from "@rendrr/shared";
import puppeteer from "puppeteer-core";

const has = (() => { try { return execFileSync("fc-match", ["-f", "%{family[0]}", "Open Sans"], { encoding: "utf8" }) === "Open Sans"; } catch { return false; } })();
const exe = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((x) => x && existsSync(x));

describe("graphics fonts", { skip: (!has || !exe) && "needs the worker image's fonts and Chromium" }, () => {
  it("every promised family is installed, and the common names draw as their stand-ins", async () => {
    const b = await puppeteer.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    try {
      const page = await b.newPage();
      await page.setContent("<!doctype html><html><body></body></html>");
      const families = Object.values(GRAPHIC_FONTS).flat();
      // A string, so the test runner's helpers are not compiled into code that runs in the page.
      const widths = (await page.evaluate(`(() => {
        const fs = ${JSON.stringify(families)}, aliases = ${JSON.stringify(GRAPHIC_FONT_ALIASES)};
        const c = document.createElement("canvas").getContext("2d");
        const w = (font) => { c.font = "700 40px " + font; return c.measureText("Hamburgefonstiv 0123 QWX").width; };
        const missing = fs.filter((f) => Math.abs(w('"' + f + '", serif') - w('"' + f + '", monospace')) > 0.01);
        const wrong = Object.entries(aliases).filter(([name, to]) => Math.abs(w('"' + name + '", monospace') - w('"' + to + '", monospace')) > 0.01).map(([n]) => n);
        return { missing, wrong, count: fs.length };
      })()`)) as { missing: string[]; wrong: string[]; count: number };
      console.log(`${widths.count} families checked`);
      assert.deepEqual(widths.missing, [], `not installed: ${widths.missing.join(", ")}`);
      assert.deepEqual(widths.wrong, [], `not drawn as their stand-in: ${widths.wrong.join(", ")}`);
    } finally { await b.close(); }
  });
});
