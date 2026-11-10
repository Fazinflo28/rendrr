// Elements (Assets page): a logo PNG with a transparent half made into the 1 s transparent WebM the worker keeps, then
// placed on an edit as the editor places it (add_graphic + set_keyframes from elementKeys: top right, a fifth of the
// frame) and rendered through the real export graph. Read back: the logo's opaque half is there, its transparent half
// and the rest of the frame show the picture under it, and it is still there at 3 s (the 1 s clip is held). Needs ffmpeg.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, elementKeys, ELEMENT_SECONDS, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { elementArgs, elementSize } from "../src/jobs/element";
import { probe, run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 4, W = 960, H = 540;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("elements: a transparent logo, kept and rendered", () => {
  let dir = "", main = "", logo = "", webm = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "element-render-"));
    main = join(dir, "main.mp4"); logo = join(dir, "logo.png"); webm = join(dir, "logo.webm");
    // The picture: flat blue. The logo: 400x200, left half transparent, right half opaque red.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x2050C0:s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black@0.0:s=200x200,format=rgba", "-f", "lavfi", "-i", "color=0xE02020:s=200x200,format=rgba",
      "-filter_complex", "[0][1]hstack=inputs=2,format=rgba", "-frames:v", "1", logo]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  it("keeps its size (even, at most 2048) and its transparency", async () => {
    assert.deepEqual(elementSize(400, 200), { width: 400, height: 200 });
    assert.deepEqual(elementSize(4001, 1000), { width: 2048, height: 512 });
    assert.deepEqual(elementSize(301, 151), { width: 302, height: 152 });
    await run("ffmpeg", elementArgs(logo, webm, 400, 200));
    const p = await probe(webm);
    assert.equal(p.width, 400); assert.equal(p.height, 200);
    assert.ok(Math.abs(p.seconds - ELEMENT_SECONDS) < 0.1, `about ${ELEMENT_SECONDS} s (${p.seconds})`);
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:stream_tags=alpha_mode", "-of", "json", webm]);
    const st = JSON.parse(stdout).streams[0];
    assert.equal(st.codec_name, "vp9"); assert.equal(st.tags?.alpha_mode ?? st.tags?.ALPHA_MODE, "1", "VP9 with an alpha channel");
    // Decoded with libvpx (keeps alpha): the left half is see-through, the right half solid.
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", webm, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout as Buffer;
    const alpha = (x: number, y: number) => raw[(y * 400 + x) * 4 + 3];
    assert.ok(alpha(50, 100) < 10, `left half transparent (alpha ${alpha(50, 100)})`);
    assert.ok(alpha(350, 100) > 245, `right half opaque (alpha ${alpha(350, 100)})`);
  });

  it("placed top right at a fifth of the frame, it renders over the picture and holds past its 1 s", async () => {
    const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: () => undefined,
      getGraphic: (id) => (id === "el1" ? { id, name: "Logo", durationSec: ELEMENT_SECONDS } : undefined) };
    let s: Snapshot = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "e", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] as never }, ctx).snap;
    s = applyOp(s, { op: "add_graphic", graphicId: "el1", start: 0.5, end: 3.5, params: {}, edit: true } as Op, ctx).snap;
    const clip = (s.timeline.tracks.v3 as { id: string }[]).at(-1)!;
    const keys = elementKeys({ width: 400, height: 200 }, { width: W, height: H });
    s = applyOp(s, { op: "set_keyframes", track: "v3", clipId: clip.id, keys } as Op, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    assert.equal(plan.width, W);
    const files: PlanFiles = { source: main, output: join(dir, "out.mp4"), graphics: { [clip.id]: webm }, graphicSeconds: { [clip.id]: ELEMENT_SECONDS } };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, "g.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));
    const rgbAt = async (t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", files.output, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    // Where the logo lands: its centre at (x, y) shares of the frame from the middle, scaled from "as large as it fits".
    const k = keys[0], fit = Math.min(W / 400, H / 200), dw = 400 * fit * k.scale!, dh = 200 * fit * k.scale!;
    const cx = W / 2 + k.x! * W, cy = H / 2 + k.y! * H;
    const px = (f: Buffer, x: number, y: number) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [f[i], f[i + 1], f[i + 2]]; };
    const isRed = ([r, g, b]: number[]) => r > 180 && g < 80 && b < 80, isBlue = ([r, g, b]: number[]) => b > 150 && r < 80;
    for (const t of [1, 3]) {
      const f = await rgbAt(t);
      assert.ok(isRed(px(f, cx + dw / 4, cy)), `${t}s: the logo's solid half is drawn (${px(f, cx + dw / 4, cy)})`);
      assert.ok(isBlue(px(f, cx - dw / 4, cy)), `${t}s: its transparent half shows the picture (${px(f, cx - dw / 4, cy)})`);
      assert.ok(isBlue(px(f, W / 2, H / 2)), `${t}s: the middle of the frame is untouched`);
      assert.ok(cx + dw / 2 < W && cy - dh / 2 > 0 && cx > W / 2 && cy < H / 2, "top right, inside the frame");
    }
    const before = await rgbAt(0.2);
    assert.ok(isBlue(px(before, cx + dw / 4, cy)), "before it starts, the picture alone");
  });
});
