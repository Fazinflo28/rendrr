// Phase 18: remove_background on a reversed clip, a mirrored clip and b-roll, rendered and read back without the model:
// a red box (the "person") that jumps 30 px every frame over grey, and its matte (a white box in the same place) in
// 10 s blocks, as the worker keeps them. In every frame checked the box is red to its edges and right outside it is
// what should show (the green background behind V1; for b-roll, the blue picture under it): the matte plays backwards
// with a reversed clip, is mirrored with a mirrored one, and follows b-roll from its own source second. Needs ffmpeg.
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

describe("remove_background on reversed, mirrored and b-roll clips, rendered", () => {
  let dir = "", main = "", blue = "";
  const blocks: string[] = [];
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "phase18-render-"));
    main = join(dir, "person.mp4"); blue = join(dir, "blue.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x0000FF:s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", blue]);
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

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "br" ? { id, name: "person", seconds: SECONDS, ready: true } : undefined) };
  const edit = (ops: (snap: Snapshot) => Op[]): Snapshot => {
    const base: Snapshot = { timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" };
    return applyOp(base, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_background", color: "#00FF00" }, ...ops(base)] as never }, ctx).snap;
  };
  async function render(plan: RenderPlan, name: string, over?: { source: string; broll: Record<string, string> }) {
    const looks: Record<string, string> = {}, mattes: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan)); looks[n] = p; }
    for (const [n, m] of Object.entries(plan.mattes ?? {})) { const p = join(dir, `${name}-${n}.txt`); await writeFile(p, m.blocks.map((k) => `file '${blocks[k]}'\n`).join("")); mattes[n] = p; }
    const all: PlanFiles = { source: over?.source ?? main, output: join(dir, `${name}.mp4`), looks, mattes, ...(over ? { broll: over.broll } : {}) };
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

  const blueish = ([r, g, b]: number[]) => b > 170 && r < 90 && g < 90;
  /** The red box found at y 180 (its left edge), then red just inside its edges and `outside` right outside them. */
  function checkAligned(f: Buffer, what: string, outside: (p: number[]) => boolean = green) {
    let x0 = -1;
    for (let x = 0; x < W; x++) if (red(at(f, x, 180))) { x0 = x; break; }
    assert.ok(x0 >= 0, `${what}: the box shows`);
    const ins = [at(f, x0 + 12, 180), at(f, x0 + 68, 180)], outs = [at(f, Math.max(2, x0 - 12), 180), at(f, Math.min(W - 3, x0 + 92), 180), at(f, x0 + 40, 100)];
    assert.ok(ins.every(red), `${what}: inside the box should stay red, got ${JSON.stringify(ins)}`);
    assert.ok(outs.every(outside), `${what}: outside the box should show what is behind, got ${JSON.stringify(outs)}`);
    return x0;
  }

  it("a reversed clip: the matte plays backwards with the picture, piece by piece", async () => {
    const snap = edit(() => [{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 5.5, label: "" }] }, { op: "set_speed", clipId: "a", reverse: true }, { op: "remove_background" }] as Op[]);
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" });
    assert.ok(plan.mattes && Object.keys(plan.mattes).length === 1, "it reads a matte");
    const out = await render(plan, "reversed");
    const ks = [0, 1, 14, 29, 30, 31, 59, 60, 100];
    const xs = (await frames(out, ks)).map((f, i) => checkAligned(f, `reversed frame ${ks[i]}`));
    // Played backwards: the box steps 30 px to the left each frame (wrapping round every 15 frames).
    for (let i = 0; i + 1 < ks.length; i++) if (ks[i + 1] === ks[i] + 1) assert.ok(xs[i + 1] - xs[i] === -30 || xs[i + 1] - xs[i] === 30 * 14, `frame ${ks[i]} to ${ks[i + 1]}: ${xs[i]} -> ${xs[i + 1]}`);
  });

  it("a mirrored clip: the matte is mirrored with the picture", async () => {
    const snap = edit((b) => [{ op: "set_flip", clipId: (b.timeline.tracks.v1 as SeqClip[])[0].id, flip: "h" }, { op: "remove_background" }] as Op[]);
    const out = await render(planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" }), "mirrored");
    const ns = [3, 150, 301];
    (await frames(out, ns)).forEach((f, i) => { const x0 = checkAligned(f, `mirrored frame ${ns[i]}`); assert.equal(x0 + 80, W - boxX(ns[i]), `mirrored: the box at ${x0}`); });
  });

  it("b-roll: its person cut out from its own source second; the picture under it shows round them", async () => {
    const snap = edit(() => [{ op: "set_background", none: true }, { op: "add_broll", videoId: "br", start: 3, end: 7, sourceStart: 4, edit: true }] as Op[]);
    const id = (snap.timeline.tracks.v2 as { id: string }[])[0].id;
    const s2 = applyOp(snap, { op: "remove_background", clipId: id }, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s2, transcript: [], source, videoId: "v", brollSeconds: { br: SECONDS } });
    assert.ok(plan.operations.some((o) => /^Background: b-roll .*removed.*the picture under it shows/.test(o)), plan.operations.join("\n"));
    const out = await render(plan, "broll", { source: blue, broll: { [id]: main } });
    // Edit frame k (3-7 s) shows b-roll source frame (k - 90) + 120.
    const ks = [92, 120, 150, 200];
    (await frames(out, ks)).forEach((f, i) => { const x0 = checkAligned(f, `b-roll frame ${ks[i]}`, blueish); assert.equal(x0, boxX(ks[i] - 90 + 120), `b-roll frame ${ks[i]}: the box where its source frame has it`); });
    const [before] = await frames(out, [60]);
    assert.ok(blueish(at(before, 320, 180)), "before the b-roll: the blue picture");
  });
});
