// Phase 4: captions and text. Caption styles (the three looks are presets of it), the shared layout (lines, sizes,
// the spoken word), text layers with presets, cards and animations, one ASS file for both, save_style carrying a
// full caption style, the check's lines and flags, and the live frame the editor draws.
import { describe, expect, it } from "vitest";
import {
  activeWord, applyOp, buildInitialTimeline, buildTranscript, captionRect, captionStyleOf, editCheck, faceOf, fontFaceCss, layoutCaptions, liveFrame, presetStyle,
  STYLES, summarizeTimeline, textAnimAt, textRect, textWidth, drawnOf, type EditContext, type FileMeasure, type Snapshot, type StyleLite, type TextStyle,
} from "../src/index";
import { planRender } from "../src/renderPlan";

const WORDS = "So the thing nobody tells you about starting an agency is that the first ten clients are the hardest ones to land".split(" ");
const tr = buildTranscript([WORDS.map((text, i) => ({ text: i === 5 ? "you," : text, start: 0.5 + i * 0.4, end: 0.8 + i * 0.4 }))], { maxWordsPerLine: 30 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const custom: StyleLite = { id: "own", name: "Own", captionLook: "bold", rules: { ...STYLES[0].rules, captions: { on: true, look: "bold", wordsAtOnce: 2, upper: true, maxLines: 1, style: { ...presetStyle("bold", "16:9"), font: "Poppins", weight: 800, color: "#FFFFFF", box: null, stroke: { color: "#000000", width: 10 }, highlight: "#00FF88" } } } };
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: (id) => (id === "own" ? custom : STYLES.find((s) => s.id === id)) };
const snap = (aspect: Snapshot["aspect"] = "16:9"): Snapshot => ({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect, styleId: "s2" });
const edit = (s: Snapshot, ...ops: Parameters<typeof applyOp>[1][]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: 12, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });

describe("caption styles", () => {
  it("the three looks are presets of a caption style, sized by the frame's shape as before", () => {
    expect(presetStyle("clean", "16:9")).toMatchObject({ font: "Inter", weight: 400, size: 4.6, box: { color: "#000000", opacity: 0.55 }, wordsAtOnce: 7, lines: 2, y: 0.87 });
    expect(presetStyle("bold", "9:16")).toMatchObject({ weight: 700, size: 8.5, color: "#0A0A0C", box: { color: "#FCFDFF" }, case: "upper", tidy: true });
    expect(presetStyle("outline", "1:1")).toMatchObject({ size: 6.6, stroke: { color: "#000000", width: 9 }, box: null });
    // A project style's word counts and case shape the preset.
    expect(captionStyleOf({ captionLook: "clean" }, "16:9", { wordsAtOnce: 4, upper: true, maxLines: 1 })).toMatchObject({ wordsAtOnce: 4, wordsPerLine: 4, lines: 1, case: "upper" });
  });
  it("set_caption_style changes the fields it is given; look starts again from a preset; bad values are refused", () => {
    const r = edit(snap(), { op: "set_caption_style", font: "Montserrat", weight: 900, size: 7, highlight: "#FFD400", box: null, stroke: { color: "#000000", width: 8 } });
    expect(r.summary).toMatch(/caption style: Montserrat 900, 7% size, #FFFFFF, stroke #000000 8%, active word #FFD400/);
    expect(r.snap.timeline.captionStyle).toMatchObject({ font: "Montserrat", weight: 900, wordsAtOnce: 8, lines: 2 }); // s2: 8 words, 2 lines
    const b = edit(r.snap, { op: "set_caption_style", look: "bold" }).snap;
    expect(b.timeline.captionStyle).toMatchObject({ font: "Inter", weight: 700, case: "upper" });
    expect(b.timeline.captionLook).toBe("bold");
    expect(() => edit(snap(), { op: "set_caption_style", color: "yellow" } as never)).toThrow();
    // set_captions{look} goes back to the plain preset.
    expect(edit(r.snap, { op: "set_captions", on: true, look: "outline" }).snap.timeline.captionStyle).toBeUndefined();
  });
  it("faces: the nearest weight of a font; widths from the font's own metrics", () => {
    // Every weight a family comes in is bundled (Engine Part 4.3); a weight it has not is drawn with the nearest.
    expect(faceOf("Montserrat", 700).weight).toBe(700);
    expect(faceOf("Roboto", 640).weight).toBe(700);
    expect(faceOf("Kalam", 850).weight).toBe(700);
    expect(faceOf("Open Sans", 950).weight).toBe(800);
    expect(faceOf("Nope", 400).font).toBe("Inter");
    const f = faceOf("Inter", 400);
    expect(textWidth("WWW", f, 40)).toBeGreaterThan(textWidth("iii", f, 40) * 2);
    expect(fontFaceCss()).toMatch(/font-family:"RC Montserrat 900";src:url\(\/fonts\/Montserrat-900\.ttf\)[^}]*ascent-override:[\d.]+%;descent-override:[\d.]+%/);
  });
});

describe("the caption layout", () => {
  const groups = [WORDS.map((text, i) => ({ text: i === 5 ? "you," : text, start: 0.5 + i * 0.4, end: 0.8 + i * 0.4 }))];
  it("words at once, words a line, lines; one caption at a time; case and tidy", () => {
    const s = { ...presetStyle("clean", "16:9"), wordsAtOnce: 6, wordsPerLine: 3, lines: 2, case: "upper" as const, tidy: true };
    const cs = layoutCaptions(groups, s, 960, 540, 20);
    expect(cs[0].lines.map((l) => l.map((w) => w.text))).toEqual([["SO", "THE", "THING"], ["NOBODY", "TELLS", "YOU"]]); // "you," tidied
    for (let i = 0; i + 1 < cs.length; i++) expect(cs[i].end).toBeLessThanOrEqual(cs[i + 1].start + 1e-9);
    expect(cs.flatMap((c) => c.lines.flat()).length).toBe(WORDS.length);
  });
  it("a line too wide for the frame breaks again by width; a caption that needs too many lines becomes two", () => {
    const big = { ...presetStyle("clean", "16:9"), size: 14, wordsAtOnce: 8, wordsPerLine: 8, lines: 1 };
    const cs = layoutCaptions(groups, big, 960, 540, 20);
    const d = drawnOf(big, 960, 540);
    for (const c of cs) {
      expect(c.lines.length).toBeLessThanOrEqual(1);
      for (const l of c.lines) if (l.length > 1) expect(textWidth(l.map((w) => w.text).join(" "), d.face, d.size)).toBeLessThanOrEqual(960 * 0.84 - 2 * (d.box?.pad ?? 0));
    }
    expect(cs.length).toBeGreaterThan(Math.ceil(WORDS.length / 8));
  });
  it("the spoken word: the last word whose time has come", () => {
    const c = layoutCaptions(groups, presetStyle("clean", "16:9"), 960, 540, 20)[0];
    expect(activeWord(c, c.start)).toEqual([0, 0]);
    expect(activeWord(c, c.lines[1][0].start + 0.01)).toEqual([1, 0]);
  });
});

describe("text layers", () => {
  it("add_text with a preset, set_text changes it; they hang on V1 like other V3 clips", () => {
    const r = edit(snap(), { op: "add_text", text: "Ten clients\nin 90 days", start: 1, end: 4, preset: "title" });
    expect(r.summary).toMatch(/added text "Ten clients" at 0:01 \(clip \w+; Montserrat 900, 9% size/);
    const c = r.snap.timeline.tracks.v3.find((x) => (x as { kind?: string }).kind === "text") as unknown as { id: string; anchorId: string; text: string; anim: string; style: TextStyle };
    expect(c).toMatchObject({ text: "Ten clients\nin 90 days", anim: "pop", style: { font: "Montserrat", case: "upper" } });
    expect(c.anchorId).toBeTruthy();
    const s2 = edit(r.snap, { op: "set_text", clipId: c.id, color: "#FFD400", card: { color: "#000000", opacity: 0.8 }, anim: "slide", y: 0.3 }).snap;
    expect(s2.timeline.tracks.v3.find((x) => x.id === c.id)).toMatchObject({ card: { color: "#000000", opacity: 0.8 }, anim: "slide", style: { color: "#FFD400", y: 0.3, font: "Montserrat" } });
    expect(() => edit(s2, { op: "set_text", clipId: "nope" })).toThrow(/no clip "nope"/);
    expect(summarizeTimeline(s2, tr)).toMatch(/text="Ten clients\\nin 90 days" \(Montserrat 900, 9% size, #FFD400.*\) slide card #000000/);
  });
  it("animations: the player's curves match the ASS tags", () => {
    expect(textAnimAt("fade", 0.1, 3, 540)).toEqual({ opacity: 0.4, scale: 1, dy: 0 });
    expect(textAnimAt("fade", 2.9, 3, 540)).toEqual({ opacity: 0.4, scale: 1, dy: 0 });
    expect(textAnimAt("pop", 0.075, 3, 540)).toEqual({ opacity: 0.75, scale: 0.9, dy: 0 });
    expect(textAnimAt("slide", 0.125, 3, 540)).toEqual({ opacity: 0.5, scale: 1, dy: 10.8 });
    expect(textAnimAt("none", 0.01, 3, 540)).toEqual({ opacity: 1, scale: 1, dy: 0 });
  });
});

describe("the render plan and its ASS file", () => {
  it("captions and text layers in one file: own fonts by name, no wrapping by libass, the spoken word coloured", () => {
    const s = edit(snap(), { op: "set_caption_style", font: "Montserrat", weight: 900, highlight: "#FFD400", wordsAtOnce: 3, wordsPerLine: 3, lines: 1 },
      { op: "add_text", text: "TITLE", start: 1, end: 4, preset: "title", card: { color: "#101010", opacity: 0.9 } },
      { op: "add_text", text: "Slide", start: 2, end: 5, preset: "lower-third" }).snap;
    const p = plan(s);
    expect(p.ass).toMatch(/WrapStyle: 2/);
    expect(p.ass).toMatch(/Style: Cap,RC Montserrat 900,[\d.]+,&H00FFFFFF/);
    expect(p.ass).toMatch(/Style: T0,RC Montserrat 900,/);
    expect(p.ass).toMatch(/Style: Card,/);
    expect(p.ass).toMatch(/\{\\an7\\pos\(0,0\)\\p1\\bord0\\shad0\\1c&H101010&\\1a&H1A&\\fad\(100,250\)\}m 0 0 l 960 0 960 540 0 540\{\\p0\}/);
    expect(p.ass).toMatch(/\\fad\(100,250\)\\fscx80\\fscy80\\t\(0,150,\\fscx100\\fscy100\)/);
    expect(p.ass).toMatch(/\\move\([\d.]+,[\d.]+,[\d.]+,[\d.]+,0,250\)\\fad\(250,250\)/);
    // One caption event per spoken word, that word in the highlight colour.
    const first = p.styledCaptions![0];
    const evs = p.ass!.split("\n").filter((l) => l.startsWith("Dialogue: 1000,"));
    expect(evs.length).toBe(p.styledCaptions!.reduce((n, c) => n + c.lines.flat().length, 0));
    expect(evs[0]).toContain(`{\\1c&H00D4FF&}${first.lines[0][0].text}{\\1c&HFFFFFF&}`);
    expect(evs[1]).toContain(`{\\1c&H00D4FF&}${first.lines[0][1].text}{\\1c&HFFFFFF&}`);
    expect(p.texts).toHaveLength(2);
    expect(p.operations.join("\n")).toMatch(/Captions: \d+ word-timed events, own style: Montserrat 900[^\n]*\nText layers: 2/);
  });
  it("the live frame: the caption's lines with the spoken word, text layers with their animation", () => {
    const s = edit(snap(), { op: "set_caption_style", highlight: "#FFD400" }, { op: "add_text", text: "Hi", start: 1, end: 4, preset: "callout" }).snap;
    const p = plan(s);
    const c = p.styledCaptions![0];
    const f = liveFrame(p, c.lines[0][1].start + 0.01);
    expect(f.captionLines![0][1]).toEqual({ text: c.lines[0][1].text, active: true });
    expect(f.captionLines![0][0].active).toBe(false);
    const g = liveFrame(p, p.texts![0].start + 0.05);
    expect(g.texts[0]).toMatchObject({ layer: { clipId: p.texts![0].clipId }, scale: expect.any(Number) });
    expect(g.texts[0].opacity).toBeLessThan(1);
  });
});

describe("styles carry a full caption style", () => {
  it("apply_style and set_captions{styleId} give any video the style's captions in one step", () => {
    const a = edit(snap(), { op: "apply_style", styleId: "own" }).snap;
    expect(a.timeline.captionStyle).toMatchObject({ font: "Poppins", weight: 800, highlight: "#00FF88" });
    const b = edit(snap("9:16"), { op: "set_captions", on: true, styleId: "own" });
    expect(b.summary).toMatch(/captions on, style of Own: Poppins 800/);
    expect(b.snap.timeline.captionStyle).toEqual(a.timeline.captionStyle);
    // A style without one gives the look's preset (the edit's own style goes).
    expect(edit(a, { op: "apply_style", styleId: "s2" }).snap.timeline.captionStyle).toBeUndefined();
  });
});

describe("the check", () => {
  const ok: FileMeasure = { videoSeconds: 9.9, audioSeconds: 9.9, black: [], silences: [], lufs: -14, peakDb: -1.5, graphics: [] };
  it("names the caption style, lists text layers, and flags text that does not fit or covers the captions", () => {
    let s = edit(snap(), { op: "set_caption_style", font: "Montserrat", weight: 900 }).snap;
    s = edit(s, { op: "add_text", text: "Fits", start: 1, end: 3, preset: "callout" },
      { op: "add_text", text: "A VERY LONG TITLE THAT CANNOT POSSIBLY FIT ACROSS THE FRAME", start: 2, end: 4, preset: "title", size: 12 },
      { op: "add_text", text: "Over the captions", start: 1, end: 3, y: 0.86 }).snap;
    const q = editCheck(s, tr, { measured: ok });
    expect(q).toMatch(/Captions: on \(own style: Montserrat 900/);
    expect(q).toMatch(/Text: 3 layers: 0:01\.0-0:03\.0 "Fits" pop/);
    expect(q).toMatch(/text "A VERY LONG TITLE THAT CANNOT " at 0:02\.0 does not fit in the frame/);
    expect(q).toMatch(/text "Over the captions" at 0:01\.0 covers the captions/);
    expect(q).not.toMatch(/"Fits" at 0:01\.0 (does not fit|covers)/);
  });
  it("the layout's boxes: a caption's bottom sits on y, its box reaches past it by the padding", () => {
    const st = presetStyle("clean", "16:9");
    const c = layoutCaptions([[{ text: "Hello", start: 0, end: 0.4 }, { text: "world", start: 0.4, end: 0.8 }]], st, 960, 540, 2)[0];
    const r = captionRect(c, st, 960, 540), d = drawnOf(st, 960, 540);
    expect(r.y + r.h).toBeCloseTo(st.y * 540 + d.box!.pad, 5);
    const t = textRect({ lines: ["Hi"], style: { ...presetStyle("clean", "16:9"), align: "left", x: 0.1, y: 0.5 } as TextStyle }, 960, 540);
    expect(t.x).toBeCloseTo(96, 5);
  });
});
