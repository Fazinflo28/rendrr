// Storyboard mode: the panels asked for (checked, on frames, in order), Rendrr's own panels from a plan, the words on
// screen in each panel, the style sheet read from the edit, and how Claude reads them.
import { describe, expect, it } from "vitest";
import {
  applyOp, boardPanelsText, boardStyle, boardStyleText, buildInitialTimeline, buildTranscript, captionAnimation, captionStyleOf, onScreenAt, panelOf, sampleClock,
  storyboardAutoPanels, storyboardItems, StoryboardRequestSchema, STORYBOARD_MAX_CLIPS, STORYBOARD_MAX_PANELS, type EditContext, type Op, type Snapshot,
} from "../src/index";
import { planRender, type SourceInfo } from "../src/renderPlan";

const WORDS = Array.from({ length: 60 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const SRC: SourceInfo = { width: 1080, height: 1920, fps: 30, seconds: 31, hasAudio: true };
const ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 31, getStyle: () => undefined, getVideo: (id: string) => (id === "b" ? { id, name: "B-roll", seconds: 10, ready: true } : undefined) } as unknown as EditContext;
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : ({ op: "batch", ops } as Op), ctx).snap;
/** Three clips (0-6, 10-16, 20-26 s of footage: 18 s), captions on, a title at 7 s, b-roll at 13 s. */
const board = (): Snapshot => edit({ timeline: buildInitialTimeline(tr, 31, "clean", [], "v"), name: "Launch", aspect: "9:16", styleId: null },
  { op: "set_clips", track: "v1", clips: [{ start: 0, end: 6, label: "" }, { start: 10, end: 16, label: "" }, { start: 20, end: 26, label: "" }] } as Op,
  { op: "set_captions", on: true } as Op, { op: "set_caption_style", highlight: "#34C759", wordsAtOnce: 3 } as Op,
  { op: "add_text", text: "Meet Fontora", start: 7, end: 9.5, edit: true, preset: "title", anim: "pop", font: "Poppins", color: "#0B3D2E" } as Op);
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source: SRC, videoId: "v" });

describe("the panels asked for", () => {
  it("frames and short clips on the edit's frames, in order, with their words; end or clip makes a clip", () => {
    const items = storyboardItems([
      { at: 9.01, title: "Problem", caption: "Still downloading icons?", shot: "Close-up, slow push in" },
      { at: 0, title: "Hook", note: "Is the first word strong enough?" },
      { at: 12, end: 14.5, title: "Reveal" },
      { at: 15, clip: true },
    ], 18);
    expect(items.map((x) => [x.kind, x.at, x.end ?? null, x.title ?? null])).toEqual([["frame", 0, null, "Hook"], ["frame", 9, null, "Problem"], ["clip", 12, 14.5, "Reveal"], ["clip", 15, 18, null]]);
    expect(items[1]).toMatchObject({ caption: "Still downloading icons?", shot: "Close-up, slow push in" });
    expect(items[0].note).toBe("Is the first word strong enough?");
  });
  it("refuses panels past the end, clips over 6 s, and more clips than a board takes", () => {
    expect(() => storyboardItems([{ at: 30 }], 18)).toThrow(/past the end of the edit/);
    expect(() => storyboardItems([{ at: 2, end: 9 }], 18)).toThrow(/at most 6 s/);
    expect(() => storyboardItems(Array.from({ length: STORYBOARD_MAX_CLIPS + 1 }, (_, i) => ({ at: i, clip: true })), 60)).toThrow(/at most 8 clip panels/);
    expect(StoryboardRequestSchema.safeParse({ panels: Array.from({ length: STORYBOARD_MAX_PANELS + 1 }, () => ({ at: 0 })) }).success).toBe(false);
    expect(StoryboardRequestSchema.safeParse({ palette: [{ hex: "green" }] }).success).toBe(false);
    expect(StoryboardRequestSchema.parse({ rules: ["Captions centred"], palette: [{ hex: "#34C759", name: "brand green" }] })).toMatchObject({ rules: ["Captions centred"] });
  });
});

describe("Rendrr's own panels and the words on screen", () => {
  it("the opening, each scene, the title once it is in and the b-roll, titled by what they show", () => {
    const p = plan(board());
    const auto = storyboardAutoPanels({ ...p, broll: [{ clipId: "b1", start: 15, end: 17 }] });
    // Scene 2 (6.3 s) and the title (7.5 s) are one panel, and the title wins it.
    expect(auto.map((x) => x.title)).toEqual(["Opening", "Meet Fontora", "Scene 3", "B-roll"]);
    expect(auto.every((x) => x.kind === "frame")).toBe(true);
    expect(auto[1].at).toBeCloseTo(7.5, 5);
    expect(auto[2].at).toBeCloseTo(12.3, 5);
    for (const x of auto) expect(Math.round(x.at * 30) / 30).toBeCloseTo(x.at, 9); // on frames
    // A graphic is a short clip, so its animation shows; beats closer than 1.5 s are one panel.
    const g = storyboardAutoPanels({ ...p, broll: [], graphics: [{ clipId: "g1", start: 2, end: 8 }] });
    expect(g.find((x) => x.title === "Graphic")).toMatchObject({ kind: "clip", at: 2, end: 6 });
  });
  it("more beats than a board takes: the first, the last and evenly between", () => {
    const parts = Array.from({ length: 40 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, clipIds: [`c${i}`] }));
    const auto = storyboardAutoPanels({ outputSeconds: 120, parts, graphics: [], broll: [] }, 10);
    expect(auto.length).toBe(10);
    expect(auto[0].title).toBe("Opening");
    expect(auto[9].title).toBe("Scene 40");
  });
  it("on screen: the title and the caption a viewer reads at that moment", () => {
    const p = plan(board());
    const said = onScreenAt(p, 1.0);
    expect(said).toMatch(/^w\d+/);
    expect(onScreenAt(p, 8)).toMatch(/^Meet Fontora/);
    expect(onScreenAt({ styledCaptions: [], texts: [] }, 3)).toBe("");
  });
});

describe("the style sheet", () => {
  it("captions, fonts, colours, how things move, the look, music, sound and pacing, from the edit", () => {
    const s = board(), p = plan(s);
    const st = boardStyle({ aspect: s.aspect, outputSeconds: p.outputSeconds, width: p.width, height: p.height, captionStyle: p.captionStyle, captionsOn: true, texts: p.texts, cards: [], background: null, transitions: [], cuts: 2, look: "as shot", music: "none", sound: "cleanup none" },
      [{ hex: "#34c759", name: "brand green" }, { hex: "#0B3D2E", name: "ink" }]);
    expect(st.captions).toMatchObject({ font: "Inter", highlight: "#34C759", wordsAtOnce: 3, position: "bottom", animation: "3 words at a time, the spoken word lit in #34C759" });
    expect(st.fonts).toEqual([{ font: "Inter", weight: 400, use: "captions" }, { font: "Poppins", weight: expect.any(Number), use: "titles and text" }]);
    // The palette comes first with its names; colours the edit uses join them.
    expect(st.colors[0]).toEqual({ hex: "#34C759", name: "brand green, spoken word" });
    expect(st.colors[1]).toEqual({ hex: "#0B3D2E", name: "ink, title text" });
    expect(st.colors.some((c) => c.hex === "#FFFFFF" && /caption text/.test(c.name))).toBe(true);
    expect(st.texts).toEqual({ count: 1, animations: ["pop"] });
    expect(st.pacing).toBe("2 cuts in 0:18 (6.7 a minute)");
    const words = boardStyleText(st).join("\n");
    expect(words).toMatch(/Captions: Inter 400, [\d.]+% of the short side, #FFFFFF on a #000000 box, 2 lines at the bottom; 3 words at a time, the spoken word lit in #34C759/);
    expect(words).toMatch(/Fonts: Inter 400 \(captions\); Poppins \d+ \(titles and text\)/);
    expect(words).toMatch(/Transitions: cuts only/);
    // Captions off: none on the sheet.
    expect(boardStyle({ aspect: "16:9", outputSeconds: 10, width: 1920, height: 1080, captionStyle: captionStyleOf(s.timeline, "16:9"), captionsOn: false, cuts: 0, look: "", music: "", sound: "" }).captions).toBeNull();
    expect(captionAnimation({ ...captionStyleOf(s.timeline, "9:16"), highlight: null, wordsAtOnce: 1 })).toBe("one word at a time, as they are said");
  });
});

describe("how Claude reads a board", () => {
  it("one line a panel with its words; a comment finds its panel", () => {
    const items = storyboardItems([{ at: 0, title: "Hook", caption: "Still downloading icons?" }, { at: 4, end: 7, title: "Reveal", shot: "UI zoom" }], 18);
    const txt = boardPanelsText([{ ...items[0], onScreen: "Still downloading" }, items[1]]);
    expect(txt).toBe('1. frame 0:00.0 "Hook" - says: Still downloading icons? - on screen: Still downloading\n2. clip 0:04.0-0:07.0 "Reveal" - shows: UI zoom');
    expect(panelOf(items, 0)).toBe(0);
    expect(panelOf(items, 5.5)).toBe(1);
    expect(panelOf(items, 0.3)).toBe(0);
    expect(panelOf(items, 12)).toBe(-1);
    expect(sampleClock(4)).toBe("0:04.0");
  });
});
