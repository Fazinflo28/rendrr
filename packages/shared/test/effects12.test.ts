// Premiere parity, phase 12b: more transitions (push, wipe, iris, cross zoom, film dissolve, clock, barn doors,
// diamond) drawn by FFmpeg's xfade from both sides' footage, and more effects (glow, grain, RGB split, camera shake,
// mirror, corner pin). The op, the plan, the graph and the player's look.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, effectsText, transitionAt, xfadeOf, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] }] } as never, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
const graph = (s: Snapshot) => {
  const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", looks } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph };
};

describe("transitions by xfade", () => {
  it("each new type maps to its xfade transition, from both sides' footage, and keeps its direction", () => {
    expect(["push", "wipe", "iris", "cross-zoom", "film-dissolve", "clock", "barn-door", "diamond"].map((t) => xfadeOf(t as never, "right"))).toEqual(["slideright", "wiperight", "circleopen", "zoomin", "fade", "custom:expr='if(lt(mod(atan2(X-W/2,H/2-Y)+2*PI,2*PI),(1-P)*2*PI),B,A)'", "vertopen", "custom:expr='if(lt(abs(X/W-0.5)+abs(Y/H-0.5),1-P),B,A)'"]);
    const s = edit(base(), { op: "set_transition", clipId: "b", type: "wipe", duration: 0.5, dir: "up" } as Op).snap;
    expect((s.timeline.tracks.v1 as { id: string; transition?: unknown }[])[1].transition).toEqual({ type: "wipe", duration: 0.5, dir: "up" });
    const { p, g } = graph(s);
    const t = p.transitions!.find((x) => x.type === "wipe")!;
    expect([t.start, t.end]).toEqual([3.767, 4.233]); // half a window on whole frames either side of the cut
    expect(t.a.length).toBeGreaterThan(0);
    expect(t.b.length).toBeGreaterThan(0);
    expect(g).toMatch(/\[xa0\]\[xb0\]xfade=transition=wipeup:duration=0\.466000:offset=0,trim=end_frame=14,format=yuv420p\[tx0\]/);
  });
  it("a film dissolve mixes in linear light; the others in the picture's own values", () => {
    const g = graph(edit(base(), { op: "set_transition", clipId: "b", type: "film-dissolve", duration: 0.4 } as Op).snap).g;
    expect(g).toMatch(/format=gbrp16le,lutrgb=r='pow\(val\/65535,2\.2\)\*65535'.*\[xa0\]/);
    expect(g).toMatch(/xfade=transition=fade:duration=0\.400000:offset=0,trim=end_frame=12,format=gbrp16le,lutrgb=r='pow\(val\/65535,1\/2\.2\)\*65535'/);
  });
  it("the player draws them with a clip-path, a mask, both sides moving, or A zooming", () => {
    expect(transitionAt({ type: "wipe", dir: "left" }, 0.5, 100, 100).clip).toBe("inset(0 0 0 50%)");
    expect(transitionAt({ type: "wipe", dir: "down" }, 0.25, 100, 100).clip).toBe("inset(0 0 75% 0)");
    expect(transitionAt({ type: "iris" }, 0.5, 100, 100).clip).toBe("circle(35.5% at 50% 50%)");
    expect(transitionAt({ type: "barn-door" }, 0.5, 100, 100).clip).toBe("inset(0 25% 0 25%)");
    expect(transitionAt({ type: "diamond" }, 0.5, 100, 100).clip).toBe("polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)");
    expect(transitionAt({ type: "clock" }, 0.25, 100, 100).mask).toBe("conic-gradient(#000 90deg, transparent 0)");
    const push = transitionAt({ type: "push", dir: "left" }, 0.5, 100, 100);
    expect([push.a.x, push.b.x]).toEqual([-50, 50]);
    expect(transitionAt({ type: "cross-zoom" }, 0.5, 100, 100)).toMatchObject({ aScale: 1.5, b: { opacity: 0.5 } });
  });
});

describe("more effects", () => {
  it("glow, grain, RGB split, shake, mirror and corner pin go in the clip's colour chain; the pin makes it see-through outside", () => {
    let s = edit(base(), { op: "set_effects", clipIds: ["a"], effects: [{ type: "glow", amount: 50 }, { type: "grain", amount: 40 }, { type: "rgbsplit", amount: 50 }, { type: "shake", amount: 50 }] } as Op).snap;
    let { p, g } = graph(s);
    expect(g).toMatch(/blend=all_mode=screen:all_opacity=0\.714/);
    expect(g).toMatch(/format=gbrp,noise=alls=32:allf=t,format=gbrp16le/);
    expect(g).toMatch(/rgbashift=rh=-3:bh=3:edge=smear/);
    expect(g).toMatch(/scale=\d+:\d+,crop=960:540:x='\(iw-ow\)\/2\+8\*\(0\.6\*sin\(2\*PI\*t\*5\.3\)/);
    expect(p.looks!.a.alpha).toBe(false);
    const r = edit(base(), { op: "set_effects", clipIds: ["b"], effects: [{ type: "mirror", amount: 100 }, { type: "pin", amount: 100, corners: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] }] } as Op);
    expect(r.summary).toMatch(/mirror 100, corner pin to 25%,25% 75%,25% 25%,75% 75%,75%/);
    s = r.snap;
    ({ p, g } = graph(s));
    expect(g).toMatch(/crop=iw\/2:ih:0:0,split\[ml/);
    expect(g).toMatch(/hstack,scale=960:540/);
    expect(g).toMatch(/perspective=x0=240:y0=135:x1=720:y1=135:x2=240:y2=405:x3=720:y3=405:sense=destination/);
    expect(g).toMatch(/color=c=white:s=958x538:.*format=gray,pad=960:540:1:1:black,lut=c0='if\(gt\(val,128\),255,0\)',trim=end_frame=\d+,perspective=x0=240/);
    expect(p.looks!.b.alpha).toBe(true);
    expect(effectsText([{ type: "rgbsplit", amount: 30 }])).toBe("RGB split 30");
  });
});
