// A new edit is the raw footage: nothing cut, captions off, no style. A reference is never applied; only apply_style
// gives an edit a style (and its caption rules).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildRawTimeline, editCheck, MCP_TOOLS, STYLES, stubTranscript, summarizeTimeline, type EditContext, type Snapshot } from "../src/index";
import { planRender } from "../src/renderPlan";

const tr = stubTranscript(30);
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: (id) => STYLES.find((s) => s.id === id) };
const raw = (): Snapshot => ({ timeline: buildRawTimeline(tr, 30, [], "v"), name: "t", aspect: "16:9", styleId: null });
const source = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };

describe("a new edit is the raw footage", () => {
  it("plays the whole footage in order with nothing cut and no captions", () => {
    const tl = raw().timeline;
    expect(tl.captionsOn).toBe(false);
    expect(tl.cut).toEqual([]);
    expect(tl.tracks.v2).toEqual([]);
    expect(tl.tracks.a2).toEqual([]);
    // The same clips as before, only captions off.
    expect(tl.tracks.v1).toEqual(buildInitialTimeline(tr, 30, "clean", [], "v").tracks.v1);
    const plan = planRender({ kind: "preview", snapshot: raw(), transcript: tr, source, videoId: "v" });
    expect(plan.outputSeconds).toBeCloseTo(30, 1);
    expect(plan.captions).toEqual([]);
    expect(plan.zooms).toEqual([]);
  });

  it("keeps only the words the user removed on the footage page", () => {
    const tl = buildRawTimeline(tr, 30, [words[3].id, words[4].id], "v");
    expect(tl.cut).toEqual([words[3].id, words[4].id]);
    expect(tl.captionsOn).toBe(false);
  });

  it("the connector and the check say so, with no style named", () => {
    const text = summarizeTimeline(raw(), tr, 60, "v");
    expect(text).toMatch(/Captions off/);
    expect(text).not.toMatch(/style/);
    expect(editCheck(raw(), tr, { videoId: "v" })).toMatch(/Captions: off/);
    const create = MCP_TOOLS.find((t) => t.name === "create_project")!;
    expect(create.description).toMatch(/raw footage: nothing cut, captions off, no style/);
    expect(create.description).toMatch(/reference only \(not applied\)/);
  });

  it("caption rules come from a style only when it was applied", () => {
    // Captions turned on by hand in a raw edit: the look's own preset, no style's rules; a caption style change
    // starts from that preset too.
    const on = applyOp(applyOp(raw(), { op: "set_captions", on: true, look: "clean" }, ctx).snap, { op: "set_caption_style", size: 6 }, ctx).snap;
    expect(on.timeline.captionStyle?.case).toBe("none");
    const a = planRender({ kind: "preview", snapshot: on, transcript: tr, source, videoId: "v" });
    // apply_style s1: the style is the edit's now, and its rules shape the captions.
    const styled = applyOp(raw(), { op: "apply_style", styleId: "s1" }, ctx).snap;
    expect(styled.styleId).toBe("s1");
    expect(summarizeTimeline(styled, tr, 60, "v")).toMatch(/style s1/);
    const b = planRender({ kind: "preview", snapshot: styled, transcript: tr, source, videoId: "v", captionRules: STYLES.find((s) => s.id === "s1")!.rules.captions });
    expect(a.captions.length).toBeGreaterThan(0);
    expect(b.captions.length).toBeGreaterThan(0);
    expect(a.captions.some((c) => c.text !== c.text.toUpperCase())).toBe(true);
    expect(b.captions.every((c) => c.text === c.text.toUpperCase())).toBe(true);
  });

  it("an editor save keeps a null style, and a replace without one keeps the edit's", () => {
    const r = applyOp(raw(), { op: "replace", timeline: raw().timeline, styleId: null }, ctx).snap;
    expect(r.styleId).toBeNull();
    const styled = applyOp(raw(), { op: "apply_style", styleId: "s2" }, ctx).snap;
    expect(applyOp(styled, { op: "replace", timeline: styled.timeline }, ctx).snap.styleId).toBe("s2");
  });
});
