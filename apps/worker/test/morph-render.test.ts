// Phase 8 rendered and measured: Morph Cut on a jump cut. The footage has a textured square that sits still, then sits
// 60 px (at the preview's size) to the right; the edit cuts from the first stretch to the second. With a plain cut it
// jumps; with a morph, the middle of the window shows one square part of the way across (not two faint ones, as a
// dissolve would), and the edit is as long. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 8;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540;

describe("Morph Cut, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "morph-"));
    main = join(dir, "source.mp4");
    const tex = join(dir, "tex.png");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=120x120:d=1,format=gray,geq=lum='80+170*random(1)',gblur=sigma=1.5", "-frames:v", "1", tex]);
    // A grey field; the textured square at x=200 until 4 s, then at x=240 (40 px at 640 = 60 px at the preview's 960).
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x202020:s=640x360:r=30:d=${SECONDS}`, "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", tex, "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", "[0][1]overlay=x='if(lt(t,4),200,240)':y=120:format=auto,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 3, label: "" }, { id: "b", start: 5, end: 7, label: "" }] }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`) };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { file: files.output, plan };
  };
  /** Where the square is in frame n: the middle of the columns that differ from the grey field, and how many there are. */
  const square = async (file: string, n: number) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${n}),format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    const cols: number[] = [];
    for (let x = 0; x < W; x++) { let d = 0; for (let y = 200; y < 340; y += 4) d += Math.abs(raw[y * W + x] - 32); if (d / 35 > 25) cols.push(x); }
    return { mid: cols.length ? (cols[0] + cols[cols.length - 1]) / 2 : -1, width: cols.length ? cols[cols.length - 1] - cols[0] + 1 : 0 };
  };

  it("a plain cut jumps; a morph moves the square part of the way across in the middle of the window", async () => {
    const cut = await render(edit([]), "cut");
    const mo = await render(edit([{ op: "set_transition", clipId: "b", type: "morph", duration: 0.4 } as Op]), "morph");
    const t = mo.plan.transitions!.find((x) => x.type === "morph")!;
    assert.ok(t && t.end > t.start, "the morph is planned");
    const midFrame = Math.round(((t.start + t.end) / 2) * 30);
    const a = await square(cut.file, 30), b = await square(cut.file, 90), m = await square(mo.file, midFrame), c = await square(cut.file, midFrame);
    console.log(`square middle: A ${a.mid}, B ${b.mid}; at the window's middle (frame ${midFrame}) the cut shows ${c.mid}, the morph ${m.mid} (width ${m.width}, the square's ${a.width})`);
    assert.ok(Math.abs(b.mid - a.mid - 60) < 4, "the jump is 60 px");
    assert.ok(m.mid > a.mid + 15 && m.mid < b.mid - 15, "the morph shows it part of the way across");
    assert.ok(m.width < a.width + 30, "one square, not two");
    const lenA = (await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cut.file])).stdout.trim();
    const lenB = (await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mo.file])).stdout.trim();
    assert.ok(Math.abs(Number(lenA) - Number(lenB)) < 0.05, `as long (${lenA} and ${lenB})`);
  });
});
