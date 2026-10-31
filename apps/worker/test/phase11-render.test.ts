// Phase 11 rendered and measured: flip (V1 and b-roll), the anchor point (a clip scaled to half about its top left
// fills the top left quarter), motion blur (a fast-moving square's edge smeared over the distance it moves while the
// shutter is open), optical-flow slow motion (a moving bar at half speed steps evenly frame to frame instead of
// holding every other frame) and a b-roll card (cropped, the picture showing round it, its drop shadow under its
// edge). Needs ffmpeg.
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
const SECONDS = 6;
const W = 960, H = 540;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("Phase 11, rendered", () => {
  let dir = "";
  const files: Record<string, string> = {};
  const make = async (name: string, vf: string, seconds = SECONDS) => {
    const p = join(dir, `${name}.mp4`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${seconds}`, "-f", "lavfi", "-i", `sine=f=440:d=${seconds}:sample_rate=48000`, "-vf", `${vf},format=yuv420p`, "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-shortest", p]);
    files[name] = p;
  };
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "phase11-"));
    await make("halves", "geq=r='if(lt(X,320),220,30)':g='30':b='if(lt(X,320),30,220)'");
    await make("grey", "geq=lum='128':cb=128:cr=128");
    await make("square", "geq=lum='if(between(X,270,370)*between(Y,130,230),255,0)':cb=128:cr=128");
    // A bar 20 px wide moving right 6 px a frame.
    await make("bar", "geq=lum='if(between(X,40+6*N,60+6*N),255,0)':cb=128:cr=128");
    await make("updown", "geq=r='if(lt(Y,180),40,230)':g='if(lt(Y,180),200,220)':b='if(lt(Y,180),40,30)'", 4);
    await make("orange", "geq=r='224':g='112':b='32'", 4);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "updown" || id === "orange" ? { id, name: id, seconds: 4, ready: true } : undefined) };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "p", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, main: string, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { updown: 4, orange: 4 } });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const broll = Object.fromEntries((s.timeline.tracks.v2 as { id: string; videoId?: string }[]).filter((c) => c.videoId).map((c) => [c.id, files[c.videoId!]]));
    const pf: PlanFiles = { source: files[main], output: join(dir, `${name}.mp4`), looks, broll };
    const { args, filterGraph } = ffmpegArgs(plan, pf, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: pf.output, plan };
  };
  const frame = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  const frames = async (file: string, from: number, n: number) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", from.toFixed(3), "-i", file, "-frames:v", String(n), "-vf", "format=gray", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    return Array.from({ length: raw.length / (W * H) }, (_, i) => raw.subarray(i * W * H, (i + 1) * W * H));
  };
  const px = (f: Buffer, x: number, y: number) => { const o = (Math.round(y) * W + Math.round(x)) * 3; return [f[o], f[o + 1], f[o + 2]]; };
  const lum = (p: number[]) => (p[0] + p[1] + p[2]) / 3;

  it("flip: a V1 clip mirrored left to right, b-roll upside down", async () => {
    const plain = await frame((await render(edit([]), "halves", "flip0")).out, 1);
    const s = edit([{ op: "add_broll", videoId: "updown", start: 3, end: 5, sourceStart: 0, edit: true } as Op]);
    const id = (s.timeline.tracks.v2 as { id: string }[])[0].id;
    const { out } = await render(applyOp(applyOp(s, { op: "set_flip", clipIds: [(s.timeline.tracks.v1 as { id: string }[])[0].id], flip: "h" } as Op, ctx).snap, { op: "set_flip", clipId: id, flip: "v" } as Op, ctx).snap, "halves", "flip");
    const f1 = await frame(out, 1), f4 = await frame(out, 4);
    console.log(`left ${px(plain, 100, 270)} -> ${px(f1, 100, 270)}, right ${px(plain, 860, 270)} -> ${px(f1, 860, 270)}; b-roll top ${px(f4, 480, 60)}, bottom ${px(f4, 480, 480)}`);
    assert.ok(px(plain, 100, 270)[0] > 180 && px(f1, 100, 270)[2] > 180, "the left is now the right (blue)");
    assert.ok(px(f1, 860, 270)[0] > 180, "the right is now red");
    assert.ok(px(f4, 480, 60)[0] > 180 && px(f4, 480, 480)[0] < 80, "the b-roll's bottom (yellow) is on top");
  });

  it("anchor: scaled to half about the top left, the clip fills the top left quarter", async () => {
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    const keys = [{ t: 0, scale: 0.5 }, { t: 5, scale: 0.5 }];
    const mid = await frame((await render(edit([{ op: "set_keyframes", clipId: id, keys } as Op]), "grey", "anchor0")).out, 1);
    const tl = await frame((await render(edit([{ op: "set_keyframes", clipId: id, keys, anchor: { x: 0, y: 0 } } as Op]), "grey", "anchor")).out, 1);
    console.log(`middle anchor: corner ${lum(px(mid, 60, 40))}, centre ${lum(px(mid, 480, 270))}; top-left anchor: ${lum(px(tl, 60, 40))} top left, ${lum(px(tl, 420, 230))} inside, ${lum(px(tl, 700, 400))} bottom right`);
    assert.ok(lum(px(mid, 60, 40)) < 20 && lum(px(mid, 480, 270)) > 100, "about the middle: centred");
    assert.ok(lum(px(tl, 60, 40)) > 100 && lum(px(tl, 420, 230)) > 100, "about the top left: the top left quarter");
    assert.ok(lum(px(tl, 700, 400)) < 20 && lum(px(tl, 500, 270)) < 20, "the rest black");
  });

  it("motion blur: a fast-moving square's edge smears over the shutter's travel", async () => {
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    const keys = [{ t: 0, x: -0.3 }, { t: 1, x: 0.3 }];
    const edgeWidth = async (s: Snapshot, name: string) => {
      const f = (await frames((await render(s, "square", name)).out, 0.5, 1))[0];
      let n = 0; for (let x = 0; x < W; x++) { const v = f[270 * W + x]; if (v > 40 && v < 215) n++; }
      return n;
    };
    const sharp = await edgeWidth(edit([{ op: "set_keyframes", clipId: id, keys } as Op]), "mb0");
    const blurred = await edgeWidth(edit([{ op: "set_keyframes", clipId: id, keys, motionBlur: 100 } as Op]), "mb");
    console.log(`edge pixels between dark and bright: ${sharp} sharp, ${blurred} with motion blur 100 (the square moves 19 px a frame)`);
    assert.ok(sharp <= 6, "without blur the edges are sharp");
    assert.ok(blurred >= 18, "with blur both edges smear over about the travel");
  });

  it("optical flow: half speed steps evenly frame to frame; frame sampling holds every other frame", async () => {
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    const steps = async (interp: string, name: string) => {
      const fs = await frames((await render(edit([{ op: "set_speed", clipId: id, speed: 0.5, ...(interp ? { interp } : {}) } as Op]), "bar", name)).out, 1, 16);
      const xs = fs.map((f) => { let s = 0, w = 0; for (let x = 0; x < W; x++) { const v = f[270 * W + x]; if (v > 128) { s += x; w++; } } return w ? s / w : NaN; });
      return xs.slice(1).map((x, i) => Math.round((x - xs[i]) * 10) / 10);
    };
    const held = await steps("", "slow0"), flow = await steps("flow", "slow");
    console.log(`bar steps per frame: frame sampling ${held.join(" ")}; optical flow ${flow.join(" ")} (the bar moves 9 px a source frame)`);
    assert.ok(held.filter((d) => Math.abs(d) < 1).length >= 6, "frame sampling holds every other frame");
    assert.ok(flow.every((d) => d > 2.5 && d < 6.5), "optical flow moves it about 4.5 px every frame");
  });

  it("b-roll card: cropped (the picture round it), its drop shadow under its edge", async () => {
    const s0 = edit([{ op: "add_broll", videoId: "orange", start: 2, end: 4, sourceStart: 0, edit: true } as Op]);
    const id = (s0.timeline.tracks.v2 as { id: string }[])[0].id;
    const { out } = await render(applyOp(s0, { op: "set_card", clipIds: [id], crop: { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 }, shadow: { opacity: 0.6 } } as Op, ctx).snap, "grey", "card");
    const f = await frame(out, 3);
    const inside = px(f, 480, 270), outside = px(f, 100, 270), below = lum(px(f, 480, 0.8 * H + 8)), far = lum(px(f, 480, 0.97 * H));
    console.log(`card: inside ${inside}, beside it ${outside}; just under its edge ${below.toFixed(0)}, far below ${far.toFixed(0)}`);
    assert.ok(inside[0] > 200 && inside[2] < 60, "the b-roll in the middle");
    assert.ok(Math.abs(lum(outside) - 128) < 6, "cropped: the picture shows beside it");
    assert.ok(below < far - 15, "its shadow darkens the picture just under it");
    assert.ok(Math.abs(far - 128) < 6, "far from it the picture is as it was");
  });
});
