// Engine Part 5: a 6-minute graphic that moves on every frame, at the largest size (1080x1920), records without
// failing, as the graphic job records it (the job's own time limit), in chunks of at most 90 s recorded in parallel
// and joined into one file; every part of the file shows the frame its time says. Needs ffmpeg and Chromium; takes
// several minutes (about 10 on 4 CPUs).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { GRAPHIC_WORKERS, recordHtml, recordLimitMs } from "../src/lib/graphics";

const execFileP = promisify(execFile);
const W = 1080, H = 1920, SECONDS = 360;
// The frame number drawn as a bar 0-1079 px wide on row 100 (frame % 1080), and as a big counter: every frame differs.
const html = `<canvas id="c" width="${W}" height="${H}"></canvas><style>body{margin:0}</style><script>
const g = document.getElementById("c").getContext("2d");
window.renderFrame = (t) => {
  const f = Math.round(t * 30);
  g.clearRect(0, 0, ${W}, ${H});
  g.fillStyle = "#ffffff"; g.fillRect(0, 80, (f % 1080) + 1, 40);
  for (let i = 0; i < 24; i++) { g.fillStyle = "hsl(" + ((f * 3 + i * 15) % 360) + ",80%,55%)"; g.beginPath(); g.arc(540 + 400 * Math.cos(t * 2 + i), 1000 + 600 * Math.sin(t * 1.3 + i), 60, 0, 7); g.fill(); }
  g.fillStyle = "#ffffff"; g.font = "bold 160px sans-serif"; g.fillText(String(f), 200, 1800);
};
</script>`;

/** The bar's width at a time of the file: the frame number it shows, mod 1080. */
async function barAt(file: string, t: number): Promise<number> {
  const px = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `fps=30,select=eq(n\\,${Math.round(t * 30)}),crop=${W}:2:0:100,alphaextract`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { encoding: "buffer", maxBuffer: 16 << 20 })).stdout as Buffer;
  let n = 0; // the first of the two rows read
  while (n < W && px[n] > 128) n++;
  return n;
}

describe("a 6-minute busy graphic", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "graphic-busy-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("records without failing, within the graphic job's limit, every part where its time says", { timeout: 40 * 60_000 }, async () => {
    const limit = recordLimitMs(SECONDS, W, H);
    const t0 = Date.now();
    let last = 0;
    const r = await recordHtml(html, { width: W, height: H, durationSec: SECONDS, transparent: true, dir, maxMs: limit, onProgress: (p) => { if (p - last >= 0.1) { last = p; console.log(`  ${Math.round(p * 100)}% after ${Math.round((Date.now() - t0) / 1000)} s`); } } });
    const took = Date.now() - t0;
    console.log(`6 min at ${W}x${H}, every frame moving: recorded in ${(took / 1000).toFixed(0)} s with ${GRAPHIC_WORKERS} browsers (the job's limit: ${Math.round(limit / 1000)} s), ${r.pictures} pictures, ${r.chunks ?? "?"} chunks`);
    assert.ok(took < limit, `took ${took} ms, limit ${limit} ms`);
    assert.equal(r.seconds, SECONDS);
    assert.equal(r.pictures, SECONDS * 30);
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", r.path]);
    assert.ok(Math.abs(Number(stdout) - SECONDS) < 0.1, `file ${stdout.trim()} s`);
    // Frames from every part of the file (the chunks' joins included) show the frame their time says.
    for (const t of [0.5, 59.9, 90.1, 121.3, 179.97, 240.03, 301.7, 359.9]) {
      const f = Math.round(t * 30);
      assert.equal(await barAt(r.path, t), (f % 1080) + 1, `at ${t} s`);
    }
  });
});
