// Premiere parity, phase 11: flip, crop and drop shadow on b-roll (cards), the anchor point and motion blur on keyed
// movement, smooth slow motion (frame blending, optical flow) and eased speed ramps. The ops and their text, the plan,
// the FFmpeg graph and the player's frame.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, liveFrame, rampSteps, speedAt, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined, getVideo: (id) => (id === "leaf" ? { id, name: "Leaf", seconds: 20, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] }] } as never, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const v1 = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as SeqClip[]).find((c) => c.id === id)!;
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
const graph = (s: Snapshot) => {
  const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", brollSeconds: { leaf: 20 } });
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  const broll = Object.fromEntries(p.broll.map((b) => [b.clipId, "/leaf.mp4"]));
  return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", looks, broll } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph };
};
const withBroll = () => { const s = edit(base(), { op: "add_broll", videoId: "leaf", start: 2, end: 4, sourceStart: 0, edit: true } as Op).snap; return { s, id: (s.timeline.tracks.v2 as { id: string }[]).at(-1)!.id }; };

describe("flip", () => {
  it("mirrors V1 clips and b-roll; the plan and the graph mirror them; none puts them back", () => {
    const { s: s0, id } = withBroll();
    let r = edit(s0, { op: "set_flip", clipIds: ["a"], flip: "h" } as Op);
    expect(r.summary).toBe("a: mirrored left to right");
    r = edit(r.snap, { op: "set_flip", clipId: id, flip: "both" } as Op);
    expect(v1(r.snap, "a").flip).toBe("h");
    const { p, g } = graph(r.snap);
    expect(p.parts.find((x) => x.clipIds.includes("a"))!.flip).toBe("h");
    expect(p.parts.find((x) => x.clipIds.includes("b"))!.flip).toBeUndefined();
    expect(g).toMatch(/hflip,fps=30,scale=960:540:force_original_aspect_ratio=increase/);
    expect(g).toMatch(/fps=30,hflip,vflip,scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1/);
    expect(p.operations.join("\n")).toMatch(/Mirrored: a, /);
    const back = edit(r.snap, { op: "set_flip", clipIds: ["a"], flip: "none" } as Op).snap;
    expect(v1(back, "a").flip).toBeUndefined();
    expect(() => edit(base(), { op: "set_flip", clipIds: ["zz"], flip: "h" } as Op)).toThrow(/no V1 clip or b-roll "zz"/);
  });
});

describe("smooth slow motion and eased ramps", () => {
  it("optical flow makes slow motion's in-between frames; at 1x or faster nothing changes", () => {
    let s = edit(base(), { op: "set_speed", clipId: "b", speed: 0.5 } as Op).snap;
    const r = edit(s, { op: "set_speed", clipId: "b", interp: "flow" } as Op);
    expect(r.summary).toMatch(/b: 0\.5x \(sound pitch kept\); slow motion by optical flow, now 8\.00s in the edit/);
    s = r.snap;
    const { p, g } = graph(s);
    const part = p.parts.find((x) => x.clipIds.includes("b"))!;
    expect(part.interp).toBe("flow");
    expect(g).toMatch(/trim=start=6\.000000:end=10\.066667,fps=30,settb=1\/90000,setpts=\(PTS-STARTPTS\)\/0\.500000,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none,fps=30,tpad=stop_mode=clone:stop=2,trim=end_frame=240/);
    expect(p.operations.join("\n")).toMatch(/Slow motion: b optical flow at 50%/);
    const blend = graph(edit(s, { op: "set_speed", clipId: "b", interp: "blend" } as Op).snap).g;
    expect(blend).toMatch(/minterpolate=fps=30:mi_mode=blend:scd=none/);
    const fast = edit(s, { op: "set_speed", clipId: "b", speed: 2 } as Op).snap;
    expect(graph(fast).p.parts.find((x) => x.clipIds.includes("b"))!.interp).toBeUndefined();
    expect(edit(s, { op: "set_speed", clipId: "b", interp: "frames" } as Op).snap.timeline.tracks.v1.find((c) => c.id === "b")!.interp).toBeUndefined();
  });
  it("an eased ramp changes speed slowly at first, then quicker; the steps follow it", () => {
    const lin = [{ at: 0, speed: 1 }, { at: 4, speed: 3 }], eased = [{ at: 0, speed: 1, ease: "in" as const }, { at: 4, speed: 3 }];
    expect(speedAt(lin, 1)).toBeCloseTo(1.5, 6);
    expect(speedAt(eased, 1)).toBeLessThan(1.25);
    expect(speedAt(eased, 4)).toBe(3);
    const a = rampSteps(lin, 0, 4), b = rampSteps(eased, 0, 4);
    expect(b.length).toBeGreaterThan(a.length); // slower for longer: more edit time, more steps
    const s = edit(base(), { op: "set_speed", clipId: "a", ramp: [{ at: 1, speed: 1, ease: "in-out" }, { at: 5, speed: 3 }] } as Op).snap;
    expect(v1(s, "a").ramp![0].ease).toBe("in-out");
  });
});

describe("anchor point and motion blur", () => {
  it("set_keyframes takes an anchor and motion blur without touching the keys; the graph turns about the anchor and blurs", () => {
    let s = edit(base(), { op: "set_keyframes", clipId: "a", keys: [{ t: 0, rotation: 0, scale: 0.5 }, { t: 2, rotation: 90, scale: 0.5 }] } as Op).snap;
    const r = edit(s, { op: "set_keyframes", clipId: "a", anchor: { x: 0, y: 0 }, motionBlur: 50 } as Op);
    expect(r.summary).toBe("a: anchor 0, 0, motion blur 50");
    s = r.snap;
    expect(v1(s, "a").keys).toHaveLength(2);
    const { p, g } = graph(s);
    expect(p.clipMotion!.a).toMatchObject({ anchor: { x: 0, y: 0 }, motionBlur: 50 });
    // The anchor (the picture's top left) lands at the frame's top left, 2 px into the padded canvas; the canvas corner
    // is 242 px left of the shrunk picture's top left. Motion at 4x the rate, 2 of each 4 sub-frames averaged
    // premultiplied, back to 30 fps.
    expect(g).toMatch(/fps=120,format=yuva420p,scale=480:270,pad=964:544/);
    expect(g).toMatch(/perspective=x0='2\+960\*0\+0\.5\/0\.5\*\(-242\*cos/);
    expect(g).toMatch(/premultiply=inplace=1,tmix=frames=2,unpremultiply=inplace=1,fps=30,trim=end_frame=\d+,format=yuva420p/);
    expect(p.operations.join("\n")).toMatch(/Motion blur: a 50 \(in the render\)/);
    expect(p.operations.join("\n")).toMatch(/Anchor points: a/);
    const fr = liveFrame(p, 1);
    expect(fr.motionAnchor).toEqual({ x: 0, y: 0 });
    // Off: the middle, no blur; the graph as before.
    const off = edit(s, { op: "set_keyframes", clipId: "a", anchor: null, motionBlur: 0 } as Op).snap;
    expect(v1(off, "a").anchor).toBeUndefined();
    expect(graph(off).g).not.toMatch(/tmix/);
  });
});

describe("b-roll as a card: crop, corners, drop shadow", () => {
  it("set_card on b-roll crops and rounds it (its mask) and lays a shadow under it; a border too (phase 17)", () => {
    const { s: s0, id } = withBroll();
    const r = edit(s0, { op: "set_card", clipIds: [id], crop: { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 }, radius: 0.1, shadow: {} } as Op);
    expect(r.summary).toMatch(new RegExp(`^${id}: drawn as a card over the picture: `));
    const { p, g } = graph(r.snap);
    expect(p.looks![id].mask).toBeTruthy();
    expect(p.broll[0].shadow).toEqual({ color: "#000000", opacity: 0.35, blur: 0.03, x: 0, y: 0.012 });
    expect(g).toMatch(/alphaextract,gblur=sigma=8\.100,lut=c0='val\*0\.350'/);
    expect(g).toMatch(/overlay=0:6:enable='between\(t,2\.000000,3\.983333\)'/);
    expect(p.operations.join("\n")).toMatch(/B-roll cards: /);
    const fr = liveFrame(p, 3);
    expect(fr.broll!.shadow).toEqual(p.broll[0].shadow);
    expect(edit(s0, { op: "set_card", clipIds: [id], border: { color: "#ffffff", width: 0.01 } } as Op).summary).toMatch(/border #ffffff 1%/i);
    // V1 cards as before.
    expect(edit(base(), { op: "set_card", clipIds: ["a"], radius: 0.05 } as Op).summary).toMatch(/^1 clip drawn as a card/);
  });
});
