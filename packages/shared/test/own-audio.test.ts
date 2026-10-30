// The user's own audio files: set_voice plays a file in place of every clip's sound (a voice enhanced outside Rendrr
// from this edit's exported sound), add_music soundId puts one under the edit. The plan, the FFmpeg graph and the live
// player's levels.
import { describe, expect, it } from "vitest";
import { applyOp, audioAt, buildInitialTimeline, buildTranscript, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type SourceInfo } from "../src/renderPlan";

const WORDS = Array.from({ length: 30 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const SRC: SourceInfo = { width: 1920, height: 1080, fps: 30, seconds: 20, hasAudio: true };
const sounds = { snd1: { id: "snd1", name: "Cold Outreaching enhanced", seconds: 9, ready: true }, snd2: { id: "snd2", name: "Busy", seconds: 5, ready: false }, mus: { id: "mus", name: "My track", seconds: 60, ready: true } };
const ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 20, getStyle: () => undefined, getSound: (id: string) => sounds[id as keyof typeof sounds] } as unknown as EditContext;
const base = (): Snapshot => {
  const s: Snapshot = { timeline: buildInitialTimeline(tr, 20, "clean", [], "v"), name: "t", aspect: "16:9", styleId: null };
  return applyOp(s, { op: "set_clips", track: "v1", clips: [{ start: 1, end: 5, label: "" }, { start: 10, end: 15, label: "" }] } as Op, ctx).snap; // 9 s
};
const keys = { snd1: { key: "sounds/u/snd1.m4a", seconds: 9, name: "Cold Outreaching enhanced" }, mus: { key: "sounds/u/mus.m4a", seconds: 60, name: "My track" } };
const plan = (s: Snapshot, withSounds = true) => planRender({ kind: "preview", snapshot: s, transcript: tr, source: SRC, videoId: "v", ...(withSounds ? { sounds: keys } : {}) });
const files = { source: "/in.mp4", output: "/o.mp4", assPath: "/c.ass", audio: { voice: "/voice.m4a" } as Record<string, string> };

describe("set_voice", () => {
  it("plays the file in place of every clip's sound, says how it lines up, and is undone with null", () => {
    const r = applyOp(base(), { op: "set_voice", soundId: "snd1" } as Op, ctx);
    expect(r.snap.timeline.voice).toEqual({ soundId: "snd1", start: 0, editSeconds: 9 });
    expect(r.summary).toBe('the edit\'s sound is now "Cold Outreaching enhanced" (9.00s, from 0.00s of the edit, 9.00s long): it lines up with the edit\'s end. Every clip\'s own sound is off; later cuts are not in the file, so make it last');
    const off = applyOp(r.snap, { op: "set_voice", soundId: null } as Op, ctx);
    expect(off.snap.timeline.voice).toBeUndefined();
    expect(off.summary).toBe("the edit plays its clips' own sound again");
  });
  it("refuses a file that is not there or not ready", () => {
    expect(() => applyOp(base(), { op: "set_voice", soundId: "nope" } as Op, ctx)).toThrow(/no audio file "nope"/);
    expect(() => applyOp(base(), { op: "set_voice", soundId: "snd2" } as Op, ctx)).toThrow(/still being prepared/);
  });
  it("the plan has the voice; the graph reads the file and no footage sound at all", () => {
    const s = applyOp(base(), { op: "set_voice", soundId: "snd1" } as Op, ctx).snap;
    const p = plan(s);
    expect(p.audio).toEqual([{ clipId: "voice", start: 0, end: 9, gainDb: 0, assetKey: "sounds/u/snd1.m4a", kind: "voice", fadeIn: 0, fadeOut: 0, soundId: "snd1" }]);
    expect(p.operations.some((l) => /^Voice: "Cold Outreaching enhanced" plays in place of every clip's own sound, from 0s \(9s file, edit 9s\)$/.test(l))).toBe(true);
    const { args, filterGraph } = ffmpegArgs(p, files, SRC, { loudnessGainDb: 0 });
    expect(args).toContain("/voice.m4a");
    expect(filterGraph).toContain("volume=0dB,adelay=delays=0:all=1,apad=whole_dur=9.000000,atrim=end=9.000000[acat]");
    expect(filterGraph).not.toMatch(/\[\d+:a\]asetpts|atrim=start=/); // no clip's sound is read
    expect(args.filter((a) => a === "-i").length).toBe(2); // the footage (picture) and the voice
  });
  it("a cut after it is said: the file no longer lines up", () => {
    let s = applyOp(base(), { op: "set_voice", soundId: "snd1" } as Op, ctx).snap;
    s = applyOp(s, { op: "set_clips", track: "v1", clips: [{ start: 1, end: 4, label: "" }, { start: 10, end: 15, label: "" }] } as Op, ctx).snap;
    expect(plan(s).operations.find((l) => l.startsWith("Voice:"))).toMatch(/the edit was 9s when the voice was set: a cut since then is not in the file, so it is out of sync after it/);
  });
  it("without the file (not this user's, deleted), the clips' sound plays and the plan says so", () => {
    const s = applyOp(base(), { op: "set_voice", soundId: "snd1" } as Op, ctx).snap;
    const p = plan(s, false);
    expect(p.audio).toEqual([]);
    expect(p.operations).toContain("Voice left out: its audio file is not in Rendrr (the clips' own sound plays)");
  });
  it("the live player: the footage silent, the file at its level", () => {
    const p = plan(applyOp(base(), { op: "set_voice", soundId: "snd1", gainDb: -3 } as Op, ctx).snap);
    const lv = audioAt(p, 2);
    expect(lv.dialogue).toBe(0);
    expect(lv.sfx).toEqual([{ clipId: "voice", assetKey: "sounds/u/snd1.m4a", src: 2, gain: expect.closeTo(Math.pow(10, -3 / 20), 6) }]);
  });
});

describe("add_music soundId", () => {
  it("puts the user's own file under the edit, ducked like library music", () => {
    const r = applyOp(base(), { op: "add_music", soundId: "mus" } as Op, ctx);
    expect(r.summary).toMatch(/^added music: My track \(clip m\w+\)$/);
    const p = plan(r.snap);
    expect(p.audio).toHaveLength(1);
    expect(p.audio[0]).toMatchObject({ kind: "music", assetKey: "sounds/u/mus.m4a", soundId: "mus", start: 0, end: 9, gainDb: -18 });
    expect(() => applyOp(base(), { op: "add_music", soundId: "mus", trackId: "lofi" } as Op, ctx)).toThrow(/not both/);
    expect(() => applyOp(base(), { op: "add_music" } as Op, ctx)).toThrow(/needs trackId/);
    // Without its file, left out and said.
    expect(plan(r.snap, false).operations.some((l) => /^Music m\w+ left out: its audio file is not in Rendrr$/.test(l))).toBe(true);
  });
});
