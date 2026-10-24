// Phase 5 rendered and read back: speed, a freeze, reverse, transitions, keyframes. The test footage shows its own
// frame number as two grey levels (left half: frame mod 50, right half: frame / 50), so every output frame says which
// source frame it shows. Its sound is a 440 Hz tone, so a sped-up clip can be checked for pitch. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, showAt, textLookAt, textRect, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
/** A command's stdout as bytes. */
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;

const SECONDS = 10;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const SW = 96, SH = 54; // frames are read back at this size

describe("speed, transitions and keyframes, rendered", () => {
  let dir = "", main = "", green = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "motion-render-"));
    main = join(dir, "main.mp4"); green = join(dir, "green.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SECONDS},geq=lum='if(lt(X,320),16+mod(N,50)*4,16+floor(N/50)*30)':cb=128:cr=128`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0x00FF00:s=640x360:r=30:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", green]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "g" ? { id: "g", name: "green", seconds: 4, ready: true } : undefined) };
  const edit = (ops: Op[]): Snapshot => {
    let s: Snapshot = { timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" };
    s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
    return s;
  };
  async function render(plan: RenderPlan, name: string, files: Partial<PlanFiles> = {}) {
    const all: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), assPath: join(dir, `${name}.ass`), fontsDir: join(process.cwd(), "../web/public/fonts"), ...files };
    if (plan.ass) await writeFile(all.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, all, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    const t0 = Date.now();
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    console.log(`${name}: rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return all.output;
  }
  /** Every frame's luma at SW x SH. */
  const lumas = async (file: string) => await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${SW}:${SH}:flags=area`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
  // Grey output is full range; the footage was made in TV range (16-235).
const px = (buf: Buffer, k: number, x: number, y: number) => 16 + (buf[k * SW * SH + y * SW + x] * 219) / 255;
  /** The source frame a frame shows, read from its grey levels at (xl, y) and (xr, y). */
  const shown = (buf: Buffer, k: number, xl = 24, xr = 72, y = 27) => 50 * Math.round((px(buf, k, xr, y) - 16) / 30) + Math.round((px(buf, k, xl, y) - 16) / 4);
  const duration = async (file: string, stream: "v" | "a") => Number((await run("ffprobe", ["-v", "error", "-select_streams", `${stream}:0`, "-show_entries", "stream=duration", "-of", "csv=p=0", file])).stdout.trim());
  /** Sound in [from, from+len): its level, and its pitch from zero crossings. */
  const sound = async (file: string, from: number, len: number) => {
    const pcm = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(from), "-t", String(len), "-i", file, "-ac", "1", "-f", "f32le", "-ar", "48000", "pipe:1"]);
    const x = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    let cross = 0, sum = 0;
    for (let i = 1; i < x.length; i++) { if ((x[i - 1] < 0) !== (x[i] < 0)) cross++; sum += x[i] * x[i]; }
    return { hz: cross / 2 / (x.length / 48000), db: 10 * Math.log10(sum / Math.max(1, x.length) + 1e-12) };
  };

  // V1: normal, 2x, a freeze, reversed, then cuts with a dissolve, a dip to black, keyframes, a whip, a slide, a zoom.
  const OPS: Op[] = [
    { op: "set_clips", track: "v1", clips: [
      { id: "c1", start: 0, end: 1, label: "" }, { id: "c2", start: 1, end: 3, label: "" }, { id: "c3", start: 4, end: 5.5, label: "" },
      { id: "c4", start: 6, end: 7, label: "" }, { id: "c5", start: 7.5, end: 8.5, label: "" }, { id: "c6", start: 2, end: 3, label: "" },
      { id: "c7", start: 8.5, end: 9.5, label: "" }, { id: "c8", start: 0.5, end: 1.5, label: "" }, { id: "c9", start: 3, end: 4, label: "" },
    ] } as Op,
    { op: "set_speed", clipId: "c2", speed: 2 },
    { op: "freeze_frame", clipId: "c2", at: 3, length: 0.5 },
    { op: "set_speed", clipId: "c3", reverse: true },
    { op: "set_transition", clipId: "c4", type: "dissolve", duration: 0.4 },
    { op: "set_transition", clipId: "c5", type: "dip-black", duration: 0.4 },
    { op: "set_keyframes", clipId: "c6", keys: [{ t: 0, scale: 0.5 }] },
    { op: "set_transition", clipId: "c7", type: "whip", duration: 0.3 },
    { op: "set_transition", clipId: "c8", type: "slide", duration: 0.4, dir: "left" },
    { op: "set_transition", clipId: "c9", type: "zoom", duration: 0.4 },
  ];

  let plan: RenderPlan, file = "", Y: Buffer;
  it("renders to exactly the planned length, picture and sound", async () => {
    plan = planRender({ kind: "preview", snapshot: edit(OPS), transcript: [], source, videoId: "v" });
    assert.equal(plan.outputSeconds, 10);
    file = await render(plan, "seq");
    Y = await lumas(file);
    assert.equal(Y.length / (SW * SH), 300, "300 frames");
    assert.ok(Math.abs((await duration(file, "a")) - 10) < 0.05, "sound as long as the picture");
    console.log("SHOWN " + Array.from({ length: 300 }, (_, k) => shown(Y, k)).join(","));
    console.log(JSON.stringify(plan.parts.map((p) => [p.srcIn.toFixed(3), p.srcOut.toFixed(3), p.start.toFixed(3), p.end.toFixed(3), p.rate ?? 1])));
    console.log(plan.operations.filter((l) => /^(Speed|Transitions|Keyframes)/.test(l)).join("\n"));
  });

  it("a 2x clip shows every other frame, and its sound keeps its pitch", async () => {
    const off: string[] = [];
    // The player shows the same frames (showAt: the middle of each output frame).
    const part = plan.parts.find((p) => p.rate === 2)!;
    for (let k = 30; k < 60; k++) { const want = Math.floor(showAt(part, (k + 0.01) / 30) * 30); if (shown(Y, k) !== want) off.push(`${k}: file ${shown(Y, k)}, player ${want}`); }
    assert.deepEqual(off, [], "frames 30-59 show the frames the player shows (source 31, 33, … 89)");
    const s = await sound(file, 1.1, 0.8);
    assert.ok(Math.abs(s.hz - 440) < 15, `pitch ${s.hz.toFixed(0)} Hz (440 kept)`);
    assert.ok(s.db > -30, `sound plays (${s.db.toFixed(1)} dB; the tone is -21 dB)`);
  });

  it("a freeze holds one frame, silent", async () => {
    const f = new Set<number>();
    for (let k = 60; k < 75; k++) f.add(shown(Y, k));
    assert.equal(f.size, 1, `one frame held (${[...f].join(",")})`);
    assert.ok(Math.abs([...f][0] - 89) <= 1, `the clip's last frame (${[...f][0]})`);
    assert.ok((await sound(file, 2.05, 0.4)).db < -60, "silent");
  });

  it("a reversed clip plays its frames backwards, silent", async () => {
    const off: string[] = [];
    const part = plan.parts.find((p) => p.rate === -1)!;
    for (let k = 75; k < 114; k++) { const want = Math.floor(showAt(part, (k + 0.01) / 30) * 30); if (shown(Y, k) !== 164 - (k - 75) || want !== shown(Y, k)) off.push(`${k}: file ${shown(Y, k)}, player ${want}`); }
    assert.deepEqual(off, [], "frames 75-113 show source 164, 163, …");
    assert.ok((await sound(file, 2.6, 1.0)).db < -60, "silent");
  });

  it("a dissolve mixes both sides; a dip goes to black at the cut", () => {
    // At the dissolve's middle (edit 4.0): the reversed clip continued (frame 119) and the next clip (frame 180), half each.
    const l = px(Y, 120, 24, 27), r = px(Y, 120, 72, 27);
    assert.ok(Math.abs(l - (92 + 136) / 2) <= 5 && Math.abs(r - (76 + 106) / 2) <= 5, `dissolve middle ${l}/${r}, want ${(92 + 136) / 2}/${(76 + 106) / 2}`);
    assert.ok(px(Y, 150, 24, 27) <= 20 && px(Y, 150, 72, 27) <= 20, `black at the dip's cut (${px(Y, 150, 24, 27)})`);
    assert.ok(Math.abs(shown(Y, 160) - (225 + 10)) <= 1, "after the dip, the next clip");
  });

  it("keyframes scale the picture about its centre over black", () => {
    const k = 195; // c6, half size
    assert.ok(px(Y, k, 4, 4) <= 20 && px(Y, k, 91, 49) <= 20, "black around");
    assert.ok(Math.abs(shown(Y, k, 36, 60) - (60 + 15)) <= 1, `the half-size picture shows its frame (${shown(Y, k, 36, 60)})`);
  });

  it("a slide has the next clip halfway in at the cut", () => {
    // Edit 8.0: the clip before (c7, frame 285) on the left, the next clip (c8, frame 15) slid half in from the right.
    assert.ok(Math.abs(px(Y, 240, 24, 27) - 156) <= 5, `left: the clip before (${px(Y, 240, 24, 27)})`);
    assert.ok(Math.abs(px(Y, 240, 72, 27) - 76) <= 5, `right: the next clip's left half (${px(Y, 240, 72, 27)})`);
  });

  it("a speed ramp: steps whose frames move forward faster and faster; its sound keeps its pitch and its length", async () => {
    const p = planRender({ kind: "preview", snapshot: edit([
      { op: "set_clips", track: "v1", clips: [{ id: "r", start: 1, end: 7, label: "" }] } as Op,
      { op: "set_speed", clipId: "r", ramp: [{ at: 1, speed: 1 }, { at: 7, speed: 3 }] },
    ]), transcript: [], source, videoId: "v" });
    const out = await render(p, "ramp");
    const y = await lumas(out);
    const n = Math.round(p.outputSeconds * 30);
    assert.equal(y.length / (SW * SH), n);
    const seen = Array.from({ length: n }, (_, k) => shown(y, k));
    const steps = seen.slice(1).map((v, k) => v - seen[k]);
    assert.ok(steps.every((d) => d >= 0 && d <= 4), `frames move forward (${steps.join(",")})`);
    assert.ok(steps.slice(0, 10).reduce((a, b) => a + b, 0) < steps.slice(-10).reduce((a, b) => a + b, 0), "faster at the end");
    // The player shows the same frames.
    const off = seen.map((v, k) => { const part = p.parts.find((x) => x.start <= (k + 0.01) / 30 && x.end > (k + 0.01) / 30)!; return Math.floor(showAt(part, (k + 0.01) / 30) * 30) === v ? null : `${k}: file ${v}`; }).filter(Boolean);
    assert.deepEqual(off, [], "every ramp frame is the one the player shows");
    assert.ok(Math.abs((await duration(out, "a")) - p.outputSeconds) < 0.05, "sound as long as the picture");
    for (const [from, len] of [[0.3, 0.6], [p.outputSeconds - 0.9, 0.6]]) {
      const s = await sound(out, from, len);
      assert.ok(Math.abs(s.hz - 440) < 20 && s.db > -30, `pitch ${s.hz.toFixed(0)} Hz at ${from.toFixed(1)}s (${s.db.toFixed(1)} dB)`);
    }
  });

  it("text and b-roll keyframes: the text moves where textLookAt says, the b-roll is a moving picture-in-picture", async () => {
    const snap = edit([
      { op: "set_clips", track: "v1", clips: [{ id: "c1", start: 0, end: 4, label: "" }] } as Op,
      { op: "add_text", text: "MOVE", start: 0, end: 3, edit: true, color: "#000000", box: { color: "#FF00FF", opacity: 1, padding: 20 }, x: 0.2, y: 0.5, anim: "none" } as Op,
      { op: "add_broll", videoId: "g", start: 0, end: 3, sourceStart: 0, edit: true } as Op,
    ]);
    const tid = snap.timeline.tracks.v3.find((c) => (c as { kind?: string }).kind === "text")!.id, bid = snap.timeline.tracks.v2[0].id;
    const s2 = applyOp(snap, { op: "batch", ops: [
      { op: "set_keyframes", track: "v3", clipId: tid, keys: [{ t: 0, x: 0, rotation: 0 }, { t: 2, x: 0.6, rotation: 0, ease: "in-out" }] },
      { op: "set_keyframes", track: "v2", clipId: bid, keys: [{ t: 0, scale: 0.3, x: -0.3, y: -0.3 }, { t: 2, scale: 0.3, x: 0.3, y: 0.3 }] },
    ] as never }, ctx).snap;
    const p = planRender({ kind: "preview", snapshot: s2, transcript: [], source, videoId: "v", brollSeconds: { g: 4 } });
    const out = await render(p, "keys", { broll: { [bid]: green } });
    const rgb = async (t: number) => await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    const W = p.width, H = p.height;
    const box = (buf: Buffer, c: [number, number, number]) => {
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (Math.abs(buf[i] - c[0]) < 60 && Math.abs(buf[i + 1] - c[1]) < 60 && Math.abs(buf[i + 2] - c[2]) < 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
      return x1 < 0 ? null : { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const layer = p.texts![0];
    for (const t of [0.5, 1.0, 1.5]) {
      const f = await rgb(t);
      const want = textLookAt(layer, t - layer.start, W, H), rect = textRect(layer, W, H);
      const got = box(f, [255, 0, 255])!;
      assert.ok(got && Math.abs(got.cx - (want.x + rect.x + rect.w / 2 - layer.style.x * W)) <= 4, `text at ${t}s: centre ${got?.cx.toFixed(1)}, want ${(want.x + rect.x + rect.w / 2 - layer.style.x * W).toFixed(1)}`);
      // The b-roll: 30% of the frame, its centre moving from (-0.3, -0.3) to (0.3, 0.3) of the frame, linearly.
      const g = box(f, [0, 255, 0])!;
      const u = Math.min(1, t / 2), cx = W / 2 + (-0.3 + 0.6 * u) * W, cy = H / 2 + (-0.3 + 0.6 * u) * H;
      assert.ok(g && Math.abs(g.cx - cx) <= 3 && Math.abs(g.cy - cy) <= 3 && Math.abs(g.w - 0.3 * W) <= 4, `b-roll at ${t}s: ${g?.cx.toFixed(0)},${g?.cy.toFixed(0)} ${g?.w}px, want ${cx.toFixed(0)},${cy.toFixed(0)} ${(0.3 * W).toFixed(0)}px`);
    }
  });
});
