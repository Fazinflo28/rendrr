// Phase 16 rendered and read back: adjustment layers that darken a flat grey picture by half, (1) only inside a
// rectangle that moves from the left half to the right half over the layer (keys at seconds from the layer's start),
// (2) everywhere at 50% strength, fading in over 1 s. Each spot's brightness is what the player's numbers say
// (adjustStrengthAt). Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adjustStrengthAt, applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { writeMoving } from "../src/lib/moving";

const execFileP = promisify(execFile);
const SECONDS = 8;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540;

describe("masked and keyframed adjustment layers, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "adjust16-render-"));
    main = join(dir, "main.mp4");
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", "-colorspace", "bt709"];
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x808080:s=640x360:r=30:d=${SECONDS},format=yuv444p,scale=out_color_matrix=bt709:out_range=tv`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, ...enc, "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "a", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) {
      const p = join(dir, `${name}-${n}${spec.kind === "moving" ? ".mkv" : ""}`);
      if (spec.kind === "moving") await writeMoving(spec, plan, p); else await writeFile(p, lookFileData(spec, plan, {}));
      looks[n] = p;
    }
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: files.output, plan };
  };
  const rgbAt = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  const level = (f: Buffer, fx: number, fy = 0.5) => { const cx = Math.round(W * fx), cy = Math.round(H * fy); let s = 0; for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) for (let k = 0; k < 3; k++) s += f[(y * W + x) * 3 + k]; return s / 147; };

  it("a moving mask: darker only inside it, where its keys put it (seconds from the layer's start)", async () => {
    const box = { shape: "rect" as const, x: 0, y: 0, w: 0.5, h: 1, keys: [{ at: 0, x: 0, y: 0, w: 0.5, h: 1 }, { at: 2, x: 0.5, y: 0, w: 0.5, h: 1 }] };
    const { out, plan } = await render(edit([{ op: "adjustment_layer", start: 1, end: 3, edit: true, effects: [{ type: "darken", amount: 50 }], masks: [box] } as Op]), "moving");
    assert.match(plan.operations.join("\n"), /Adjustment layers: 0:01-0:03 darken 50, only in rect 50%x100% at 0%,0% moving/);
    const f05 = await rgbAt(out, 0.5), f11 = await rgbAt(out, 1.1), f28 = await rgbAt(out, 2.8), f35 = await rgbAt(out, 3.5);
    const at = (f: Buffer) => [level(f, 0.25), level(f, 0.75)].map((v) => Math.round(v));
    console.log(`left, right: ${at(f05)} before; ${at(f11)} 0.1 s in (mask on the left); ${at(f28)} 1.8 s in (mask on the right); ${at(f35)} after`);
    for (const f of [f05, f35]) at(f).forEach((v) => assert.ok(Math.abs(v - 128) < 4, `outside the layer's time the grey stays (${v})`));
    assert.ok(Math.abs(level(f11, 0.25) - 64) < 4, `0.1 s in: the left is inside the mask, half as bright (${level(f11, 0.25)})`);
    assert.ok(Math.abs(level(f11, 0.75) - 128) < 4, `0.1 s in: the right is outside it (${level(f11, 0.75)})`);
    assert.ok(Math.abs(level(f28, 0.25) - 128) < 4, `1.8 s in: the mask has moved off the left (${level(f28, 0.25)})`);
    assert.ok(Math.abs(level(f28, 0.75) - 64) < 4, `1.8 s in: and onto the right (${level(f28, 0.75)})`);
  });

  it("strength and a fade in: the change is the player's strength at each moment", async () => {
    const layer = { opacity: 0.5, fadeIn: 1 };
    const { out } = await render(edit([{ op: "adjustment_layer", start: 4, end: 7, edit: true, effects: [{ type: "darken", amount: 50 }], ...layer } as Op]), "strength");
    for (const t of [3.5, 4.5, 6, 7.5]) {
      const f = await rgbAt(out, t), got = level(f, 0.5);
      const s = t >= 4 && t < 7 ? adjustStrengthAt(layer, t - 4, 3) : 0, want = 128 * (1 - 0.5 * s);
      console.log(`${t}s: strength ${s.toFixed(2)}: ${got.toFixed(1)} (player's numbers: ${want.toFixed(1)})`);
      assert.ok(Math.abs(got - want) < 3, `${t}s: ${got.toFixed(1)}, want ${want.toFixed(1)}`);
    }
  });
});
