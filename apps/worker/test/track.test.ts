// Object tracking measured against the truth: a textured patch that moves across a textured background and grows (as
// a product brought toward the camera), the box drawn on it half way through the clip. The tracker follows it forward
// and backward; on every frame its box overlaps the patch's true box by most of their area and its centre is within a
// few percent of the frame. A patch that leaves the frame is reported lost (low confidence). Needs ffmpeg and OpenCV.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { run } from "../src/lib/ffmpeg";
import { trackObject } from "../src/lib/track";

const W = 640, H = 360, SECONDS = 6;
// The patch's true box at t (pixels): from (60, 120) at 72 px, moving right 70 px a second, a little up and down, growing 12 px a second.
const truth = (t: number) => { const s = 72 + 12 * t; return { x: 60 + 70 * t, y: 120 + 30 * Math.sin(t * 1.3), w: s, h: s }; };
const iou = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = ix * iy; return i / (a.w * a.h + b.w * b.h - i);
};

describe("object tracking", () => {
  let dir = "", clip = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "track-"));
    const bg = join(dir, "bg.png"), obj = join(dir, "obj.png");
    clip = join(dir, "clip.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:d=1,format=gray,geq=lum='96+60*random(1)',gblur=sigma=2,format=rgb24`, "-frames:v", "1", bg]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=200x200:d=1,format=rgb24,geq=r='255*random(1)':g='128*random(2)':b='64+128*random(3)',gblur=sigma=1.2", "-frames:v", "1", obj]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", bg, "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", obj,
      "-filter_complex", "[1:v]scale=w='72+12*t':h='72+12*t':eval=frame[o];[0:v][o]overlay=x='60+70*t':y='120+30*sin(t*1.3)':eval=frame,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", clip]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("follows a moving, growing object both ways from where the box was drawn", async () => {
    const at = 3, b = truth(at);
    const rows = await trackObject(clip, { from: 0, to: 5.5, at, box: { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H }, w: W, h: H, rotate: 0, fitY: 0.5, dir });
    assert.ok(rows.length >= 50, `a box for each tenth of a second (${rows.length})`);
    let worst = 1, worstAt = 0, worstC = 0;
    for (const [t, x0, y0, x1, y1] of rows) {
      const want = truth(t), got = { x: x0 * W, y: y0 * H, w: (x1 - x0) * W, h: (y1 - y0) * H };
      const o = iou(got, want), c = Math.hypot(got.x + got.w / 2 - (want.x + want.w / 2), got.y + got.h / 2 - (want.y + want.h / 2)) / W;
      if (o < worst) { worst = o; worstAt = t; }
      worstC = Math.max(worstC, c);
    }
    console.log(`${rows.length} boxes; worst overlap ${(worst * 100).toFixed(0)}% at ${worstAt.toFixed(1)} s; worst centre error ${(worstC * 100).toFixed(1)}% of the width; confidence ${(rows.reduce((a, r) => a + r[5], 0) / rows.length).toFixed(2)} on average`);
    assert.ok(worst > 0.7, `the box stays on the object (worst overlap ${(worst * 100).toFixed(0)}% at ${worstAt.toFixed(1)} s)`);
    assert.ok(worstC < 0.03, `its centre within 3% of the width (${(worstC * 100).toFixed(1)}%)`);
  });
});
