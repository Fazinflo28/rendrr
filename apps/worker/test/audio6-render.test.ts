// Phase 6 rendered and measured: a clip's pan (one side silent, the other as it was), EQ (a 60 Hz tone down by the low
// band, a 5 kHz tone left), volume keys (the level follows them), reverb (a room rings on after a tone stops), and a
// crossfade at a cut (no dip where the declick fade dips, and the edit as long as before). The rendered sound is
// decoded to samples and measured here. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, reverbIr, wavStereo, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const SECONDS = 12, R = 48000;
const source: SourceInfo = { width: 320, height: 180, fps: 30, seconds: SECONDS, hasAudio: true };

describe("a clip's own sound and crossfades, rendered", () => {
  let dir = "", tones = "", burst = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "audio6-"));
    tones = join(dir, "tones.mp4"); burst = join(dir, "burst.mp4");
    const vid = ["-f", "lavfi", "-i", `color=black:s=320x180:r=30:d=${SECONDS}`];
    // A 60 Hz and a 5 kHz tone together, the same on both sides.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...vid, "-f", "lavfi", "-i", `aevalsrc='0.2*sin(2*PI*60*t)+0.2*sin(2*PI*5000*t)|0.2*sin(2*PI*60*t)+0.2*sin(2*PI*5000*t)':s=${R}:d=${SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", "-shortest", tones.replace(".mp4", ".mov")]);
    tones = tones.replace(".mp4", ".mov");
    // 1 kHz bursts of 0.5 s every 2 s, silence between.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...vid, "-f", "lavfi", "-i", `aevalsrc='0.3*sin(2*PI*1000*t)*lt(mod(t,2),0.5)|0.3*sin(2*PI*1000*t)*lt(mod(t,2),0.5)':s=${R}:d=${SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", "-shortest", burst.replace(".mp4", ".mov")]);
    burst = burst.replace(".mp4", ".mov");
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "a", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  /** The rendered sound as samples: [left, right]. */
  const render = async (s: Snapshot, name: string, src: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const irs: Record<string, string> = {};
    for (const [n, size] of Object.entries(plan.audioMix?.irs ?? {})) { const [l, r] = reverbIr(size); const p = join(dir, `${name}-${n}`); await writeFile(p, wavStereo(l, r)); irs[n] = p; }
    const files: PlanFiles = { source: src, output: join(dir, `${name}.mp4`), irs };
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0 });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", files.output, "-f", "f32le", "-ac", "2", "-ar", String(R), "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), n = f.length / 2;
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = f[2 * i]; r[i] = f[2 * i + 1]; }
    return { l, r, seconds: n / R, plan };
  };
  const rms = (x: Float32Array, a: number, b: number) => { let s = 0; const i0 = Math.round(a * R), i1 = Math.round(b * R); for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
  const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));
  /** A tone's level over a stretch: the sound through a band around it (FFmpeg's bandpass, same render). */
  const band = async (file: string, f: number, a: number, b: number) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(a), "-t", String(b - a), "-i", file, "-af", `bandpass=f=${f}:width_type=q:w=4,pan=mono|c0=c0`, "-f", "f32le", "-ar", String(R), "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4); let s = 0; for (const v of x) s += v * v; return db(Math.sqrt(s / x.length));
  };

  it("pan: hard left, the right side is silent and the left as it was", async () => {
    const { l, r } = await render(edit([{ op: "set_clip_audio", clipId: "c_0", pan: -1 } as Op].filter(() => false)), "plain", tones);
    const ref = db(rms(l, 2, 4));
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    const p = await render(edit([{ op: "set_clip_audio", clipId: id, pan: -1 } as Op]), "pan", tones);
    console.log(`pan: left ${db(rms(p.l, 2, 4)).toFixed(1)} dB (plain ${ref.toFixed(1)}), right ${db(rms(p.r, 2, 4)).toFixed(1)} dB`);
    assert.ok(Math.abs(db(rms(p.l, 2, 4)) - ref) < 0.5);
    assert.ok(db(rms(p.r, 2, 4)) < -80);
    void r;
  });

  it("EQ: the low band takes the 60 Hz tone down and leaves the 5 kHz one", async () => {
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    await render(edit([]), "eq0", tones);
    await render(edit([{ op: "set_clip_audio", clipId: id, eq: { low: -12 } } as Op]), "eq", tones);
    const lo0 = await band(join(dir, "eq0.mp4"), 60, 2, 4), lo = await band(join(dir, "eq.mp4"), 60, 2, 4);
    const hi0 = await band(join(dir, "eq0.mp4"), 5000, 2, 4), hi = await band(join(dir, "eq.mp4"), 5000, 2, 4);
    console.log(`EQ low -12: 60 Hz ${(lo - lo0).toFixed(1)} dB, 5 kHz ${(hi - hi0).toFixed(1)} dB`);
    assert.ok(lo - lo0 < -9 && lo - lo0 > -13, "60 Hz down by about 12 dB");
    assert.ok(Math.abs(hi - hi0) < 0.6, "5 kHz left");
  });

  it("volume keys: the level follows them, a straight line in dB", async () => {
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    const base = await render(edit([]), "k0", tones);
    const k = await render(edit([{ op: "set_clip_audio", clipId: id, keys: [{ t: 2, gainDb: 0 }, { t: 4, gainDb: -20 }] } as Op]), "keys", tones);
    const at = (t: number) => db(rms(k.l, t - 0.05, t + 0.05)) - db(rms(base.l, t - 0.05, t + 0.05));
    console.log(`keys: ${[1, 3, 5].map((t) => `${t}s ${at(t).toFixed(1)} dB`).join(", ")}`);
    assert.ok(Math.abs(at(1)) < 0.5 && Math.abs(at(3) + 10) < 0.8 && Math.abs(at(5) + 20) < 0.8);
  });

  it("reverb: the room rings on after a burst stops; without it, silence", async () => {
    const id = (edit([]).timeline.tracks.v1 as { id: string }[])[0].id;
    const dry = await render(edit([]), "dry", burst);
    const wet = await render(edit([{ op: "set_clip_audio", clipId: id, reverb: { amount: 60, size: 50 } } as Op]), "wet", burst);
    // The burst at 2.0-2.5 s; 2.6-2.9 s is after it.
    const d = db(rms(dry.l, 2.6, 2.9)), w = db(rms(wet.l, 2.6, 2.9)), on = db(rms(wet.l, 2.1, 2.4));
    console.log(`reverb: after the burst ${w.toFixed(1)} dB (dry ${d.toFixed(1)} dB), during it ${on.toFixed(1)} dB`);
    assert.ok(d < -70, "dry: silence after the burst");
    assert.ok(w > -45 && w < on - 6, "wet: the room rings on, quieter than the burst");
  });

  it("crossfade: no dip at the cut where the declick fade dips, and the edit is as long", async () => {
    const cut = (ops: Op[]) => edit([{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5.013, label: "" }, { id: "b", start: 6.017, end: 10, label: "" }] } as Op, ...ops]);
    const dk = await render(cut([]), "declick", tones), xf = await render(cut([{ op: "set_audio", crossfade: 0.08 } as Op]), "crossfade", tones);
    const at = 4.013; // the cut, in edit seconds
    const dip = (x: Float32Array) => { let m = Infinity; for (let t = at - 0.04; t < at + 0.04; t += 0.005) m = Math.min(m, db(rms(x, t - 0.0025, t + 0.0025))); return m - db(rms(x, 2, 3)); };
    console.log(`at the cut: declick dips ${dip(dk.l).toFixed(1)} dB, crossfade ${dip(xf.l).toFixed(1)} dB; ${dk.seconds.toFixed(3)} s and ${xf.seconds.toFixed(3)} s long`);
    assert.ok(dip(dk.l) < -10, "the declick fade dips at the cut");
    assert.ok(dip(xf.l) > -6, "the crossfade does not");
    assert.ok(Math.abs(xf.seconds - dk.seconds) < 0.002, "nothing moved");
    assert.ok(xf.plan.operations.join("\n").includes("80 ms crossfade at cuts"));
  });
});
