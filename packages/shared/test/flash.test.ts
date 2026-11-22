// The overexposure flash (set_transition flash): its curve (building to the cut, the peak on the cut's first frame, a fast
// fall and a soft tail, fitted to a reference flash), the plan (a window centred on the cut, no footage past it needed;
// on the first clip it opens on the flash), the render's graph (the picture itself in float RGB, its exposure and black
// level set frame by frame, the blown-out part glowing), the player's look and Claude's text.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, FLASH_LIFT, FLASH_STOPS, flashLevel, flashMap, liveFrame, MCP_TOOLS, transitionAt, TRANSITIONS, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 30 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined };
const source = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx).snap;
// Two clips: 2-6 and 8-12 s of the footage (the cut at edit 4 s).
const two = () => edit({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: null },
  { op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 6, label: "" }, { id: "b", start: 8, end: 12, label: "" }] } as Op);
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
const graph = (s: Snapshot) => ffmpegArgs(plan(s), { source: "/in.mp4", output: "/o.mp4", assPath: "/c.ass" } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;

describe("the overexposure flash", () => {
  it("builds to the cut, peaks on its first frame, falls fast and fades out softly", () => {
    expect(TRANSITIONS).toContain("flash");
    expect(flashLevel(0)).toBe(0);
    expect(flashLevel(0.5)).toBe(1);
    expect(flashLevel(1)).toBeCloseTo(0, 9);
    // Before the cut: hardly anything until its last frames.
    expect(flashLevel(0.25)).toBeCloseTo(1 / 16, 9);
    expect(flashLevel(0.45)).toBeLessThan(0.7);
    // After it: a fast fall (a third of the way down after a frame of a 0.5 s flash at 30 fps), then a soft tail.
    const after = [1, 2, 3, 4, 5, 6, 7].map((k) => flashLevel(0.5 + k / 15));
    expect(after[0]).toBeLessThan(0.4);
    expect(after[0]).toBeGreaterThan(0.25);
    for (let k = 1; k < after.length; k++) expect(after[k]).toBeLessThan(after[k - 1]);
    expect(after[3]).toBeGreaterThan(0.05);
  });

  it("is planned centred on the cut with no footage past it; on the first clip it opens on the flash", () => {
    const p = plan(edit(two(), { op: "set_transition", clipId: "b", type: "flash", duration: 0.5 }));
    const t = p.transitions![0];
    expect(t).toMatchObject({ type: "flash", at: 4, a: [], b: [] });
    expect(t.start).toBeCloseTo(4 - 7 / 30, 3);
    expect(t.end).toBeCloseTo(4 + 7 / 30, 3);
    const f = plan(edit(two(), { op: "set_transition", clipId: "a", type: "flash", duration: 0.5 })).transitions![0];
    expect(f).toMatchObject({ type: "flash", start: 0, at: 0, note: "first clip: opens on the flash" });
  });

  it("the render blows the picture out frame by frame, the peak on the cut's first frame, and the blown-out part glows", () => {
    const g = graph(edit(two(), { op: "set_transition", clipId: "b", type: "flash", duration: 0.5 }));
    const cmd = /sendcmd=c='([^']+)',exposure@fx0=exposure=0/.exec(g);
    expect(cmd, "the exposure is set frame by frame").toBeTruthy();
    const lines = cmd![1].split(";");
    expect(lines).toHaveLength(14);
    // Each frame's values go in half a frame before it (never a frame late).
    expect(lines[0]).toBe("0.000 exposure@fx0 exposure 0.000, exposure@fx0 black 0.000");
    expect(lines[7]).toBe(`${(6.5 / 30).toFixed(3)} exposure@fx0 exposure ${FLASH_STOPS.toFixed(3)}, exposure@fx0 black ${(-FLASH_LIFT).toFixed(3)}`);
    const stops = lines.map((l) => Number(/exposure (\S+),/.exec(l)![1]));
    expect(Math.max(...stops)).toBe(stops[7]);
    // The window (frames 113-126, by half-frame margins): the picture in float RGB (BT.709) and back; the glow from what
    // goes over white, a Gaussian of 9% of the short side (540 in a preview) screened over; laid back only inside it.
    expect(g).toMatch(/\[fw0\]trim=start=3\.750000:end=4\.216667,setpts=PTS-STARTPTS,scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp16le,format=gbrpf32le,sendcmd/);
    expect(g).toMatch(/\[fg0\]exposure=exposure=-2,format=gbrp16le,lutrgb=r='max\(0,val-16384\)\*3'.*gblur=sigma=49\[fb0\]/);
    expect(g).toMatch(/\[fc0\]\[fb0\]blend=all_mode=screen,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,settb=1\/30,setpts=PTS-STARTPTS\+113\[fl0\]/);
    expect(g).toMatch(/\[fo0\]\[fl0\]overlay=enable='between\(t,3\.750000,4\.216667\)':eof_action=pass\[vf0\]/);
    // A white dip stays a white layer.
    expect(graph(edit(two(), { op: "set_transition", clipId: "b", type: "dip-white", duration: 0.5 }))).not.toMatch(/exposure@/);
  });

  it("the player shows it: the picture brighter by the same stops, the lift near the peak", () => {
    const p = plan(edit(two(), { op: "set_transition", clipId: "b", type: "flash", duration: 0.5 }));
    const peak = liveFrame(p, 4 + 0.001).transition!.look.flash!;
    expect(peak.level).toBeCloseTo(1, 1);
    // FFmpeg's exposure at the peak: v -> (v + 0.35) / (2^-3 + 0.35), about 2.1 v + 0.74; the player draws the same.
    const m = flashMap(1);
    expect(m.gain).toBeCloseTo(1 / (2 ** -FLASH_STOPS + FLASH_LIFT), 9);
    expect(m.add).toBeCloseTo(FLASH_LIFT * m.gain, 9);
    const look = transitionAt({ type: "flash" }, 0.5, 1920, 1080).flash!;
    for (const v of [0, 0.1, 0.3]) expect(Math.min(1, v * look.bright) * (1 - look.lift) + look.lift).toBeCloseTo(Math.min(1, v * m.gain + m.add), 9);
    expect(flashMap(0)).toEqual({ gain: 1, add: 0 });
    expect(liveFrame(p, 3).transition).toBeNull();
    // The first clip's flash opens on its peak.
    const f = plan(edit(two(), { op: "set_transition", clipId: "a", type: "flash", duration: 0.5 }));
    expect(liveFrame(f, 0.001).transition!.look.flash!.level).toBeGreaterThan(0.95);
  });

  it("Claude is told what it is and how it differs from a white dip", () => {
    const d = MCP_TOOLS.find((t) => t.name === "apply_edits")!.description;
    expect(d).toMatch(/flash \(overexposure flash: the picture itself blows out to white with a glow on the cut/);
    expect(d).toMatch(/dip-white \(a white layer fades in and out\)/);
  });
});
