// A talking head as a card on a background, rendered and read back: the footage shrunk and placed (set_framing),
// drawn as a card (set_card: rounded corners, drop shadow, white border) on a pink gradient (set_background). The file
// is compared with the same picture made from the shared maths (the gradient, the card's mask, shadow and border:
// what the editor's player draws). Then a library video and the clip's own blurred picture as the background, and a
// crop. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, cardBorderPicture, cardScreenBox, cardShadowPicture, gradientPicture, maskPicture, masksWithCard, type CardLook, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;

const SECONDS = 3;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const BLUE: [number, number, number] = [60, 120, 216];

describe("a card on a background, rendered", () => {
  let dir = "", main = "", red = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "card-render-"));
    main = join(dir, "main.mp4"); red = join(dir, "red.mp4");
    // Flat footage (one colour: the fit and the compression do not move it), and a red library video.
    for (const [file, hex, d] of [[main, "3C78D8", SECONDS], [red, "D02020", 1.5]] as const)
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x${hex}:s=640x360:r=30:d=${d},format=gbrp`, "-f", "lavfi", "-i", `sine=f=440:d=${d}:sample_rate=48000`,
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "2", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-shortest", file]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "red" ? { id: "red", name: "red loop", seconds: 1.5, ready: true } : undefined) };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "c", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_aspect", aspect: "9:16" }, ...ops] as never }, ctx).snap;
  async function render(plan: RenderPlan, name: string, files: Partial<PlanFiles> = {}) {
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan)); looks[n] = p; }
    const all: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), looks, ...files };
    const { args, filterGraph } = ffmpegArgs(plan, all, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return all.output;
  }
  const rgbAt = (file: string, t: number) => bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp,format=rgb24", "-f", "rawvideo", "pipe:1"]);

  const CARD: CardLook = { radius: 0.12, shadow: { opacity: 0.6, blur: 0.03, y: 0.02 }, border: { color: "#FFFFFF", width: 0.01 } };
  const FRAMING = { scale: 0.6, x: 0, y: 0.15 };
  const GRAD = { from: "#FF66AA", to: "#FFE0F0", angle: 160 };

  it("the card, its shadow and border on the gradient match the shared maths (what the player draws)", async () => {
    const snap = edit([{ op: "set_framing", ...FRAMING } as Op, { op: "set_card", ...CARD } as Op, { op: "set_background", gradient: GRAD } as Op]);
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" });
    const W = plan.width, H = plan.height;
    assert.ok(H > W, `9:16 (${W}x${H})`);
    assert.ok(plan.operations.some((o) => o.startsWith("Cards: ")) && plan.operations.some((o) => o.startsWith("Behind V1: gradient #FF66AA")), plan.operations.join(" | "));
    const out = await render(plan, "card");
    const px = await rgbAt(out, 1.5);
    // The same picture from the shared maths: gradient, shadow, the card (footage inside its mask), border.
    const grad = gradientPicture(GRAD, W, H), sh = cardShadowPicture(CARD, FRAMING, W, H), bd = cardBorderPicture(CARD, FRAMING, W, H);
    const mask = maskPicture(masksWithCard(undefined, CARD)!, W, H), box = cardScreenBox(CARD, FRAMING, W, H);
    const sw = Math.max(2, Math.round((W * 0.6) / 2) * 2), sh2 = Math.max(2, Math.round((H * 0.6) / 2) * 2), ox = Math.round((W - sw) / 2), oy = Math.round((H - sh2) / 2 + 0.15 * H);
    const want = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c = [grad[i * 3], grad[i * 3 + 1], grad[i * 3 + 2]];
      const a = sh[i] / 255; c = c.map((v) => v * (1 - a));
      // The card: the mask at the fitted picture's matching point (scaled by the framing).
      const fx = Math.floor(((x - ox + 0.5) / sw) * W), fy = Math.floor(((y - oy + 0.5) / sh2) * H);
      if (fx >= 0 && fy >= 0 && fx < W && fy < H && x >= ox && y >= oy && x < ox + sw && y < oy + sh2) { const m = mask[fy * W + fx] / 255; c = c.map((v, k) => v * (1 - m) + BLUE[k] * m); }
      const b = bd[i] / 255; c = c.map((v) => v * (1 - b) + 255 * b);
      want.set(c, i * 3);
    }
    // Compared in 12 x 12 blocks (compression noise and the scaler's sub-pixel differences average out).
    let worst = 0, sum = 0, n = 0;
    for (let by = 0; by + 12 <= H; by += 12) for (let bx = 0; bx + 12 <= W; bx += 12) for (let k = 0; k < 3; k++) {
      let a = 0, b = 0;
      for (let y = by; y < by + 12; y++) for (let x = bx; x < bx + 12; x++) { a += px[(y * W + x) * 3 + k]; b += want[(y * W + x) * 3 + k]; }
      const d = Math.abs(a - b) / 144; worst = Math.max(worst, d); sum += d; n++;
    }
    console.log(`card on gradient: mean ${(sum / n).toFixed(2)}, worst block ${worst.toFixed(1)} levels`);
    assert.ok(sum / n < 2.5, `mean ${(sum / n).toFixed(2)} levels`);
    assert.ok(worst < 40, `worst block ${worst.toFixed(1)} levels (edges)`);
    // Spot checks: the gradient in a corner of the frame, footage in the card, background in the card's rounded
    // corner, white on its border, darker under it (the shadow).
    const at = (x: number, y: number) => Array.from(px.subarray((Math.round(y) * W + Math.round(x)) * 3, (Math.round(y) * W + Math.round(x)) * 3 + 3));
    const near = (a: number[], b: number[], tol: number) => a.every((v, k) => Math.abs(v - b[k]) <= tol);
    assert.ok(near(at(4, 4), Array.from(grad.subarray(4 * W * 3 + 12, 4 * W * 3 + 15)), 6), `frame corner is the gradient (${at(4, 4)})`);
    assert.ok(near(at(box.x + box.w / 2, box.y + box.h / 2), BLUE, 6), `card centre is the footage (${at(box.x + box.w / 2, box.y + box.h / 2)})`);
    const corner = at(box.x + 2, box.y + 2);
    assert.ok(!near(corner, BLUE, 30) && corner[0] > 200, `the card's corner is rounded away (${corner})`);
    assert.ok(near(at(box.x + box.w / 2, box.y + 1), [255, 255, 255], 30), `border on the top edge (${at(box.x + box.w / 2, box.y + 1)})`);
    const below = at(box.x + box.w / 2, box.y + box.h + 0.012 * W), open = at(box.x + box.w / 2, Math.min(H - 2, box.y + box.h + 0.15 * W));
    assert.ok(below[0] < open[0] - 20, `shadow under the card (${below} vs ${open})`);
  });

  it("a library video behind V1 (looped), and the clip's own picture blurred", async () => {
    const vid = edit([{ op: "set_framing", ...FRAMING } as Op, { op: "set_card", radius: 0.1 } as Op, { op: "set_background", videoId: "red" } as Op]);
    const plan = planRender({ kind: "preview", snapshot: vid, transcript: [], source, videoId: "v", brollSeconds: { red: 1.5 } });
    assert.equal(plan.background?.videoId, "red");
    const out = await render(plan, "bgvideo", { background: red });
    for (const t of [0.5, 2.5]) { // 2.5 s: the 1.5 s video has looped
      const px = await rgbAt(out, t);
      const c = Array.from(px.subarray(12 * 3 + 12 * plan.width * 3, 12 * 3 + 12 * plan.width * 3 + 3));
      assert.ok(c[0] > 180 && c[1] < 60 && c[2] < 60, `red behind V1 at ${t}s (${c})`);
    }
    const blur = edit([{ op: "set_framing", ...FRAMING } as Op, { op: "set_background", blur: 60 } as Op]);
    const bp = planRender({ kind: "preview", snapshot: blur, transcript: [], source, videoId: "v" });
    const px = await rgbAt(await render(bp, "bgblur"), 1);
    const c = Array.from(px.subarray(12 * 3 + 12 * bp.width * 3, 12 * 3 + 12 * bp.width * 3 + 3));
    assert.ok(c.every((v, k) => Math.abs(v - BLUE[k]) <= 8), `the footage, blurred, fills the frame behind it (${c})`);
  });

  it("two clips framed apart (each part drawn on its own): each card has its shadow, border and the background", async () => {
    const snap = edit([
      { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 1.5, label: "" }, { id: "b", start: 1.5, end: 3, label: "" }] } as Op,
      { op: "set_framing", clipIds: ["a"], scale: 0.5, y: -0.2 } as Op, { op: "set_framing", clipIds: ["b"], scale: 0.5, y: 0.2 } as Op,
      { op: "set_card", clipIds: ["a", "b"], ...CARD } as Op, { op: "set_background", color: "#F0C8DC" } as Op]);
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" });
    assert.equal(plan.parts.length, 2);
    const W = plan.width, H = plan.height;
    const out = await render(plan, "parts");
    for (const [id, t, fr] of [["a", 0.7, { scale: 0.5, x: 0, y: -0.2 }], ["b", 2.2, { scale: 0.5, x: 0, y: 0.2 }]] as const) {
      const px = await rgbAt(out, t);
      const at = (x: number, y: number) => Array.from(px.subarray((Math.round(y) * W + Math.round(x)) * 3, (Math.round(y) * W + Math.round(x)) * 3 + 3));
      const box = cardScreenBox(CARD, fr, W, H);
      assert.ok(at(box.x + box.w / 2, box.y + box.h / 2).every((v, k) => Math.abs(v - BLUE[k]) <= 6), `${id}: the footage in its card`);
      assert.ok(at(box.x + box.w / 2, box.y + 1).every((v) => v > 225), `${id}: its border (${at(box.x + box.w / 2, box.y + 1)})`);
      const below = at(box.x + box.w / 2, box.y + box.h + 0.012 * W);
      assert.ok(below[0] < 200, `${id}: its shadow (${below})`);
      assert.ok(at(4, 4).every((v, k) => Math.abs(v - [240, 200, 220][k]) <= 6), `${id}: the background colour (${at(4, 4)})`);
    }
  });

  it("a crop cuts the card's sides in place; set_card null and set_background none undo them", async () => {
    const snap = edit([{ op: "set_card", crop: { left: 0.25, right: 0.25 } } as Op, { op: "set_background", color: "#102030" } as Op]);
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: [], source, videoId: "v" });
    const W = plan.width, H = plan.height;
    const px = await rgbAt(await render(plan, "crop"), 1);
    const at = (x: number, y: number) => Array.from(px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    assert.ok(at(Math.round(W * 0.1), H >> 1).every((v, k) => Math.abs(v - [16, 32, 48][k]) <= 6), `left quarter shows the background colour (${at(Math.round(W * 0.1), H >> 1)})`);
    assert.ok(at(W >> 1, H >> 1).every((v, k) => Math.abs(v - BLUE[k]) <= 6), `the middle keeps the footage (${at(W >> 1, H >> 1)})`);
    const undone = applyOp(snap, { op: "batch", ops: [{ op: "set_card", crop: null }, { op: "set_background", none: true }] } as never, ctx).snap;
    const tl = undone.timeline as unknown as { background?: unknown; tracks: { v1: { cardLook?: unknown }[] } };
    assert.equal(tl.background, undefined);
    assert.ok(tl.tracks.v1.every((c) => !c.cardLook));
  });
});
