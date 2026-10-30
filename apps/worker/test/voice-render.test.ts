// A render with the user's own voice file (set_voice): the output's sound is the file, timed from the edit's start,
// and none of the footage's own sound. The footage hums at 300 Hz, the file at 1 kHz. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

describe("render with the user's voice file", () => {
  let dir = "";
  const src: SourceInfo = { width: 320, height: 180, fps: 30, seconds: 20, hasAudio: true };
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "voice-render-"));
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=20", "-f", "lavfi", "-i", "sine=f=300:d=20:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(dir, "foot.mp4")]);
    // The voice file: 1 kHz for 9 s, as AAC 48 kHz stereo like the worker makes it.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=1000:d=9:sample_rate=48000", "-ac", "2", "-c:a", "aac", "-b:a", "256k", join(dir, "voice.m4a")]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  const rms = async (file: string, filter: string, from = 0.5, len = 7.5) => {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", file, "-af", `${filter},astats=metadata=1:reset=0`, "-f", "null", "-"]);
    const m = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)];
    return Number(m[m.length - 1]?.[1] ?? -999);
  };

  it("plays the file in place of the clips' sound", async () => {
    const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 20, getStyle: () => undefined, getSound: () => ({ id: "s", name: "Enhanced", seconds: 9, ready: true }) } as unknown as EditContext;
    let s: Snapshot = { timeline: buildInitialTimeline([], 20, "clean", [], "v"), name: "w", aspect: "16:9", styleId: null };
    s = applyOp(s, { op: "batch", ops: [{ op: "set_clips", track: "v1", clips: [{ start: 1, end: 5, label: "a" }, { start: 10, end: 15, label: "b" }] }, { op: "set_captions", on: false }, { op: "set_audio", loudness: null }] } as Op, ctx).snap;
    const before = s;
    s = applyOp(s, { op: "set_voice", soundId: "s" } as Op, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source: src, videoId: "v", sounds: { s: { key: "sounds/u/s.m4a", seconds: 9, name: "Enhanced" } } });
    const out = join(dir, "out.mp4");
    const made = ffmpegArgs(plan, { source: join(dir, "foot.mp4"), output: out, assPath: join(dir, "c.ass"), audio: { voice: join(dir, "voice.m4a") } }, src, {});
    await writeFile(join(dir, "g.txt"), made.filterGraph);
    await run("ffmpeg", made.args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));
    const len = Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out])).stdout.trim());
    assert.ok(Math.abs(len - 9) < 0.1, `9 s long (${len})`);
    // Steep filters (four 12 dB/octave stages each), so each tone is measured without the other's spill.
    const voice = await rms(out, "highpass=f=700,highpass=f=700,highpass=f=700,highpass=f=700"), foot = await rms(out, "lowpass=f=400,lowpass=f=400,lowpass=f=400,lowpass=f=400");
    assert.ok(voice > -30, `the voice file is heard (${voice} dB above 700 Hz)`);
    assert.ok(foot < -50, `none of the footage's 300 Hz sound (${foot} dB below 400 Hz)`);
    // The same edit without the voice: the footage's sound is there (so the filters above do see it).
    const p0 = planRender({ kind: "preview", snapshot: before, transcript: [], source: src, videoId: "v" });
    const out0 = join(dir, "out0.mp4");
    const m0 = ffmpegArgs(p0, { source: join(dir, "foot.mp4"), output: out0, assPath: join(dir, "c.ass") }, src, {});
    await writeFile(join(dir, "g0.txt"), m0.filterGraph);
    await run("ffmpeg", m0.args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g0.txt") : a)));
    const foot0 = await rms(out0, "lowpass=f=400,lowpass=f=400,lowpass=f=400,lowpass=f=400");
    assert.ok(foot0 > -35, `without the voice, the footage's sound plays (${foot0} dB)`);
  });
});
