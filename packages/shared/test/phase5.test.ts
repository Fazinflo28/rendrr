// Phase 5: speed, transitions, keyframes. The curve tables (the player's values equal the render's FFmpeg
// expressions), speed in the sequence (lengths, footage mapping, sound, no J/L), the four ops, transitions made shorter
// by short clips or missing handles, the live frame, the ASS pieces of a keyframed text layer and the check's lines.
import { describe, expect, it } from "vitest";
import {
  applyOp, bezierAt, buildInitialTimeline, buildTranscript, editCheck, keyTrack, keyTracks, liveFrame, motionAt, rampSteps, sequenceView, showAt, speedAt,
  summarizeTimeline, textLookAt, trackAt, trackExpr, transitionAt, type EditContext, type Key, type Op, type SeqClip, type Snapshot,
} from "../src/index";
import { planRender, zoomExpr } from "../src/renderPlan";
import { zoomAt } from "../src/playback";

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined };
const base = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" });
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);
const clips = (s: Snapshot) => s.timeline.tracks.v1 as SeqClip[];
const source = { width: 1280, height: 720, fps: 30, seconds: 30, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
// Three clips: 2-6, 8-12, 14-18 s of the footage.
const three = () => edit(base(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 6, label: "" }, { id: "b", start: 8, end: 12, label: "" }, { id: "c", start: 14, end: 18, label: "" }] } as Op).snap;
/** FFmpeg's expression functions, enough to evaluate trackExpr in JS. */
const evalExpr = (e: string, t: number) => new Function("t", "clip", "gte", `return ${e};`)(t, (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)), (a: number, b: number) => (a >= b ? 1 : 0));

describe("keyframe curves", () => {
  it("named easings are the CSS curves", () => {
    expect(bezierAt([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 5);
    expect(bezierAt([0.42, 0, 1, 1], 0.5)).toBeLessThan(0.35);
    expect(bezierAt([0, 0, 0.58, 1], 0.5)).toBeGreaterThan(0.65);
  });
  it("the player's value equals the render's expression at every moment", () => {
    const keys: Key[] = [{ t: 0, x: 0, scale: 1, opacity: 1, ease: "in-out" }, { t: 1, x: 0.5, scale: 2, ease: [0.2, 1.4, 0.6, 1] }, { t: 2.5, x: -0.2, scale: 1, opacity: 0 }, { t: 2.5, x: 0.3 }];
    for (const p of ["x", "scale", "opacity"] as const) {
      const tr = keyTrack(keys, p)!;
      const ex = trackExpr(tr, "t");
      for (let t = -0.5; t <= 3; t += 0.037) expect(evalExpr(ex, t)).toBeCloseTo(trackAt(tr, t), 6);
    }
    // Between keys an eased segment follows its curve (16 pieces); a key at the same time jumps.
    const tx = keyTrack(keys, "x")!;
    expect(trackAt(tx, 0.5)).toBeCloseTo(0.25, 2);
    expect(trackAt(tx, 2.5)).toBeCloseTo(0.3, 6);
    const m = motionAt(keyTracks(keys), 3);
    for (const [k, v] of Object.entries({ x: 0.3, y: 0, scale: 1, rotation: 0, opacity: 0 })) expect(m[k as keyof typeof m]).toBeCloseTo(v, 9);
    // An overshooting bezier goes past the next value on the way (scale 2 down to 1 dips under 1).
    expect(Math.min(...Array.from({ length: 50 }, (_, i) => trackAt(keyTrack(keys, "scale")!, 1 + (i * 1.5) / 50)))).toBeLessThan(1);
  });
});

describe("speed in the sequence", () => {
  it("2x halves a clip's edit length; footage and edit times map both ways; its sound plays at 2x", () => {
    const s = edit(three(), { op: "set_speed", clipId: "b", speed: 2 }).snap;
    const v = sequenceView(s.timeline, words);
    expect(v.clip("b")!.end - v.clip("b")!.start).toBeCloseTo(2, 6);
    expect(v.total).toBeCloseTo(10, 6);
    expect(v.editAt("b", 10)).toBeCloseTo(4 + 1, 6);
    expect(v.editToSource("b", 5)).toBeCloseTo(10, 6);
    expect(v.sound.find((x) => x.clipId === "b")).toMatchObject({ rate: 2, srcIn: 8, srcOut: 12 });
    expect(v.sound.find((x) => x.clipId === "b")!.silent).toBeUndefined();
  });
  it("reverse plays the footage backwards and silent; a freeze holds a frame, silent; 0.25x is silent", () => {
    const s = edit(three(), { op: "set_speed", clipId: "a", reverse: true }, { op: "freeze_frame", clipId: "b", at: 10, length: 1 }, { op: "set_speed", clipId: "c", speed: 0.25 }).snap;
    const v = sequenceView(s.timeline, words, { align: 30 });
    const a = v.clip("a")!;
    expect(v.editToSource("a", a.start + 0.5)).toBeCloseTo(5.5, 6);
    expect(v.sound.filter((x) => x.clipId === "a").every((x) => x.silent && x.rate === -1)).toBe(true);
    const ids = clips(s).map((c) => c.id);
    expect(ids.length).toBe(5); // b split around the freeze
    const fr = clips(s)[2];
    expect(fr).toMatchObject({ freeze: 1, sourceIn: 10 });
    expect(v.clip(fr.id)!.end - v.clip(fr.id)!.start).toBeCloseTo(1, 6);
    expect(v.picture.find((p) => p.rate === 0)).toMatchObject({ srcIn: 10 });
    expect(v.clip("c")!.end - v.clip("c")!.start).toBeCloseTo(16, 6);
    expect(v.sound.filter((x) => x.clipId === "c").every((x) => x.silent)).toBe(true);
    expect(() => edit(s, { op: "set_speed", clipId: fr.id, speed: 2 })).toThrow(/freeze frame/);
  });
  it("a ramp plays in steps of at most 0.2 s at the speed of each step's middle; its length is the integral of 1/speed", () => {
    const ramp = [{ at: 8, speed: 1 }, { at: 12, speed: 3 }];
    const st = rampSteps(ramp, 8, 12);
    expect(st[0].srcIn).toBe(8);
    expect(st[st.length - 1].srcOut).toBeCloseTo(12, 9);
    for (const x of st) { expect((x.srcOut - x.srcIn) / x.speed).toBeLessThanOrEqual(0.2 + 1e-9); expect(x.speed).toBeCloseTo(speedAt(ramp, (x.srcIn + x.srcOut) / 2), 2); }
    const s = edit(three(), { op: "set_speed", clipId: "b", ramp }).snap;
    const v = sequenceView(s.timeline, words, { align: 30 });
    const len = v.clip("b")!.end - v.clip("b")!.start;
    expect(len).toBeCloseTo(2 * Math.log(3), 1); // ∫ dx / (1 + x/2) from 0 to 4 = 2 ln 3 ≈ 2.20
    expect(v.picture.filter((p) => p.clipIds[0] === "b").every((p) => Math.abs((p.end - p.start) * 30 - Math.round((p.end - p.start) * 30)) < 1e-6)).toBe(true);
  });
  it("no J/L cut at a clip off normal speed", () => {
    let s = edit(three(), { op: "set_audio_offset", clipId: "b", start: -0.5 }).snap;
    expect(sequenceView(s.timeline, words).clip("b")!.soundStart).toBeCloseTo(3.5, 6);
    s = edit(s, { op: "set_speed", clipId: "b", speed: 1.5 }).snap;
    expect(clips(s).find((c) => c.id === "b")!.audioStart).toBeUndefined();
    expect(sequenceView(s.timeline, words).clip("b")!.soundStart).toBeCloseTo(4, 6);
  });
  it("captions follow sped-up speech and leave out reversed speech", () => {
    const s = edit(three(), { op: "set_speed", clipId: "b", speed: 2 }, { op: "set_speed", clipId: "c", reverse: true }).snap;
    const p = plan(s);
    const b = sequenceView(s.timeline, words, { align: 30 }).clip("b")!;
    const inB = p.styledCaptions!.filter((c) => c.start >= b.start - 0.01 && c.end <= b.end + 0.3);
    expect(inB.length).toBeGreaterThan(0);
    // Word w15 (footage 8.0 s) is said at the start of b; w19 (10.0 s) one second later at 2x.
    const word = (txt: string) => p.styledCaptions!.flatMap((c) => c.lines.flat()).find((w) => w.text === txt)!;
    expect(word("w19").start - word("w15").start).toBeCloseTo(1, 1);
    expect(p.styledCaptions!.some((c) => c.lines.flat().some((w) => w.text === "w28"))).toBe(false); // in c (14-18 s), reversed
  });
});

describe("transitions", () => {
  it("set_transition on one cut, many cuts, or all; type cut removes them", () => {
    const one = edit(three(), { op: "set_transition", clipId: "b", type: "dissolve", duration: 0.6 });
    expect(one.summary).toBe("dissolve 0.6s on the cut before b (edit 0:04) (uses footage past the cut)");
    const all = edit(three(), { op: "set_transition", all: true, type: "whip", dir: "right" }).snap;
    expect(clips(all).map((c) => c.transition)).toEqual([undefined, { type: "whip", duration: 0.3, dir: "right" }, { type: "whip", duration: 0.3, dir: "right" }]);
    expect(clips(edit(all, { op: "set_transition", all: true, type: "cut" }).snap).every((c) => !c.transition)).toBe(true);
  });
  it("windows are centred on the cut; each side's footage continues past it (handles)", () => {
    const p = plan(edit(three(), { op: "set_transition", clipId: "b", type: "dissolve", duration: 0.6 }).snap);
    const t = p.transitions![0];
    expect(t).toMatchObject({ type: "dissolve", at: 4, start: 3.7, end: 4.3 });
    expect(t.a[t.a.length - 1]).toMatchObject({ srcIn: 6, rate: 1, start: 4, end: 4.3 });
    expect(t.a[t.a.length - 1].srcOut).toBeCloseTo(6.3, 6);
    expect(t.b[0].srcIn).toBeCloseTo(7.7, 6);
    expect(t.b[0]).toMatchObject({ srcOut: 8, start: 3.7, end: 4 });
  });
  it("a short clip or too little footage past the cut makes it shorter, and the check says so", () => {
    // The first clip starts 0.1 s into the footage: a dissolve onto it from a clip before has 0.1 s of handle.
    const s = edit(base(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 5, end: 8, label: "" }, { id: "b", start: 0.1, end: 3, label: "" }] } as Op).snap;
    const r = edit(s, { op: "set_transition", clipId: "b", type: "dissolve", duration: 1 });
    expect(r.summary).toMatch(/b: 0\.20s, this clip has only 0\.10s of footage past the cut/);
    const p = plan(r.snap);
    expect(p.transitions![0].end - p.transitions![0].start).toBeCloseTo(0.2, 6);
    expect(editCheck(r.snap, tr, { videoId: "v" })).toMatch(/Flags: .*dissolve at 0:03\.0 is 0\.20s, not 1s \(this clip has only 0\.10s of footage past the cut\)/);
    // Dips need no footage past the cut.
    const d = plan(edit(s, { op: "set_transition", clipId: "b", type: "dip-black", duration: 1 }).snap);
    expect(d.transitions![0]).toMatchObject({ start: 2.5, end: 3.5 });
  });
  it("on the first clip a dip fades in from the colour; a zoom transition zooms in to the cut and out after it", () => {
    const s = edit(three(), { op: "set_transition", clipIds: ["a"], type: "dip-white", duration: 1 }, { op: "set_transition", clipId: "c", type: "zoom", duration: 0.4 }).snap;
    const p = plan(s);
    expect(p.transitions![0]).toMatchObject({ type: "dip-white", start: 0, at: 0, end: 0.5 });
    expect(liveFrame(p, 0).transition!.look.color).toEqual({ hex: "#FFFFFF", opacity: 1 });
    // Curves are read at the start of the frame showing (as the render draws them): frame 8 of the 0.5 s fade.
    expect(liveFrame(p, 8 / 30 + 0.01).transition!.look.color!.opacity).toBeCloseTo(1 - 8 / 15, 6);
    const z = p.zooms.find((x) => x.mode === "through")!;
    expect(z).toMatchObject({ start: 7.8, end: 8.2, scale: 1.6 });
    const ex = zoomExpr(p.zooms);
    for (const t of [7.8, 7.9, 8, 8.1, 8.19]) expect(new Function("t", "between", "lt", "pow", "min", "if_", `return ${ex.replace(/if\(/g, "if_(")};`)(t, (x: number, a: number, b: number) => (x >= a && x <= b ? 1 : 0), (a: number, b: number) => (a < b ? 1 : 0), Math.pow, Math.min, (c: number, a: number, b: number) => (c ? a : b))).toBeCloseTo(zoomAt(p.zooms, t), 6);
    expect(zoomAt(p.zooms, 8)).toBeCloseTo(1.6, 6);
  });
  it("the live frame gives both sides of a dissolve, slide or whip, with the same curves", () => {
    const p = plan(edit(three(), { op: "set_transition", clipId: "b", type: "whip", duration: 0.4, dir: "left" }).snap);
    const f = liveFrame(p, 4);
    expect(f.transition!.p).toBeCloseTo(0.5, 6);
    expect(f.transition!.a!.src).toBeCloseTo(6, 6);
    expect(f.transition!.b!.src).toBeCloseTo(8, 6);
    expect(f.transition!.look).toEqual(transitionAt({ type: "whip", dir: "left" }, 0.5, p.width, p.height));
    expect(f.transition!.look.a.x).toBeCloseTo(-p.width / 2, 6);
    expect(f.transition!.look.blur.x).toBeCloseTo(p.width * 0.03, 6);
  });
});

describe("keyframes", () => {
  it("V1 keys are stored at footage seconds and come back as seconds into the clip, also after a cut before them", () => {
    let s = edit(three(), { op: "set_keyframes", clipId: "b", keys: [{ t: 0, scale: 1 }, { t: 2, scale: 1.5, ease: "out" }] }).snap;
    expect(clips(s).find((c) => c.id === "b")!.keys).toEqual([{ t: 8, scale: 1 }, { t: 10, scale: 1.5, ease: "out" }]);
    expect(plan(s).clipMotion!.b.keys).toEqual([{ t: 0, scale: 1 }, { t: 2, scale: 1.5, ease: "out" }]);
    // Cut the first second of b: the key at 10 s of footage is now 1 s into the clip.
    s = edit(s, { op: "cut_words", from: 8, to: 9 }).snap;
    expect(plan(s).clipMotion!.b.keys.map((k) => k.t)).toEqual([0, 1]);
    expect(liveFrame(plan(s), plan(s).clipMotion!.b.start + 1).motion!.scale).toBeCloseTo(1.5, 6);
  });
  it("b-roll, text and graphics keys are seconds from their start; a split moves the second half's keys", () => {
    let s = edit(three(), { op: "add_text", text: "Hi", start: 1, end: 3, edit: true, anim: "none" } as Op).snap;
    const id = s.timeline.tracks.v3.find((c) => (c as { kind?: string }).kind === "text")!.id;
    s = edit(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 0, x: 0 }, { t: 2, x: 0.4 }] }).snap;
    const p = plan(s);
    expect(liveFrame(p, 2).texts[0].look!.x).toBeCloseTo(p.texts![0].style.x * p.width + 0.2 * p.width, 6);
    const r = edit(s, { op: "split_clip", track: "v3", clipId: id, at: 2, edit: true }).snap;
    const halves = r.timeline.tracks.v3.filter((c) => (c as { kind?: string }).kind === "text") as unknown as { keys: Key[] }[];
    expect(halves[1].keys).toEqual([{ t: 0, x: 0 }, { t: 1, x: 0.4 }]);
    expect(() => edit(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 5, x: 1 }] })).toThrow(/past the end/);
  });
  it("a keyframed text layer's ASS pieces start and end where textLookAt puts it", () => {
    let s = edit(three(), { op: "add_text", text: "Hi", start: 1, end: 3, edit: true, anim: "fade" } as Op).snap;
    const id = s.timeline.tracks.v3.find((c) => (c as { kind?: string }).kind === "text")!.id;
    s = edit(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 0, y: 0, rotation: 0 }, { t: 1, y: -0.2, rotation: 90 }] }).snap;
    const p = plan(s), l = p.texts![0];
    const evs = p.ass!.split("\n").filter((x) => x.startsWith("Dialogue") && x.includes(",T0,"));
    expect(evs.length).toBeGreaterThan(3);
    const at = (u: number) => textLookAt(l, u, p.width, p.height);
    const m = /\\move\(([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)/.exec(evs[1])!.slice(1).map(Number);
    const s0 = /Dialogue: \d+,0:00:(\d\d\.\d\d)/.exec(evs[1])![1];
    expect(m[1]).toBeCloseTo(at(Number(s0) - l.start).y, 0);
    expect(evs[1]).toMatch(/\\frz-/); // clockwise = negative \frz
    expect(at(0.5).opacity).toBeCloseTo(1, 6);
    expect(at(0.1).opacity).toBeCloseTo(0.4, 6); // the fade in (0.25 s) is folded in
  });
});

describe("the player shows the frame the render shows", () => {
  it("at 2x, 0.5x, 1.5x and reversed: output frame n shows source frame floor(rate x n) in play order", () => {
    for (const r of [2, 0.5, 1.5, -1, -2]) {
      const x = { srcIn: 3, srcOut: 6, start: 0, end: 3 / Math.abs(r), rate: r };
      for (let n = 0; n < 10; n++) {
        const shown = Math.floor(showAt(x, n / 30 + 0.001) * 30);
        const j = Math.floor(Math.abs(r) * n + 1e-6);
        expect(shown).toBe(r > 0 ? 90 + j : 180 - 1 - j);
      }
    }
  });
});

describe("the check and get_project", () => {
  it("say what plays at another speed, the transitions and the keyframes; a dip is not flagged as black", () => {
    const s = edit(three(), { op: "set_speed", clipId: "a", speed: 2 }, { op: "set_transition", clipId: "b", type: "dip-black", duration: 0.6 }, { op: "set_keyframes", clipId: "c", keys: [{ t: 0, opacity: 0 }, { t: 1, opacity: 1 }] }).snap;
    const black = [{ start: 1.75, end: 2.25 }];
    const check = editCheck(s, tr, { videoId: "v", measured: { videoSeconds: 10, audioSeconds: 10, black, silences: [], lufs: -14, peakDb: -2, graphics: [] } as never });
    expect(check).toMatch(/Speed: a 2x \(sound pitch kept\)/);
    expect(check).toMatch(/Transitions: 0:02\.0 dip-black 0\.60s/);
    expect(check).toMatch(/Keyframes: c opacity/);
    expect(check).not.toMatch(/black 0\.50s/);
    const plain = editCheck(three(), tr, { videoId: "v" });
    expect(plain).not.toMatch(/Speed:|Transitions:|Keyframes:/);
    const proj = summarizeTimeline(s, tr, 60, "v");
    expect(proj).toMatch(/a main 2\.00-6\.00 @0\.00-2\.00 "" 2x \(sound pitch kept\)/);
    expect(proj).toMatch(/b main 8\.00-12\.00 @2\.00-6\.00 "" dip-black 0\.6s in/);
    expect(proj).toMatch(/c main 14\.00-18\.00 @6\.00-10\.00 "" keys 0\.00,1\.00s/);
  });
});
