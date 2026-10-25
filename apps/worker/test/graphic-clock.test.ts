// Graphics see time as they would playing: a CSS transition started by setTimeout at 2 s, element.animate() started
// at 3 s and a setInterval stepper are recorded where the clock puts them (before, transitions started mid-way
// jumped to their end and timers ran on the wall clock). A long graphic's transition that crosses the boundary
// between two browsers recording at once moves smoothly across it. Needs ffmpeg and Chromium.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { GRAPHIC_WORKERS, recordHtml } from "../src/lib/graphics";

const execFileP = promisify(execFile);
const W = 320, H = 180;
const frameAt = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `fps=30,select=eq(n\\,${Math.round(t * 30)})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer", maxBuffer: 64 << 20 })).stdout as Buffer;
/** Left edge of the pixels of one colour on a row (-1: none), and the mean alpha of that colour's pixels. */
function find(px: Buffer, row: number, is: (r: number, g: number, b: number) => boolean) {
  let left = -1, alpha = 0, n = 0;
  for (let x = 0; x < W; x++) { const i = (row * W + x) * 4; if (px[i + 3] > 8 && is(px[i] * 255 / px[i + 3], px[i + 1] * 255 / px[i + 3], px[i + 2] * 255 / px[i + 3])) { if (left < 0) left = x; alpha += px[i + 3]; n++; } }
  return { left, alpha: n ? alpha / n : 0 };
}
const red = (r: number, g: number, b: number) => r > 180 && g < 80 && b < 80;
const green = (r: number, g: number, b: number) => g > 180 && r < 80 && b < 80;
const blue = (r: number, g: number, b: number) => b > 180 && r < 80 && g < 80;

describe("the graphic clock", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "graphic-clock-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("timers, transitions and element.animate() started mid-way run on graphic time", async () => {
    const html = `<style>body{margin:0;width:${W}px;height:${H}px;background:transparent}
#a,#b,#c{position:absolute;width:20px;height:20px}
#a{top:10px;left:0;background:#f00;transition:transform 1s linear}#a.go{transform:translateX(200px)}
#b{top:60px;left:100px;background:#0f0;opacity:0}
#c{top:110px;left:0;background:#00f}</style>
<div id="a"></div><div id="b"></div><div id="c"></div>
<script>
setTimeout(() => document.getElementById("a").classList.add("go"), 2000);
let n = 0; setInterval(() => { n++; document.getElementById("c").style.left = Math.min(280, n * 10) + "px"; }, 100);
let started = false;
window.renderFrame = (t) => { if (t >= 3 && !started) { started = true; document.getElementById("b").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, fill: "forwards" }); } };
</script>`;
    const r = await recordHtml(html, { width: W, height: H, durationSec: 6, transparent: true, dir });
    // The transition: still at 0 before 2 s, half way (100 px) at 2.5 s, done at 3.2 s.
    for (const [t, want] of [[1.9, 0], [2.5, 100], [2.75, 150], [3.2, 200]] as const) {
      const x = find(await frameAt(r.path, t), 20, red).left;
      assert.ok(Math.abs(x - want) <= 8, `transition at ${t}s: x=${x}, expected ${want}`);
    }
    // element.animate() from 3 s: invisible before, half-faded at 3.5 s, opaque from 4 s.
    const b = async (t: number) => find(await frameAt(r.path, t), 70, green).alpha;
    assert.equal(await b(2.9), 0);
    const mid = await b(3.5);
    assert.ok(mid > 90 && mid < 165, `fade at 3.5s: alpha ${mid}`);
    assert.ok((await b(4.2)) > 245);
    // setInterval every 100 ms: 10 px per tick.
    for (const [t, want] of [[1.05, 100], [2.55, 250]] as const) {
      const x = find(await frameAt(r.path, t), 120, blue).left;
      assert.ok(Math.abs(x - want) <= 10, `interval at ${t}s: x=${x}, expected ${want}`);
    }
  });

  it("a long graphic recorded by several browsers moves smoothly across their boundaries", async () => {
    // 30 s, so it is sampled and split into ranges; a 6 s transition starts at 12 s (by setTimeout) and crosses them.
    const html = `<style>body{margin:0;width:${W}px;height:${H}px;background:transparent}
#a{position:absolute;top:10px;left:0;width:20px;height:20px;background:#f00;transition:transform 6s linear}#a.go{transform:translateX(300px)}</style>
<div id="a"></div><script>setTimeout(() => document.getElementById("a").classList.add("go"), 12000);</script>`;
    const r = await recordHtml(html, { width: W, height: H, durationSec: 30, transparent: true, dir });
    console.log(`30 s graphic, ${GRAPHIC_WORKERS} browsers: ${r.pictures} pictures, ${r.dense} frames one by one`);
    for (const t of [11.5, 12.5, 13.6, 14.4, 15.03, 16.7, 17.5, 20]) {
      const want = Math.max(0, Math.min(300, ((t - 12) / 6) * 300));
      const x = find(await frameAt(r.path, t), 20, red).left;
      assert.ok(Math.abs(x - want) <= 8, `at ${t}s: x=${x}, expected ${want.toFixed(0)}`);
    }
  });
});
