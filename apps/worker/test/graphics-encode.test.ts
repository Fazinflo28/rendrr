// A graphic whose card goes from busy (rows of text-like bars) to empty must not keep ghosts of the old rows.
// Needs ffmpeg. The old setting (crf 32) leaves them; see encodeFrames.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { encodeFrames } from "../src/lib/graphics";
import { run } from "../src/lib/ffmpeg";

describe("graphic encoding", () => {
  let dir = "";
  before(async () => { dir = await mkdtemp(join(tmpdir(), "genc-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("an emptied card shows no ghost of what was on it", async () => {
    const frames = join(dir, "frames"); await mkdir(frames);
    // 4 s at 20 fps on a white card: rows of light bars and pills (like a card's rows), faded out over 0.25 s at
    // 2 s (the way a card leaves), then the card stays empty. Faint content that fades is what used to stay behind.
    const bars = Array.from({ length: 8 }, (_, k) => `drawbox=x=40:y=${30 + k * 44}:w=${280 + (k % 3) * 130}:h=26:color=0xe4dbe0:t=fill`).join(",");
    const keep = "if(lt(T,2),1,if(lt(T,2.25),1-(T-2)/0.25,0))"; // how much of the busy card shows (blend's T is time)
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=720x400:r=20:d=4", "-f", "lavfi", "-i", "color=c=white:s=720x400:r=20:d=4",
      "-filter_complex", `[0]${bars}[busy];[1][busy]blend=all_expr='A*(1-${keep})+B*${keep}',format=rgba`, "-start_number", "0", join(frames, "f%05d.png")]);
    const out = join(dir, "g.webm");
    await encodeFrames(frames, 20, out, true);
    // Frame at 3.5 s against the clean white card: the largest difference anywhere.
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-c:v", "libvpx-vp9", "-i", out, "-f", "lavfi", "-i", "color=c=white:s=720x400:d=1",
      "-filter_complex", "[0:v]trim=start=3.5,setpts=PTS-STARTPTS,format=rgba[a];[1]format=rgba[b];[b][a]overlay,format=gray[x];[1]format=gray[w];[x][w]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YMAX",
      "-frames:v", "1", "-f", "null", "-"]);
    const ymax = Number(/YMAX=(\d+)/.exec(stderr)?.[1]);
    assert.ok(Number.isFinite(ymax), stderr.slice(-400));
    console.log(`largest difference ${ymax}/255`);
    assert.ok(ymax <= 12, `ghost of the old rows: largest difference ${ymax}/255`);
  });
});
