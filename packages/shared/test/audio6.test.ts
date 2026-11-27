// Premiere parity, phase 6: a clip's own sound (volume keys, pan, EQ, reverb) and crossfades at dialogue cuts. The
// numbers (keys, balance, the room's impulse response), set_clip_audio and its text, the plan (the clips' effects, the
// rooms to write) and the FFmpeg graph (per clip before the joins; crossfades from the footage past each cut, nothing
// moved; no crossfade: the graph as before).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, dialogueGain, eqChain, keyExpr, keyGainDb, panGains, reverbIr, reverbSeconds, summarizeTimeline, wavStereo, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const clipOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as (SeqClip & Record<string, unknown>)[]).find((c) => c.id === id)!;
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
const graph = (s: Snapshot) => {
  const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
  const irs = Object.fromEntries(Object.keys(p.audioMix?.irs ?? {}).map((n) => [n, `/tmp/${n}`]));
  return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", irs } as PlanFiles, source, { loudnessGainDb: 0 }) };
};

describe("the numbers", () => {
  it("volume keys: a straight line in dB between keys, held before and after; the expression starts and ends the same", () => {
    const keys = [{ t: 1, gainDb: 0 }, { t: 2, gainDb: -12 }, { t: 3, gainDb: -6 }];
    expect([0, 1.5, 2, 2.5, 9].map((t) => keyGainDb(keys, t))).toEqual([0, -6, -12, -9, -6]);
    expect(keyExpr(keys)).toBe("0.000+-12.000*clip((t-1.0000)/1.0000,0,1)+6.000*clip((t-2.0000)/1.0000,0,1)");
    // On dialogue the keys ride on the clip's gain.
    expect(dialogueGain([{ start: 1, end: 5, gainDb: -6, fadeIn: 0, fadeOut: 0, keys: [{ t: 1, gainDb: 0 }, { t: 3, gainDb: -6 }] }], 4)).toBeCloseTo(Math.pow(10, -12 / 20), 6);
  });
  it("pan is a balance: the middle as it was, the far side down", () => {
    expect(panGains(0)).toEqual([1, 1]);
    expect(panGains(-0.5)).toEqual([1, 0.5]);
    expect(panGains(1)).toEqual([0, 1]);
    expect(eqChain({ low: 3, high: -2 })).toBe("lowshelf=g=3:f=120:t=q:w=0.7071,highshelf=g=-2:f=6000:t=q:w=0.7071");
  });
  it("the room: 10 ms of nothing, then a decay as long as the size says, as loud as it lets in, the same every time", () => {
    const [l, r] = reverbIr(40);
    expect(l.length).toBe(Math.round(reverbSeconds(40) * 48000) + 480);
    expect(l.slice(0, 480).every((v) => v === 0)).toBe(true);
    expect(l.reduce((a, v) => a + v * v, 0)).toBeCloseTo(1, 4);
    expect(Array.from(l.slice(1000, 1010))).toEqual(Array.from(reverbIr(40)[0].slice(1000, 1010)));
    expect(l[600]).not.toBe(r[600]);
    const head = l.slice(480, 4800).reduce((a, v) => a + v * v, 0), tail = l.slice(-4320).reduce((a, v) => a + v * v, 0);
    expect(head / tail).toBeGreaterThan(1000);
    const wav = wavStereo(l, r);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + l.length * 8);
  });
});

describe("set_clip_audio", () => {
  it("pan, EQ (merged), reverb and keys on a dialogue clip; the result and get_project say them; null removes", () => {
    let s = edit(base(), { op: "set_clip_audio", clipId: "a", pan: -0.3, eq: { low: 3 }, reverb: { amount: 30, size: 40 }, keys: [{ t: 2, gainDb: -6 }, { t: 1, gainDb: 0 }] } as Op).snap;
    const r = edit(s, { op: "set_clip_audio", clipId: "a", eq: { high: -2 } } as Op);
    s = r.snap;
    expect(clipOf(s, "a")).toMatchObject({ audioPan: -0.3, audioEq: { low: 3, high: -2 }, audioReverb: { amount: 30, size: 40 }, audioKeys: [{ t: 1, gainDb: 0 }, { t: 2, gainDb: -6 }] });
    expect(r.summary).toBe("a's dialogue: 0 dB, pan L 30%, EQ low +3 high -2 dB, reverb 30 (1.2 s room), 2 volume keys");
    expect(summarizeTimeline(s, tr)).toMatch(/dialogue pan L 30%, EQ low \+3 high -2 dB, reverb 30 \(1\.2 s room\), 2 volume keys/);
    s = edit(s, { op: "set_clip_audio", clipId: "a", pan: null, eq: null, reverb: null, keys: null } as Op).snap;
    for (const k of ["audioPan", "audioEq", "audioReverb", "audioKeys"]) expect(clipOf(s, "a")[k]).toBeUndefined();
    expect(() => edit(base(), { op: "set_clip_audio", clipId: "a" } as Op)).toThrow(/Send gainDb, fadeIn, fadeOut, pan, eq, reverb or keys/);
  });
});

describe("the render", () => {
  it("a clip's own sound goes on its dialogue before the joins; the room is a file to write; the keys ride the dialogue's volume", () => {
    const s = edit(base(), { op: "set_clip_audio", clipId: "b", pan: 0.5, eq: { mid: -4 }, reverb: { amount: 50, size: 20 }, keys: [{ t: 0, gainDb: 0 }, { t: 2, gainDb: -10 }] } as Op).snap;
    const { p, g } = graph(s);
    expect(p.audioMix!.clipFx).toEqual({ b: { pan: 0.5, eq: { mid: -4 }, reverb: { amount: 50, size: 20, ir: "ir_20.wav" } } });
    expect(p.audioMix!.irs).toEqual({ "ir_20.wav": 20 });
    expect(p.audioMix!.dialogue[0].keys).toEqual([{ t: 4, gainDb: 0 }, { t: 6, gainDb: -10 }]);
    expect(g.filterGraph).toMatch(/\[sxd1\]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=48000,asplit\[rdd1\]\[rwd1\]/);
    expect(g.filterGraph).toMatch(/equalizer=f=1000:t=q:w=0\.9198:g=-4,pan=stereo\|c0=0\.5000\*c0\|c1=1\.0000\*c1/);
    expect(g.filterGraph).toMatch(/afir=dry=1:wet=1:irnorm=-1,volume=0\.3000/);
    expect(g.filterGraph).toMatch(/pow\(10,\(0\.000\+-10\.000\*clip\(\(t-4\.0000\)\/2\.0000,0,1\)\)\/20\)/);
    expect(g.args.join(" ")).toContain("/tmp/ir_20.wav");
    expect(p.operations.join("\n")).toMatch(/clips with their own sound: b pan R 50%, EQ mid -4 dB, reverb 50/);
  });
  it("crossfade: each side reads half of it past its cut, the two overlap by it, nothing moves; off: the graph as before", () => {
    const plain = graph(base()).g.filterGraph;
    expect(plain).not.toMatch(/acrossfade/);
    expect(plain).toMatch(/atrim=start=1\.000000:end=5\.000000,asetpts=PTS-STARTPTS,afade=t=in:d=0\.020000,afade=t=out:st=3\.980000/);
    const s = edit(base(), { op: "set_audio", crossfade: 0.08 } as Op).snap;
    const { p, g } = graph(s);
    expect(g.filterGraph).toMatch(/atrim=start=1\.000000:end=5\.040000,asetpts=PTS-STARTPTS,afade=t=in:d=0\.020000\[a0\]/);
    expect(g.filterGraph).toMatch(/atrim=start=5\.960000:end=10\.000000,asetpts=PTS-STARTPTS,afade=t=out:st=4\.020000:d=0\.020000\[a1\]/);
    expect(g.filterGraph).toMatch(/\[a0\]\[a1\]acrossfade=d=0\.080000:c1=qsin:c2=qsin\[ax1\]/);
    expect(g.filterGraph).toMatch(/\[ax1\]concat=n=1:v=0:a=1/);
    expect(p.outputSeconds).toBe(graph(base()).p.outputSeconds);
    expect(p.operations.join("\n")).toMatch(/80 ms crossfade at cuts/);
  });
});
