import { describe, expect, it } from "vitest";
import {
  applyOp, buildBreakdown, buildInitialTimeline, editCheck, EditError, markFillers, MCP_TOOLS, mergeRules, refreshFillers, STYLES, stubTranscript,
  type EditContext, type Measured, type Snapshot, type Transcript,
} from "../src/index";

const tr = stubTranscript(40);
const ctx: EditContext = { transcript: tr, silences: [], sceneCuts: [], duration: 40, getStyle: (id) => STYLES.find((s) => s.id === id), getVideo: () => undefined, getGraphic: () => undefined };
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 40, "clean"), name: "t", aspect: "16:9", styleId: "s2" });
const zooms = (s: Snapshot) => s.timeline.tracks.v2.filter((c) => (c as Record<string, unknown>).kind === "zoom");

describe("apply_edits: a list of edits as one change", () => {
  it("runs every edit in order and sums them up in one summary", () => {
    const r = applyOp(snap(), { op: "batch", ops: [{ op: "cut_silences", overSeconds: 0.4 }, { op: "remove_fillers" }, { op: "set_captions", on: true, look: "bold" }, { op: "add_zoom", start: 2, end: 3, scale: 1.15 }, { op: "add_zoom", start: 10, end: 11, scale: 1.15 }, { op: "add_music", trackId: "upbeat" }] }, ctx);
    expect(r.summary.split("; ")).toHaveLength(6);
    expect(r.snap.timeline.captionLook).toBe("bold");
    expect(zooms(r.snap)).toHaveLength(2);
    expect(r.snap.timeline.tracks.a2).toHaveLength(1);
  });
  it("saves nothing when one edit fails, and says which", () => {
    expect(() => applyOp(snap(), { op: "batch", ops: [{ op: "remove_fillers" }, { op: "add_zoom", start: 5, end: 4, scale: 1.1 }] }, ctx)).toThrow(/Edit 2 \(add_zoom\).*Nothing was changed/);
    expect(() => applyOp(snap(), { op: "batch", ops: [{ op: "add_music", trackId: "no-such-mood" }] }, ctx)).toThrow(EditError);
  });
});

describe("rule-based first pass with overrides", () => {
  it("places exactly the asked number of zooms", () => {
    for (const count of [1, 2, 5]) {
      const r = applyOp(snap(), { op: "apply_style", styleId: "s1", overrides: { zoom: { mode: "count", count } } }, ctx);
      expect(zooms(r.snap)).toHaveLength(count);
    }
  });
  it("keeps the style's other rules and changes only the overridden ones", () => {
    const s1 = STYLES.find((s) => s.id === "s1")!.rules;
    const m = mergeRules(s1, { cutSilencesOver: 0.6, music: { mood: "lofi" } });
    expect(m.cutSilencesOver).toBe(0.6);
    expect(m.music).toEqual({ mood: "lofi", gainDb: s1.music.gainDb });
    expect(m.captions).toEqual(s1.captions);
  });
});

describe("fillers", () => {
  it("catches drawn-out spellings but not real words", () => {
    const w = ["umm,", "Uhh", "erm", "hmm", "um", "summer", "her", "huh", "uh-huh"].map((text, i) => ({ text, start: i, end: i + 0.3 }));
    expect(markFillers(w)).toEqual([true, true, true, true, true, false, false, false, false]);
  });
  it("re-marks a stored transcript only when something changes", () => {
    const t: Transcript = [{ id: "l0", start: 0, end: 2, gapBefore: 0, words: [{ id: "w0", text: "And,", t: 0, end: 0.2, filler: false }, { id: "w1", text: "umm,", t: 0.3, end: 0.5, filler: false }, { id: "w2", text: "yes", t: 0.6, end: 0.9, filler: false }] }];
    const next = refreshFillers(t)!;
    expect(next[0].words.map((w) => w.filler)).toEqual([false, true, false]);
    expect(refreshFillers(next)).toBeNull();
  });
});

describe("the check after a render", () => {
  it("reports pauses, fillers, captions, zooms and music as text", () => {
    const s = snap();
    const raw = editCheck(s, tr, { pauseOver: 0.4, loudness: { lufs: -14.2, peakDb: -0.4 } });
    expect(raw).toMatch(/^CHECK /);
    expect(raw).toMatch(/Captions: on \(clean\), 100% of spoken words/);
    expect(raw).toMatch(/Loudness of the file: -14.2 LUFS, true peak -0.4 dBTP \(target -14 LUFS, ceiling -1 dBTP\)/);
    expect(raw).toMatch(/Flags: .*true peak -0.4 dBTP over the -1 dBTP ceiling/);
    expect(raw).toMatch(/Sound: cleanup none, -14 LUFS \/ -1 dBTP, music 12 dB down under speech/);
    const edited = applyOp(s, { op: "batch", ops: [{ op: "cut_silences", overSeconds: 0.4 }, { op: "remove_fillers" }, { op: "add_zoom", start: 2, end: 3, scale: 1.2 }, { op: "add_music", trackId: "upbeat" }] }, ctx).snap;
    const out = editCheck(edited, tr, { pauseOver: 0.4 });
    expect(out).toMatch(/Fillers left: none/);
    expect(out).toMatch(/Zooms 1: 0:0\d\.\d 120%/);
    expect(out).toMatch(/Music: .*under 100% of the edit/);
    expect(out).not.toMatch(/Loudness/);
  });
  it("lists a filler that is still in the edit", () => {
    const t: Transcript = [{ id: "l0", start: 0, end: 2, gapBefore: 0, words: [{ id: "w0", text: "So", t: 0, end: 0.2, filler: false }, { id: "w1", text: "umm", t: 0.3, end: 0.5, filler: true }, { id: "w2", text: "yes", t: 0.6, end: 0.9, filler: false }] }];
    const s: Snapshot = { timeline: buildInitialTimeline(t, 2, "bold"), name: "t", aspect: "9:16", styleId: "s1" };
    expect(editCheck(s, t)).toMatch(/Fillers left: "umm" 0:00.3/);
  });
});

describe("overview sheet", () => {
  const measured = (sheets: number, overview: boolean): Measured => ({
    interval: 1, size: [1280, 720], loudness: [], tempo: null,
    samples: [{ t: 0, shot: 0, b: 0.5, s: 0.2, m: 0, c: ["#000000"] }],
    sheets: Array.from({ length: sheets }, (_, i) => ({ file: `sheet-00${i + 1}.jpg`, times: [i * 16, i * 16 + 15], cols: 4, rows: 4, tile: [320, 180] as [number, number] })),
    overview: overview ? { file: "sheet-overview.jpg", times: [0, 10, 20, 31], cols: 4, rows: 1, tile: [320, 180] } : null,
  });
  const video = { id: "v", name: "v", kind: "footage" as const, seconds: 32, width: 1280, height: 720, orientation: "Landscape", fps: 30, hasAudio: true };
  it("keeps the overview sheet, or uses the only sheet as the overview", () => {
    const many = buildBreakdown({ video, transcript: [], silences: [], sceneCuts: [], measured: measured(3, true), sheetKeys: ["a", "b", "c"], overviewKey: "o" });
    expect(many.frames.overview).toMatchObject({ key: "o", from: 0, to: 31 });
    const one = buildBreakdown({ video, transcript: [], silences: [], sceneCuts: [], measured: measured(1, false), sheetKeys: ["a"] });
    expect(one.frames.overview?.key).toBe("a");
  });
});

describe("connector tool list", () => {
  it("stays small", () => {
    // 23: add_font (a font file once, used by name in graphics).
    expect(MCP_TOOLS.length).toBeLessThanOrEqual(23);
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const gone of ["cut_silences", "add_zoom", "set_captions", "list_references", "get_reference"]) expect(names).not.toContain(gone);
    expect(names).toEqual(expect.arrayContaining(["apply_edits", "save_style", "link_account"]));
  });
});
