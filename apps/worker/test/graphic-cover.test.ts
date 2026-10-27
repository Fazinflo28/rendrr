// How much of the frame a graphic covers, measured on its file at 8 moments across the part on screen (min, average,
// max), so a graphic that is blank at one moment is not called invisible. A graphic blank for its first 0.1 s, one
// visible only at its start and end, a fully transparent one, an opaque one (no alpha), and a placement started
// part way in (add_graphic from) on a recording that keeps one picture per still stretch. Needs ffmpeg.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { graphicCover } from "../src/lib/ffmpeg";

const ff = (...a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
// A 320x180 transparent graphic: a box covering 25% of the frame (160x90) while `on(T)` is true.
const graphic = (file: string, sec: number, on: string, vfr = false) => ff("-f", "lavfi", "-i", `color=black@0:s=320x180:r=30:d=${sec},format=rgba`, "-vf",
  `geq=r=255:g=255:b=255:a='255*between(X,80,239)*between(Y,45,134)*(${on})'${vfr ? ",mpdecimate=hi=1:lo=1:frac=0:max=0" : ""}`, ...(vfr ? ["-fps_mode", "vfr"] : []), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "20", file);

describe("graphic cover", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "graphic-cover-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("a graphic blank for its first 0.1 s covers its box at every later moment", async () => {
    const f = join(dir, "late.webm");
    graphic(f, 3, "gte(T,0.1)");
    const c = (await graphicCover(f, 0, 3))!;
    console.log(`blank first 0.1 s: min ${c.min}%, avg ${c.avg}%, max ${c.max}%`);
    assert.ok(Math.abs(c.max - 25) < 1.5 && Math.abs(c.min - 25) < 1.5, JSON.stringify(c));
  });

  it("a graphic visible only at its start and end is seen (its middle alone would say invisible)", async () => {
    const f = join(dir, "ends.webm");
    graphic(f, 4, "lt(T,1)+gte(T,3)");
    const c = (await graphicCover(f, 0, 4))!;
    console.log(`visible at the ends only: min ${c.min}%, avg ${c.avg}%, max ${c.max}%`);
    assert.ok(c.min < 0.2, `min ${c.min}`);
    assert.ok(Math.abs(c.max - 25) < 1.5, `max ${c.max}`);
    assert.ok(c.avg > 10 && c.avg < 15, `avg ${c.avg}`); // 4 of the 8 moments
    assert.equal(c.visible, 4); // the 4 moments that show it
    // Sampled more densely (as the render does for a longer graphic: 2 a second): the moments spread the same way.
    const d = (await graphicCover(f, 0, 4, undefined, 16))!;
    assert.equal(d.samples, 16);
    assert.equal(d.visible, 8);
  });

  it("a fully transparent graphic is under 0.2% at every moment; an opaque one covers its whole box", async () => {
    const f = join(dir, "none.webm");
    graphic(f, 2, "0");
    const pick = (c: Awaited<ReturnType<typeof graphicCover>>) => c && { min: c.min, avg: c.avg, max: c.max, samples: c.samples, visible: c.visible };
    assert.deepEqual(pick(await graphicCover(f, 0, 2)), { min: 0, avg: 0, max: 0, samples: 8, visible: 0 });
    const o = join(dir, "opaque.webm");
    ff("-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=2", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", o);
    assert.deepEqual(pick(await graphicCover(o, 0, 2)), { min: 100, avg: 100, max: 100, samples: 8, visible: 8 });
  });

  it("a placement started part way in is measured on its own part, on a recording with still stretches", async () => {
    // 10 s; the box shows from 6 s on, as one picture held to the end (variable frame rate, like the recorder's).
    const f = join(dir, "vfr.webm");
    graphic(f, 10, "gte(T,6)", true);
    const pictures = execFileSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f]).toString().trim();
    assert.ok(Number(pictures) < 10, `${pictures} pictures`);
    const early = (await graphicCover(f, 1, 4))!; // 1-5 s: nothing yet
    assert.deepEqual([early.min, early.avg, early.max, early.visible], [0, 0, 0, 0]);
    const late = (await graphicCover(f, 6.5, 3))!; // 6.5-9.5 s: the held picture, at every moment
    assert.ok(Math.abs(late.min - 25) < 1.5 && Math.abs(late.max - 25) < 1.5, JSON.stringify(late));
  });

  it("a file that cannot be read gives no measurement (null), not a number", async () => {
    const bad = join(dir, "bad.webm");
    await writeFile(bad, "not a video");
    assert.equal(await graphicCover(bad, 0, 2), null);
  });
});
