// Phase 22: a camera file's start timecode read by probe, as the proxy job keeps it: MOV and MP4 with a timecode track
// (drop-frame too), and a file without one. Two cameras started 5 s apart give an angle offset of 5 s. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { timecodeOffset } from "@rendrr/shared";
import { probe, run } from "../src/lib/ffmpeg";

describe("timecode from camera files", () => {
  let dir = "";
  const make = async (name: string, rate: string, tc?: string) => {
    const p = join(dir, name);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=320x180:r=${rate}:d=2`, ...(tc ? ["-timecode", tc] : []), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", p]);
    return p;
  };
  before(async () => { dir = await mkdtemp(join(tmpdir(), "timecode-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("MOV and MP4 timecode tracks, drop-frame kept; none: empty", async () => {
    const a = await probe(await make("a.mov", "25", "10:00:05:00"));
    const b = await probe(await make("b.mp4", "25", "10:00:00:00"));
    const d = await probe(await make("d.mov", "30000/1001", "01:00:00;02"));
    const n = await probe(await make("n.mp4", "25"));
    console.log(`timecodes: ${a.timecode}, ${b.timecode}, ${d.timecode}, "${n.timecode}"`);
    assert.equal(a.timecode, "10:00:05:00");
    assert.equal(b.timecode, "10:00:00:00");
    assert.match(d.timecode, /^01:00:00[;.]02$/);
    assert.equal(n.timecode, "");
    // The camera that started at 10:00:05 is the main one: the other is 5 s ahead of it.
    assert.equal(timecodeOffset({ timecode: a.timecode, fps: a.fps }, { timecode: b.timecode, fps: b.fps }), 5);
  });
});
