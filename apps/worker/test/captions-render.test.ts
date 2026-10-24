// Phase 4 captions and text, rendered and read back: the caption box and a text layer's box land where the shared
// layout says (the editor draws from the same layout), the spoken word is coloured, and libass uses the bundled font
// itself (no fallback). Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, buildTranscript, captionRect, drawnOf, STYLES, textRect, textWidth, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 6;
const FONTS = fileURLToPath(new URL("../../web/public/fonts", import.meta.url));
const WORDS = ["Big", "bold", "captions", "in", "yellow", "on", "any", "video", "you", "edit"];
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.5 + i * 0.5 + 0.4 }))], { maxWordsPerLine: 12 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: false };

/** Bounding box of the pixels near a colour in an RGB frame. */
function bbox(px: Buffer, W: number, H: number, rgb: [number, number, number], tol = 50) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0, sx = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (Math.abs(px[i] - rgb[0]) < tol && Math.abs(px[i + 1] - rgb[1]) < tol && Math.abs(px[i + 2] - rgb[2]) < tol) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); n++; sx += x; }
  }
  return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n, cx: sx / n } : null;
}

describe("captions and text layers, rendered", () => {
  let dir = "", src = "", out = "", plan: RenderPlan, log = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "captions-render-"));
    src = join(dir, "gray.mp4"); out = join(dir, "out.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x404040:s=640x360:r=30:d=${SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", src]);
    const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: SECONDS, getStyle: (id) => STYLES.find((s) => s.id === id) };
    let s: Snapshot = { timeline: buildInitialTimeline(tr, SECONDS, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" };
    const ops: Op[] = [
      { op: "set_caption_style", font: "Montserrat", weight: 900, size: 8, color: "#FFFFFF", highlight: "#FFD400", box: { color: "#FF00FF", opacity: 1, padding: 20 }, wordsAtOnce: 3, wordsPerLine: 3, lines: 1, y: 0.85 } as Op,
      { op: "add_text", text: "TITLE HERE", start: 0.2, end: 5.8, edit: true, preset: "callout", color: "#000000", box: { color: "#00FFFF", opacity: 1, padding: 20 }, y: 0.2, anim: "none" } as Op,
    ];
    s = applyOp(s, { op: "batch", ops: ops as never }, ctx).snap;
    plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    const files: PlanFiles = { source: src, output: out, assPath: join(dir, "c.ass"), fontsDir: FONTS };
    await writeFile(files.assPath!, plan.ass!);
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0 });
    await writeFile(join(dir, "g.txt"), filterGraph);
    const r = await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a === "error" ? "verbose" : a)));
    log = r.stderr;
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });
  const frame = async (t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 64 << 20 })).stdout as Buffer;

  it("libass uses the bundled fonts by their own names", () => {
    assert.match(log, /fontselect: \(RC Montserrat 900, 400, 0\) -> RCMontserrat900/);
    assert.match(log, /fontselect: \(RC Inter 800, 400, 0\) -> RCInter800/);
  });

  it("the caption box and the text box land where the layout says (the editor draws the same)", async () => {
    const c = plan.styledCaptions![0];
    const px = await raw((c.start + c.end) / 2);
    const capBox = bbox(px, plan.width, plan.height, [255, 0, 255])!;
    const want = captionRect(c, plan.captionStyle!, plan.width, plan.height);
    const show = (a: Record<string, number>, b: Record<string, number>) => ["x", "y", "w", "h"].map((k) => `${k} ${a[k]}/${b[k].toFixed(1)}`).join(" ");
    for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(capBox[k] - want[k]) <= 6, `caption box (file/layout): ${show(capBox, want)}`);
    const t = plan.texts![0];
    const textBox = bbox(px, plan.width, plan.height, [0, 255, 255])!;
    const tw = textRect(t, plan.width, plan.height);
    for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(textBox[k] - tw[k]) <= 6, `text box (file/layout): ${show(textBox, tw)}`);
    console.log(`caption box (file/layout): ${show(capBox, want)} | text box: ${show(textBox, tw)}`);
  });

  it("the spoken word is coloured, and the colour moves word by word", async () => {
    const c = plan.styledCaptions![0], s = plan.captionStyle!, d = drawnOf(s, plan.width, plan.height);
    const line = c.lines[0].map((w) => w.text), full = textWidth(line.join(" "), d.face, d.size);
    const spanOf = (k: number) => { const a = s.x * plan.width - full / 2 + textWidth(line.slice(0, k).join(" ") + (k ? " " : ""), d.face, d.size); return [a, a + textWidth(line[k], d.face, d.size)]; };
    for (let k = 0; k < line.length; k++) {
      const w0 = c.lines[0][k].start, w1 = k + 1 < line.length ? c.lines[0][k + 1].start : c.end;
      const yellow = bbox(await raw((w0 + w1) / 2), plan.width, plan.height, [255, 212, 0], 40);
      assert.ok(yellow, `word ${k} "${line[k]}" has yellow pixels`);
      const [a, b] = spanOf(k);
      assert.ok(yellow!.cx > a - 2 && yellow!.cx < b + 2, `word ${k} "${line[k]}": yellow at ${yellow!.cx.toFixed(0)}, the word spans ${a.toFixed(0)}-${b.toFixed(0)}`);
    }
  });
  const raw = (t: number) => frame(t);
});
