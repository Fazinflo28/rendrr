// remove_background rendered and read back, without the model: a red box (the "person") that jumps 30 px every frame
// over grey, and its matte (a white box in the same place) in two 10 s blocks, as the worker keeps them. Every frame
// checked shows the box red to its edges and the edit's background (green) right outside them: the matte follows the
// clip frame by frame, across the blocks' join, at normal speed and at 2x, and a turned clip turns its matte. Needs
// ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, MATTE_BLOCK, type EditContext, type Op, type SeqClip, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;
const SECONDS = 14, W = 640, H = 360;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };
// The box: 80 x 120 at y 120, its left edge at 40 + 30 px x ((frame number + 1) mod 15) (overlay's n counts from 1 here).
const boxX = (n: number) => 40 + 30 * ((n + 1) % 15);
/** A filter graph: [0] the background, the box (a second colour source) moved there frame by frame. */
const boxOver = (offset: number, color: string) => `color=c=${color}:s=80x120:r=30[box];[0][box]overlay=x='40+30*mod(n+${offset}\\,15)':y=120:eval=frame:shortest=1`;

describe("remove_background, rendered", () => {
  let dir = "", main = "";
  const blocks: string[] = [];
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "subject-render-"));
    main = join(dir, "person.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x808080:s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", `${boxOver(0, "0xFF0000")},format=yuv420p[v]`, "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-g", "30", "-c:a", "aac", "-shortest", main]);
    // The matte in blocks, as matte.py writes them (grey in Y, yuv420p, H.264).
    for (let k = 0; k * MATTE_BLOCK < SECONDS; k++) {
      const p = join(dir, `matte-${k}.mp4`), d = Math.min(MATTE_BLOCK, SECONDS - k * MATTE_BLOCK);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=30:d=${d}`, "-filter_complex", `${boxOver(k * MATTE_BLOCK * 30, "white")},format=gray[v]`, "-map", "[v]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", p]);
      blocks.push(p);
    }
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: (snap: Snapshot) => Op[]): Snapshot => {
    const base: Snapshot = { timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" };
    return applyOp(base, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_background", color: "#00FF00" }, ...ops(base)] as never }, ctx).snap;
  };
  async function render(plan: RenderPlan, name: string) {
    const looks: Record<string, string> = {}, mattes: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan)); looks[n] = p; }
    for (const [n, m] of Object.entries(plan.mattes ?? {})) { const p = join(dir, `${name}-${n}.txt`); await writeFile(p, m.blocks.map((k) => `file '${blocks[k]}'\n`).join("")); mattes[n] = p; }
    const all: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks, mattes };
    const { args, filterGraph } = ffmpegArgs(plan, all, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return all.output;
  }
  /** Output frames as RGB at the source's size (the render fits 640 x 360 into 1280 x 720: halved back). */
  async function frames(file: string, ns: number[]) {
    const px = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select='${ns.map((n) => `eq(n\\,${n})`).join("+")}',scale=${W}:${H}:flags=area,format=rgb24`, "-vsync", "0", "-f", "rawvideo", "pipe:1"]);
    return ns.map((_, i) => px.subarray(i * W * H * 3, (i + 1) * W * H * 3));
  }
  const at = (f: Buffer, x: number, y: number) => { const i = (y * W + x) * 3; return [f[i], f[i + 1], f[i + 2]]; };
  const red = ([r, g, b]: number[]) => r > 170 && g < 90 && b < 90;
  const green = ([r, g, b]: number[]) => g > 170 && r < 90 && b < 90;
  /** Output frame k shows source frame `src(k)`: the box red just inside its edges, green just outside. */
  function checkFrame(f: Buffer, n: number, what: string) {
    const x0 = boxX(n), inside = [at(f, x0 + 12, 180), at(f, x0 + 68, 180)], outside = [at(f, Math.max(2, x0 - 12), 180), at(f, Math.min(W - 3, x0 + 92), 180), at(f, x0 + 40, 100)];
    assert.ok(inside.every(red), `${what}: inside the box should stay red, got ${JSON.stringify(inside)}`);
    assert.ok(outside.every(green), `${what}: outside the box should show the background, got ${JSON.stringify(outside)}`);
  }

  it("follows the clip frame by frame, across the blocks' join", async () => {
    const snap = edit(() => [{ op: "remove_background" }]);
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" });
    assert.deepEqual(Object.values(plan.mattes ?? {}).map((m) => m.blocks), [[0, 1]]);
    assert.ok(plan.operations.some((o) => /^Background: .*removed/.test(o) && /behind: .*#00FF00|behind: colour/i.test(o)), plan.operations.join("\n"));
    const out = await render(plan, "speed1");
    const ns = [3, 4, 150, 298, 299, 300, 301, 302, 400];
    (await frames(out, ns)).forEach((f, i) => checkFrame(f, ns[i], `frame ${ns[i]}`));
  });

  it("at 2x, the matte takes the same frames as the picture", async () => {
    const snap = edit((b) => [{ op: "set_speed", clipId: (b.timeline.tracks.v1 as SeqClip[])[0].id, speed: 2 }, { op: "remove_background" }]);
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" });
    const out = await render(plan, "speed2");
    // Output frame k shows source frame 2k (the plan's pick).
    const ks = [5, 74, 149, 150, 151, 199];
    (await frames(out, ks)).forEach((f, i) => checkFrame(f, 2 * ks[i], `2x frame ${ks[i]}`));
  });

  it("off puts the background back; edge and invert reach the render", async () => {
    const on = edit(() => [{ op: "remove_background", edge: 6, soft: 0, invert: true }]);
    const plan = planRender({ kind: "preview", snapshot: on, transcript: [], source, videoId: "v" });
    const out = await render(plan, "invert");
    const [f] = await frames(out, [150]);
    const x0 = boxX(150);
    // Inverted: the box (the "person") goes, the grey around it stays.
    assert.ok(green(at(f, x0 + 40, 180)), `the inverted box should show the background, got ${at(f, x0 + 40, 180)}`);
    const grey = at(f, x0 + 40, 60);
    assert.ok(Math.abs(grey[0] - 128) < 20 && Math.abs(grey[1] - 128) < 20, `the grey around it stays, got ${grey}`);
    const off = applyOp(on, { op: "remove_background", off: true }, ctx).snap;
    assert.equal((off.timeline.tracks.v1 as (SeqClip & { subject?: unknown })[])[0].subject, undefined);
    assert.equal(planRender({ kind: "preview", snapshot: off, transcript: [], source, videoId: "v" }).mattes, undefined);
  });
});
