// Phase 10 rendered and measured: two cameras of one take. The main camera (red, a 440 Hz tone under the talk) and an
// angle that started 2.37 s earlier (its picture's brightness counts its own seconds, an 880 Hz tone under the talk,
// 10 dB quieter). Their sound is synced the way the server does it (each file's loudness every 10 ms, slid past each
// other); the edit cuts to the angle from 3 to 6 s. The angle's frames are the synced ones, the main sound plays under
// it (or the angle's own with audio follow), and the edit is as long. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, syncEnvelope, syncOffset, wavStereo, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const R = 48000, OFFSET = 2.37, MAIN_S = 12, CAM_S = 16;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: MAIN_S, hasAudio: true };
const camInfo: SourceInfo = { width: 640, height: 360, fps: 30, seconds: CAM_S, hasAudio: true };
const W = 960, H = 540;

/** The talk: noise bursts of random length and level (seeded), the same in both rooms. */
function talk(seconds: number) {
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bursts: [number, number, number][] = [];
  for (let t = 0.2; t < seconds; ) { const len = 0.06 + rnd() * 0.25; bursts.push([t, t + len, 0.05 + rnd() * 0.25]); t += len + 0.05 + rnd() * 0.3; }
  return bursts;
}
function wav(seconds: number, from: number, gain: number, tone: number) {
  const n = Math.round(seconds * R), l = new Float32Array(n);
  const bursts = talk(40);
  let seed = 777;
  for (let i = 0; i < n; i++) {
    const t = from + i / R;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const b = bursts.find(([a, e]) => t >= a && t < e);
    l[i] = gain * ((b ? b[2] * ((seed / 4294967296) * 2 - 1) : 0) + 0.1 * Math.sin(2 * Math.PI * tone * i / R));
  }
  return wavStereo(l, l);
}

describe("multicam, rendered", () => {
  let dir = "", main = "", cam = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "multicam-"));
    main = join(dir, "main.mp4"); cam = join(dir, "cam.mp4");
    await writeFile(join(dir, "main.wav"), wav(MAIN_S, 0, 1, 440));
    // The angle started 2.37 s before the main camera: its second 2.37 is the main video's 0.
    await writeFile(join(dir, "cam.wav"), wav(CAM_S, -OFFSET, 0.32, 880));
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0xC03030:s=640x360:r=30:d=${MAIN_S}`, "-i", join(dir, "main.wav"), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", main]);
    // The angle's brightness counts its own time: 30 + 12 per second (grey).
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=640x360:r=30:d=${CAM_S},format=gray,geq=lum='30+12*T',format=yuv420p`, "-i", join(dir, "cam.wav"), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-c:a", "aac", "-b:a", "192k", "-shortest", cam]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  /** A file's loudness every 10 ms in dBFS (as the deep measurements store it). */
  const loudness = async (file: string) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(R), "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout as Buffer;
    const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), per = R / 100, n = Math.floor(x.length / per), db = new Int8Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = i * per; k < (i + 1) * per; k++) s += x[k] * x[k]; db[i] = Math.max(-128, Math.round(10 * Math.log10(s / per + 1e-13))); }
    return db;
  };
  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: MAIN_S, getStyle: () => undefined, getVideo: (id) => (id === "cam" ? { id, name: "Cam B", seconds: CAM_S, ready: true } : undefined) };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], MAIN_S, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null, declick: 0 }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, sources: { cam: camInfo }, videoId: "v" });
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), videos: { cam } };
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0 });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { out: files.output, plan };
  };
  const rgbAt = async (file: string, t: number, w = W, h = H) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h},format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  const mid = (f: Buffer, w = W, h = H) => { const o = [0, 0, 0]; for (let y = h / 2 - 5; y < h / 2 + 5; y++) for (let x = w / 2 - 5; x < w / 2 + 5; x++) for (let k = 0; k < 3; k++) o[k] += f[(y * w + x) * 3 + k] / 100; return o.map(Math.round); };
  const band = async (file: string, f: number, a: number, b: number) => {
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(a), "-t", String(b - a), "-i", file, "-af", `bandpass=f=${f}:width_type=q:w=30,pan=mono|c0=c0`, "-f", "f32le", "-ar", String(R), "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4); let s = 0; for (const v of x) s += v * v; return 10 * Math.log10(s / x.length + 1e-13);
  };
  let offset = 0;

  it("the sound syncs the angle to a few ms", async () => {
    const r = syncOffset(syncEnvelope(await loudness(main)), syncEnvelope(await loudness(cam)));
    console.log(`sync: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.offset - OFFSET) < 0.008, `offset ${r.offset}`);
    assert.ok(r.sure);
    offset = r.offset;
  });

  it("cut to the angle at 3-6 s: its synced frames, the main sound under it, as long as before", async () => {
    const { out, plan } = await render(edit([{ op: "multicam", angles: [{ videoId: "cam", offset }] } as Op, { op: "switch_angle", angle: "cam", start: 3, end: 6, edit: true } as Op]), "cut");
    assert.ok(plan.operations.join("\n").includes("Multicam: main camera 75%, cam 25%"));
    const at = async (t: number) => mid(await rgbAt(out, t));
    // The angle's frame at main second t is its own second t + offset: compare with that frame of its file.
    const want = async (t: number) => mid(await rgbAt(cam, t + OFFSET));
    for (const t of [3.5, 4.5, 5.5]) {
      const got = await at(t), ref = await want(t);
      console.log(`edit ${t}s: ${got} (the angle's frame at its ${(t + OFFSET).toFixed(2)}s: ${ref})`);
      assert.ok(Math.abs(got[0] - ref[0]) <= 4 && Math.abs(got[1] - got[0]) <= 4, `the synced frame at ${t}s`);
    }
    for (const t of [1.5, 7.5]) { const c = await at(t); assert.ok(c[0] > 150 && c[1] < 80, `the main camera at ${t}s (${c})`); }
    const tone = async (f: number, a: number, b: number) => band(out, f, a, b);
    const m440 = await tone(440, 4, 5), m880 = await tone(880, 4, 5);
    console.log(`under the angle: 440 Hz ${m440.toFixed(1)} dB, 880 Hz ${m880.toFixed(1)} dB`);
    assert.ok(m440 - m880 > 15, "the main video's sound plays under the angle");
    const len = Number((await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out])).stdout);
    assert.ok(Math.abs(len - MAIN_S) < 0.1, `as long (${len})`);
  });

  it("audio follow: the angle's own sound plays with its picture, and the main sound around it", async () => {
    const { out } = await render(edit([{ op: "multicam", angles: [{ videoId: "cam", offset }], audio: "follow" } as Op, { op: "switch_angle", angle: "cam", start: 3, end: 6, edit: true } as Op]), "follow");
    const a440 = await band(out, 440, 4, 5), a880 = await band(out, 880, 4, 5), b440 = await band(out, 440, 1, 2), b880 = await band(out, 880, 1, 2);
    console.log(`follow: under the angle 440 ${a440.toFixed(1)} / 880 ${a880.toFixed(1)} dB; before it 440 ${b440.toFixed(1)} / 880 ${b880.toFixed(1)} dB`);
    assert.ok(a880 - a440 > 15, "the angle's own sound under its picture");
    assert.ok(b440 - b880 > 15, "the main sound before it");
  });
});
