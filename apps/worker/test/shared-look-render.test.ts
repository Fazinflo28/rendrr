// One grade on every clip of an edit whose clips are drawn one by one (a clip moves, here a punch-in): the grade is
// drawn once on the joined picture, not in each clip (each clip's grade chain kept its frames to the end of the render:
// a 4K final of 62 graded clips ran the worker out of memory). Rendered by FFmpeg, its frames are the frames of the
// same grade drawn the established way (all clips still: cut, join, grade once). A clip framed smaller (what is behind
// it would be graded too) keeps its grade in the clip. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 12, W = 640, H = 360;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };

describe("one grade on every clip, drawn once", () => {
  let dir = "", src = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "shared-look-"));
    src = join(dir, "src.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`,
      "-vf", "format=gbrp,lutrgb=r='val*0.8':g='val*0.8':b='val*0.8',format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-shortest", src]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const clips = [{ id: "a", start: 1, end: 3, label: "" }, { id: "b", start: 5, end: 7, label: "" }, { id: "c", start: 8, end: 10, label: "" }];
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "x", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips }, { op: "set_grade", all: true, contrast: 35, saturation: 140, temperature: 30, blacks: -10 }, ...ops] as never }, ctx).snap;
  const render = async (name: string, ops: Op[]) => {
    const plan = planRender({ kind: "final", snapshot: edit(ops), transcript: [], source, videoId: "v" });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const pf: PlanFiles = { source: src, output: join(dir, `${name}.mp4`), looks };
    const { args, filterGraph } = ffmpegArgs(plan, pf, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: pf.output, graph: filterGraph };
  };
  const psnr = async (a: string, b: string) => {
    const { stderr } = await execFileP("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-filter_complex", "[0:v][1:v]psnr", "-f", "null", "-"], { maxBuffer: 1 << 24 });
    return Number(/average:([\d.inf]+)/.exec(stderr)?.[1] === "inf" ? 99 : /average:([\d.]+)/.exec(stderr)![1]);
  };

  it("a clip that moves: the grade drawn once, the same picture as the grade drawn the established way", { timeout: 180_000 }, async () => {
    const still = await render("still", []);
    // A punch-in that stays at 100% (so the picture is the same): the clips are then drawn one by one.
    const moving = await render("moving", [{ op: "set_keyframes", track: "v1", clipId: "b", keys: [{ t: 0, scale: 1 }, { t: 1, scale: 1 }] } as Op]);
    const luts = (g: string) => (g.match(/lut3d=/g) || []).length;
    assert.equal(luts(still.graph), 1, "the established way: one grade on the joined picture");
    assert.equal(luts(moving.graph), 1, "a moving clip: still one grade, on the joined picture");
    assert.match(moving.graph, /\[vshared\]/);
    const db = await psnr(still.out, moving.out);
    console.log(`the two renders: ${db} dB apart`);
    assert.ok(db > 45, `the same picture (${db} dB)`);
  });

  it("a clip framed smaller keeps its grade in the clip (what is behind it is not graded)", { timeout: 180_000 }, async () => {
    const small = await render("small", [{ op: "set_framing", clipIds: ["b"], scale: 0.7 } as Op]);
    assert.equal((small.graph.match(/lut3d=/g) || []).length, 3, "each clip graded on its own");
    assert.doesNotMatch(small.graph, /\[vshared\]/);
  });
});
