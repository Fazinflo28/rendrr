// Phase 17 rendered and read back, on a flat grey picture: (1) a magenta text box turned a quarter clockwise about its
// left edge's middle lands where the player's numbers (textLookAt) put it; (2) a text box sweeping across with motion
// blur has edges smeared over its movement, without blur they are sharp; (3) an orange b-roll card with a white border:
// white just inside its edge, orange further in, the grey outside, and the border moves with the card's keys. Needs
// ffmpeg with libass.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, textLookAt, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 6;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const W = 960, H = 540;

describe("text anchor and motion blur, b-roll card border, rendered", () => {
  let dir = "", main = "", orange = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "phase17-render-"));
    main = join(dir, "main.mp4"); orange = join(dir, "orange.mp4");
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", "-colorspace", "bt709"];
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x808080:s=640x360:r=30:d=${SECONDS},format=yuv444p,scale=out_color_matrix=bt709:out_range=tv`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, ...enc, "-c:a", "aac", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0xE07020:s=640x360:r=30:d=4,format=yuv444p,scale=out_color_matrix=bt709:out_range=tv", ...enc, orange]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "orange" ? { id, name: "orange", seconds: 4, ready: true } : undefined) };
  const fresh = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "a", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] } as never, ctx).snap;
  const apply = (s: Snapshot, op: Op) => applyOp(s, op, ctx).snap;
  const box = { color: "#000000", box: { color: "#FF00FF", opacity: 1, padding: 24 }, anim: "none" };
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { orange: 4 } });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const textBlurs: Record<string, string> = {};
    for (const b of plan.textBlurs ?? []) { const p = join(dir, `${name}-blur-${b.clipId}.ass`); await writeFile(p, b.ass); textBlurs[b.clipId] = p; }
    const broll = Object.fromEntries((s.timeline.tracks.v2 as { id: string }[]).map((c) => [c.id, orange]));
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks, broll, textBlurs, assPath: join(dir, `${name}.ass`) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: files.output, plan };
  };
  const rgbAt = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  const px = (f: Buffer, x: number, y: number) => [0, 1, 2].map((k) => f[(Math.round(y) * W + Math.round(x)) * 3 + k]);
  /** How magenta each pixel is (0 grey, 1 magenta: green down from 128 to 0). */
  const mag = (f: Buffer, x: number, y: number) => Math.min(1, Math.max(0, (128 - f[(y * W + x) * 3 + 1]) / 128));
  const magentaBox = (f: Buffer) => {
    let sx = 0, sy = 0, n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mag(f, x, y) > 0.5) { sx += x; sy += y; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return n ? { cx: sx / n, cy: sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1, n, y0 } : null;
  };

  it("a text box turned about its left edge's middle lands where the player's numbers put it", async () => {
    let s = apply(fresh(), { op: "add_text", text: "TURN", start: 0.5, end: 5, edit: true, x: 0.5, y: 0.5, ...box } as Op);
    const id = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "text")!.id;
    s = apply(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 0, rotation: 0 }, { t: 0.5, rotation: 0 }, { t: 1.5, rotation: 90 }], anchor: { x: 0, y: 0.5 } } as Op);
    const { out, plan } = await render(s, "anchor");
    const t = plan.texts!.find((x) => x.clipId === id)!;
    const before = magentaBox(await rgbAt(out, 0.6))!, after = magentaBox(await rgbAt(out, 3))!;
    const want = textLookAt(t, 2.5, W, H);
    console.log(`box before: ${before.cx.toFixed(1)},${before.cy.toFixed(1)} ${before.w}x${before.h}; turned: ${after.cx.toFixed(1)},${after.cy.toFixed(1)} ${after.w}x${after.h}; the player's point: ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
    assert.ok(Math.abs(before.cx - 480) < 4 && Math.abs(before.cy - 270) < 4, "at rest: in the middle");
    assert.ok(Math.abs(after.w - before.h) < 6 && Math.abs(after.h - before.w) < 6, "turned a quarter (its width and height swapped)");
    assert.ok(Math.abs(after.cx - want.x) < 4 && Math.abs(after.cy - want.y) < 4, `its middle where the player puts it (${after.cx.toFixed(1)},${after.cy.toFixed(1)} vs ${want.x.toFixed(1)},${want.y.toFixed(1)})`);
    assert.ok(Math.abs(after.cx - (480 - before.w / 2)) < 6, "below the anchor (the box's left edge before)");
  });

  it("motion blur smears a sweeping text box's edges over its movement; without it they are sharp", async () => {
    const sweep = (blur: number) => {
      let s = apply(fresh(), { op: "add_text", text: "FAST", start: 1, end: 3, edit: true, x: 0.5, y: 0.5, ...box } as Op);
      const id = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "text")!.id;
      return apply(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 0, x: -0.4 }, { t: 1, x: 0.4 }], motionBlur: blur } as Op);
    };
    // Along a row in the box's padding (above the letters): how many columns are between the grey and the box's colour.
    const soft = async (file: string) => {
      const f = await rgbAt(file, 1.5), b = magentaBox(f)!, y = b.y0 + 6;
      const red = Array.from({ length: W }, (_, x) => Math.max(0, f[(y * W + x) * 3] - 128)), top = Math.max(...red);
      return red.filter((r) => r > 0.1 * top && r < 0.9 * top).length;
    };
    const sharp = await soft((await render(sweep(0), "sharp")).out);
    const { out, plan } = await render(sweep(100), "blurred");
    assert.equal(plan.textBlurs?.length, 1);
    const smeared = await soft(out);
    // 0.8 of the width a second: 25.6 px a frame; blur 100 averages 4 sub-frames, 6.4 px apart: about 19 px a side.
    console.log(`part-covered columns across the box: ${sharp} sharp, ${smeared} with motion blur 100`);
    assert.ok(sharp <= 6, `without blur the edges are sharp (${sharp})`);
    assert.ok(smeared >= 30, `with blur the edges are smeared (${smeared})`);
  });

  it("a b-roll card's border: white just inside its edge, orange further in, grey outside; it moves with the card", async () => {
    let s = apply(fresh(), { op: "add_broll", videoId: "orange", start: 1, end: 5, sourceStart: 0, edit: true } as Op);
    const id = (s.timeline.tracks.v2 as { id: string }[])[0].id;
    s = apply(s, { op: "set_card", clipIds: [id], crop: { left: 0.25, right: 0.25, top: 0.2, bottom: 0.2 }, border: { color: "#FFFFFF", width: 0.03 } } as Op);
    const { out } = await render(s, "border");
    const f = await rgbAt(out, 2), edge = W * 0.25, bw = 0.03 * H;
    const outside = px(f, edge - 8, H / 2), ring = px(f, edge + bw / 2, H / 2), inner = px(f, edge + bw + 20, H / 2);
    console.log(`outside ${outside}, in the border ${ring}, inside the card ${inner}`);
    assert.ok(outside.every((v) => Math.abs(v - 128) < 6), "outside the card: the picture under it");
    assert.ok(ring.every((v) => v > 240), "just inside the edge: the white border");
    assert.ok(inner[0] > 200 && inner[2] < 60, "further in: the orange b-roll");
    // With keys the border moves with the card: scaled to half about the middle, its left edge is at 3/8 of the width.
    const moved = apply(s, { op: "set_keyframes", track: "v2", clipId: id, keys: [{ t: 0, scale: 0.5 }] } as Op);
    const g = await rgbAt((await render(moved, "border-moved")).out, 2), e2 = W * 0.375;
    const ring2 = px(g, e2 + bw / 4, H / 2), out2 = px(g, e2 - 8, H / 2);
    console.log(`scaled to half: outside ${out2}, in the border ${ring2}`);
    assert.ok(ring2.every((v) => v > 220), "the border moved with the card");
    assert.ok(out2.every((v) => Math.abs(v - 128) < 8), "and outside it the picture");
  });
});
