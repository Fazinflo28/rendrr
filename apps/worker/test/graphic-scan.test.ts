// The scan-first recorder: a graphic that would take too long fails right after its scan (seconds, not minutes) and
// says why; window.renderFramePure lets frames that are not captured skip renderFrame and still draws every captured
// frame where its time says; Math.random gives every browser the same values, so a graphic recorded by several
// browsers shows the same random layout in every part. Needs ffmpeg and Chromium.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { GRAPHIC_WORKERS, recordHtml } from "../src/lib/graphics";

const execFileP = promisify(execFile);
const frameAt = async (file: string, t: number, w: number, h: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `fps=30,select=eq(n\\,${Math.round(t * 30)}),scale=${w}:${h}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer", maxBuffer: 64 << 20 })).stdout as Buffer;

describe("the scan-first recorder", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "graphic-scan-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("fails right after the scan when the graphic would take too long, and says why", async () => {
    // 120 s at 1080x1920 moving on every frame: far over a 60 s budget. It must fail in seconds, not at the limit.
    const html = `<style>body{margin:0}#b{position:absolute;width:400px;height:400px;background:#f0f;animation:m 1s linear infinite alternate}@keyframes m{to{transform:translate(600px,1400px)}}</style><div id="b"></div>`;
    const t0 = Date.now();
    await assert.rejects(recordHtml(html, { width: 1080, height: 1920, durationSec: 120, transparent: true, dir, maxMs: 60_000 }), (e: Error & { code?: string }) => {
      console.log(`failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${e.message}`);
      assert.equal(e.code, "graphic-slow");
      assert.match(e.message, /would take about \d+ min to record \(the limit is 1 min\): it moves on \d+% of its 3600 frames/);
      return true;
    });
    assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`);
  });

  it("renderFramePure: frames that are not captured skip renderFrame, captured ones are where their time says", async () => {
    const W = 320, H = 180;
    // 30 s; a box moves at 20 px/s during 10-14 s and 24-26 s, still otherwise. renderFrame counts its calls.
    const html = `<canvas id="c" width="${W}" height="${H}"></canvas><style>body{margin:0}</style><script>
window.renderFramePure = true; window.calls = 0;
const g = document.getElementById("c").getContext("2d");
const xAt = (t) => t < 10 ? 0 : t < 14 ? (t - 10) * 20 : t < 24 ? 80 : t < 26 ? 80 + (t - 24) * 20 : 120;
window.renderFrame = (t) => { window.calls++; g.clearRect(0, 0, ${W}, ${H}); g.fillStyle = "#f00"; g.fillRect(20 + xAt(t), 20, 30, 30); };
</script>`;
    const r = await recordHtml(html, { width: W, height: H, durationSec: 30, transparent: true, dir });
    const left = async (t: number) => { const px = await frameAt(r.path, t, W, H); for (let x = 0; x < W; x++) { const i = (35 * W + x) * 4; if (px[i + 3] > 128 && px[i] > 180) return x; } return -1; };
    for (const [t, want] of [[5, 20], [12, 60], [13.5, 90], [20, 100], [25, 120], [28, 140]] as const) {
      const x = await left(t);
      assert.ok(Math.abs(x - want) <= 2, `at ${t}s: box at ${x}, expected ${want}`);
    }
    console.log(`30 s pure canvas: ${r.pictures} pictures, ${r.dense} frames one by one`);
    assert.ok(r.pictures < 300, `${r.pictures} pictures for 900 frames`);
  });

  it("Math.random is the same in every browser, so a random layout stays put across the browsers' parts", async () => {
    const W = 320, H = 180;
    // 40 dots placed with Math.random at load, and a bar that grows the whole time (so every part is recorded).
    const html = `<canvas id="c" width="${W}" height="${H}"></canvas><style>body{margin:0}</style><script>
const g = document.getElementById("c").getContext("2d");
const dots = Array.from({ length: 40 }, () => [Math.random() * ${W}, 20 + Math.random() * 100]);
window.renderFrame = (t) => { g.clearRect(0, 0, ${W}, ${H}); g.fillStyle = "#0f0"; for (const [x, y] of dots) g.fillRect(x, y, 4, 4); g.fillStyle = "#00f"; g.fillRect(0, 160, ${W} * t / 40, 10); };
</script>`;
    const r = await recordHtml(html, { width: W, height: H, durationSec: 40, transparent: true, dir });
    const dotsAt = async (t: number) => { const px = await frameAt(r.path, t, W, H); let s = ""; for (let y = 20; y < 124; y += 2) for (let x = 0; x < W; x += 2) s += px[(y * W + x) * 4 + 1] > 180 && px[(y * W + x) * 4 + 3] > 128 ? "1" : "0"; return s; };
    const first = await dotsAt(1);
    assert.ok(first.includes("1"), "no dots drawn");
    for (const t of [12, 25, 38]) assert.equal(await dotsAt(t), first, `the dots moved at ${t}s (recorded by ${GRAPHIC_WORKERS} browsers)`);
  });
});
