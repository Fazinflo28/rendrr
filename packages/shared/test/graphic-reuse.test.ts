// One custom graphic placed many times: add_graphic from (seconds into the recording) and params (window.params
// values) are checked against the graphic, kept on the clip, cut into the render from the right frame and shown
// by the player at the same time.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, canonicalJson, customParamsSchema, graphicDefaults, liveFrame, placementParams, summarizeTimeline, withParams, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const defaults = { title: "Step", color: "#ffffff", n: 1 };
const ctx: EditContext = {
  videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: () => undefined,
  getGraphic: (id) => (id === "gc" ? { id, name: "Chapter card", durationSec: 20, custom: true, params: graphicDefaults(customParamsSchema(defaults)) } : id === "gt_title_card" ? { id, name: "Title card", durationSec: 3 } : undefined),
} as EditContext;
const base = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" });
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);
const src = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };
const files: PlanFiles = { source: "/in.mp4", output: "/out.mp4" };

describe("custom graphic params", () => {
  it("are stored as defaults and read back; a placement's values replace them, checked by name and type", () => {
    expect(graphicDefaults(customParamsSchema(defaults))).toEqual(defaults);
    expect(placementParams("Card", defaults, { title: "Two" })).toEqual({ params: { title: "Two", color: "#ffffff", n: 1 } });
    expect(placementParams("Card", defaults, { titel: "x" })).toEqual({ error: 'Card has no param "titel". Its params: title, color, n.' });
    expect(placementParams("Card", defaults, { n: "2" })).toEqual({ error: 'Param "n" of Card takes a number (default 1), not a string.' });
    expect(placementParams("Card", {}, { a: 1 })).toMatchObject({ error: expect.stringMatching(/has no params/) });
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}');
  });

  it("window.params is set before the graphic's own scripts, and cannot end its script early", () => {
    const p = { title: "</script><b>" };
    expect(withParams("<canvas></canvas><script>go()</script>", p)).toBe(`<script>window.params=Object.freeze({"title":"\\u003c/script>\\u003cb>"});</script><canvas></canvas><script>go()</script>`);
    expect(withParams("<!doctype html><html><head><title>x</title></head><body></body></html>", {})).toMatch(/^<!doctype html><html><head><script>window\.params=Object\.freeze\(\{\}\);<\/script><title>/);
    expect(withParams("<!doctype html><body><script>go()</script></body>", {})).toMatch(/^<!doctype html><body><script>window\.params/);
  });
});

describe("add_graphic from and params", () => {
  it("places one custom graphic four times at different offsets, each clip naming its id", () => {
    let s = base();
    const ids: string[] = [];
    for (const [i, from] of [0, 5, 10, 15].entries()) {
      const r = edit(s, { op: "add_graphic", graphicId: "gc", start: 1 + i * 4, end: 4 + i * 4, from, ...(i === 3 ? { params: { title: "Last", n: 4 } } : {}) } as Op);
      s = r.snap;
      const c = s.timeline.tracks.v3.filter((x) => x.kind === "graphic").at(-1)!;
      ids.push(c.id);
      expect(r.summary).toContain(`(clip ${c.id})`);
      if (from) expect(r.summary).toContain(`from ${from.toFixed(2)}s of it`);
      expect(c.sourceStart).toBe(from || undefined);
    }
    expect(s.timeline.tracks.v3.find((x) => x.id === ids[3])!.params).toEqual({ title: "Last", n: 4 });
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source: src, videoId: "v" });
    expect(p.graphics.map((g) => g.sourceStart)).toEqual([0, 5, 10, 15]);
    // The render starts each placement on the frame its offset names (on the frame grid first: a still stretch is one
    // picture in the file), and holds the last frame only when the rest of the recording is shorter than the clip.
    const gs = Object.fromEntries(p.graphics.map((g) => [g.clipId, `/g-${g.clipId}.webm`]));
    const secs = Object.fromEntries(p.graphics.map((g) => [g.clipId, 20]));
    const graph = ffmpegArgs(p, { ...files, graphics: gs, graphicSeconds: secs }, src, { loudnessGainDb: 0 }).filterGraph;
    for (const from of [5, 10, 15]) expect(graph).toContain(`fps=30,trim=start_frame=${from * 30},setpts=PTS-STARTPTS,format=yuva420p`);
    expect(graph).not.toContain("stop=-1");
    const late = ffmpegArgs(p, { ...files, graphics: gs, graphicSeconds: { ...secs, [ids[3]]: 17 } }, src, { loudnessGainDb: 0 }).filterGraph;
    expect(late).toContain(`fps=30,trim=start_frame=450,setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop=-1`);
    // The player shows the same moment: 1 s into the third placement is 11 s into the graphic.
    const g3 = p.graphics[2];
    expect(liveFrame(p, g3.start + 1).graphics.find((g) => g.clipId === g3.clipId)!.t).toBeCloseTo(11, 6);
    expect(summarizeTimeline(s, tr, 60, "v")).toContain(`graphic=gc from 15s params={"title":"Last","n":4}`);
  });

  it("refuses from on a template, past the graphic's end, and params the graphic did not declare", () => {
    expect(() => edit(base(), { op: "add_graphic", graphicId: "gt_title_card", start: 1, end: 3, from: 1 } as Op)).toThrow(/from works on custom graphics/);
    expect(() => edit(base(), { op: "add_graphic", graphicId: "gc", start: 1, end: 3, from: 20 } as Op)).toThrow(/from 20\.00s is past the end of Chapter card \(20\.00s long\)/);
    expect(() => edit(base(), { op: "add_graphic", graphicId: "gc", start: 1, end: 3, params: { colour: "#000000" } } as Op)).toThrow(/no param "colour"\. Its params: title, color, n/);
    // A template's params are its fields, as before.
    expect(edit(base(), { op: "add_graphic", graphicId: "gt_title_card", start: 1, end: 3, params: { title: "Hi" } } as Op).snap.timeline.tracks.v3.find((x) => x.kind === "graphic")!.params).toEqual({ title: "Hi" });
  });
});
