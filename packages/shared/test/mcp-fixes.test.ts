// Notes from a long session with the connector: restore_words undoes a range cut (from/to, or the words inside it);
// set_clips keeps V3 graphics at their edit times when their V1 clip is replaced, and says so; delete_clip finds the
// track from the clip id; a graphic placement takes data (any JSON) without declaring it.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, customParamsSchema, graphicDefaults, outputDuration, allWords, MCP_TOOLS, type EditContext, type Op, type Snapshot } from "../src/index";

const tr = buildTranscript([Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const words = allWords(tr);
const ctx: EditContext = {
  videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined,
  getGraphic: (id) => (id === "gc" ? { id, name: "Card", durationSec: 20, custom: true, params: graphicDefaults(customParamsSchema({ word: "Hi" })) } : undefined),
} as EditContext;
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_captions", on: false } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const len = (s: Snapshot) => Math.round(outputDuration(s.timeline, words) * 1000) / 1000;
const v1 = (s: Snapshot) => s.timeline.tracks.v1 as unknown as { id: string; sourceIn: number; sourceOut: number }[];

describe("restore_words undoes a range cut", () => {
  it("from/to puts the footage back, and the two halves are one clip again", () => {
    const cut = edit(base(), { op: "cut_words", from: 5, to: 8 } as Op).snap;
    expect(len(cut)).toBe(27);
    expect(v1(cut)).toHaveLength(2);
    const r = edit(cut, { op: "restore_words", from: 5, to: 8 } as Op);
    expect(len(r.snap)).toBe(30);
    expect(v1(r.snap).map((c) => [c.sourceIn, c.sourceOut])).toEqual([[0, 30]]);
    expect(r.summary).toMatch(/put back 3\.00s of footage a range cut took out/);
  });
  it("part of it, or the words inside it by id", () => {
    const cut = edit(base(), { op: "cut_words", from: 5, to: 8 } as Op).snap;
    expect(len(edit(cut, { op: "restore_words", from: 5, to: 6 } as Op).snap)).toBe(28);
    // w10 is 5.5-5.9: its footage back (and nothing else of the range).
    const r = edit(cut, { op: "restore_words", wordIds: ["w10"] } as Op);
    expect(r.summary).toMatch(/put back 0\.40s of footage a range cut took out \(1 word\)/);
    expect(len(r.snap)).toBeCloseTo(27.4, 3);
    expect(edit(base(), { op: "restore_words", from: 1, to: 2 } as Op).summary).toBe("1.00s to 2.00s already plays");
  });
  it("cut words still come back as before", () => {
    const w = words[3].id;
    const cut = edit(base(), { op: "cut_words", wordIds: [w] } as Op).snap;
    expect(edit(cut, { op: "restore_words", wordIds: [w] } as Op).summary).toBe("restored 1 cut word");
  });
});

describe("set_clips keeps V3 at its edit times", () => {
  it("a graphic on a V1 clip that is replaced stays at the same edit time, and the result says so", () => {
    let s = edit(base(), { op: "add_graphic", graphicId: "gc", start: 4, end: 7, edit: true } as Op).snap;
    const g = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "graphic")!;
    // New clips with new ids: the graphic's V1 clip is gone, and its footage (4-7 s) no longer plays.
    const r = edit(s, { op: "set_clips", track: "v1", clips: [{ start: 10, end: 20, label: "" }, { start: 22, end: 28, label: "" }] } as Op);
    s = r.snap;
    const after = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.id === g.id);
    expect(after, "the graphic is still there").toBeTruthy();
    expect(r.summary).toMatch(new RegExp(`kept on V3 at their edit times \\(their V1 clip was replaced\\): ${g.id}`));
  });
});

describe("delete_clip without a track", () => {
  it("finds the track from the clip id", () => {
    let s = edit(base(), { op: "add_graphic", graphicId: "gc", start: 4, end: 7 } as Op).snap;
    const g = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "graphic")!;
    s = edit(s, { op: "delete_clip", clipId: g.id } as Op).snap;
    expect((s.timeline.tracks.v3 as { id: string }[]).some((c) => c.id === g.id)).toBe(false);
    expect(() => edit(s, { op: "delete_clip", clipId: "nope" } as Op)).toThrow(/no clip "nope" on any track/);
  });
});

describe("a graphic placement's data", () => {
  it("takes any JSON as data without declaring it; other new names are still refused", () => {
    const data = { words: [{ id: "w12", t: "Every", s: 7.37, e: 7.54 }], scenes: [[0, 4.2], [4.2, 9]] };
    const s = edit(base(), { op: "add_graphic", graphicId: "gc", start: 1, end: 3, params: { word: "Yo" }, data } as Op).snap;
    expect((s.timeline.tracks.v3 as { kind?: string; params?: Record<string, unknown> }[]).find((c) => c.kind === "graphic")!.params).toEqual({ word: "Yo", data });
    expect(() => edit(base(), { op: "add_graphic", graphicId: "gc", start: 1, end: 3, params: { colour: "red" } } as Op)).toThrow(/has no param "colour"/);
  });
});

describe("new tool fields sent as text by a chat with an older tool list", () => {
  const input = (n: string) => MCP_TOOLS.find((t) => t.name === n)!.input;
  it("create_graphic edits as JSON text, replace and upload as \"true\"", () => {
    const r = input("create_graphic").parse({ codeFrom: "g1", edits: '[{"find":"#FFC400","replace":"#38E07B"}]', replace: "true", upload: "false" });
    expect(r).toMatchObject({ codeFrom: "g1", edits: [{ find: "#FFC400", replace: "#38E07B" }], replace: true, upload: false });
    expect(() => input("create_graphic").parse({ codeFrom: "g1", edits: "[{bad" })).toThrow(/Expected array/);
  });
  it("wait_seconds as text; test_graphic data as JSON text, rerecord as \"true\"", () => {
    expect(input("get_render").parse({ renderId: "r", wait_seconds: "90" }).wait_seconds).toBe(90);
    expect(input("get_graphic").parse({ graphicId: "g", wait_seconds: "30" }).wait_seconds).toBe(30);
    expect(() => input("get_render").parse({ renderId: "r", wait_seconds: "500" })).toThrow();
    const t = input("test_graphic").parse({ graphicId: "g", data: '{"words":[1,2]}', rerecord: "true" });
    expect(t).toMatchObject({ data: { words: [1, 2] }, rerecord: true });
    expect(input("test_graphic").parse({ graphicId: "g", data: "plain text" }).data).toBe("plain text");
  });
});
