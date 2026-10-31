// Object tracking rendered and measured: a textured square slides across a plain grey frame. The real tracker follows
// it from a box drawn at one moment; a blur that follows it (set_effects follow "object") is drawn over it in the
// render, frame by frame (the square loses its texture wherever it is, the grey around it is untouched), and a white
// text layer pinned to it (pin_layer) moves with it (the text's bright pixels keep their distance from the square).
// Needs ffmpeg and OpenCV.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { writeMoving } from "../src/lib/moving";
import { trackObject } from "../src/lib/track";

const execFileP = promisify(execFile);
const W = 640, H = 360, SECONDS = 8;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };
// The square's left edge at footage second t (pixels): 60 px, then 50 px a second; 96 px wide, 132 px down.
const sqX = (t: number) => 60 + 50 * t, SQ = 96, SQY = 132;

describe("object tracking, rendered", () => {
  let dir = "", clip = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "track-render-"));
    const tex = join(dir, "tex.png");
    clip = join(dir, "clip.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `nullsrc=s=${SQ}x${SQ}:d=1,format=gray,geq=lum='255*random(1)',gblur=sigma=0.8,eq=contrast=2.5`, "-frames:v", "1", tex]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x606060:s=${W}x${H}:r=30:d=${SECONDS}`, "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", tex,
      "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", `[0:v][1:v]overlay=x='${sqX(0)}+50*t':y=${SQY}:shortest=1,format=yuv420p[v]`, "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-t", String(SECONDS), clip]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) {
      const p = join(dir, `${name}-${n}`);
      if (spec.kind === "moving") await writeMoving(spec, plan, p);
      else await writeFile(p, lookFileData(spec, plan, {}));
      looks[n] = p;
    }
    const files: PlanFiles = { source: clip, output: join(dir, `${name}.mp4`), looks, broll: {}, assPath: join(dir, `${name}.ass`), fontsDir: fileURLToPath(new URL("../../web/public/fonts", import.meta.url)) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", files.output, "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 29 })).stdout as Buffer;
    return { raw, frames: raw.length / (W * H), plan };
  };
  /** Texture inside a box of frame f (mean absolute difference between neighbouring pixels). */
  const texture = (raw: Buffer, f: number, x0: number, y0: number, w: number, h: number) => {
    let s = 0, n = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(1, x0); x < Math.min(W, x0 + w); x++) { s += Math.abs(raw[f * W * H + y * W + x] - raw[f * W * H + y * W + x - 1]); n++; }
    return s / Math.max(1, n);
  };

  it("a blur follows the square and a pinned text moves with it", async () => {
    // The edit: footage 1-7 s (edit 0-6 s). The box drawn round the square at footage 2 s.
    let s = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" },
      { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "c", start: 1, end: 7, label: "" }] }] } as never, ctx).snap;
    const plain = await render(s, "plain");
    const at = 2, box = { x: sqX(at) / W, y: SQY / H, w: SQ / W, h: SQ / H };
    const rows = await trackObject(clip, { from: 1, to: 7, at, box, w: W, h: H, rotate: 0, fitY: 0.4, dir });
    s = applyOp(s, { op: "track_object", clipId: "c", at, box, label: "square", rows } as Op, ctx).snap;
    s = applyOp(s, { op: "set_effects", clipId: "c", effects: [{ type: "blur", amount: 80, area: { shape: "rect", follow: "object", object: "o1" } }] } as Op, ctx).snap;
    // A text layer of white blocks above the square, over edit 0.5-5.5 s, pinned to it.
    s = applyOp(s, { op: "add_text", text: "HHHH", start: 0.5, end: 5.5, edit: true, x: (sqX(1.5) + SQ / 2) / W, y: (SQY - 40) / H, size: 8, color: "#FFFFFF", anim: "none" } as Op, ctx).snap;
    const textId = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "text")!.id;
    s = applyOp(s, { op: "pin_layer", clipId: textId, to: { clipId: "c", object: "o1" } } as Op, ctx).snap;
    const out = await render(s, "tracked");
    assert.equal(out.frames, plain.frames, "as long");
    // Frame by frame: edit second e shows footage 1 + e, the square at sqX(1 + e).
    const ins: number[] = [], plainIns: number[] = [], bgs: number[] = [], plainBgs: number[] = [], offs: number[] = [];
    for (const e of [0.3, 1.2, 2.5, 3.8, 5.1, 5.8]) {
      const f = Math.round(e * 30), x = Math.round(sqX(1 + e));
      ins.push(texture(out.raw, f, x + 12, SQY + 12, SQ - 24, SQ - 24)); plainIns.push(texture(plain.raw, f, x + 12, SQY + 12, SQ - 24, SQ - 24));
      // The grey well below the square: untouched.
      bgs.push(texture(out.raw, f, 0, SQY + SQ + 40, W, 40)); plainBgs.push(texture(plain.raw, f, 0, SQY + SQ + 40, W, 40));
      if (e >= 0.5 && e <= 5.5) {
        // The text's bright pixels (well above the square's grey): their centre against the square's.
        let sx = 0, n = 0;
        for (let y = 0; y < SQY - 4; y++) for (let xx = 0; xx < W; xx++) if (out.raw[f * W * H + y * W + xx] > 200) { sx += xx; n++; }
        if (n > 50) offs.push(sx / n - (x + SQ / 2));
      }
    }
    console.log(`texture inside the square: ${plainIns.map((v) => v.toFixed(1)).join(", ")} as filmed -> ${ins.map((v) => v.toFixed(1)).join(", ")} blurred; grey below ${plainBgs.map((v) => v.toFixed(2)).join("/")} -> ${bgs.map((v) => v.toFixed(2)).join("/")}; text centre against the square ${offs.map((v) => v.toFixed(1)).join(", ")} px`);
    for (let i = 0; i < ins.length; i++) assert.ok(ins[i] < plainIns[i] * 0.35, `the square is blurred wherever it is (${plainIns[i].toFixed(1)} -> ${ins[i].toFixed(1)} at sample ${i})`);
    for (let i = 0; i < bgs.length; i++) assert.ok(Math.abs(bgs[i] - plainBgs[i]) < 0.5, `the grey around it is untouched (sample ${i})`);
    assert.ok(offs.length >= 4, `the text is seen (${offs.length} samples)`);
    assert.ok(Math.max(...offs) - Math.min(...offs) < 8, `the pinned text keeps its place against the square (moves ${(Math.max(...offs) - Math.min(...offs)).toFixed(1)} px against it while the square moves 250 px)`);
  });
});
