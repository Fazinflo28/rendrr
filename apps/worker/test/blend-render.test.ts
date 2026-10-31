// Phase 4 rendered and read back: every blend mode, and opacity, on b-roll over the picture. The picture is four flat
// colour bands across, the b-roll four flat bands down: each of the 16 cells is one pair. Each cell of the file is
// compared with the W3C formula (what CSS mix-blend-mode draws in the editor) applied to the plain picture and the plain
// b-roll as they come out of the same render. Frames outside the b-roll's time are untouched. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, composite, BLEND_MODES, type BlendMode, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const MODES = BLEND_MODES.filter((m) => m !== "normal");
const SLOT = 0.5; // each mode's b-roll window, seconds
const SECONDS = 1 + MODES.length * SLOT + 1;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540;
// Bands in sRGB: dark, mid grey, a saturated orange, light blue (across for the picture, down for the b-roll).
const PIC = ["0x202020", "0x808080", "0xE07020", "0xA0C8F0"], LAYER = ["0x101010", "0x606060", "0xC0C0C0", "0x30A050"];

describe("blend modes, rendered", () => {
  let dir = "", main = "", leak = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "blend-render-"));
    main = join(dir, "main.mp4"); leak = join(dir, "leak.mp4");
    const bands = (cs: string[], across: boolean, d: number) => {
      const parts = cs.map((c, i) => `color=${c}:s=${across ? "160x360" : "640x90"}:r=30:d=${d}[c${i}]`).join(";");
      return `${parts};${cs.map((_, i) => `[c${i}]`).join("")}${across ? "hstack" : "vstack"}=inputs=4,format=yuv444p`;
    };
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", `${bands(PIC, true, SECONDS)},scale=out_color_matrix=bt709:out_range=tv[v]`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-map", "[v]", "-map", "0:a", ...enc, "-c:a", "aac", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", `${bands(LAYER, false, 4)},scale=out_color_matrix=bt709:out_range=tv[v]`, "-map", "[v]", ...enc, leak]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "leak" ? { id, name: "bands", seconds: 4, ready: true } : undefined) };
  const rgbAt = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  // The middle of cell (column i of the picture, row j of the b-roll), averaged over a 9 x 9 patch.
  const cell = (f: Buffer, i: number, j: number) => {
    const cx = Math.round((i + 0.5) * W / 4), cy = Math.round((j + 0.5) * H / 4), out = [0, 0, 0];
    for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) for (let k = 0; k < 3; k++) out[k] += f[(y * W + x) * 3 + k] / 81;
    return out;
  };

  it("each mode equals the W3C formula on the plain picture and b-roll, cell by cell; outside its time nothing changes", async () => {
    let s: Snapshot = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "b", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] as never }, ctx).snap;
    // One plain b-roll window (to read the layer as it comes out), then each mode, then one at 50% normal.
    const windows: { mode: BlendMode | "plain" | "half"; at: number }[] = [{ mode: "plain", at: 0.25 }, ...MODES.map((m, i) => ({ mode: m, at: 1 + i * SLOT })), { mode: "half", at: SECONDS - 0.75 }];
    for (const w of windows) {
      s = applyOp(s, { op: "add_broll", videoId: "leak", start: w.at, end: w.at + (w.mode === "plain" ? 0.5 : w.mode === "half" ? 0.5 : SLOT), sourceStart: 0, edit: true } as Op, ctx).snap;
      const id = (s.timeline.tracks.v2 as { id: string }[]).at(-1)!.id;
      if (w.mode === "half") s = applyOp(s, { op: "set_blend", clipId: id, opacity: 0.5 } as Op, ctx).snap;
      else if (w.mode !== "plain") s = applyOp(s, { op: "set_blend", clipId: id, blend: w.mode } as Op, ctx).snap;
    }
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { leak: 4 } });
    const broll = Object.fromEntries((s.timeline.tracks.v2 as { id: string }[]).map((c) => [c.id, leak]));
    const files: PlanFiles = { source: main, output: join(dir, "out.mp4"), broll };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, "g.txt"), filterGraph);
    const t0 = Date.now();
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));
    console.log(`${MODES.length} modes rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const out = files.output;
    // The plain picture (between windows) and the plain b-roll (the first window, normal).
    const pic = await rgbAt(out, 0.85), lay = await rgbAt(out, 0.4);
    let worst = { d: 0, what: "" };
    const compare = async (mode: BlendMode, t: number, alpha: number) => {
      const f = await rgbAt(out, t);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const b = cell(pic, i, j), l = cell(lay, i, j), got = cell(f, i, j);
        for (let k = 0; k < 3; k++) {
          // The plain picture and b-roll are read from the encoded file (a few levels of compression noise), and dodge
          // and burn magnify that noise (they divide): the file must be within what the formula gives for inputs within
          // 3 levels of those read, plus 4.
          const at = (db: number, dl: number) => composite(mode, Math.min(1, Math.max(0, (b[k] + db) / 255)), Math.min(1, Math.max(0, (l[k] + dl) / 255)), alpha) * 255;
          const want = at(0, 0), span = [-3, 0, 3].flatMap((db) => [-3, 0, 3].map((dl) => at(db, dl)));
          const lo = Math.min(...span) - 4, hi = Math.max(...span) + 4, d = got[k] < lo ? lo - got[k] : got[k] > hi ? got[k] - hi : 0;
          if (Math.abs(got[k] - want) > worst.d) worst = { d: Math.abs(got[k] - want), what: `${mode} cell ${i},${j} channel ${k}: ${got[k].toFixed(1)} vs ${want.toFixed(1)}` };
          assert.ok(d === 0, `${mode} at cell ${i},${j} channel ${"rgb"[k]}: the file has ${got[k].toFixed(1)}, the formula ${want.toFixed(1)} (${lo.toFixed(1)}-${hi.toFixed(1)})`);
        }
      }
    };
    for (const w of windows) if (w.mode !== "plain" && w.mode !== "half") await compare(w.mode, w.at + SLOT / 2, 1);
    await compare("normal", SECONDS - 0.5, 0.5);
    console.log(`largest difference ${worst.d.toFixed(2)} of 255 (${worst.what})`);
    // Between two windows the picture is the plain picture.
    const gap = await rgbAt(out, SECONDS - 1.05 + 0.02), p0 = cell(pic, 2, 1), g0 = cell(gap, 2, 1);
    assert.ok(Math.abs(p0[0] - g0[0]) < 2 && Math.abs(p0[2] - g0[2]) < 2, "outside the windows nothing changes");
  });
});
