// The original of local footage is made to face the way its preview copy does. A copy stored another way up
// (upside down, sideways, mirrored; no tag, or a wrong tag) gets its orientation tag rewritten, without a new encode;
// a copy that already faces the same way, plain or through its tag, is left alone. Needs ffmpeg.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FACINGS, face, likeness, matchFacing } from "../src/lib/orient";

describe("the original faces the way its preview copy does", () => {
  let dir = "", proxy = "";
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // A picture that looks different every way round: the test card with moving parts, 16:9.
  const src = (out: string, vf: string, s = "640x360") => { ff(["-f", "lavfi", "-i", `testsrc2=s=${s}:r=30:d=6`, "-f", "lavfi", "-i", "sine=d=6", "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]); return out; };
  const tag = (inp: string, out: string, opts: string[]) => { ff([...opts, "-i", inp, "-c", "copy", out]); return out; };

  before(async () => {
    dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "facing-"));
    proxy = src(join(dir, "proxy.mp4"), "null", "480x270"); // the preview copy, as the editor shows it
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("the 8 facings turn a picture as FFmpeg's display options show it", () => {
    const n = 4, img = Uint8Array.from({ length: 16 }, (_, i) => i);
    assert.deepEqual([...face(img, FACINGS[3], n)], [...img].reverse()); // 180
    assert.deepEqual([...face(face(img, FACINGS[4], n), FACINGS[5], n)], [...img]); // clockwise then back
    assert.ok(likeness(img, img) > 0.999 && likeness(img, face(img, FACINGS[3], n)) < 0);
  });

  const cases: [string, string, string[], string | null][] = [
    ["stored upside down, no tag", "hflip,vflip", [], "180"],
    ["stored sideways (clockwise), no tag", "transpose=cclock", [], "cw"],
    ["mirrored, no tag", "hflip", [], "mirror"],
    ["upright but tagged 180 by mistake", "null", ["-display_rotation:v:0", "180"], "stored"],
    ["the same way up", "null", [], null],
    ["stored upside down with a 180 tag (plays upright)", "hflip,vflip", ["-display_rotation:v:0", "180"], null],
  ];
  for (const [name, vf, tagOpts, expect] of cases) {
    it(`${name}: ${expect ? `set to ${expect}` : "left alone"}`, { timeout: 60_000 }, async () => {
      const base = src(join(dir, `${name.replace(/\W+/g, "-")}-raw.mp4`), vf);
      const file = tagOpts.length ? tag(base, join(dir, `${name.replace(/\W+/g, "-")}.mp4`), tagOpts) : base;
      const size0 = (await stat(file)).size;
      const r = await matchFacing(file, proxy, dir);
      console.log(`${name}: ${r.changed?.id ?? "unchanged"} (as it played ${r.before.toFixed(2)}, best ${r.best.id} ${r.best.likeness.toFixed(2)}, after ${r.after.toFixed(2)})`);
      assert.equal(r.changed?.id ?? null, expect);
      if (expect) {
        assert.ok(r.after > 0.8, `matches its preview copy after (${r.after})`);
        assert.ok(Math.abs((await stat(file)).size - size0) < size0 * 0.05, "the streams are copied, not encoded again");
      } else assert.ok(r.before > 0.8, `it already matched (${r.before})`);
    });
  }
});
