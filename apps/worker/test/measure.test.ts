// The after-render check reads what measureFile finds in the file: made-up files with known black, silence and
// graphic coverage must measure as made. Needs ffmpeg. Run: pnpm --filter @rendrr/worker test
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { graphicCover, measureFile, run } from "../src/lib/ffmpeg";

describe("measuring a rendered file", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "measure-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });
  const ff = (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

  it("finds the black start, the silent stretch, both stream lengths and the loudness", async () => {
    const out = join(dir, "edit.mp4");
    // 0.5 s black then picture; tone, 0.5 s of silence at 1.0 s, tone again. 3 s each.
    await ff(["-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=0.5", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=2.5",
      "-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=48000", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.5", "-f", "lavfi", "-i", "sine=f=440:d=1.5:sample_rate=48000",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]atrim=0:1[a0];[3:a]atrim=0:0.5[a1];[4:a]atrim=0:1.5[a2];[a0][a1][a2]concat=n=3:v=0:a=1[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", out]);
    const m = await measureFile(out, { timeoutMs: 30_000 });
    assert.ok(Math.abs((m.videoSeconds ?? 0) - 3) < 0.1, `video ${m.videoSeconds}`);
    assert.ok(Math.abs((m.audioSeconds ?? 0) - 3) < 0.1, `audio ${m.audioSeconds}`);
    assert.equal(m.black.length, 1);
    assert.ok(m.black[0].start < 0.05 && Math.abs(m.black[0].end - 0.5) < 0.1, JSON.stringify(m.black));
    const gap = m.silences.find((s) => s.start > 0.8 && s.start < 1.2);
    assert.ok(gap && Math.abs(gap.end - 1.5) < 0.1, JSON.stringify(m.silences));
    assert.ok(m.lufs != null && m.peakDb != null);
  });

  it("measures how much of the frame a transparent graphic covers", async () => {
    const box = join(dir, "box.webm"), empty = join(dir, "empty.webm");
    const enc = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"];
    const opaque = join(dir, "opaque.webm");
    await ff(["-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=1,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,80)*lt(Y,60),255,0)'", ...enc, box]);
    await ff(["-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=1,format=rgba,geq=r=255:g=255:b=255:a=0", ...enc, empty]);
    await ff(["-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=1", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", opaque]);
    const c = await graphicCover(box, 0.5);
    assert.ok(c != null && Math.abs(c - 6.25) < 1, `cover ${c}`); // 80x60 of 320x240
    assert.ok(((await graphicCover(empty, 0.5)) ?? 99) < 0.2);
    assert.equal(await graphicCover(opaque, 0.5), 100); // no alpha: covers its whole box
  });

  it("gives up after its time limit instead of running forever", async () => {
    const out = join(dir, "edit.mp4");
    await assert.rejects(measureFile(out, { timeoutMs: 1 }), /longer than|failed/);
  });
});
