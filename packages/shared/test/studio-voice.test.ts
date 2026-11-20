// Studio voice: the voice presets' AI steps (enhance: DeepFilterNet3 noise and room removal; dereverb: WPE echo
// removal), made before the render in blocks of footage and read in place of the footage's sound; leveling and
// crispness in the chain; set_audio's hand values; the plan, the graph, the check text and the render's limit.
import { describe, expect, it } from "vitest";
import {
  applyOp, audioSettings, buildInitialTimeline, buildTranscript, CLEANUP_CHAINS, CLEANUP_PRESETS, cleanupChain, cleanupParams, cleanupText, crispFilter, EDITING_SKILL, HOW_TO_EDIT, levelFilter, MCP_TOOLS, renderLimitMs, summarizeTimeline,
  VOICE_BLOCK, VOICE_PRESETS, voiceAllowanceMs, voiceBlocks, voiceKey, voiceTag, type EditContext, type Op, type Snapshot,
} from "../src/index";
import { ffmpegArgs, planRender, windowPlan, type SourceInfo } from "../src/renderPlan";

const WORDS = Array.from({ length: 160 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const SRC: SourceInfo = { width: 1920, height: 1080, fps: 30, seconds: 90, hasAudio: true };
const sounds = { snd1: { id: "snd1", name: "Enhanced", seconds: 30, ready: true } };
const ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 90, getStyle: () => undefined, getSound: (id: string) => sounds[id as keyof typeof sounds] } as unknown as EditContext;
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : ({ op: "batch", ops } as Op), ctx);
/** Two clips: 2-20 s and 70-80 s of the footage. */
const base = (): Snapshot => edit({ timeline: buildInitialTimeline(tr, 90, "clean", [], "v"), name: "t", aspect: "16:9", styleId: null }, { op: "set_clips", track: "v1", clips: [{ start: 2, end: 20, label: "" }, { start: 70, end: 80, label: "" }] } as Op).snap;
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source: SRC, videoId: "v", sounds: { snd1: { key: "sounds/u/snd1.m4a", seconds: 30, name: "Enhanced" } } });
const files = (p: ReturnType<typeof plan>) => ({ source: "/in.mp4", output: "/o.mp4", assPath: "/c.ass", audio: Object.fromEntries(p.audio.map((a) => [a.clipId, "/a.m4a"])), voices: Object.fromEntries(Object.keys(p.voices ?? {}).map((v) => [v, `/voice-${v}.flac`])) });

describe("the studio voice preset and its hand values", () => {
  it("studio: AI noise and echo removal first, then a full close-mic tone, crispness, de-esser, leveling and compression", () => {
    expect(CLEANUP_PRESETS.studio).toMatchObject({ enhance: 100, dereverb: 60, level: 50, crisp: 25 });
    expect(CLEANUP_CHAINS.studio).toBe("highpass=f=80,equalizer=f=180:t=q:w=0.9:g=1.5,equalizer=f=250:t=q:w=1:g=-2.5,equalizer=f=4500:t=q:w=1:g=2.5,treble=g=3:f=10000:t=q:w=0.7,aexciter=amount=1.45:drive=8.5:blend=0:freq=6000:ceil=16000,deesser=i=0.4,dynaudnorm=f=250:g=31:p=0.9:m=1.995,acompressor=threshold=-21dB:ratio=3:attack=5:release=90");
    expect(VOICE_PRESETS[1]).toMatchObject({ id: "studio", name: "Studio voice" });
    // The presets that clean the voice use the AI now, not FFmpeg's FFT denoiser.
    for (const k of ["studio", "podcast", "voice", "noisy", "roomy"] as const) {
      expect(CLEANUP_PRESETS[k].enhance).toBeGreaterThan(0);
      expect(CLEANUP_CHAINS[k]).not.toMatch(/afftdn/);
    }
    expect(CLEANUP_PRESETS.roomy.dereverb).toBe(100);
    for (const k of ["light", "balanced", "warm", "bright", "radio", "phone", "soft", "punchy"] as const) expect(CLEANUP_PRESETS[k]).toMatchObject({ enhance: 0, dereverb: 0, level: 0, crisp: 0 });
  });
  it("leveling and crispness as numbers: +12 dB at most at level 100, harmonics from 6 kHz", () => {
    expect(levelFilter(100)).toBe("dynaudnorm=f=250:g=31:p=0.9:m=3.981");
    expect(levelFilter(50)).toBe("dynaudnorm=f=250:g=31:p=0.9:m=1.995");
    expect(crispFilter(100)).toBe("aexciter=amount=4.00:drive=8.5:blend=0:freq=6000:ceil=16000");
    expect(cleanupChain(cleanupParams({ cleanup: "none", level: 40 }))).toBe("dynaudnorm=f=250:g=31:p=0.9:m=1.738");
    expect(cleanupChain(cleanupParams({ cleanup: "none", enhance: 100, dereverb: 50 }))).toBe(""); // the AI steps are made before the render
  });
  it("set_audio sets them by hand over the preset, says so, and null goes back to the preset's", () => {
    const r = edit(base(), { op: "set_audio", cleanup: "studio", enhance: 70, dereverb: 100, level: 0, crisp: 60 } as Op);
    expect(r.summary).toMatch(/cleanup studio, AI noise removal 70, echo removal 100, no leveling, crispness 60/);
    expect(cleanupText(audioSettings(r.snap.timeline))).toBe("studio, AI noise removal 70, echo removal 100, no leveling, crispness 60");
    expect(summarizeTimeline(r.snap, tr)).toMatch(/Sound: cleanup studio, AI noise removal 70/);
    const back = edit(r.snap, { op: "set_audio", enhance: null, level: null } as Op).snap;
    expect(back.timeline.audio).toMatchObject({ cleanup: "studio", dereverb: 100, crisp: 60 });
    expect(back.timeline.audio).not.toHaveProperty("enhance");
    // A new preset starts from its own values.
    expect(edit(r.snap, { op: "set_audio", cleanup: "podcast" } as Op).snap.timeline.audio).not.toHaveProperty("crisp");
    expect(() => edit(base(), { op: "set_audio", enhance: 120 } as Op)).toThrow();
    expect(edit(base(), { op: "set_audio", cleanup: "studio" } as Op).summary).toMatch(/cleanup studio/);
  });
});

describe("the studio voice in the plan and the graph", () => {
  it("the blocks of footage the dialogue reads, at the strengths in steps of 10, read in place of the footage's sound", () => {
    const s = edit(base(), { op: "set_audio", cleanup: "studio", enhance: 84, dereverb: 55 } as Op).snap;
    const p = plan(s);
    // 2-20 s and 70-80 s with a second either side: blocks 0 (0-30) and 2 (60-90).
    expect(p.voices).toEqual({ v: { videoId: "v", enhance: 80, dereverb: 60, blocks: [0, 2] } });
    expect(p.operations.join("\n")).toMatch(/Studio voice: the dialogue read from its studio voice: AI noise and room removal 80 \(DeepFilterNet3\), echo removal 60 \(WPE\); made once per 30 s block of footage \(2 blocks\) and kept/);
    const a = ffmpegArgs(p, files(p), SRC, { loudnessGainDb: 0 });
    // The dialogue reads the voice file (seeked windows of it); the footage gives the picture only.
    const inputs = a.args.filter((x, i) => a.args[i - 1] === "-i");
    expect(inputs).toContain("/voice-v.flac");
    const vi = inputs.indexOf("/voice-v.flac"), si = inputs.indexOf("/in.mp4");
    expect(a.filterGraph).toMatch(new RegExp(`\\[${vi}:a\\]`));
    expect(a.filterGraph).not.toMatch(new RegExp(`\\[${si}:a\\]`));
    expect(a.filterGraph).toContain(cleanupChain(cleanupParams(audioSettings(s.timeline))));
    // The measuring pass reads it too (the loudness is the cleaned voice's).
    const m = ffmpegArgs(p, files(p), SRC, { measure: true });
    expect(m.args).toContain("/voice-v.flac");
    // Without the file the render stops rather than play the noisy sound.
    expect(() => ffmpegArgs(p, { ...files(p), voices: {} }, SRC, { loudnessGainDb: 0 })).toThrow(/studio voice of a video in this edit is missing/);
  });
  it("none without an AI step, with the user's own voice file, or for muted clips", () => {
    expect(plan(base()).voices).toBeUndefined();
    expect(plan(edit(base(), { op: "set_audio", cleanup: "warm" } as Op).snap).voices).toBeUndefined();
    expect(plan(edit(base(), { op: "set_audio", cleanup: "studio", enhance: 0, dereverb: 0 } as Op).snap).voices).toBeUndefined();
    expect(plan(edit(base(), { op: "set_audio", cleanup: "studio", enhance: 4, dereverb: 3 } as Op).snap).voices).toBeUndefined(); // rounds to 0
    expect(plan(edit(base(), { op: "set_audio", cleanup: "warm", dereverb: 50 } as Op).snap).voices).toEqual({ v: { videoId: "v", enhance: 0, dereverb: 50, blocks: [0, 2] } });
    const own = edit(base(), { op: "set_audio", cleanup: "studio" } as Op, { op: "set_voice", soundId: "snd1" } as Op).snap;
    expect(plan(own).voices).toBeUndefined();
    const s = edit(base(), { op: "set_audio", cleanup: "studio" } as Op).snap;
    const muted = edit(s, { op: "set_audio_offset", clipId: s.timeline.tracks.v1[1].id, muted: true } as Op).snap;
    expect(plan(muted).voices?.v.blocks).toEqual([0]);
  });
  it("a sample keeps every block (its loudness is measured over the whole mix)", () => {
    const p = plan(edit(base(), { op: "set_audio", cleanup: "studio" } as Op).snap);
    expect(windowPlan(p, 1, 3).voices).toEqual(p.voices);
  });
});

describe("the blocks, their keys and the render's limit", () => {
  it("blocks of VOICE_BLOCK s from the video's start, a second to spare each side, never past its end", () => {
    expect(VOICE_BLOCK).toBe(30);
    expect(voiceBlocks(2, 20)).toEqual([0]);
    expect(voiceBlocks(29.5, 31)).toEqual([0, 1]);
    expect(voiceBlocks(70, 80, 90)).toEqual([2]);
    expect(voiceBlocks(85, 89.5, 90)).toEqual([2]);
    expect(voiceBlocks(20, 10)).toEqual([0]); // either order
    expect(voiceTag({ enhance: 84, dereverb: 55 })).toBe("e80-d60");
    expect(voiceKey("u1", "v1", "e80-d60", 3)).toBe("frames/u1/v1/voice-v1-e80-d60-3.flac");
  });
  it("the render may take longer when the voice has to be made: every block at 3x real time, plus 20 s", () => {
    expect(voiceAllowanceMs(base().timeline)).toBe(0);
    expect(voiceAllowanceMs(null)).toBe(0);
    const s = edit(base(), { op: "set_audio", cleanup: "studio" } as Op).snap;
    expect(voiceAllowanceMs(s.timeline)).toBe(20_000 + 2 * 10_000);
    expect(renderLimitMs("preview", 90, null, s.timeline) - renderLimitMs("preview", 90, null, base().timeline)).toBe(40_000);
  });
});

describe("what Claude reads", () => {
  it("set_audio names the studio voice and its four values; the guide says which to use for echo, noise, crispness and level", () => {
    const apply = JSON.stringify(MCP_TOOLS.find((t) => t.name === "apply_edits"));
    for (const w of ["studio (Studio voice", "enhance 0-100", "dereverb 0-100", "level 0-100", "crisp 0-100"]) expect(apply).toContain(w);
    expect(HOW_TO_EDIT).toMatch(/A better voice: cleanup studio \(or podcast\); less echo or room: dereverb 80-100; less noise: enhance 100; crisper: crisp 40-70/);
    expect(EDITING_SKILL).toMatch(/cleanup studio \(the AI takes noise, room and echo out/);
  });
});
