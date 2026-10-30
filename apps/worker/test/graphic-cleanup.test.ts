// The recorder and the container's thread limit: a recording that fails leaves no browser running (one left running
// holds about 80 threads until the worker restarts, and enough of them stopped every graphic and render on
// 30 Oct 2026), and recordings at the same time never run more browsers than the worker's slots. Needs ffmpeg and
// Chromium.
import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.BROWSER_SLOTS = "3";
const { BROWSER_SLOTS, freeBrowserSlots, GRAPHIC_WORKERS, recordHtml } = await import("../src/lib/graphics");

/** Main Chromium processes the recorder started (its children carry --type=). */
const browsersRunning = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
  try { const c = readFileSync(`/proc/${p}/cmdline`, "utf8"); return c.includes("puppeteer_dev_chrome_profile") && !c.includes("--type="); } catch { return false; }
}).map(Number);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 12 s at 720x1280, moving on every frame: every frame is captured, in lanes on several browsers.
const busy = `<style>body{margin:0}#b{position:absolute;width:300px;height:300px;background:#0af;animation:m 1s linear infinite alternate}@keyframes m{to{transform:translate(400px,900px) rotate(90deg)}}</style><div id="b"></div>`;

describe("the recorder's browsers", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "graphic-cleanup-")); assert.deepEqual(browsersRunning(), [], "no browser from before"); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("a lane whose browser dies twice fails the recording, and no browser is left running", async () => {
    assert.ok(GRAPHIC_WORKERS >= 2, `needs 2 lanes (GRAPHIC_WORKERS ${GRAPHIC_WORKERS})`);
    const rec = recordHtml(busy, { width: 720, height: 1280, durationSec: 12, transparent: true, dir });
    const failed = rec.then(() => null, (e: Error) => e);
    // Kill one browser once the lanes are recording; then the one started in its place.
    const kill = async (not: number[]) => {
      for (let i = 0; i < 100; i++) { const b = browsersRunning().filter((p) => !not.includes(p)); if (b.length) { process.kill(b[0], "SIGKILL"); return [...not, ...browsersRunning()]; } await sleep(100); }
      throw new Error("no browser to kill");
    };
    for (let i = 0; i < 50 && browsersRunning().length < GRAPHIC_WORKERS; i++) await sleep(100);
    await sleep(1500);
    const seen = await kill([]);
    await sleep(1500);
    await kill(seen);
    const e = await failed;
    assert.ok(e, "the recording failed");
    console.log(`failed: ${e!.message}`);
    // Lanes still recording when it failed must not start new browsers after the cleanup.
    await sleep(3000);
    assert.deepEqual(browsersRunning(), [], "no browser left running");
    assert.equal(freeBrowserSlots(), BROWSER_SLOTS, "every slot is back");
  });

  it("a browser that fails to start fails the recording, and the others it started are closed", async () => {
    // A Chromium that fails the first time it is started (as it did when the container had no threads left), then
    // starts. The old recorder's cleanup stopped at the gap that browser left ("reading 'close'") and left the others.
    const real = ["/usr/bin/chromium", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => { try { readFileSync(p); return true; } catch { return false; } })!;
    const wrap = join(dir, "chromium.sh"), count = join(dir, "launches");
    writeFileSync(wrap, `#!/bin/sh\nn=$(cat "${count}" 2>/dev/null || echo 0); echo $((n+1)) > "${count}"\n[ "$n" = "0" ] && exit 1\nexec "${real}" "$@"\n`);
    chmodSync(wrap, 0o755);
    const was = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = wrap;
    try {
      const e = await recordHtml(busy, { width: 720, height: 1280, durationSec: 12, transparent: true, dir }).then(() => null, (x: Error) => x);
      assert.ok(e, "the recording failed");
      console.log(`failed after ${readFileSync(count, "utf8").trim()} launches: ${e!.message}`);
      assert.match(e!.message, /Failed to launch the browser process/);
    } finally { if (was === undefined) delete process.env.CHROMIUM_PATH; else process.env.CHROMIUM_PATH = was; }
    await sleep(1000);
    assert.deepEqual(browsersRunning(), [], "no browser left running");
    assert.equal(freeBrowserSlots(), BROWSER_SLOTS, "every slot is back");
  });

  it("two recordings at once share the worker's browser slots", async () => {
    let most = 0, on = true;
    const watch = (async () => { while (on) { most = Math.max(most, browsersRunning().length); await sleep(50); } })();
    const t0 = Date.now();
    const [a, b] = await Promise.all([1, 2].map(() => recordHtml(busy, { width: 360, height: 640, durationSec: 6, transparent: true, dir })));
    on = false; await watch;
    console.log(`both recorded in ${((Date.now() - t0) / 1000).toFixed(1)} s; at most ${most} browsers (slots ${BROWSER_SLOTS}, ${GRAPHIC_WORKERS} per recording)`);
    assert.equal(a.seconds, 6); assert.equal(b.seconds, 6);
    assert.ok(most <= BROWSER_SLOTS, `${most} browsers at once`);
    assert.equal(freeBrowserSlots(), BROWSER_SLOTS);
    await sleep(500);
    assert.deepEqual(browsersRunning(), []);
  });
});
