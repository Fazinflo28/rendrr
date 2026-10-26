// Part 1: Rendrr marks what it measures and never cuts on its own. Marks from the analysis (silences, fillers,
// retakes, stumbles, false starts, notes to the crew, picture), where they play in an edit, and the AI's own marks
// and notes on Rendrr's (add_marks, update_mark, delete_mark), kept with the edit.
import { describe, expect, it } from "vitest";
import {
  applyOp, buildRawTimeline, fillerMarks, findRetakes, footageMarks, lineSimilarity, markInEdit, marksOf, marksText, pictureMarks, sequenceView, silenceMarks, speechMarks, stumblesIn, TimelineSchema,
  type EditContext, type FootageInput, type Line, type Op, type Snapshot, type Transcript, type Word,
} from "../src/index";

/** A line of words spoken one after another from `start`, each `per` seconds with a 0.05 s gap. */
let wn = 0;
function line(id: string, start: number, text: string, per = 0.3, fillers: string[] = []): Line {
  const words: Word[] = text.split(" ").map((w, i) => ({ id: `w${wn++}`, text: w, t: +(start + i * (per + 0.05)).toFixed(3), end: +(start + i * (per + 0.05) + per).toFixed(3), filler: fillers.includes(w.toLowerCase().replace(/[^a-z]/g, "")) }));
  return { id, start, end: words[words.length - 1].end, gapBefore: 0, words };
}
// A talking head with a retake (three takes of one line), a stumble, a false start and a note to the crew.
wn = 0;
const tr: Transcript = [
  line("l0", 0.5, "Hi everyone, welcome back to the channel."),
  line("l1", 3.5, "Today we are going to build a"),
  line("l2", 6.5, "Today we are going to build a, um, website from scratch."),
  line("l3", 11.5, "Sorry, let me start again."),
  line("l4", 14, "Today we are going to build a website from scratch in ten minutes.", 0.3, ["um"]),
  line("l5", 19, "It is it is really easy, uh, if you follow along.", 0.3, ["uh"]),
  line("l6", 24, "First first we buil building the page."),
];
const f: FootageInput = { videoId: "vidAB12", transcript: tr, silences: [{ start: 2.9, end: 3.45 }, { start: 30, end: 33 }], sceneCuts: [10], loudnessDb: Array.from({ length: 34 }, (_, i) => (i === 5 ? -6 : -21 + (i % 3))), beats: [1, 2], dark: [{ start: 8, end: 9 }], duration: 34 };

describe("silences and fillers", () => {
  it("every gap between words from 0.15 s, before the first and after the last word, and stretches with no speech", () => {
    const m = silenceMarks(f);
    const first = m[0];
    expect(first).toMatchObject({ id: "sil_0_AB12", kind: "silence", start: 0, end: 0.5, label: "before the first word", source: "rendrr", level_db: null });
    // l0 ends at 2.95; l1 starts at 3.5: quiet in the audio (2.9-3.45 covers 2.95-3.5 within 50 ms): -35 dB.
    const gap = m.find((x) => x.start === tr[0].end)!;
    expect(gap).toMatchObject({ end: 3.5, label: "between words", level_db: -35, confidence: 0.95 });
    const last = m[m.length - 1];
    expect(last).toMatchObject({ label: "after the last word", end: 34 });
    // Gaps under 0.15 s are not marks (0.05 s between words here).
    expect(m.every((x) => x.end - x.start >= 0.15)).toBe(true);
    // The same footage gives the same ids.
    expect(silenceMarks(f).map((x) => x.id)).toEqual(m.map((x) => x.id));
  });
  it("fillers carry their word id and text", () => {
    const m = fillerMarks(f);
    expect(m.map((x) => [x.text, x.kind])).toEqual([["uh,", "filler"]]); // "um," in l2 was not marked a filler by the transcriber here
    expect(m[0].id).toBe(`fil_${m[0].wordId}_AB12`);
  });
});

describe("retakes, stumbles, false starts and notes to the crew", () => {
  it("lines that say the same thing are grouped and each take is measured, never picked", () => {
    expect(lineSimilarity(["today", "we", "are", "going"], ["today", "we", "are", "going", "to"])).toBeGreaterThanOrEqual(0.6);
    expect(lineSimilarity(["hi", "everyone"], ["first", "we", "build"])).toBe(0);
    const g = findRetakes(f);
    expect(g).toHaveLength(1);
    expect(g[0].groupId).toBe("rt1");
    expect(g[0].takes.map((t) => t.lineId)).toEqual(["l1", "l2", "l4"]);
    const [a, b, c] = g[0].takes;
    expect(c.words).toBeGreaterThan(b.words);
    expect(c.score).toBeGreaterThan(a.score); // complete and ends a sentence
    expect(b.fillers).toBe(0);
    expect(c).toMatchObject({ pitch_var: null });
    expect(typeof c.wpm).toBe("number");
    expect(c.loudness).not.toBeNull();
    // No take is marked as the one to keep: only measurements.
    expect(Object.keys(c)).not.toContain("best");
  });
  it("stumbles: a repeated word, a cut-off word, a repeated pair", () => {
    expect(stumblesIn(tr[5].words).map((s) => s.text)).toEqual(["It is it is"]);
    expect(stumblesIn(tr[6].words).map((s) => s.text)).toEqual(["First first", "buil building"]);
  });
  it("false starts and notes to the crew", () => {
    const m = speechMarks(f);
    const fs = m.filter((x) => x.kind === "false_start");
    expect(fs.map((x) => x.start)).toContain(3.5); // "Today we are going to build a" then the same opening 3 s later
    const dir = m.filter((x) => x.kind === "director_note");
    expect(dir).toHaveLength(1);
    expect(dir[0]).toMatchObject({ start: 11.5, label: "let me start again" });
    expect(m.filter((x) => x.kind === "retake").map((x) => x.label)).toEqual(["rt1 take 1 of 3", "rt1 take 2 of 3", "rt1 take 3 of 3"]);
  });
  it("picture and sound: scene changes, beats, dark stretches, loud moments", () => {
    const m = pictureMarks(f);
    expect(m.filter((x) => x.kind === "scene_change").map((x) => x.start)).toEqual([10]);
    expect(m.filter((x) => x.kind === "music_beat")).toHaveLength(2);
    expect(m.find((x) => x.kind === "low_light")).toMatchObject({ start: 8, end: 9 });
    expect(m.filter((x) => x.kind === "loud_peak").map((x) => x.start)).toEqual([5]);
  });
  it("one mark per id, in time order", () => {
    const all = footageMarks(f);
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
    for (let i = 1; i < all.length; i++) expect(all[i].start).toBeGreaterThanOrEqual(all[i - 1].start);
  });
});

// ---------------------------------------------------------------------------------------------
// In an edit.
// ---------------------------------------------------------------------------------------------
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "vidAB12", transcript: tr, silences: f.silences, sceneCuts: [10], duration: 34, getStyle: () => undefined, getVideo: (id) => (id === "b2" ? { id, name: "B-roll", seconds: 5, ready: true } : undefined), rendrrMarkIds: () => new Set(footageMarks(f).map((m) => m.id)) };
const raw = (): Snapshot => ({ timeline: buildRawTimeline(tr, 34, [], "vidAB12"), name: "t", aspect: "16:9", styleId: null });
const edit = (s: Snapshot, ...ops: unknown[]) => applyOp(s, (ops.length === 1 ? ops[0] : { op: "batch", ops }) as Op, ctx);

describe("where a mark plays in the edit", () => {
  it("edit times after a cut, partly cut, and null once cut", () => {
    const s = edit(raw(), { op: "cut_words", from: 3, to: 6.5 }).snap; // takes out l1 and the silence before it
    const view = sequenceView(s.timeline, words);
    expect(markInEdit(view, "vidAB12", 0.5, 2.9)).toEqual({ start: 0.5, end: 2.9, partly: false });
    expect(markInEdit(view, "vidAB12", 3.5, 5)).toBeNull();
    const p = markInEdit(view, "vidAB12", 2.5, 7)!;
    expect(p.partly).toBe(true);
    expect(p.start).toBeCloseTo(2.5, 3);
    expect(p.end).toBeCloseTo(3.5, 3); // 7 s of footage plays at 7 - 3.5
    // A moment (start = end) plays at one edit time.
    expect(markInEdit(view, "vidAB12", 10, 10)).toEqual({ start: 6.5, end: 6.5, partly: false });
  });
  it("marksOf adds the AI's marks and its notes on Rendrr's, and each one's place in the edit", () => {
    let s = edit(raw(), { op: "add_marks", marks: [{ kind: "custom", start: 1, end: 2, label: "nice smile" }] }).snap;
    const filler = fillerMarks(f)[0];
    s = edit(s, { op: "update_mark", id: filler.id, note: "keep: it sounds natural", label: "uh (keep)" }).snap;
    const rows = marksOf([f], s.timeline, sequenceView(s.timeline, words));
    const mine = rows.find((r) => r.source === "ai")!;
    expect(mine).toMatchObject({ kind: "custom", start: 1, end: 2, label: "nice smile", videoId: "vidAB12", edit: { start: 1, end: 2, partly: false } });
    expect(rows.find((r) => r.id === filler.id)).toMatchObject({ label: "uh (keep)", note: "keep: it sounds natural" });
    expect(marksText(rows.filter((r) => r.id === mine.id))).toBe(`${mine.id} custom 1-2 ai "nice smile" | edit 1-2`);
  });
});

describe("the AI's marks: add_marks, update_mark, delete_mark", () => {
  it("adds marks in footage or edit seconds and names their ids", () => {
    const cut = edit(raw(), { op: "cut_words", from: 3, to: 6.5 }).snap;
    const r = edit(cut, { op: "add_marks", marks: [{ kind: "retake", start: 7, end: 9, note: "best energy" }, { kind: "off_camera", start: 1, edit: undefined }] });
    const m = r.snap.timeline.marks!;
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ kind: "retake", videoId: "vidAB12", start: 7, end: 9, source: "ai", note: "best energy" });
    expect(m[1]).toMatchObject({ kind: "off_camera", start: 1, end: 1 });
    expect(r.summary).toBe(`added 2 marks: ${m[0].id}, ${m[1].id}`);
    expect(m.every((x) => /^mk_/.test(x.id))).toBe(true);
    // Edit seconds: 4 s of the edit is 7.5 s of footage (3.5 s were cut before it).
    const e = edit(cut, { op: "add_marks", marks: [{ kind: "custom", start: 4, end: 5 }], edit: true });
    expect(e.snap.timeline.marks![0]).toMatchObject({ start: 7.5, end: 8.5 });
    expect(e.summary).toMatch(/added mark mk_\w+ \(custom 7\.50s to 8\.50s\)/);
    // Stored with the edit: the timeline still parses (and so goes back with undo, like any version).
    expect(TimelineSchema.safeParse(e.snap.timeline).success).toBe(true);
  });
  it("refuses marks that end before they start, run past the footage, or cross a cut to other footage", () => {
    expect(() => edit(raw(), { op: "add_marks", marks: [{ kind: "custom", start: 5, end: 4 }] })).toThrow(/ends \(4\.00s\) before it starts \(5\.00s\)/);
    expect(() => edit(raw(), { op: "add_marks", marks: [{ kind: "custom", start: 30, end: 40 }] })).toThrow(/only 34\.0s long/);
    const two = edit(raw(), { op: "add_clip", videoId: "b2", from: 0, to: 5 }).snap;
    expect(() => edit(two, { op: "add_marks", marks: [{ kind: "custom", start: 33, end: 36 }], edit: true })).toThrow(/runs across a cut to other footage/);
    const onB = edit(two, { op: "add_marks", marks: [{ kind: "custom", start: 35, end: 36 }], edit: true }).snap.timeline.marks![0];
    expect(onB).toMatchObject({ videoId: "b2", start: 1, end: 2 });
  });
  it("update_mark: any field of the AI's own; label, note and hidden of Rendrr's", () => {
    let s = edit(raw(), { op: "add_marks", marks: [{ kind: "custom", start: 1, end: 2, label: "a", note: "n" }] }).snap;
    const id = s.timeline.marks![0].id;
    s = edit(s, { op: "update_mark", id, kind: "stumble", start: 1.5, label: null, note: "trip" }).snap;
    expect(s.timeline.marks![0]).toEqual({ id, kind: "stumble", videoId: "vidAB12", start: 1.5, end: 2, source: "ai", note: "trip" });
    expect(() => edit(s, { op: "update_mark", id, hidden: true })).toThrow(/hidden is for Rendrr's marks/);
    const sil = silenceMarks(f)[0].id;
    expect(() => edit(s, { op: "update_mark", id: sil, start: 0.1 })).toThrow(/one of Rendrr's marks: its kind, times and confidence are measured/);
    const h = edit(s, { op: "update_mark", id: sil, hidden: true, note: "a breath, keep" });
    expect(h.snap.timeline.markEdits).toEqual({ [sil]: { hidden: true, note: "a breath, keep" } });
    expect(h.summary).toBe(`updated Rendrr's mark ${sil}: note, hidden in this edit`);
    const back = edit(h.snap, { op: "update_mark", id: sil, hidden: false, note: null }).snap;
    expect(back.timeline.markEdits).toBeUndefined(); // nothing left to keep
    expect(() => edit(s, { op: "update_mark", id: "sil_99999_AB12" })).toThrow(/There is no mark sil_99999_AB12/);
    expect(() => edit(s, { op: "update_mark", id: "nope" })).toThrow(/There is no mark nope/);
  });
  it("delete_mark: the AI's go, Rendrr's are hidden in this edit", () => {
    let s = edit(raw(), { op: "add_marks", marks: [{ kind: "custom", start: 1 }, { kind: "custom", start: 2 }] }).snap;
    const [a, b] = s.timeline.marks!.map((m) => m.id);
    const fil = fillerMarks(f)[0].id;
    const r = edit(s, { op: "delete_mark", ids: [a, fil] });
    expect(r.snap.timeline.marks!.map((m) => m.id)).toEqual([b]);
    expect(r.snap.timeline.markEdits).toEqual({ [fil]: { hidden: true } });
    expect(r.summary).toBe(`deleted 1 mark; hid Rendrr's mark ${fil} in this edit (update_mark hidden false shows it again)`);
    s = edit(r.snap, { op: "delete_mark", id: b }).snap;
    expect(s.timeline.marks).toBeUndefined();
    expect(() => edit(s, { op: "delete_mark", ids: [] })).toThrow(/needs id or ids/);
    // Hidden marks stay listed only when asked (marksOf flags them).
    expect(marksOf([f], s.timeline).find((m) => m.id === fil)!.hidden).toBe(true);
  });
  it("an editor save that does not send marks keeps them; an old edit without marks still loads", () => {
    const s = edit(raw(), { op: "add_marks", marks: [{ kind: "custom", start: 1 }] }).snap;
    const { marks: _m, ...fromEditor } = s.timeline;
    const saved = edit(s, { op: "replace", timeline: fromEditor }).snap;
    expect(saved.timeline.marks).toEqual(s.timeline.marks);
    expect(TimelineSchema.safeParse(raw().timeline).success).toBe(true);
    expect(raw().timeline.marks).toBeUndefined();
  });
});
