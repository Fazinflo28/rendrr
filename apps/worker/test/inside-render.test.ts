// Video inside text and text cut out of its card (Phase 2b), rendered and read back. Grey footage; a 2 s library video
// (red for its first second, green for its second) plays inside a big "I" on a yellow card from 0.5 s into it, so it
// loops; then an "I" cut out of a blue card shows the grey footage through it. Each frame checked at the letter's middle
// and beside it. Needs ffmpeg and the bundled fonts.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { fileURLToPath } from "node:url";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;
const FONTS_DIR = fileURLToPath(new URL("../../web/public/fonts", import.meta.url));
const SECONDS = 6, W = 640, H = 360;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };

describe("video inside text and text cut out of its card, rendered", () => {
  let dir = "", main = "", wave = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "inside-render-"));
    main = join(dir, "grey.mp4");
    wave = join(dir, "wave.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x808080:s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", main]);
    // A smaller picture of another shape (it is fitted to cover the frame): red, then green.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xFF0000:s=320x240:r=30:d=1", "-f", "lavfi", "-i", "color=c=0x00FF00:s=320x240:r=30:d=1",
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-g", "15", wave]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "br" ? { id, name: "wave.mp4", seconds: 2, ready: true } : undefined) } as EditContext;
  const letter = { text: "I", edit: true, font: "Anton", size: 25, x: 0.5, y: 0.5, stroke: null, shadow: null, anim: "none" };
  const snap = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" },
    { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null },
      { op: "add_text", ...letter, start: 1, end: 3.5, inside: { videoId: "br", from: 0.5 }, card: { color: "#FFFF00", opacity: 1 } },
      { op: "add_text", ...letter, start: 4, end: 5, cutout: true, card: { color: "#0000FF", opacity: 1 } }] as never }, ctx).snap;

  /** Output frames as RGB at the source's size. */
  async function frames(file: string, ns: number[]) {
    const px = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select='${ns.map((n) => `eq(n\\,${n})`).join("+")}',scale=${W}:${H}:flags=area,format=rgb24`, "-vsync", "0", "-f", "rawvideo", "pipe:1"]);
    return ns.map((_, i) => px.subarray(i * W * H * 3, (i + 1) * W * H * 3));
  }
  const at = (f: Buffer, x: number, y: number) => { const i = (y * W + x) * 3; return [f[i], f[i + 1], f[i + 2]]; };
  // (The letter's stem is about 9 px wide here: the preview's 4:2:0 colour and its compression bleed a little into it.)
  const near = (want: number[], tol = 40) => (got: number[]) => got.every((v, i) => Math.abs(v - want[i]) <= tol);
  const RED = [255, 0, 0], GREEN = [0, 255, 0], YELLOW = [255, 255, 0], BLUE = [0, 0, 255], GREY = [128, 128, 128];
  /** The letter's middle and two points beside it (left of it, above it). */
  function check(f: Buffer, what: string, inLetter: number[], around: number[]) {
    const mid = at(f, W / 2, H / 2), beside = [at(f, W / 2 - 70, H / 2), at(f, W / 2, H / 2 - 75), at(f, 20, 20)];
    for (const p of [mid, at(f, W / 2, H / 2 - 15), at(f, W / 2, H / 2 + 15)]) assert.ok(near(inLetter)(p), `${what}: in the letter ${JSON.stringify(inLetter)}, got ${JSON.stringify(p)}`);
    for (const b of beside) assert.ok(near(around)(b), `${what}: around the letter ${JSON.stringify(around)}, got ${JSON.stringify(b)}`);
  }

  it("the video plays (and loops) in the letter over its card; the cut-out shows the footage through its card", async () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: [], source, videoId: "v", brollSeconds: { br: 2 } });
    assert.equal(plan.textMattes?.length, 2);
    assert.ok(plan.operations.some((o) => /^Inside the letters: \w+ video br from 0\.5s \(looped\); \w+ cut out of its card #0000FF/.test(o)), plan.operations.join("\n"));
    const files: PlanFiles = { source: main, output: join(dir, "out.mp4"), fontsDir: FONTS_DIR, textMasks: {}, textDecor: {}, insides: {} };
    for (const m of plan.textMattes!) {
      files.textMasks![m.clipId] = join(dir, `${m.clipId}-mask.ass`);
      await writeFile(files.textMasks![m.clipId], m.mask);
      if (m.decor) { files.textDecor![m.clipId] = join(dir, `${m.clipId}-decor.ass`); await writeFile(files.textDecor![m.clipId], m.decor); }
      if (m.inside) files.insides![m.clipId] = wave;
    }
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { inputThreads: 8 });
    await writeFile(join(dir, "graph.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "graph.txt") : a)));
    // 0.5 s: before the layers. 1.2 s: 0.7 s into the video (red). 2.0 s: 1.5 s (green). 2.8 s: 2.3 s, looped to 0.3 s
    // (red). 4.5 s: the cut-out. 5.5 s: after.
    const [f0, f1, f2, f3, f4, f5] = await frames(files.output, [15, 36, 60, 84, 135, 165]);
    check(f0, "0.5 s, before", GREY, GREY);
    check(f1, "1.2 s", RED, YELLOW);
    check(f2, "2.0 s", GREEN, YELLOW);
    check(f3, "2.8 s, looped", RED, YELLOW);
    check(f4, "4.5 s, cut out", GREY, BLUE);
    check(f5, "5.5 s, after", GREY, GREY);
  });
});
