// Text behind the person, rendered and read back, without the model: a red box (the "person") that jumps 30 px every
// frame over grey, and its matte (a white box in the same place) in two 10 s blocks, as the worker keeps them. A text
// layer with a full-frame blue card goes behind the person: every frame checked shows the box red to its edges and
// blue right outside them (the person laid back over the card frame by frame, across the blocks' join and through a
// zoom). A green card text in front covers everything. Before the layers: the footage as it is. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, MATTE_BLOCK, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, zoomAt, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;
const SECONDS = 14, W = 640, H = 360;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };
// The box: 80 x 120 at y 120, its left edge at 40 + 30 px x ((frame number + 1) mod 15) (overlay's n counts from 1).
const boxX = (n: number) => 40 + 30 * ((n + 1) % 15);
const boxOver = (offset: number, color: string) => `color=c=${color}:s=80x120:r=30[box];[0][box]overlay=x='40+30*mod(n+${offset}\\,15)':y=120:eval=frame:shortest=1`;

describe("text behind the person, rendered", () => {
  let dir = "", main = "";
  const blocks: string[] = [];
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "behind-render-"));
    main = join(dir, "person.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x808080:s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", `${boxOver(0, "0xFF0000")},format=yuv420p[v]`, "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-g", "30", "-c:a", "aac", "-shortest", main]);
    for (let k = 0; k * MATTE_BLOCK < SECONDS; k++) {
      const p = join(dir, `matte-${k}.mp4`), d = Math.min(MATTE_BLOCK, SECONDS - k * MATTE_BLOCK);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=30:d=${d}`, "-filter_complex", `${boxOver(k * MATTE_BLOCK * 30, "white")},format=gray[v]`, "-map", "[v]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", p]);
      blocks.push(p);
    }
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  // Card texts: tiny "." at the bottom edge, so only the card shows where the checks look.
  const card = (color: string, start: number, end: number, behind: boolean) => ({ op: "add_text", text: ".", start, end, edit: true, behind, size: 2, y: 0.98, anim: "none", card: { color, opacity: 1 } });
  const snap = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" },
    { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, card("#0000FF", 2, 12, true), card("#00FF00", 12, 13, false), { op: "add_zoom", start: 5, end: 7, scale: 1.3, edit: true }] as never }, ctx).snap;
  async function render(plan: RenderPlan, name: string) {
    const mattes: Record<string, string> = {};
    for (const [n, m] of Object.entries(plan.mattes ?? {})) { const p = join(dir, `${name}-${n}.txt`); await writeFile(p, m.blocks.map((k) => `file '${blocks[k]}'\n`).join("")); mattes[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), mattes, assPath: join(dir, `${name}.ass`), assBehindPath: join(dir, `${name}-behind.ass`) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    if (plan.assBehind) await writeFile(files.assBehindPath!, plan.assBehind);
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { inputThreads: 8 });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return files.output;
  }
  /** Output frames as RGB at the source's size (the render is 1280 x 720: halved back). */
  async function frames(file: string, ns: number[]) {
    const px = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select='${ns.map((n) => `eq(n\\,${n})`).join("+")}',scale=${W}:${H}:flags=area,format=rgb24`, "-vsync", "0", "-f", "rawvideo", "pipe:1"]);
    return ns.map((_, i) => px.subarray(i * W * H * 3, (i + 1) * W * H * 3));
  }
  const at = (f: Buffer, x: number, y: number) => { const i = (y * W + x) * 3; return [f[i], f[i + 1], f[i + 2]]; };
  const is = (want: "red" | "blue" | "green" | "grey") => ([r, g, b]: number[]) => want === "red" ? r > 170 && g < 90 && b < 90 : want === "blue" ? b > 170 && r < 90 && g < 90 : want === "green" ? g > 170 && r < 90 && b < 90 : Math.abs(r - 128) < 25 && Math.abs(g - 128) < 25 && Math.abs(b - 128) < 25;
  /** The box (the person) at (x0, 120..240) red just inside, `around` just outside, at a zoom z (about 50% across, 40% down). */
  function check(f: Buffer, n: number, around: "blue" | "grey", what: string, z = 1) {
    const zx = (x: number) => Math.round(W / 2 + (x - W / 2) * z), zy = (y: number) => Math.round(0.4 * H + (y - 0.4 * H) * z);
    const x0 = boxX(n), inside = [at(f, zx(x0 + 14), zy(180)), at(f, zx(x0 + 66), zy(180))];
    const outside = [at(f, Math.max(2, zx(x0 - 14)), zy(180)), at(f, Math.min(W - 3, zx(x0 + 94)), zy(180)), at(f, zx(x0 + 40), zy(100))];
    assert.ok(inside.every(is("red")), `${what}: the person should stay red over the layer, got ${JSON.stringify(inside)}`);
    assert.ok(outside.every(is(around)), `${what}: around the person should be ${around}, got ${JSON.stringify(outside)}`);
  }

  it("the person in front of the blue card frame by frame, across the blocks' join and through a zoom; green in front covers them", async () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: [], source, videoId: "v" });
    assert.ok(plan.person && plan.person.windows.length, "the plan lays the person back");
    assert.ok(plan.operations.some((o) => /^Behind the person: 1 text layers/.test(o)), plan.operations.join("\n"));
    const out = await render(plan, "behind");
    // Before the layers (0-2 s): the footage as it is.
    const [f0] = await frames(out, [30]);
    check(f0, 30, "grey", "before the layers");
    // Behind (2-12 s), across the matte's blocks (frame 300 is 10 s) and through the zoom (5-7 s: frames 150-210).
    const ns = [61, 90, 298, 299, 300, 301, 350];
    (await frames(out, ns)).forEach((f, i) => check(f, ns[i], "blue", `frame ${ns[i]}`));
    // The zoom at that frame as the render computes it (a zoom eases in and out).
    // (Frame 172: the box mid-frame, so zoomed it stays on screen.)
    const z = zoomAt(plan.zooms, 172 / 30);
    assert.ok(z > 1.1, `frame 172 is zoomed in (${z})`);
    const [fz] = await frames(out, [172]);
    check(fz, 172, "blue", `frame 172, zoomed ${z.toFixed(3)}`, z);
    // Green in front (12-13 s): over everything, the person too.
    const [fg] = await frames(out, [375]);
    for (const [x, y] of [[boxX(375) + 40, 180], [10, 10], [W - 10, 300]]) assert.ok(is("green")(at(fg, x, y)), `in front: green at ${x},${y}, got ${at(fg, x, y)}`);
  });
});
