// Studio voice (python/voice.py): speech (espeak-ng) in a noisy, echoing room, cleaned in blocks by WPE and
// DeepFilterNet3 (the official ONNX export, VOICE_MODELS), joined, and rendered through the edit's graph in place of
// the footage's sound. Needs ffmpeg, espeak-ng, Python with numpy and onnxruntime (PYTHON_BIN) and the model files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, VOICE_BLOCK, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { VOICE_MODELS, VOICE_PY } from "../src/lib/voice";

const PY = process.env.PYTHON_BIN || "python3";
const has = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const ready = has(PY, ["-c", "import numpy, onnxruntime"]) && has("espeak-ng", ["--version"]) && existsSync(join(VOICE_MODELS, "enc.onnx"));
const SR = 48000;

describe("the studio voice", { skip: !ready && "needs espeak-ng, PYTHON_BIN with numpy and onnxruntime, and VOICE_MODELS (DeepFilterNet3's ONNX export)" }, () => {
  let dir = "";
  const SECONDS = 40;
  // Speech at 2-9 s and 31-38 s (block 0 and block 1), pauses between; the room: fan noise and a 0.5 s echo.
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-voice-"));
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", join(dir, "s1.wav"), "Today we are going to make this voice sound like it was recorded in a studio."]);
    execFileSync("espeak-ng", ["-v", "en-gb", "-s", "140", "-w", join(dir, "s2.wav"), "The quick brown fox jumps over the lazy dog, then runs back into the forest."]);
    execFileSync(PY, ["-I", "-c", `
import numpy as np, subprocess, sys
d=sys.argv[1]; SR=48000
def rd(p): return np.frombuffer(subprocess.run(["ffmpeg","-v","error","-i",p,"-ac","1","-ar",str(SR),"-f","f32le","-"],capture_output=True,check=True).stdout,np.float32)
x=np.zeros(${SECONDS}*SR,np.float32)
for p,at in ((d+"/s1.wav",2),(d+"/s2.wav",31)):
    s=rd(p)[:7*SR]; s=s/np.max(np.abs(s))*0.5; x[at*SR:at*SR+len(s)]+=s
rng=np.random.default_rng(3); t=np.arange(int(0.8*SR))/SR
rir=rng.standard_normal(len(t))*np.exp(-6.9*t/0.5)*0.03; rir[:240]=0; rir[0]=1
y=np.convolve(x,rir)[:len(x)]
w=rng.standard_normal(len(x)); f=np.fft.rfft(w); f/=np.maximum(1,np.sqrt(np.arange(len(f)))); n=np.fft.irfft(f,len(x))
y=y+n/np.sqrt(np.mean(n**2))*0.02
subprocess.run(["ffmpeg","-v","error","-y","-f","f32le","-ar",str(SR),"-ac","1","-i","-","-c:a","pcm_s16le",d+"/room.wav"],input=y.astype(np.float32).tobytes(),check=True)
`, dir]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=s=320x180:r=30:d=${SECONDS}`, "-i", join(dir, "room.wav"), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-shortest", join(dir, "foot.mp4")]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  // Above 100 Hz: the room's rumble under that is the chain's high-pass's (80 Hz), not the AI's.
  const rms = async (file: string, from: number, len: number, filter = "highpass=f=100:poles=2,highpass=f=100:poles=2") => {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", file, "-af", `${filter ? filter + "," : ""}astats=metadata=1:reset=0`, "-f", "null", "-"]);
    const m = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)];
    const v = m[m.length - 1]?.[1];
    return v === "-inf" ? -200 : Number(v ?? -999);
  };
  const samples = async (file: string) => Number((await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-count_packets", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", file])).stdout.trim());

  it("cleans each block: the noise between words goes, the speech stays; blocks are exact and joined smoothly", { timeout: 240_000 }, async () => {
    const out = join(dir, "blocks");
    const { stdout } = await run(PY, [VOICE_PY, "--input", join(dir, "foot.mp4"), "--blocks", "0,1", "--block", String(VOICE_BLOCK), "--seconds", String(SECONDS), "--denoise", "100", "--dereverb", "60", "--models", VOICE_MODELS, "--out", out]);
    const sum = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.deepEqual(sum.blocks, [0, 1]);
    // Block 0: 0-30 s plus the 20 ms the join crossfades over; block 1: 30-40 s (the video's end).
    assert.equal(await samples(join(out, "voice-0.flac")), 30 * SR + 0.02 * SR);
    assert.equal(await samples(join(out, "voice-1.flac")), 10 * SR);
    // The pause (fan noise only) between the sentences: far quieter; the sentence keeps its level.
    const noiseIn = await rms(join(dir, "foot.mp4"), 12, 2), noiseOut = await rms(join(out, "voice-0.flac"), 12, 2);
    const talkIn = await rms(join(dir, "foot.mp4"), 3, 4), talkOut = await rms(join(out, "voice-0.flac"), 3, 4);
    assert.ok(noiseIn > -50 && noiseOut < noiseIn - 20, `noise ${noiseIn} -> ${noiseOut} dB`);
    assert.ok(Math.abs(talkOut - talkIn) < 6, `speech ${talkIn} -> ${talkOut} dB`);
    // Joined from the video's start: the whole length; a block not made is silence.
    const joined = join(dir, "voice.flac"), half = join(dir, "voice-half.flac");
    await run(PY, [VOICE_PY, "--join", "--dir", out, "--blocks", "0,1", "--block", String(VOICE_BLOCK), "--seconds", String(SECONDS), "--out", joined]);
    await run(PY, [VOICE_PY, "--join", "--dir", out, "--blocks", "1", "--block", String(VOICE_BLOCK), "--seconds", String(SECONDS), "--out", half]);
    assert.equal(await samples(joined), SECONDS * SR);
    assert.equal(await samples(half), SECONDS * SR);
    assert.equal(await rms(half, 0, 29.9, ""), -200);
    assert.ok(Math.abs((await rms(half, 32, 5)) - (await rms(joined, 32, 5))) < 0.1);
    // No step where two blocks meet (both are the same voice there, made from the same seconds either side).
    const seam = execFileSync(PY, ["-I", "-c", `
import numpy as np, subprocess, sys
x=np.frombuffer(subprocess.run(["ffmpeg","-v","error","-i",sys.argv[1],"-f","f32le","-"],capture_output=True,check=True).stdout,np.float32)
i=30*48000; d=np.abs(np.diff(x[i-2000:i+2000])); print(float(d.max()), float(np.abs(np.diff(x[i-48000:i-2000])).max()))
`, joined]).toString().trim().split(" ").map(Number);
    assert.ok(seam[0] <= Math.max(0.02, seam[1] * 1.5), `largest step at the join ${seam[0]} (elsewhere ${seam[1]})`);
    assert.ok((await stat(joined)).size > 0);
  });

  it("an edit with the studio voice preset renders its dialogue from the cleaned voice", { timeout: 240_000 }, async () => {
    const src: SourceInfo = { width: 320, height: 180, fps: 30, seconds: SECONDS, hasAudio: true };
    const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined } as unknown as EditContext;
    let s: Snapshot = { timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "w", aspect: "16:9", styleId: null };
    s = applyOp(s, { op: "batch", ops: [{ op: "set_clips", track: "v1", clips: [{ start: 0, end: 9, label: "a" }, { start: 30, end: 38, label: "b" }] }, { op: "set_captions", on: false }, { op: "set_audio", cleanup: "studio", loudness: null }] } as Op, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source: src, videoId: "v" });
    assert.deepEqual(plan.voices, { v: { videoId: "v", enhance: 100, dereverb: 60, blocks: [0, 1] } });
    const out = join(dir, "out.mp4");
    const made = ffmpegArgs(plan, { source: join(dir, "foot.mp4"), output: out, assPath: join(dir, "c.ass"), voices: { v: join(dir, "voice.flac") } }, src, {});
    await writeFile(join(dir, "g.txt"), made.filterGraph);
    await run("ffmpeg", made.args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));
    // The edit's 0.5-1.5 s are the room before the first sentence: quiet now; the sentence is there.
    const pause = await rms(out, 0.5, 1), talk = await rms(out, 3, 4);
    const roomPause = await rms(join(dir, "foot.mp4"), 0.5, 1);
    assert.ok(pause < roomPause - 20, `pause ${roomPause} -> ${pause} dB`);
    assert.ok(talk > -40, `speech ${talk} dB`);
  });
});
