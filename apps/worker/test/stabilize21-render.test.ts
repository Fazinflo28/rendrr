// Phase 21 rendered and measured: footage of a still scene seen through a shaking camera, stabilized where it plays at
// another speed (half speed, a ramp from normal to slow, reversed) and as b-roll over the picture. Each reads a
// stabilized copy of its footage (the shake measured over the whole clip, smoothed as one): frame-to-frame movement drops
// against the same edit as filmed, the edit is as long, and a ramp's steps join without a jump. Needs ffmpeg with vidstab.
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
import { detectShake, makeStableCopy } from "../src/lib/stabilize";

const execFileP = promisify(execFile);
const SECONDS = 10;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const GW = 160, GH = 90;

describe("Warp Stabilizer on b-roll and on clips at other speeds, rendered", () => {
  let dir = "", main = "", flat = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "stabilize21-"));
    main = join(dir, "shaky.mp4"); flat = join(dir, "flat.mp4");
    const still = join(dir, "still.png");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=960x540:d=1,format=gray,geq=lum='255*random(1)',gblur=sigma=3,eq=contrast=4", "-frames:v", "1", still]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", still, "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`,
      "-vf", "crop=640:360:x='160+14*sin(n*1.3)+9*sin(n*3.1)':y='90+11*sin(n*1.7)+7*sin(n*2.9)',format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-shortest", main]);
    // A flat grey picture under the b-roll (so the movement measured is the b-roll's).
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x808080:s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-shortest", flat]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: (id) => (id === "shaky" ? { id, name: "shaky", seconds: SECONDS, ready: true } : undefined) };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "s", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "c", start: 2, end: 6, label: "" }] }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string, src = main) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { shaky: SECONDS } });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const files: PlanFiles = { source: src, output: join(dir, `${name}.mp4`), looks, broll: Object.fromEntries(plan.broll.map((b) => [b.clipId, main])) };
    for (const [key, st] of Object.entries(plan.stabilize ?? {})) { const p = join(dir, `${name}-${st.file}`); await detectShake(src, st, plan.rate || "30", p); (files.stabilize ??= {})[key] = p; }
    for (const [id, st] of Object.entries(plan.stabilized ?? {})) {
      const from = st.broll ? main : src, trf = join(dir, `${name}-${st.file}`), copy = join(dir, `${name}-${st.copy}`);
      await detectShake(from, st, plan.rate || "30", trf); await makeStableCopy(from, st, plan.rate || "30", trf, copy); (files.stableCopies ??= {})[id] = copy;
    }
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", files.output, "-vf", `scale=${GW}:${GH}:flags=area,format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    return { frames: raw.length / (GW * GH), raw, plan, graph: filterGraph, args };
  };
  /** Frame-to-frame differences in the middle of the picture, between frames that show different footage frames. */
  const moves = (raw: Buffer, frames: number, from = 1, to = frames - 1) => {
    const out: number[] = [];
    for (let f = Math.max(1, from); f < Math.min(frames - 1, to); f++) {
      let s = 0, n = 0;
      for (let y = 20; y < GH - 20; y++) for (let x = 30; x < GW - 30; x++) { s += Math.abs(raw[f * GW * GH + y * GW + x] - raw[(f - 1) * GW * GH + y * GW + x]); n++; }
      out.push(s / n);
    }
    return out;
  };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  // At half speed every footage frame shows twice: only the changes count (pairs of equal frames are left out).
  const changing = (xs: number[]) => xs.filter((x) => x > 0.5);

  it("half speed: from a stabilized copy, the shake nearly gone; as long", async () => {
    const slow = (st: boolean) => edit([{ op: "set_speed", clipId: "c", speed: 0.5 } as Op, ...(st ? [{ op: "stabilize", clipId: "c", smooth: 60 } as Op] : [])]);
    const shaky = await render(slow(false), "slow-shaky"), steady = await render(slow(true), "slow-steady");
    assert.ok(steady.plan.stabilized?.c && !steady.plan.stabilize, "the clip reads a stabilized copy (not the normal-speed path)");
    assert.ok(steady.args.some((a) => /stable_[0-9a-f]+\.mkv$/.test(a)) && !steady.graph.includes("vidstabtransform"), "the render reads the copy (already smoothed)");
    assert.match(steady.plan.operations.join("\n"), /Stabilized \(Warp Stabilizer.*c \(at its speeds, from a stabilized copy\)/);
    const a = mean(changing(moves(shaky.raw, shaky.frames, 31))), b = mean(changing(moves(steady.raw, steady.frames, 31)));
    console.log(`half speed: frame-to-frame difference ${a.toFixed(2)} as filmed, ${b.toFixed(2)} stabilized (${shaky.frames} and ${steady.frames} frames)`);
    assert.equal(steady.frames, shaky.frames, "as long");
    assert.ok(b < a * 0.25, `the movement nearly gone (${a.toFixed(2)} -> ${b.toFixed(2)})`);
  });

  it("a ramp from normal to slow: smoothed through the speed change, no jump where the speed changes", async () => {
    const ramp = (st: boolean) => edit([{ op: "set_speed", clipId: "c", ramp: [{ at: 2, speed: 1 }, { at: 3.5, speed: 1 }, { at: 4, speed: 0.4 }, { at: 6, speed: 0.4 }] } as Op, ...(st ? [{ op: "stabilize", clipId: "c", smooth: 60 } as Op] : [])]);
    const shaky = await render(ramp(false), "ramp-shaky"), steady = await render(ramp(true), "ramp-steady");
    assert.ok(steady.plan.parts.length > 1, `a ramp is drawn in steps (${steady.plan.parts.length})`);
    assert.ok(steady.plan.stabilized?.c, "one copy for the whole clip");
    const ms = changing(moves(steady.raw, steady.frames, 31)), a = mean(changing(moves(shaky.raw, shaky.frames, 31))), b = mean(ms);
    console.log(`ramp: ${a.toFixed(2)} as filmed, ${b.toFixed(2)} stabilized; worst step ${Math.max(...ms).toFixed(2)}`);
    assert.equal(steady.frames, shaky.frames, "as long");
    assert.ok(b < a * 0.3, `the movement nearly gone (${a.toFixed(2)} -> ${b.toFixed(2)})`);
    assert.ok(Math.max(...ms) < a * 0.6, `no jump where the speed changes (worst ${Math.max(...ms).toFixed(2)} against ${a.toFixed(2)} as filmed)`);
  });

  it("reversed: stabilized too", async () => {
    const rev = (st: boolean) => edit([{ op: "set_speed", clipId: "c", speed: 1, reverse: true } as Op, ...(st ? [{ op: "stabilize", clipId: "c", smooth: 60 } as Op] : [])]);
    const shaky = await render(rev(false), "rev-shaky"), steady = await render(rev(true), "rev-steady");
    const a = mean(moves(shaky.raw, shaky.frames, 31)), b = mean(moves(steady.raw, steady.frames, 31));
    console.log(`reversed: ${a.toFixed(2)} as filmed, ${b.toFixed(2)} stabilized`);
    assert.equal(steady.frames, shaky.frames, "as long");
    assert.ok(b < a * 0.25, `the movement nearly gone (${a.toFixed(2)} -> ${b.toFixed(2)})`);
  });

  it("b-roll: stabilized from its own footage, over a still picture", async () => {
    const withB = (st: boolean) => {
      let s = edit([{ op: "add_broll", videoId: "shaky", start: 0.5, end: 3.5, sourceStart: 2, edit: true } as Op]);
      const id = (s.timeline.tracks.v2 as { id: string }[])[0].id;
      if (st) s = applyOp(s, { op: "stabilize", clipId: id, smooth: 60 } as Op, ctx).snap;
      return s;
    };
    const shaky = await render(withB(false), "broll-shaky", flat), steady = await render(withB(true), "broll-steady", flat);
    assert.ok(Object.values(steady.plan.stabilized ?? {})[0]?.broll, "the b-roll reads a stabilized copy");
    const a = mean(moves(shaky.raw, shaky.frames, 31, 100)), b = mean(moves(steady.raw, steady.frames, 31, 100));
    console.log(`b-roll: ${a.toFixed(2)} as filmed, ${b.toFixed(2)} stabilized`);
    assert.ok(b < a * 0.25, `the movement nearly gone (${a.toFixed(2)} -> ${b.toFixed(2)})`);
  });
});
