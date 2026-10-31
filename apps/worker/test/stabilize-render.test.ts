// Phase 7 rendered and measured: footage of a still scene seen through a shaking camera (a crop that jitters every
// frame), on a clip that starts part way in. Stabilized (the worker's vidstabdetect pass over the frames the render
// reads, then vidstabtransform in the render), frame-to-frame movement drops; the edit is as long, and plays as filmed
// where nothing asks for it. Needs ffmpeg with vidstab.
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
import { detectShake } from "../src/lib/stabilize";

const execFileP = promisify(execFile);
const SECONDS = 8;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const GW = 160, GH = 90;

describe("Warp Stabilizer, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "stabilize-"));
    main = join(dir, "source.mp4");
    // A still scene (blurred noise: texture a tracker can follow, as real footage has), 960x540, seen through a 640x360
    // window that shakes every frame, as a hand-held camera does.
    const still = join(dir, "still.png");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=960x540:d=1,format=gray,geq=lum='255*random(1)',gblur=sigma=3,eq=contrast=4", "-frames:v", "1", still]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", still, "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`,
      "-vf", "crop=640:360:x='160+14*sin(n*1.3)+9*sin(n*3.1)':y='90+11*sin(n*1.7)+7*sin(n*2.9)',format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "c", start: 1.5, end: 7, label: "" }] }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks };
    for (const [key, st] of Object.entries(plan.stabilize ?? {})) { const p = join(dir, `${name}-${st.file}`); await detectShake(main, st, plan.rate || "30", p); (files.stabilize ??= {})[key] = p; }
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", files.output, "-vf", `scale=${GW}:${GH}:flags=area,format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    return { frames: raw.length / (GW * GH), raw, plan, graph: filterGraph };
  };
  /** The mean frame-to-frame difference in the middle of the picture (the edges are zoomed in or out). */
  const motion = (raw: Buffer, frames: number) => {
    let s = 0, n = 0;
    for (let f = 31; f < frames - 1; f++) for (let y = 20; y < GH - 20; y++) for (let x = 30; x < GW - 30; x++) { s += Math.abs(raw[f * GW * GH + y * GW + x] - raw[(f - 1) * GW * GH + y * GW + x]); n++; }
    return s / n;
  };

  it("stabilized, the shake is nearly gone from frame to frame; the edit is as long", async () => {
    const shaky = await render(edit([]), "shaky");
    const steady = await render(edit([{ op: "stabilize", clipId: "c", smooth: 60 } as Op]), "steady");
    const a = motion(shaky.raw, shaky.frames), b = motion(steady.raw, steady.frames);
    console.log(`frame-to-frame difference: ${a.toFixed(2)} as filmed, ${b.toFixed(2)} stabilized (${shaky.frames} and ${steady.frames} frames)`);
    assert.ok(steady.graph.includes("vidstabtransform=input="), "the render smooths the shake");
    assert.ok(steady.plan.operations.join("\n").includes("Stabilized (Warp Stabilizer"));
    assert.equal(steady.frames, shaky.frames, "as long");
    assert.ok(b < a * 0.15, `the movement nearly gone (${a.toFixed(2)} -> ${b.toFixed(2)})`);
  });
});
