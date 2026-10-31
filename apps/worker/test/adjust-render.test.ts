// Phase 9 rendered and read back: an adjustment layer (darken 50 and saturation 0) over 3-5 s of an edit whose picture is
// flat grey, with orange b-roll at 4-6 s and a text box (magenta) on top the whole time. Under the layer the grey is half
// as bright and the b-roll grey (and darker); the text box stays magenta; before and after it nothing changes. Needs
// ffmpeg with libass.
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
const SECONDS = 8;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540;

describe("adjustment layers, rendered", () => {
  let dir = "", main = "", orange = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "adjust-render-"));
    main = join(dir, "main.mp4"); orange = join(dir, "orange.mp4");
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", "-colorspace", "bt709"];
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x808080:s=640x360:r=30:d=${SECONDS},format=yuv444p,scale=out_color_matrix=bt709:out_range=tv`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, ...enc, "-c:a", "aac", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0xE07020:s=640x360:r=30:d=4,format=yuv444p,scale=out_color_matrix=bt709:out_range=tv", ...enc, orange]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "orange" ? { id, name: "orange", seconds: 4, ready: true } : undefined) };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "a", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null },
    { op: "add_broll", videoId: "orange", start: 4, end: 6, sourceStart: 0, edit: true },
    { op: "add_text", text: "TEXT", start: 0.5, end: 7.5, edit: true, color: "#000000", box: { color: "#FF00FF", opacity: 1, padding: 24 }, x: 0.2, y: 0.5, anim: "none" },
    ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { orange: 4 } });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const broll = Object.fromEntries((s.timeline.tracks.v2 as { id: string }[]).map((c) => [c.id, orange]));
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks, broll, assPath: join(dir, `${name}.ass`) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: files.output, plan };
  };
  const rgbAt = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  const patch = (f: Buffer, cx: number, cy: number) => { const o = [0, 0, 0]; for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) for (let k = 0; k < 3; k++) o[k] += f[(y * W + x) * 3 + k] / 49; return o.map(Math.round); };
  /** Where the magenta box is: the middle of its pixels. */
  const boxAt = (f: Buffer) => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 3; if (f[i] > 200 && f[i + 1] < 60 && f[i + 2] > 200) { sx += x; sy += y; n++; } }
    return n ? [Math.round(sx / n), Math.round(sy / n), n] : null;
  };

  it("under the layer: the picture darker, the b-roll grey; the text on top as it was; before and after, nothing changes", async () => {
    const { out, plan } = await render(edit([{ op: "adjustment_layer", start: 3, end: 5, edit: true, grade: { saturation: 0 }, effects: [{ type: "darken", amount: 50 }] } as Op]), "adjust");
    assert.ok(plan.operations.join("\n").includes("Adjustment layers: 0:03-0:05"));
    const f2 = await rgbAt(out, 2), f35 = await rgbAt(out, 3.5), f45 = await rgbAt(out, 4.5), f55 = await rgbAt(out, 5.5), f65 = await rgbAt(out, 6.5);
    const box = boxAt(f2);
    assert.ok(box, "the text box shows");
    // A spot of the picture away from the text box (right half).
    const spot = (f: Buffer) => patch(f, Math.round(W * 0.75), Math.round(H * 0.3));
    const inBox = (f: Buffer) => { const [x0, y0] = box!; return patch(f, x0, Math.round(y0 - 0.02 * H)); };
    console.log(`picture: ${spot(f2)} before, ${spot(f35)} under the layer, ${spot(f65)} after; b-roll ${spot(f45)} under the layer, ${spot(f55)} after; text box ${inBox(f2)} before, ${inBox(f35)} under`);
    const mean = (p: number[]) => (p[0] + p[1] + p[2]) / 3;
    assert.ok(Math.abs(mean(spot(f2)) - 128) < 4 && Math.abs(mean(spot(f65)) - 128) < 4, "before and after: the grey as it is");
    assert.ok(Math.abs(mean(spot(f35)) / mean(spot(f2)) - 0.5) < 0.05, "under the layer: half as bright");
    const br = spot(f45), plain = spot(f55);
    assert.ok(plain[0] > 200 && plain[2] < 60, "after the layer the b-roll is orange");
    assert.ok(Math.max(...br) - Math.min(...br) < 6, `under the layer the b-roll is grey (${br})`);
    assert.ok(mean(br) < mean(plain) * 0.7, "and darker");
    const tb = inBox(f35);
    assert.ok(tb[0] > 220 && tb[1] < 40 && tb[2] > 220, `the text box stays magenta under the layer (${tb})`);
    assert.deepEqual(boxAt(f35)?.slice(0, 2), box!.slice(0, 2), "in the same place");
  });
});
