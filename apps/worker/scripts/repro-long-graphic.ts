// Reproduces the long graphic that failed live (393 s, 1920x1080, transparent, a canvas drawn by window.renderFrame(t),
// moving on about 30% of its frames) and records it with the worker's recorder. Prints the time taken, the pictures
// kept and the file's length. Usage (from apps/worker): npx tsx scripts/repro-long-graphic.ts [seconds] [pure]
// "pure" adds window.renderFramePure = true (renderFrame draws the whole frame from t alone).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe } from "../src/lib/ffmpeg";
import { GRAPHIC_WORKERS, recordHtml } from "../src/lib/graphics";

const seconds = Number(process.argv[2] || 393), pure = process.argv[3] === "pure";
const W = 1920, H = 1080;
// Every 10 s: 3 s of motion (cards slide in, dots orbit, a bar fills, a counter runs), then 7 s still.
export const reproHtml = (dur: number, isPure: boolean) => `<canvas id="c" width="${W}" height="${H}"></canvas>
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<script>
${isPure ? "window.renderFramePure = true;" : ""}
const c = document.getElementById("c"), g = c.getContext("2d");
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
window.renderFrame = (t) => {
  const block = Math.floor(t / 10), local = Math.min(3, t - block * 10), p = ease(local / 3);
  g.clearRect(0, 0, ${W}, ${H});
  g.fillStyle = "rgba(15,17,19,0.85)"; g.beginPath(); g.roundRect(120 - 400 * (1 - p), 120, 900, 260, 32); g.fill();
  g.fillStyle = "#fff"; g.font = "800 72px Montserrat, sans-serif"; g.fillText("Section " + (block + 1), 170 - 400 * (1 - p), 230);
  g.font = "400 40px 'Open Sans', sans-serif"; g.fillText("Step " + (block + 1) + " of ${Math.ceil(dur / 10)}", 170 - 400 * (1 - p), 300);
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2 + local * 1.2; g.fillStyle = "hsl(" + (i * 30) + ",80%,60%)"; g.beginPath(); g.arc(1500 + Math.cos(a) * 220, 540 + Math.sin(a) * 220, 26, 0, 7); g.fill(); }
  g.fillStyle = "rgba(255,255,255,.25)"; g.fillRect(120, 940, 1680, 24);
  g.fillStyle = "#bde816"; g.fillRect(120, 940, 1680 * ((block + p) / ${Math.ceil(dur / 10)}), 24);
  g.fillStyle = "#fff"; g.font = "700 64px Inter, sans-serif"; g.fillText(Math.round(p * 100) + "%", 1640, 900);
};
</script>`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = await mkdtemp(join(tmpdir(), "repro-graphic-"));
  try {
    const t0 = Date.now();
    let last = 0;
    const r = await recordHtml(reproHtml(seconds, pure), { width: W, height: H, durationSec: seconds, transparent: true, dir, onProgress: (p) => { if (p - last >= 0.1 || p === 1) { last = p; console.log(`  ${Math.round(p * 100)}% at ${((Date.now() - t0) / 1000).toFixed(0)} s`); } } });
    const len = (await probe(r.path)).seconds;
    console.log(JSON.stringify({ seconds, size: `${W}x${H}`, pure, browsers: GRAPHIC_WORKERS, tookSec: Math.round((Date.now() - t0) / 100) / 10, pictures: r.pictures, framesOneByOne: r.dense, fileSeconds: len }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
