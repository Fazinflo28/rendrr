// The renders that filled the memory of the user's Mac and of the cloud (23 November), made small and run with FFmpeg:
// clips of off-grid lengths (most cuts fall between two frames), framed 1.22 and moved up, a plain morph at the last
// cut, a dissolve and a flash near the end, the footage read in one window (as a final from a 4K original is). Before
// the fix the morph's B side took a sliver of the clip before it with no frame in it, framed it on a frame that never
// ended, and the morph's reverse kept every frame: FFmpeg grew without end and never made a frame. And each late layer
// made FFmpeg make, and keep, all of the edit before it first. Now it renders in a bounded amount of memory, every
// frame is there, and the morph shows the clips (not black).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";

const execFileP = promisify(execFile);
const SECONDS = 60;
const source: SourceInfo = { width: 360, height: 640, fps: 30, seconds: SECONDS, hasAudio: true };
// The morph's cut at 15.085 s: frame 452.55, so the picture changes on frame 453, after the clip's own start (as in the
// user's edit, at 92.617 s): the morph's B side began with a sliver of the clip before it.
const LENS = [1.225, 1.585, 2.295, 1.585, 0.955, 0.635, 2.355, 2.97, 1.48, 1.855];
const clips = LENS.map((len, i) => ({ id: `c${i}`, start: 3 + i * 5.5, end: 3 + i * 5.5 + len, label: "" }));
/** Peak memory of a run (Linux: its RSS, read every 100 ms); killed past `limit` bytes or `ms`. */
function measured(args: string[], limit: number, ms: number): Promise<{ code: number | null; peak: number; killed: string | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let peak = 0, killed: string | null = null, err = "";
    p.stderr.on("data", (d) => { if (err.length < 20000) err += d; });
    const t0 = Date.now();
    const tick = setInterval(() => {
      try {
        const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${p.pid}/status`, "utf8"));
        if (m) peak = Math.max(peak, Number(m[1]) * 1024);
      } catch { /* gone */ }
      if (peak > limit) { killed = `over ${Math.round(limit / 1e6)} MB`; p.kill("SIGKILL"); }
      else if (Date.now() - t0 > ms) { killed = `over ${ms / 1000} s`; p.kill("SIGKILL"); }
    }, 100);
    p.on("close", (code) => { clearInterval(tick); resolve({ code, peak, killed, err }); });
  });
}

describe("a heavy edit renders in bounded memory (late morph, dissolve and flash; footage in one window)", { skip: process.platform !== "linux" && "reads /proc for the memory" }, () => {
  let dir = "", src = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "heavy-graph-"));
    src = join(dir, "source.mp4");
    await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=360x640:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}`, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  it("renders every frame, the morph shows the clips, and FFmpeg stays small", async () => {
    const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
    let s = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "t", aspect: "9:16", styleId: "s2" } as Snapshot, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips }] } as never, ctx).snap;
    const ids = ((s.timeline as unknown as { sequence?: { id: string }[] }).sequence ?? (s.timeline.tracks as unknown as { v1: { id: string }[] }).v1).map((c) => c.id);
    s = applyOp(s, { op: "batch", ops: [
      { op: "set_framing", all: true, scale: 1.22, y: -0.03 },
      { op: "set_transition", clipId: ids[6], type: "dissolve", duration: 0.4 },
      { op: "set_transition", clipId: ids[7], type: "flash", duration: 0.4 },
      { op: "set_transition", clipId: ids[9], type: "morph", duration: 0.25, face: false },
    ] as Op[] } as never, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const files: PlanFiles = { source: src, output: join(dir, "out.mp4") } as PlanFiles;
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0, threads: 2, inputThreads: 4, filterThreads: 2, windowBudget: { v: 1 } });
    await writeFile(join(dir, "graph.txt"), filterGraph);
    const run = await measured(args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "graph.txt") : a)), 1.5e9, 180_000);
    assert.equal(run.killed, null, `FFmpeg ran away (${run.killed}, peak ${Math.round(run.peak / 1e6)} MB)`);
    assert.equal(run.code, 0, run.err.slice(-1500));
    // Small: the footage is 360x640 and the picture 540x960 (it was past 1.5 GB and still growing before the fix).
    assert.ok(run.peak < 700e6, `peak ${Math.round(run.peak / 1e6)} MB`);
    // Every frame of the edit.
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", files.output]);
    assert.equal(Number(stdout.trim()), Math.round(plan.outputSeconds * 30));
    // The morph's frames are pictures, not black (a side that never ended showed black).
    const m = plan.transitions!.find((t) => t.type === "morph")!;
    const { stderr } = await execFileP("ffmpeg", ["-hide_banner", "-ss", String(m.start + 0.02), "-t", String(m.end - m.start - 0.04), "-i", files.output, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"], { maxBuffer: 1 << 24 });
    const lumas = [...stderr.matchAll(/YAVG=([\d.]+)/g)].map((x) => Number(x[1]));
    assert.ok(lumas.length >= 3, `frames in the morph (${lumas.length})`);
    assert.ok(Math.min(...lumas) > 40, `no black frame in the morph (${lumas.map((x) => x.toFixed(0)).join(", ")})`);
  });
});
