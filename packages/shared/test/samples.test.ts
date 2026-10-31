// Samples: a few seconds of an edit drawn on their own (windowPlan), exactly as the whole render draws them. The plan
// keeps only what the window shows (parts clipped at its ends, their footage moved to match; overlays, zooms and
// transitions elsewhere left out), the graph moves the joined picture to its edit time and trims the end result, and the
// sound is the whole mix, trimmed.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, windowPlan, type PlanFiles } from "../src/renderPlan";
import { SAMPLE_MAX_CLIP, sampleItems, samplesText, sampleWindow } from "../src/samples";

const SEC = 30;
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined,
  getVideo: (id) => (id === "orange" ? { id, name: "orange", seconds: 8, ready: true } : undefined) };
const source = { width: 1280, height: 720, fps: 30, seconds: SEC, hasAudio: true };
const edit = (...ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" },
  { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 6, label: "" }, { id: "b", start: 10, end: 14, label: "" }, { id: "c", start: 20, end: 25, label: "" }] }, ...ops] } as never, ctx).snap;
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { orange: 8 }, videoSeconds: { v: SEC } } as never);
const graph = (p: ReturnType<typeof plan>) => {
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  const broll = Object.fromEntries(p.broll.map((b) => [b.clipId, "/tmp/orange.mp4"]));
  return ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", looks, assPath: "/c.ass", broll } as PlanFiles, source, { loudnessGainDb: 0 });
};

describe("windowPlan: a few seconds of the edit", () => {
  it("keeps only the parts the window shows, clipped at its ends with their footage moved to match", () => {
    const p = plan(edit());
    // The edit: a 0-4 (footage 2-6), b 4-8 (10-14), c 8-13 (20-25).
    expect(p.parts.map((x) => [x.start, x.end, x.srcIn, x.srcOut])).toEqual([[0, 4, 2, 6], [4, 8, 10, 14], [8, 13, 20, 25]]);
    const w = windowPlan(p, 3, 7.5);
    expect(w.window).toEqual({ from: 3, to: 7.5 });
    // Footage cuts are written on whole frames (FFmpeg rounds trim times to frames).
    const h = 0;
    expect(w.parts.map((x) => [x.start, x.end])).toEqual([[3, 4], [4, 7.5]]);
    expect(w.parts[0].srcIn).toBeCloseTo(5 - h, 9); expect(w.parts[0].srcOut).toBe(6);
    expect(w.parts[1].srcIn).toBe(10); expect(w.parts[1].srcOut).toBeCloseTo(13.5 - h, 9);
    expect(w.kept).toEqual(w.parts.map((x) => ({ start: x.srcIn, end: x.srcOut })));
    expect(w.operations.at(-1)).toMatch(/^Sample: edit 0:03-0:07/);
    // The sound plan is the whole edit's (trimmed in the graph).
    expect(w.sound).toBe(p.sound);
  });
  it("a still needs no loudness measurement (it has no sound); a clip does", () => {
    const p = plan(edit({ op: "set_audio", loudness: -14 } as Op));
    expect(p.audioMix?.loudness).toBe(-14);
    const w = windowPlan(p, 5, 5);
    const files = { source: "/in.mp4", output: "/o.jpg", assPath: "/c.ass" } as PlanFiles;
    expect(() => ffmpegArgs(w, files, source, { still: true })).not.toThrow();
    expect(() => ffmpegArgs(windowPlan(p, 5, 7), files, source)).toThrow(/measure the mix first/);
  });
  it("a window inside a transition keeps the matte of the clip on the far side of the cut", () => {
    const p = plan(edit({ op: "remove_background", clipIds: ["c"] } as Op, { op: "set_transition", clipId: "c", type: "dissolve", duration: 0.5 } as Op));
    expect(Object.keys(p.mattes ?? {}).length).toBe(1);
    const t = p.transitions!.find((x) => x.clipId === "c")!;
    const w = windowPlan(p, t.start + 0.05, t.at - 0.05);
    expect(w.parts.every((x) => !x.clipIds.includes("c"))).toBe(true);
    expect(Object.values(w.mattes ?? {})[0]?.blocks.length).toBeGreaterThan(0);
  });
  it("puts its ends on frames, keeps at least one frame, and stops at the end of the edit", () => {
    const p = plan(edit());
    const w = windowPlan(p, 5.01, 5.01);
    expect(w.window!.from).toBeCloseTo(5, 9); expect(w.window!.to).toBeCloseTo(5 + 1 / 30, 9);
    expect(windowPlan(p, 11, 20).window).toEqual({ from: 11, to: 13 });
    expect(() => windowPlan(p, 14, 16)).toThrow(/past the end of the edit/);
  });
  it("a slowed clip: the window's footage at its speed", () => {
    const s = edit({ op: "set_speed", clipId: "b", speed: 0.5 } as Op);
    const p = plan(s), b = p.parts.find((x) => x.clipIds[0] === "b")!;
    expect(b.end - b.start).toBeCloseTo(8, 6);
    const w = windowPlan(p, b.start + 2, b.start + 4).parts[0];
    expect(w.start).toBeCloseTo(b.start + 2, 9);
    expect(w.srcIn).toBeCloseTo(11, 6); expect(w.srcOut).toBeCloseTo(12, 6);
    // At half speed each footage frame is shown twice: a window starting on the second showing starts the part a frame
    // early (on the first), so every frame is the one the whole render shows there; the end result is trimmed.
    const odd = windowPlan(p, b.start + 2 + 1 / 30, b.start + 4);
    expect(odd.window!.from).toBeCloseTo(b.start + 2 + 1 / 30, 9);
    expect(odd.parts[0].start).toBeCloseTo(b.start + 2, 9);
    expect(odd.parts[0].srcIn).toBeCloseTo(11, 6);
    const { filterGraph: g } = graph(odd);
    expect(g).toMatch(new RegExp(`setpts=PTS\\+${Math.round((b.start + 2) * 30)}\\[vwin\\]`));
    expect(g).toMatch(new RegExp(`trim=start=${(b.start + 2 + 1 / 30).toFixed(6).replace(".", "\\.")}:end=`));
  });
  it("a stabilized part is drawn whole (its smoothing runs over the whole part)", () => {
    const p = plan(edit({ op: "stabilize", clipIds: ["b"], smooth: 30 } as Op));
    const b = p.parts.find((x) => x.clipIds[0] === "b")!;
    const w = windowPlan(p, b.start + 1, b.start + 2);
    expect(w.parts[0]).toBe(b);
    expect(Object.keys(w.stabilize ?? {})).toHaveLength(1);
  });
  it("leaves out b-roll, text and transitions outside the window and keeps those in it", () => {
    const s = edit(
      { op: "add_broll", videoId: "orange", start: 0.5, end: 2, sourceStart: 0, edit: true } as Op,
      { op: "add_broll", videoId: "orange", start: 9, end: 11, sourceStart: 1, edit: true } as Op,
      { op: "add_text", text: "EARLY", start: 0, end: 1.5, edit: true, anim: "none" } as Op,
      { op: "add_text", text: "LATE", start: 9.5, end: 12, edit: true, anim: "none" } as Op,
      { op: "set_transition", clipId: "b", type: "dissolve", duration: 1 } as Op,
      { op: "set_transition", clipId: "c", type: "dissolve", duration: 1 } as Op,
    );
    const p = plan(s);
    expect(p.broll).toHaveLength(2); expect(p.transitions).toHaveLength(2);
    const w = windowPlan(p, 8.2, 12);
    expect(w.broll.map((b) => b.start)).toEqual([9]);
    expect(w.transitions!.map((t) => t.at)).toEqual([8]);
    // A transition the window starts inside of is drawn whole (from its own footage) and laid on at its own time.
    const g = graph(w).filterGraph;
    expect(g).toMatch(/enable='between\(t,7\.500000,/);
    expect(g.match(/concat=n=2:v=1:a=0/)).not.toBeNull();
  });
  it("the graph moves the joined picture to its edit time, trims the picture and the sound to the window, and encodes its length", () => {
    const p = plan(edit());
    const w = windowPlan(p, 3, 7.5);
    const { args, filterGraph: g } = graph(w);
    expect(g).toMatch(/setpts=PTS\+90\[vwin\]/);
    expect(g).toMatch(/trim=start=3\.000000:end=7\.500000,setpts=PTS-STARTPTS\[vout\]/);
    expect(g).toMatch(/atrim=start=3\.000000:end=7\.500000,asetpts=PTS-STARTPTS\[aout\]/);
    expect(args[args.lastIndexOf("-t") + 1]).toBe("4.500");
    // The whole sound is still made (each unit of the edit read), so the sample hears what the render hears.
    expect(g.match(/\[sa\d+\]/g)!.length).toBeGreaterThanOrEqual(3);
    // The whole render: none of it.
    const full = graph(p).filterGraph;
    expect(full).not.toMatch(/\[vwin\]/);
    expect(full).not.toMatch(/atrim=start=[\d.]+:end=[\d.]+,asetpts=PTS-STARTPTS\[aout\]/);
  });
  it("a sample clip is at most a few seconds", () => {
    expect(SAMPLE_MAX_CLIP).toBeLessThanOrEqual(6);
  });
});

describe("the samples asked for", () => {
  it("frames and clips in edit order, on frames; a clip without an end is 4 s; the last frame is the edit's last", () => {
    const items = sampleItems({ frames: [{ at: 9.99, note: "the end" }, { at: 1.01 }], clips: [{ start: 3, note: "the hook" }, { start: 8, end: 20 / 3 + 3 }] }, 10);
    expect(items.map((s) => [s.kind, s.at, s.end])).toEqual([["frame", 1, undefined], ["clip", 3, 7], ["clip", 8, 9.666666666666666], ["frame", 29.9 / 3, undefined]].map(([k, a, e]) => [k, a, e]));
    expect(items[3].at).toBeCloseTo(10 - 1 / 30, 9);
    expect(sampleWindow(items[0])).toEqual({ from: 1, to: 1 + 1 / 30 });
    expect(samplesText(items)).toBe("1. frame 0:01.0\n2. clip 0:03.0-0:07.0 - the hook\n3. clip 0:08.0-0:09.7\n4. frame 0:10.0 - the end");
  });
  it("refuses a clip over 6 s, a sample past the end and an empty ask", () => {
    expect(() => sampleItems({ clips: [{ start: 1, end: 8 }] }, 30)).toThrow(/at most 6 s/);
    expect(() => sampleItems({ frames: [{ at: 31 }] }, 30)).toThrow(/past the end/);
    expect(() => sampleItems({ clips: [{ start: 30 }] }, 30)).toThrow(/past the end/);
    expect(() => sampleItems({}, 30)).toThrow(/at least one/);
  });
});
