// Phase 3: the sound. Cleanup presets, loudness (-14 LUFS / -1 dBTP by default, two passes), fades, ducking under
// speech, per-clip gain; the same curves in the render's expressions and in the live player; the check's sound lines.
import { describe, expect, it } from "vitest";
import {
  applyOp, audioAt, buildInitialTimeline, buildInitialTimelineA, duckExpr, duckFactor, dialogueExpr, dialogueGain, editCheck, fadeFactor,
  STYLES, stubTranscript, summarizeTimeline, DUCK_ATTACK, DUCK_RELEASE,
  type Clip, type EditContext, type FileMeasure, type Snapshot, type Transcript,
} from "../src/index";
import { ffmpegArgs, loudnessGain, planRender, readMixLoudness } from "../src/renderPlan";

const tr = stubTranscript(40);
const ctx: EditContext = {
  videoId: "vid1", transcript: tr, silences: [], sceneCuts: [], duration: 40, getStyle: (id) => STYLES.find((s) => s.id === id),
  getVideo: (id) => (id === "noTr" ? { id, name: "No transcript", seconds: 20, ready: true } : undefined),
};
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 40, "clean", [], "vid1"), name: "t", aspect: "16:9", styleId: "s2" });
const edit = (s: Snapshot, ...ops: Parameters<typeof applyOp>[1][]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "vid1", sources: { noTr: { ...source, seconds: 20 } } });
const files = (p: ReturnType<typeof plan>) => ({ source: "/m.mp4", videos: { noTr: "/n.mp4" }, output: "/o.mp4", audio: Object.fromEntries(p.audio.map((a) => [a.clipId, "/a.m4a"])) });
/** Evaluates an FFmpeg expression at t (the functions the expressions use). */
const evalExpr = (expr: string, t: number) => new Function("t", "clip", "min", "max", "gte", "lt", "pow", `return ${expr}`)(t, (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)), Math.min, Math.max, (a: number, b: number) => +(a >= b), (a: number, b: number) => +(a < b), Math.pow);

describe("the sound settings", () => {
  it("defaults: no cleanup, -14 LUFS / -1 dBTP, music 12 dB down under speech", () => {
    const p = plan(snap());
    expect(p.audioMix).toMatchObject({ cleanup: "none", loudness: -14, peak: -1, duck: 12, fadeIn: 0, fadeOut: 0 });
    expect(p.operations.join("\n")).toMatch(/Loudness: measured first, then set to -14 LUFS with a -1 dBTP true-peak ceiling/);
    expect(summarizeTimeline(snap(), tr)).toMatch(/Sound: cleanup none, -14 LUFS \/ -1 dBTP, music 12 dB down under speech\./);
  });
  it("set_audio changes what it is given and keeps the rest; fades must fit the edit", () => {
    const r = edit(snap(), { op: "set_audio", cleanup: "voice", duck: 8, fadeIn: 0.5, fadeOut: 1 });
    expect(r.summary).toMatch(/sound: cleanup voice, -14 LUFS \/ -1 dBTP, music 8 dB down under speech, mix fades in 0.5s, out 1s/);
    const off = edit(r.snap, { op: "set_audio", loudness: null }).snap;
    expect(off.timeline.audio).toMatchObject({ cleanup: "voice", loudness: null, duck: 8 });
    const short = edit(snap(), { op: "set_clips", track: "v1", clips: [{ start: 0, end: 5, label: "" }] }).snap;
    expect(() => edit(short, { op: "set_audio", fadeIn: 3, fadeOut: 3 })).toThrow(/longer than the edit \(5.0s\)/);
  });
  it("set_clip_audio: a dialogue clip's gain and fades, a music clip's fades", () => {
    const s0 = edit(snap(), { op: "add_music", trackId: "m_lofi" }).snap;
    const c = s0.timeline.tracks.v1[1], m = s0.timeline.tracks.a2[0];
    const r = edit(s0, { op: "set_clip_audio", clipId: c.id, gainDb: 4, fadeIn: 0.3 }, { op: "set_clip_audio", track: "a2", clipId: m.id, fadeIn: 2, fadeOut: 3, gainDb: -22 });
    expect(r.summary).toMatch(/dialogue: \+4 dB, fade in 0.3s; .*: -22 dB, fade in 2s, fade out 3s/);
    const p = plan(r.snap);
    const v = p.parts; void v;
    const span = p.audioMix!.dialogue[0];
    expect(span).toMatchObject({ gainDb: 4, fadeIn: 0.3, fadeOut: 0 });
    expect(span.start).toBeCloseTo(c.start, 1);
    expect(p.audio[0]).toMatchObject({ kind: "music", gainDb: -22, fadeIn: 2, fadeOut: 3 });
    expect(summarizeTimeline(r.snap, tr)).toMatch(/dialogue \+4 dB fades 0.3\/0s/);
    expect(() => edit(s0, { op: "set_clip_audio", clipId: c.id, fadeIn: 30 })).toThrow(/do not fit/);
    expect(() => edit(s0, { op: "set_clip_audio", clipId: c.id })).toThrow(/Send gainDb/);
  });
});

describe("where music ducks: under the words, joined across short gaps", () => {
  it("speech follows the spoken words; a video without a transcript counts as speech where heard", () => {
    const words = tr.flatMap((l) => l.words);
    const p = plan(snap());
    const sp = p.audioMix!.speech;
    expect(sp[0].start).toBeCloseTo(words[0].t, 2);
    expect(sp.every((r, i) => i === 0 || r.start - sp[i - 1].end >= 1)).toBe(true); // gaps under 1 s are joined
    const withOther = plan(edit(snap(), { op: "add_clip", videoId: "noTr", from: 2, to: 5 }).snap);
    const last = withOther.audioMix!.speech[withOther.audioMix!.speech.length - 1];
    expect(last.end).toBeCloseTo(withOther.outputSeconds, 1); // the whole added clip
  });
  it("muted dialogue is not speech", () => {
    const s = snap();
    const c = s.timeline.tracks.v1[0];
    const p = plan(edit(s, { op: "set_audio_offset", clipId: c.id, muted: true }).snap);
    expect(p.audioMix!.speech.every((r) => r.start >= c.end - 0.01)).toBe(true);
  });
});

describe("the render's expressions are the player's curves", () => {
  const ranges = [{ start: 2, end: 4 }, { start: 6, end: 9.5 }];
  it("ducking: down 0.2 s before speech, back up over 0.5 s after", () => {
    const e = duckExpr(ranges);
    for (const t of [0, 1.8, 1.9, 2, 3, 4.2, 4.5, 5.9, 7, 9.7, 12]) expect(evalExpr(e, t)).toBeCloseTo(duckFactor(ranges, t), 6);
    expect(duckFactor(ranges, 2 - DUCK_ATTACK / 2)).toBeCloseTo(0.5, 6);
    expect(duckFactor(ranges, 4 + DUCK_RELEASE)).toBe(0);
  });
  it("dialogue: each clip's gain and fades, 1 elsewhere", () => {
    const spans = [{ start: 1, end: 3, gainDb: 6, fadeIn: 0.5, fadeOut: 0 }, { start: 5, end: 8, gainDb: -3, fadeIn: 0, fadeOut: 1 }];
    const e = dialogueExpr(spans)!;
    for (const t of [0, 1, 1.25, 2, 2.99, 3, 4, 5, 7.5, 7.99, 9]) expect(evalExpr(e, t)).toBeCloseTo(dialogueGain(spans, t), 6);
    expect(dialogueGain(spans, 1.25)).toBeCloseTo(Math.pow(10, 6 / 20) * 0.5, 6);
    expect(fadeFactor(0.25, 0, 10, 0.5, 0)).toBeCloseTo(0.5, 6);
  });
});

describe("the graph", () => {
  it("cleanup, declick at cuts, dialogue gains and fades, ducked music, mix fades, loudness with a true-peak limiter", () => {
    const s0 = edit(snap(), { op: "add_music", trackId: "m_lofi" }, { op: "cut_words", from: 10, to: 12 }).snap;
    const s = edit(s0, { op: "set_audio", cleanup: "voice", fadeIn: 0.5, fadeOut: 1 }, { op: "set_clip_audio", clipId: s0.timeline.tracks.v1[0].id, gainDb: 3 }).snap;
    const p = plan(s);
    const g = ffmpegArgs(p, files(p), source, { loudnessGainDb: 2.5 }).filterGraph;
    expect(g).toMatch(/afftdn=nr=10:nf=-40:tn=1,.*deesser=i=0.4,acompressor=threshold=-18dB:ratio=3/); // the voice preset
    expect(g).toMatch(/atrim=start=[\d.]+:end=[\d.]+,asetpts=PTS-STARTPTS,afade=t=in:d=0\.004000,afade=t=out:st=[\d.]+:d=0\.004000\[a\d+\]/); // no click at cuts
    expect(g).toMatch(/asetnsamples=n=480,volume='1\+gte\(t,/); // the clip's gain
    expect(g).toMatch(/volume='pow\(10,-12\*\(min\(1,clip/); // music ducking
    expect(g).toMatch(/amix=inputs=2:normalize=0:duration=first,afade=t=in:d=0\.500,afade=t=out:st=[\d.]+:d=1\.000,volume=2\.50dB,aresample=192000,alimiter=limit=0\.7943:attack=5:release=50:level=disabled,aresample=48000\[aout\]/);
    expect(g).not.toMatch(/sidechaincompress/);
  });
  it("the measuring pass: audio only, through ebur128, to nowhere; a normalized render needs its gain", () => {
    const s = edit(snap(), { op: "add_music", trackId: "m_lofi" }).snap;
    const p = plan(s);
    const m = ffmpegArgs(p, files(p), source, { measure: true });
    expect(m.filterGraph).not.toMatch(/\[vout\]|fps=30|concat=n=\d+:v=1/);
    expect(m.filterGraph).toMatch(/ebur128=peak=true:framelog=quiet\[aout\]$/);
    expect(m.args.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(() => ffmpegArgs(p, files(p), source)).toThrow(/measure the mix first/);
  });
  it("loudness off: the old limiter, no measuring needed", () => {
    const s = edit(snap(), { op: "set_audio", loudness: null }).snap;
    const p = plan(s);
    expect(ffmpegArgs(p, files(p), source).filterGraph).toMatch(/anull,alimiter=limit=0\.95\[aout\]$/);
  });
  it("reads the measuring pass and turns it into a gain (capped; silence gets none)", () => {
    const log = "[Parsed_ebur128_9 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.4 LUFS\n\n  True peak:\n    Peak:       -6.1 dBFS";
    expect(readMixLoudness(log)).toEqual({ lufs: -23.4, peakDb: -6.1 });
    expect(loudnessGain(-14, -23.4)).toBe(9.4);
    expect(loudnessGain(-14, -60)).toBe(24);
    expect(loudnessGain(-14, -120)).toBe(0);
    expect(loudnessGain(-14, null)).toBe(0);
  });
});

describe("the live player's levels", () => {
  it("music ducks under speech and fades with the mix; the dialogue follows its clip's gain", () => {
    const s0 = edit(snap(), { op: "add_music", trackId: "m_lofi", gainDb: -18 }).snap;
    const s = edit(s0, { op: "set_audio", fadeIn: 1 }, { op: "set_clip_audio", clipId: s0.timeline.tracks.v1[1].id, gainDb: -6 }).snap;
    const p = plan(s);
    const sp = p.audioMix!.speech[0];
    const under = audioAt(p, (sp.start + sp.end) / 2);
    expect(under.music[0].gain).toBeCloseTo(Math.pow(10, (-18 - 12) / 20), 4);
    const half = audioAt(p, 0.5);
    expect(half.dialogue).toBeCloseTo(0.5, 4); // the mix fades in over 1 s
    const c = p.audioMix!.dialogue[0];
    expect(audioAt(p, (c.start + c.end) / 2).dialogue).toBeCloseTo(Math.pow(10, -6 / 20), 4);
  });
});

describe("the check's sound lines", () => {
  const s = snap();
  const ok: FileMeasure = { videoSeconds: 40, audioSeconds: 40, black: [], silences: [], lufs: -14.3, peakDb: -1.4, graphics: [] };
  it("on target: no flag; off target or over the ceiling: flagged", () => {
    expect(editCheck(s, tr, { measured: ok })).toMatch(/Loudness of the file: -14.3 LUFS, true peak -1.4 dBTP \(target -14 LUFS, ceiling -1 dBTP\)/);
    expect(editCheck(s, tr, { measured: ok })).not.toMatch(/target -14$|over the/m);
    const bad = editCheck(s, tr, { measured: { ...ok, lufs: -16.2, peakDb: -0.5 } });
    expect(bad).toMatch(/loudness -16.2 LUFS, target -14/);
    expect(bad).toMatch(/true peak -0.5 dBTP over the -1 dBTP ceiling/);
  });
  it("a version mixed before Phase 3 is checked as it was mixed", () => {
    const a: Snapshot = { timeline: buildInitialTimelineA(tr, 40, "clean"), name: "t", aspect: "16:9", styleId: "s2" };
    const out = editCheck(a, tr, { measured: { ...ok, lufs: -13.5, peakDb: -0.4 }, videoId: "vid1" });
    expect(out).toMatch(/Sound: mixed before Phase 3 \(limiter only\)/);
    expect(out).toMatch(/peak -0.4dB \(may clip\)/);
  });
  void ({} as Clip); void ({} as Transcript);
});
