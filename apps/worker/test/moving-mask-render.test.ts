// Phase 3 rendered and read back: a darken box that moves with keys. The mask video is in footage time, so on a clip
// that starts 2 s into the footage the box is where its keys put it at 2 s, and it keeps moving with the footage. And a
// moving mask on a clip: the picture shows only inside the box as it moves. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { writeMoving } from "../src/lib/moving";

const execFileP = promisify(execFile);
const SECONDS = 6;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const GW = 96, GH = 54; // frames read back this small: enough to see where the box is

describe("moving masks, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "moving-render-"));
    main = join(dir, "main.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0xB4B4B4:s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  async function render(plan: RenderPlan, name: string) {
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) {
      const p = join(dir, `${name}-${n}`);
      if (spec.kind === "moving") await writeMoving(spec, plan, p); else await writeFile(p, lookFileData(spec, plan, {}));
      looks[n] = p;
    }
    const all: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks };
    const { args, filterGraph } = ffmpegArgs(plan, all, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return all.output;
  }
  const frame = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${GW}:${GH}:flags=area`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout as Buffer;
  /** The middle of the dark columns on the middle row, as a share of the width. */
  const darkAt = (f: Buffer) => { const row = Array.from(f.subarray((GH >> 1) * GW, (GH >> 1) * GW + GW)); const xs = row.map((v, x) => (v < 60 ? x : -1)).filter((x) => x >= 0); return xs.length ? (xs[0] + xs[xs.length - 1]) / 2 / GW : -1; };
  // A box a fifth of the frame wide, from the left edge at 0 s to the right edge at 5 s (footage seconds).
  const keys = [{ at: 0, x: 0, y: 0.25, w: 0.2, h: 0.5 }, { at: 5, x: 0.8, y: 0.25, w: 0.2, h: 0.5 }];

  it("a darken box moves with its keys, in footage time (a clip from 2 s starts with the box at 2 s)", async () => {
    const s = edit([
      { op: "set_clips", track: "v1", clips: [{ id: "c", start: 2, end: 5, label: "" }] },
      { op: "set_effects", clipId: "c", effects: [{ type: "darken", amount: 100, area: { shape: "rect", ...keys[0], keys } }] },
    ] as Op[]);
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    assert.ok(Object.values(plan.lookFiles ?? {}).some((f) => f.kind === "moving"), "a moving mask file");
    const out = await render(plan, "darken");
    // Footage 2 s -> the box's centre at 0.1 + 0.8 * 2/5 = 0.42; footage 4.5 s -> 0.82.
    const a = darkAt(await frame(out, 0.05)), b = darkAt(await frame(out, 2.5));
    console.log(`box centre ${a.toFixed(3)} at the start, ${b.toFixed(3)} 2.5 s later`);
    assert.ok(Math.abs(a - 0.42) < 0.04, `at the clip's start the box is where its keys put it at 2 s (${a})`);
    assert.ok(Math.abs(b - 0.82) < 0.04, `and it moved with the footage (${b})`);
    // Outside the box the picture is untouched.
    const f = await frame(out, 0.05);
    assert.ok(f[(GH >> 1) * GW + GW - 4] > 150, "the right edge is not darkened at the start");
  });

  it("a moving mask: the clip shows only inside the box as it moves", async () => {
    const s = edit([{ op: "set_masks", clipId: undefined, all: true, masks: [{ shape: "rect", ...keys[0], keys }] }] as Op[]);
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const out = await render(plan, "mask");
    const lit = (f: Buffer) => { const row = Array.from(f.subarray((GH >> 1) * GW, (GH >> 1) * GW + GW)); const xs = row.map((v, x) => (v > 120 ? x : -1)).filter((x) => x >= 0); return (xs[0] + xs[xs.length - 1]) / 2 / GW; };
    const a = lit(await frame(out, 0.5)), b = lit(await frame(out, 4.5));
    console.log(`picture shows around ${a.toFixed(3)} at 0.5 s, ${b.toFixed(3)} at 4.5 s`);
    assert.ok(Math.abs(a - 0.18) < 0.04 && Math.abs(b - 0.82) < 0.04);
  });
});
