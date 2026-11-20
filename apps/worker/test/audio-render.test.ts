// Phase 3 sound, rendered and measured: the file lands on -14 LUFS under a -1 dBTP ceiling (also with sharp peaks),
// music goes down by the set amount under speech, fades fade, and the cleanup presets lower the noise. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, buildTranscript, noiseBetweenWords, STYLES, type EditContext, type Op, type Snapshot, type Transcript } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { measureFile, run } from "../src/lib/ffmpeg";
import { measureMix } from "../src/lib/mix";
import { VOICE_MODELS, VOICE_PY } from "../src/lib/voice";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { VOICE_BLOCK } from "@rendrr/shared";

// The noisy-room cleanup takes the noise out with the AI (python/voice.py): Python with numpy and onnxruntime
// (PYTHON_BIN), DeepFilterNet3's model (VOICE_MODELS) and a voice that is speech (espeak-ng).
const PY = process.env.PYTHON_BIN || "python3";
const has = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const aiReady = has(PY, ["-c", "import numpy, onnxruntime"]) && has("espeak-ng", ["--version"]) && existsSync(join(VOICE_MODELS, "enc.onnx"));

const SECONDS = 12;
const words = (from: number, to: number) => buildTranscript([Array.from({ length: Math.floor((to - from) / 0.5) }, (_, i) => ({ text: `w${i}`, start: from + i * 0.5, end: from + i * 0.5 + 0.4 }))], { maxWordsPerLine: 6 })
  .map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const source = (hasAudio = true): SourceInfo => ({ width: 320, height: 180, fps: 30, seconds: SECONDS, hasAudio });

describe("the sound, rendered and measured", () => {
  let dir = "";
  const media: Record<string, string> = {};
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "audio-render-"));
    const v = (name: string, audio: string[], filter = "") => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=gray:s=320x180:r=30:d=${SECONDS}`, ...audio, ...(filter ? ["-filter_complex", filter, "-map", "0:v", "-map", "[a]"] : []), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "192k", "-shortest", (media[name] = join(dir, `${name}.mp4`))]);
    // A quiet voice: a tone around -33 LUFS.
    await v("quiet", ["-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`], "[1:a]volume=-12dB[a]");
    // Far too quiet (around -47 LUFS): more than the 24 dB the loudness step may add.
    await v("faint", ["-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`], "[1:a]volume=-26dB[a]");
    // Sharp peaks: a voice-level tone (around -21 LUFS) with a 0.5 ms full-scale click every second, like plosives.
    await v("peaky", ["-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`, "-f", "lavfi", "-i", `aevalsrc='if(lt(mod(t,1),0.0005),0.99,0)':d=${SECONDS}:s=48000`], "[1:a][2:a]amix=inputs=2:normalize=0[a]");
    // A loud steady tone (-2 dBFS): a cut in it jumps in the middle of a wave.
    await v("tone", ["-f", "lavfi", "-i", `aevalsrc='0.8*sin(2*PI*220*t)':d=${SECONDS}:s=48000`], "[1:a]anull[a]");
    // No sound at all (for ducking: only the music is heard).
    await v("silent", []);
    // A voice from 3 s to 8 s over room noise everywhere (speech, for the AI; a tone where espeak-ng is missing).
    if (aiReady) {
      execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", join(dir, "talk.wav"), "We are going to clean up this voice so it sounds like a studio."]);
      await v("noisy", ["-i", join(dir, "talk.wav"), "-f", "lavfi", "-i", `anoisesrc=c=pink:a=0.02:d=${SECONDS}:r=48000`], "[1:a]aresample=48000,atrim=0:5,volume=-6dB,adelay=3000:all=1,apad=whole_dur=12[s];[s][2:a]amix=inputs=2:normalize=0[a]");
    } else await v("noisy", ["-f", "lavfi", "-i", `sine=f=300:d=${SECONDS}:sample_rate=48000`, "-f", "lavfi", "-i", `anoisesrc=c=pink:a=0.02:d=${SECONDS}:r=48000`], "[1:a]volume=-12dB,volume='between(t,3,8)':eval=frame[s];[s][2:a]amix=inputs=2:normalize=0[a]");
    media.music = join(dir, "music.m4a");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=f=500:d=${SECONDS}:sample_rate=48000`, "-c:a", "aac", media.music]);
  });
  after(async () => { if (process.env.KEEP_AUDIO_TEST) console.log("kept", dir); else await rm(dir, { recursive: true, force: true }); });

  const ctxFor = (tr: Transcript): EditContext => ({ videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: SECONDS, getStyle: (id) => STYLES.find((s) => s.id === id) });
  /** Renders an edit the way the render job does (measure, then render) and measures the file. */
  async function render(name: string, src: string, tr: Transcript, ops: Op[], hasAudio = true) {
    let s: Snapshot = { timeline: buildInitialTimeline(tr, SECONDS, "clean", [], "v"), name, aspect: "16:9", styleId: "s2" };
    s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, ...ops] as never }, ctxFor(tr)).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: source(hasAudio), videoId: "v" });
    const files: PlanFiles = { source: media[src], output: join(dir, `out-${name}.mp4`), audio: Object.fromEntries(plan.audio.map((a) => [a.clipId, media.music])) };
    // The studio voice, made as the render job does (lib/voice.ts): the blocks, then joined from the video's start.
    for (const vo of Object.values(plan.voices ?? {})) {
      const vdir = join(dir, `voice-${name}`), joined = join(dir, `voice-${name}.flac`);
      await run(PY, [VOICE_PY, "--input", media[src], "--blocks", vo.blocks.join(","), "--block", String(VOICE_BLOCK), "--seconds", String(SECONDS), "--denoise", String(vo.enhance), "--dereverb", String(vo.dereverb), "--models", VOICE_MODELS, "--out", vdir]);
      await run(PY, [VOICE_PY, "--join", "--dir", vdir, "--blocks", vo.blocks.join(","), "--block", String(VOICE_BLOCK), "--seconds", String(SECONDS), "--out", joined]);
      (files.voices ??= {})[vo.videoId] = joined;
    }
    const mix = await measureMix(plan, files, source(hasAudio), { dir });
    const { args, filterGraph } = ffmpegArgs(plan, files, source(hasAudio), { loudnessGainDb: mix.gainDb });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { file: files.output, mix, measured: await measureFile(files.output, { timeoutMs: 60_000 }) };
  }
  const meanDb = async (file: string, from: number, len: number) => {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    return Number(/mean_volume:\s*(-?[\d.]+)/.exec(stderr)?.[1] ?? "-999");
  };

  it("a quiet voice comes out at -14 LUFS under the -1 dBTP ceiling", async () => {
    const { mix, measured } = await render("quiet", "quiet", words(0.5, 11.5), []);
    assert.ok(mix.lufs! < -28, `measured mix ${mix.lufs}`);
    assert.ok(mix.gainDb > 14, `gain ${mix.gainDb}`);
    assert.ok(Math.abs(measured.lufs! - -14) <= 1, `file ${measured.lufs} LUFS`);
    assert.ok(measured.peakDb! <= -1 + 0.2, `true peak ${measured.peakDb}`);
  });

  it("a far too quiet source gets at most +24 dB, and the file's real loudness is what the check sees", async () => {
    const { mix, measured } = await render("faint", "faint", words(0.5, 11.5), []);
    assert.equal(mix.gainDb, 24);
    assert.ok(Math.abs(measured.lufs! - (mix.lufs! + 24)) <= 1, `file ${measured.lufs} LUFS, mix ${mix.lufs}`);
    assert.ok(measured.lufs! < -15, `file ${measured.lufs} LUFS (off target: the check flags it)`);
  });

  it("sharp peaks stay under the ceiling", async () => {
    const { mix, measured } = await render("peaky", "peaky", words(0.5, 11.5), []);
    assert.ok(mix.peakDb! + mix.gainDb > 3, `with the gain the clicks would reach ${(mix.peakDb! + mix.gainDb).toFixed(1)} dBTP`);
    assert.ok(measured.peakDb! <= -1 + 0.2, `true peak ${measured.peakDb} dBTP`);
    assert.ok(Math.abs(measured.lufs! - -14) <= 1, `loudness ${measured.lufs} LUFS`);
  });

  it("other targets are honoured: -23 LUFS, -2 dBTP", async () => {
    const { measured } = await render("broadcast", "quiet", words(0.5, 11.5), [{ op: "set_audio", loudness: -23, peak: -2 }]);
    assert.ok(Math.abs(measured.lufs! - -23) <= 1, `file ${measured.lufs} LUFS`);
    assert.ok(measured.peakDb! <= -2 + 0.2, `true peak ${measured.peakDb}`);
  });

  it("music goes down 12 dB under speech and comes back after", async () => {
    // Speech from 4 s to 6 s; no dialogue sound (silent source), so only the music is heard.
    const { file } = await render("duck", "silent", words(4, 6), [{ op: "add_music", trackId: "m_lofi", gainDb: -10 }, { op: "set_audio", loudness: null }], false);
    const before = await meanDb(file, 1, 1.5), under = await meanDb(file, 4.5, 1), afterwards = await meanDb(file, 8, 1.5);
    assert.ok(Math.abs(before - under - 12) <= 1, `ducked by ${(before - under).toFixed(1)} dB (${before} vs ${under})`);
    assert.ok(Math.abs(afterwards - before) <= 1, `back up: ${afterwards} vs ${before}`);
  });

  it("fades: the whole mix fades in and out", async () => {
    const { file } = await render("fades", "quiet", words(0.5, 11.5), [{ op: "set_audio", fadeIn: 2, fadeOut: 2 }]);
    const start = await meanDb(file, 0, 0.4), mid = await meanDb(file, 5, 2), end = await meanDb(file, SECONDS - 0.4, 0.4);
    assert.ok(mid - start > 12, `fade in: ${start} vs ${mid}`);
    assert.ok(mid - end > 12, `fade out: ${end} vs ${mid}`);
  });

  it("a dialogue clip's gain changes its level only", async () => {
    let s: Snapshot = { timeline: buildInitialTimeline(words(0.5, 11.5), SECONDS, "clean", [], "v"), name: "g", aspect: "16:9", styleId: "s2" };
    s = applyOp(s, { op: "set_clips", track: "v1", clips: [{ start: 0, end: 6, label: "a" }, { start: 6, end: 12, label: "b" }] }, ctxFor(words(0.5, 11.5))).snap;
    const b = s.timeline.tracks.v1[1].id;
    const { file } = await render("gain", "quiet", words(0.5, 11.5), [{ op: "set_clips", track: "v1", clips: [{ id: s.timeline.tracks.v1[0].id, start: 0, end: 6, label: "a" }, { id: b, start: 6, end: 12, label: "b" }] }, { op: "set_clip_audio", clipId: b, gainDb: -6 }, { op: "set_audio", loudness: null }]);
    const a1 = await meanDb(file, 2, 2), b1 = await meanDb(file, 8, 2);
    assert.ok(Math.abs(a1 - b1 - 6) <= 0.5, `second clip ${(a1 - b1).toFixed(2)} dB lower`);
  });

  it("a 20 ms fade at the cut takes the click out", async () => {
    // A cut in a steady tone jumps in the middle of a wave: a step between two samples, many times the tone's own.
    const jump = async (file: string, from: number) => {
      const out = join(dir, "jump.f32");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(from), "-t", "0.2", "-i", file, "-ac", "1", "-f", "f32le", out]);
      const buf = await readFile(out), x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      let m = 0;
      for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
      return m;
    };
    const cutAt = async (name: string, declick: number) => {
      const { file } = await render(name, "tone", words(0.5, 11.5), [{ op: "cut_words", from: 3.03, to: 4.0 }, { op: "set_audio", declick }]);
      return (await jump(file, 2.95)) / (await jump(file, 1.0)); // the cut is at 3.03 s; 1.0-1.2 s has no cut
    };
    const hard = await cutAt("click-on", 0), soft = await cutAt("click-off", 0.02);
    assert.ok(hard > 3, `without the fade the cut jumps ${hard.toFixed(1)}x the tone's own step`);
    assert.ok(soft < 1.3, `with the fade the cut steps ${soft.toFixed(2)}x the tone's own step`);
  });

  it("the check's noise reading between words drops with the noisy-room cleanup", { skip: !aiReady && "needs espeak-ng, PYTHON_BIN with numpy and onnxruntime, and VOICE_MODELS", timeout: 120_000 }, async () => {
    const tr = words(3, 8);
    const a = await render("noise-a", "noisy", tr, [{ op: "set_audio", loudness: null }]);
    const b = await render("noise-b", "noisy", tr, [{ op: "set_audio", loudness: null, cleanup: "noisy" }]);
    const spans = tr.flatMap((l) => l.words).map((w) => ({ start: w.t, end: w.end }));
    const na = noiseBetweenWords(a.measured.momentary, spans, SECONDS), nb = noiseBetweenWords(b.measured.momentary, spans, SECONDS);
    assert.ok(na && nb, "both files have pauses to measure");
    assert.ok(na!.lufs - nb!.lufs >= 6, `noise between words: ${na!.lufs} LUFS without cleanup, ${nb!.lufs} LUFS with it`);
  });

  it("the noisy-room cleanup lowers the noise between the words", { skip: !aiReady && "needs espeak-ng, PYTHON_BIN with numpy and onnxruntime, and VOICE_MODELS", timeout: 120_000 }, async () => {
    const tr = words(3, 8);
    const plain = await render("noisy-none", "noisy", tr, []);
    const clean = await render("noisy-clean", "noisy", tr, [{ op: "set_audio", cleanup: "noisy" }]);
    const snr = async (f: string) => (await meanDb(f, 4, 3)) - (await meanDb(f, 0.5, 2));
    const [a, b] = [await snr(plain.file), await snr(clean.file)];
    assert.ok(b - a >= 6, `voice over noise: ${a.toFixed(1)} dB without cleanup, ${b.toFixed(1)} dB with`);
    assert.ok(Math.abs(clean.measured.lufs! - -14) <= 1, `still on target: ${clean.measured.lufs}`);
  });
});
