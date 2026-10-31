// Phase 12b rendered and measured. Transitions between a red clip and a blue one, read at the middle of the window
// (where the player draws the same split: wipe, push, iris, barn doors, diamond, clock at a quarter), a film dissolve
// mixed in linear light against a plain one; and the new effects: grain, RGB split, mirror, camera shake, glow and
// corner pin, each against the plain render. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, transitionAt, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 10, W = 960, H = 540;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("Phase 12b transitions and effects, rendered", () => {
  let dir = "";
  const files: Record<string, string> = {};
  const make = async (name: string, vf: string) => {
    const p = join(dir, `${name}.mp4`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-vf", `${vf},format=yuv420p`, "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-shortest", p]);
    files[name] = p;
  };
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "fx12-"));
    await make("redblue", "geq=r='if(lt(T,5),208,32)':g='32':b='if(lt(T,5),32,208)'");
    await make("grey", "geq=lum='128':cb=128:cr=128");
    await make("square", "geq=lum='if(between(X,270,370)*between(Y,130,230),255,0)':cb=128:cr=128");
    await make("halves", "geq=r='if(lt(X,320),220,30)':g='30':b='if(lt(X,320),30,220)'");
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[], clips = [{ id: "a", start: 1, end: 4, label: "" }, { id: "b", start: 6, end: 9, label: "" }]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "x", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, main: string, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, `${name}-${n}`); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const pf: PlanFiles = { source: files[main], output: join(dir, `${name}.mp4`), looks };
    const { args, filterGraph } = ffmpegArgs(plan, pf, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: pf.output, plan };
  };
  const frame = async (file: string, t: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  const px = (f: Buffer, x: number, y: number) => { const o = (Math.round(y * (H - 1)) * W + Math.round(x * (W - 1))) * 3; return [f[o], f[o + 1], f[o + 2]]; };
  const isB = (p: number[]) => p[2] > 150 && p[0] < 80, isA = (p: number[]) => p[0] > 150 && p[2] < 80;

  it("transitions at the middle of the window split the picture where the player splits it", async () => {
    // The cut at edit 3.0 s; a 0.6 s window; frames read at progress q.
    const cases: [string, string | undefined, number, [number, number, "A" | "B"][]][] = [
      ["wipe", "left", 0.5, [[0.2, 0.5, "A"], [0.8, 0.5, "B"]]],
      ["push", "left", 0.5, [[0.2, 0.5, "A"], [0.8, 0.5, "B"]]],
      ["iris", undefined, 0.5, [[0.5, 0.5, "B"], [0.03, 0.03, "A"]]],
      ["barn-door", "left", 0.5, [[0.5, 0.05, "B"], [0.5, 0.95, "B"], [0.06, 0.5, "A"], [0.94, 0.5, "A"]]],
      ["diamond", undefined, 0.5, [[0.5, 0.5, "B"], [0.04, 0.04, "A"], [0.96, 0.96, "A"]]],
      ["clock", undefined, 0.25, [[0.75, 0.2, "B"], [0.25, 0.8, "A"], [0.25, 0.2, "A"]]],
    ];
    for (const [type, dir, q, checks] of cases) {
      const s = edit([{ op: "set_transition", clipId: "b", type, duration: 0.6, ...(dir ? { dir } : {}) } as Op]);
      const { out, plan } = await render(s, "redblue", `tr-${type}`);
      const t = plan.transitions!.find((x) => x.type === type)!;
      const f = await frame(out, t.start + q * (t.end - t.start));
      const look = transitionAt({ type: type as never, dir: dir as never }, q, W, H);
      const got = checks.map(([x, y, want]) => { const p = px(f, x, y); return { x, y, want, ok: want === "B" ? isB(p) : isA(p), p }; });
      console.log(`${type}${dir ? " " + dir : ""} at ${q}: ${got.map((g) => `(${g.x},${g.y}) ${g.want} ${g.p}${g.ok ? "" : " WRONG"}`).join("; ")}; player ${look.clip ?? look.mask ?? `a.x ${look.a.x} b.x ${look.b.x}`}`);
      assert.ok(got.every((g) => g.ok), `${type}: the split where the player draws it`);
    }
  });

  it("a film dissolve mixes in linear light (brighter in the middle than a plain dissolve)", async () => {
    const mid = async (type: string) => { const { out, plan } = await render(edit([{ op: "set_transition", clipId: "b", type, duration: 0.6 } as Op]), "redblue", `mid-${type}`); const t = plan.transitions![0]; return px(await frame(out, (t.start + t.end) / 2), 0.5, 0.5); };
    const film = await mid("film-dissolve"), plain = await mid("dissolve");
    console.log(`middle of the window: film dissolve ${film}, dissolve ${plain} (linear-light mix of 208 and 32: about 153)`);
    assert.ok(film[0] > 140 && film[2] > 140, "film dissolve: both near 153");
    assert.ok(plain[0] < 132 && plain[2] < 132, "plain dissolve: both near 120");
  });

  it("grain, RGB split, mirror, camera shake, glow and corner pin each change the picture as they should", async () => {
    const one = [{ id: "c", start: 1, end: 4, label: "" }];
    const fx = (effects: object[], main: string, name: string) => render(edit([{ op: "set_effects", clipIds: ["c"], effects } as Op], one), main, name);
    // Grain: a flat grey picture gets texture.
    const sd = (f: Buffer) => { const xs: number[] = []; for (let y = 200; y < 300; y += 2) for (let x = 400; x < 560; x += 2) xs.push(f[(y * W + x) * 3]); const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
    const g0 = sd(await frame((await render(edit([], one), "grey", "plain-grey")).out, 1)), g1 = sd(await frame((await fx([{ type: "grain", amount: 60 }], "grey", "grain")).out, 1));
    // RGB split: a white square's red edge and blue edge apart.
    const rgb = await frame((await fx([{ type: "rgbsplit", amount: 100 }], "square", "rgbsplit")).out, 1);
    const first = (k: number) => { for (let x = 0; x < W; x++) if (rgb[(270 * W + x) * 3 + k] > 128) return x; return -1; };
    // Mirror: the red left half reflected onto the right.
    const mir = await frame((await fx([{ type: "mirror", amount: 100 }], "halves", "mirror")).out, 1);
    // Shake: a still picture moves frame to frame.
    const sh = await render(edit([{ op: "set_effects", clipIds: ["c"], effects: [{ type: "shake", amount: 100 }] } as Op], one), "square", "shake");
    const diff = async (file: string) => { const a = await frame(file, 1), b = await frame(file, 1.1); let s = 0; for (let i = 0; i < a.length; i += 3) s += Math.abs(a[i] - b[i]); return s / (a.length / 3); };
    const still = await diff((await render(edit([], one), "square", "plain-square")).out), moved = await diff(sh.out);
    // Glow: light spreads past the square's edge.
    const glow = await frame((await fx([{ type: "glow", amount: 80 }], "square", "glow")).out, 1), plainSq = await frame(join(dir, "plain-square.mp4"), 1);
    const outside = (f: Buffer) => f[(270 * W + 395) * 3]; // 10 px right of the square's edge (it ends at x 555... 370*1.5)
    // Corner pin: the picture squeezed into the middle quarter, black round it.
    const pin = await frame((await fx([{ type: "pin", amount: 100, corners: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] }], "grey", "pin")).out, 1);
    console.log(`grain: spread ${g0.toFixed(1)} -> ${g1.toFixed(1)}; RGB split: red edge at ${first(0)}, blue at ${first(2)}; mirror: right ${px(mir, 0.8, 0.5)}; shake: frame-to-frame ${still.toFixed(2)} -> ${moved.toFixed(2)}; glow outside the edge ${outside(plainSq)} -> ${outside(glow)}; pin: corner ${px(pin, 0.1, 0.1)}, middle ${px(pin, 0.5, 0.5)}`);
    assert.ok(g1 > g0 + 3, "grain adds texture");
    assert.ok(first(2) - first(0) >= 10, "red and blue edges pulled apart");
    assert.ok(px(mir, 0.8, 0.5)[0] > 180, "the right half shows the left (red)");
    assert.ok(still < 0.5 && moved > 3, "shake moves a still picture");
    assert.ok(outside(glow) > outside(plainSq) + 15, "glow spreads past the edge");
    assert.ok(px(pin, 0.1, 0.1).every((v) => v < 20) && Math.abs(px(pin, 0.5, 0.5)[1] - 128) < 10, "pinned into the middle, black round it");
  });
});
