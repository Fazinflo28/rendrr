import { describe, expect, it } from "vitest";
import {
  allWords, applyOp, buildBreakdown, buildInitialTimeline, EDIT_OP_NAMES, editCheck, EditError, HOW_TO_EDIT, markFillers, MCP_TOOLS, mergeRules, refreshFillers, STYLES, stubTranscript,
  type EditContext, type Measured, type Snapshot, type Transcript,
} from "../src/index";

const tr = stubTranscript(40);
const ctx: EditContext = { transcript: tr, silences: [], sceneCuts: [], duration: 40, getStyle: (id) => STYLES.find((s) => s.id === id), getVideo: () => undefined, getGraphic: () => undefined };
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 40, "clean"), name: "t", aspect: "16:9", styleId: "s2" });
const zooms = (s: Snapshot) => s.timeline.tracks.v2.filter((c) => (c as Record<string, unknown>).kind === "zoom");
const fillerIds = allWords(tr).filter((w) => w.filler).map((w) => w.id);

describe("apply_edits: a list of edits as one change", () => {
  it("runs every edit in order and sums them up in one summary", () => {
    const r = applyOp(snap(), { op: "batch", ops: [{ op: "cut_words", from: 3, to: 3.5 }, { op: "add_marks", marks: [{ kind: "custom", start: 1 }] }, { op: "set_captions", on: true, look: "bold" }, { op: "add_zoom", start: 2, end: 3, scale: 1.15 }, { op: "add_zoom", start: 10, end: 11, scale: 1.15 }, { op: "add_music", trackId: "upbeat" }] }, ctx);
    expect(r.summary.split("; ")).toHaveLength(6);
    expect(r.snap.timeline.captionLook).toBe("bold");
    expect(zooms(r.snap)).toHaveLength(2);
    expect(r.snap.timeline.tracks.a2).toHaveLength(1);
  });
  it("saves nothing when one edit fails, and says which", () => {
    expect(() => applyOp(snap(), { op: "batch", ops: [{ op: "set_captions", on: true }, { op: "add_zoom", start: 5, end: 4, scale: 1.1 }] }, ctx)).toThrow(/Edit 2 \(add_zoom\).*Nothing was changed/);
    expect(() => applyOp(snap(), { op: "batch", ops: [{ op: "add_music", trackId: "no-such-mood" }] }, ctx)).toThrow(EditError);
  });
});

describe("Rendrr never edits on its own", () => {
  it("apply_style sets the style's looks only, and names its other rules for the AI to do", () => {
    const before = snap();
    const r = applyOp(before, { op: "apply_style", styleId: "s1", overrides: { zoom: { mode: "count", count: 3 } } }, ctx);
    expect(zooms(r.snap)).toHaveLength(0);
    expect(r.snap.timeline.tracks.v1).toEqual(before.timeline.tracks.v1);
    expect(r.snap.timeline.tracks.a2).toEqual([]);
    expect(r.snap.timeline.cut).toEqual(before.timeline.cut);
    expect(r.snap.styleId).toBe("s1");
    expect(r.summary).toMatch(/applied style .* \(looks only\): captions \w+\. Its other rules, for you to do with explicit edits if you want them: .*3 zooms of \d+% on sentence starts/);
  });
  it("cut_silences and remove_fillers are retired: a clear answer with what to do instead", () => {
    expect(() => applyOp(snap(), { op: "cut_silences", overSeconds: 0.4 }, ctx)).toThrow(/cut_silences is retired.*mark_silences.*cut_words \{from, to\}/);
    expect(() => applyOp(snap(), { op: "remove_fillers" }, ctx)).toThrow(/remove_fillers is retired.*mark_fillers.*cut_words \{wordIds\}/);
    expect(EDIT_OP_NAMES).not.toContain("cut_silences");
    expect(EDIT_OP_NAMES).not.toContain("remove_fillers");
    expect(EDIT_OP_NAMES).toEqual(expect.arrayContaining(["add_marks", "update_mark", "delete_mark"]));
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
    const edited = applyOp(s, { op: "batch", ops: [{ op: "cut_words", wordIds: fillerIds }, { op: "add_zoom", start: 2, end: 3, scale: 1.2 }, { op: "add_music", trackId: "upbeat" }] }, ctx).snap;
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
    // 23: add_font (a font file once, used by name in graphics); 24: get_graphic (long recordings are polled);
    // 28: mark_silences, mark_fillers, list_marks, get_retakes (Rendrr measures, the AI cuts);
    // 32: get_audio, get_waveform_image, get_vision, map_time (the deeper measurements and time conversion).
    // 33: test_graphic (a few seconds of a graphic over the footage, before a full preview).
    // 37: list_library, get_library_item, add_library_item, search_icons (the hidden library: ready animations).
    // 38: analyze_reference (a reference video measured into a style file).
    // 41: get_editing_skill (the skill that comes with the connector), check_edit (a check with no render, so one
    // render per revision), open_projects (the Rendrr app in the chat; its own tools are in APP_TOOLS, hidden from the AI).
    // 42: add_lut (a .cube LUT from a link, the user's Drive or its text: a look made outside Rendrr, put on the edit).
    // 44: create_folder (a project folder for a client or series), create_shorts (shorts from a long video in one call:
    // an edit per short, cut, shaped, reframed and captioned).
    // 45: save_to_drive (a final copied into the folder the user named in their Google Drive).
    expect(MCP_TOOLS.length).toBeLessThanOrEqual(45);
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const gone of ["cut_silences", "remove_fillers", "add_zoom", "set_captions", "list_references", "get_reference"]) expect(names).not.toContain(gone);
    expect(names).toEqual(expect.arrayContaining(["apply_edits", "save_style", "link_account"]));
  });
  it("an app's old copy of apply_edits cannot hide newer ops: op is free text and the guide lists every op", () => {
    const ae = MCP_TOOLS.find((t) => t.name === "apply_edits")!;
    expect(ae.input.safeParse({ projectId: "p", edits: [{ op: "a_future_op", x: 1 }] }).success).toBe(true);
    for (const op of EDIT_OP_NAMES) expect(HOW_TO_EDIT).toContain(op);
    expect(HOW_TO_EDIT).toContain("set_rotation{degrees");
    expect(HOW_TO_EDIT).toContain("add_marks{marks");
    expect(HOW_TO_EDIT).not.toContain("cut_silences{");
  });
});
