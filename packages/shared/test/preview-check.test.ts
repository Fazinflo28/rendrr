// Engine Part 3: the preview check's new lines. Gaps in speech come from the FILE's sound and are placed at the edit's
// joins (which side of the join, footage time, clip); words a cut goes through come from the word edges in the sound;
// clicks at joins; how much of the face a graphic covers; what is heard against the edit's words.
import { describe, expect, it } from "vitest";
import {
  applyOp, boxCover, boxOnScreen, buildRawTimeline, buildTranscript, clippedWords, editCheck, faceAt, heardDiff, heardDiffLine, joinClicks, sequenceView, soundJoins, speechGaps, STYLES, wordsAsPlayed,
  type Aligned, type EditContext, type EditOp, type FileMeasure, type Snapshot, type Transcript,
} from "../src/index";
import { zoomAt } from "../src/renderPlan";

// 20 words, each 0.4 s with 0.1 s between (word i from 0.5 + i * 0.5), so the footage's pauses are 0.1 s.
const SEC = 12;
const tr: Transcript = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `word${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 5 })
  .map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: SEC, getStyle: (id) => STYLES.find((s) => s.id === id), getGraphic: (id) => ({ id, name: "Box", durationSec: 4 }) };
const raw = (): Snapshot => ({ timeline: buildRawTimeline(tr, SEC, [], "v"), name: "t", aspect: "16:9", styleId: null });
const edit = (s: Snapshot, ...ops: EditOp[]) => applyOp(s, { op: "batch", ops }, ctx).snap;
const clips = (...cs: [string, number, number][]) => ({ op: "set_clips", track: "v1", clips: cs.map(([id, start, end]) => ({ id, start, end, label: "" })) }) as EditOp;
// The word edges in the sound (alignment): here 20 ms wider than the transcriber's on each side.
const aligned = new Map<string, Aligned>(words.map((w) => [w.id, { s: Math.round((w.t - 0.02) * 1000) / 1000, e: Math.round((w.end + 0.02) * 1000) / 1000, c: 0.9 }]));
const viewOf = (s: Snapshot) => sequenceView(s.timeline, words);
const isCut = (s: Snapshot) => (_v: string, id: string) => s.timeline.cut.includes(id);

describe("joins", () => {
  it("a join where the dialogue jumps; none where the footage goes on", () => {
    const s = edit(raw(), clips(["a", 0, 3], ["b", 3, 6], ["c", 8, 12]));
    const j = soundJoins(viewOf(s).sound);
    expect(j.map((x) => x.at)).toEqual([6]); // a|b goes on (3 = 3), b|c jumps from 6 to 8
  });
});

describe("gaps in speech, from the file's sound", () => {
  // Clip a ends 0.2 s after word5's sound (3.42), clip b starts 0.1 s before word10's sound (5.48): a 0.3 s gap at the join.
  const s = edit(raw(), clips(["a", 0, 3.62], ["b", 5.38, 12]));
  const view = viewOf(s);
  const join = 3.62;
  // The file's speech: each word's sound in the edit (word edges +-20 ms), one long stretch where words follow closely.
  it("a gap across a join is split into its two sides, each with its clip and footage time", () => {
    const sound = { speech: [[0.48, 3.42], [join + 0.1, 10]] as [number, number][], breaths: [] };
    const gaps = speechGaps(view, sound, [], view.total);
    const g = gaps.find((x) => x.joins.length)!;
    expect(g.start).toBeCloseTo(3.42, 6);
    expect(g.end).toBeCloseTo(join + 0.1, 6);
    expect(g.segments.map((x) => [x.where, x.clipId, Math.round((x.end - x.start) * 100) / 100, x.src!.map((v) => Math.round(v * 1000) / 1000)])).toEqual([
      ["end", "a", 0.2, [3.42, 3.62]],
      ["start", "b", 0.1, [5.38, 5.48]],
    ]);
    // The lead (before the first word) is a gap too, inside clip a.
    expect(gaps[0]).toMatchObject({ lead: true, joins: [] });
    expect(gaps[0].segments[0]).toMatchObject({ where: "inside", clipId: "a" });
  });
  it("in the check: the gaps line replaces the pauses from word times; silent and breath are said", () => {
    const measured: FileMeasure = { videoSeconds: view.total, audioSeconds: view.total, black: [], silences: [{ start: 3.43, end: 3.71 }], lufs: -14, peakDb: -2, graphics: [],
      sound: { speech: [[0.48, 3.42], [join + 0.1, view.total - 0.2]], roomDb: -70, speechDb: -20, breaths: [], joinClicks: [] } };
    const text = editCheck(s, tr, { measured, videoId: "v" });
    expect(text).not.toMatch(/^Pauses over/m);
    expect(text).toMatch(/^Gaps in speech from 0\.15s \(measured in the file's sound; edit time, length, where; footage seconds\): 1 at joins: 0:03\.42 0\.30s \(silent\) at the join a\|b: end of a 0\.20s \(footage 3\.420-3\.620\) \+ start of b 0\.10s \(footage 5\.380-5\.480\) \| 2 inside clips/m);
    expect(text).toMatch(/^Clicks at joins: none$/m);
  });
  it("gaps under 0.15 s are not listed", () => {
    const gaps = speechGaps(view, { speech: [[0, 3.5], [3.64, view.total]], breaths: [] }, [], view.total);
    expect(gaps).toEqual([]);
  });
});

describe("words a cut goes through", () => {
  it("clips built from each word's edges in the sound: none", () => {
    // An AI-style script: each clip from the start of its first word's sound to the end of its last word's.
    const pick = [[0, 4], [7, 9], [12, 19]].map(([a, b]) => [aligned.get(words[a].id)!.s, aligned.get(words[b].id)!.e]);
    const s = edit(raw(), clips(...pick.map(([a, b], i) => [`k${i}`, a, b] as [string, number, number])));
    const r = clippedWords(viewOf(s), { wordsOf: () => words, alignedOf: () => aligned, isCut: isCut(s) });
    expect(r).toEqual({ words: [], unmeasured: [] });
  });
  it("a cut through a word's sound: the ms cut off and the ms that play, at the start or end of its clip", () => {
    // word3 sounds 1.98-2.42; clip a ends at 2.3 (120 ms cut off). word6 sounds 3.48-3.92; clip b starts at 3.5 (20 ms cut off).
    const s = edit(raw(), clips(["a", 0, 2.3], ["b", 3.5, 12]));
    const r = clippedWords(viewOf(s), { wordsOf: () => words, alignedOf: () => aligned, isCut: isCut(s) });
    expect(r.words.map((w) => [w.text, w.clipId, w.side, Math.round(w.lost * 1000), Math.round(w.plays * 1000)])).toEqual([["word3", "a", "end", 120, 320], ["word6", "b", "start", 20, 420]]);
    const text = editCheck(s, tr, { videoId: "v", aligned: { v: aligned } });
    expect(text).toMatch(/^Clipped words \(a cut goes through the word's sound\): 2: "word3" end of a at 0:02\.30 \(footage 2\.300\): 120ms cut off, 320ms plays; "word6" start of b at 0:02\.30 \(footage 3\.500\): 20ms cut off, 420ms plays$/m);
    expect(text).toMatch(/Flags: .*2 words cut through \(see Clipped words\)/);
  });
  it("a cut word still partly heard is named; without an alignment the transcriber's times are used, and said", () => {
    // cut_words removes word8 by the transcriber's times, from its start to the next word's (4.5-5.0). Its sound starts
    // at 4.48, so 20 ms of it still plays; word9's sound starts at 4.98, so its first 20 ms are cut off.
    const s = edit(raw(), { op: "cut_words", wordIds: [words[8].id] } as EditOp);
    const r = clippedWords(viewOf(s), { wordsOf: () => words, alignedOf: () => aligned, isCut: isCut(s) });
    expect(r.words.map((w) => [w.text, w.cut, w.side, Math.round(w.lost * 1000), Math.round(w.plays * 1000)])).toEqual([["word8", true, "end", 420, 20], ["word9", false, "start", 20, 420]]);
    const none = clippedWords(viewOf(s), { wordsOf: () => words, alignedOf: () => null, isCut: isCut(s) });
    expect(none).toEqual({ words: [], unmeasured: ["v"] });
    expect(editCheck(s, tr, { videoId: "v", aligned: {} })).toMatch(/^Clipped words \(a cut goes through the word's sound\) \(the footage: word edges from the transcriber, the sound is not aligned yet\): none$/m);
  });
});

describe("clicks at joins", () => {
  it("a click within 25 ms of a join is listed with its join, others are not; a burst under 30 dB is a word starting there", () => {
    const s = edit(raw(), clips(["a", 0, 3], ["b", 5, 12]));
    const v = viewOf(s);
    expect(joinClicks(v, { joinClicks: [[3.012, 34.5, "click"], [6, 40, "click"]] })).toEqual(["0:03.01 34.5dB at the join a|b"]);
    // Found live: a "b" right after a cut measured 22.7 dB. Under the in-speech bar it is not a click; the cut's own
    // jump in the waveform is one from 20 dB.
    expect(joinClicks(v, { joinClicks: [[3.01, 22.7, "click"], [3.0, 22.7]] })).toEqual([]);
    expect(joinClicks(v, { joinClicks: [[3.0, 22.7, "cut"]] })).toEqual(["0:03.00 22.7dB at the join a|b (the cut jumps the waveform)"]);
    const measured: FileMeasure = { videoSeconds: v.total, audioSeconds: v.total, black: [], silences: [], lufs: -14, peakDb: -2, graphics: [], sound: { speech: [[0, v.total]], roomDb: -70, speechDb: -20, breaths: [], joinClicks: [[3.012, 34.5, "click"]] } };
    expect(editCheck(s, tr, { measured, videoId: "v" })).toMatch(/Flags: .*1 click at joins/);
  });
});

describe("faces on screen", () => {
  const face: [number, number, number, number] = [0.4, 0.2, 0.2, 0.3];
  it("the same shape, no framing: where it was measured", () => {
    expect(boxOnScreen(face, 0, [640, 360], 960, 540, { rotate: 0 })!.map((v) => +v.toFixed(4))).toEqual([0.4, 0.2, 0.6, 0.5]);
  });
  it("16:9 footage in a 9:16 frame: the middle of it across, all the way down", () => {
    // Fitted: the 640x360 picture scaled to 1707x960, 540 kept across from (1707-540)/2: x 0.4-0.6 of it is 683-1024,
    // so 100-441 on screen.
    const b = boxOnScreen([0.4, 0, 0.2, 1], 0, [640, 360], 540, 960, { rotate: 0 })!;
    expect(b.map((v) => +v.toFixed(2))).toEqual([0.18, 0, 0.82, 1]);
  });
  it("framing halves it about the centre and moves it; zoom grows it about the centre across, 40% down", () => {
    expect(boxOnScreen(face, 0, [640, 360], 960, 540, { rotate: 0, framing: { scale: 0.5, x: 0.1, y: 0 } })!.map((v) => +v.toFixed(4))).toEqual([0.55, 0.35, 0.65, 0.5]);
    const z = boxOnScreen([0.5, 0.4, 0, 0].map((v, i) => (i < 2 ? v : 0.0001)) as [number, number, number, number], 0, [640, 360], 960, 540, { rotate: 0, zoom: 2 })!;
    expect([+z[0].toFixed(3), +z[1].toFixed(3)]).toEqual([0.5, 0.4]); // the zoom's fixed point
    expect(zoomAt([{ start: 1, end: 3, scale: 1.2, mode: "punch" }], 2)).toBeCloseTo(1.2, 9);
  });
  it("measured on the picture turned 90° and the render turns it 90°: the same box; not turned by the render: turned back", () => {
    // A portrait picture measured turned (vision's size is the turned one, 360x640) in a 9:16 frame.
    expect(boxOnScreen(face, 90, [360, 640], 540, 960, { rotate: 90 })!.map((v) => +v.toFixed(4))).toEqual([0.4, 0.2, 0.6, 0.5]);
    // As filmed (landscape 640x360 into a 16:9 frame): the turned box (x 0.4-0.6, y 0.2-0.5) turned back counter-clockwise.
    expect(boxOnScreen(face, 90, [360, 640], 960, 540, { rotate: 0 })!.map((v) => +v.toFixed(4))).toEqual([0.2, 0.4, 0.5, 0.6]);
  });
  it("faceAt takes the largest face of the nearest frame; boxCover is the mean alpha over the box", () => {
    const d = { frames: [[1, [[1, 0.1, 0.1, 0.1, 0.1, 0.9, null, null, null, null], [2, 0.5, 0.5, 0.3, 0.3, 0.9, null, null, null, null]]], [1.1, []]] as never };
    expect(faceAt(d, 1.04)).toEqual([0.5, 0.5, 0.3, 0.3]);
    expect(faceAt(d, 1.08)).toBeNull();
    const S = 4, map = new Uint8Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < 2; i++) map[j * S + i] = 255; // left half opaque
    expect(boxCover(map, S, [0, 0, 1, 1])).toBe(50);
    expect(boxCover(map, S, [0, 0, 0.5, 0.5])).toBe(100);
    expect(boxCover(map, S, [0.25, 0, 0.75, 1])).toBe(50);
  });
  it("in the check: a graphic over the face is flagged; one never visible in any sampled moment is invisible", () => {
    const s = edit(raw(), { op: "add_graphic", graphicId: "g", start: 1, end: 3, params: {} } as EditOp);
    const g = s.timeline.tracks.v3.find((c) => (c as { kind?: string }).kind === "graphic")!;
    const base: FileMeasure = { videoSeconds: SEC, audioSeconds: SEC, black: [], silences: [], lufs: -14, peakDb: -2, graphics: [] };
    const over = editCheck(s, tr, { measured: { ...base, graphics: [{ clipId: g.id, start: 1, end: 3, coverPct: 30, coverMin: 30, coverMax: 30, samples: 8, visible: 8, face: { max: 62, at: 2.1, of: 8 } }] }, videoId: "v" });
    expect(over).toMatch(/shows in 8 of 8 moments; over the face up to 62% \(0:02\.1\)/);
    expect(over).toMatch(/covers the face \(up to 62% of it, at 0:02\.1\)/);
    const blank = editCheck(s, tr, { measured: { ...base, graphics: [{ clipId: g.id, start: 1, end: 3, coverPct: 0, coverMin: 0, coverMax: 0.3, samples: 12, visible: 0, face: null }] }, videoId: "v" });
    expect(blank).toMatch(/is invisible \(fully transparent at all 12 moments measured\)/);
  });
});

describe("heard: the preview transcribed again", () => {
  it("the same words (case and punctuation aside): no difference", () => {
    const ex = [{ text: "Hello", at: 0 }, { text: "world.", at: 0.5 }];
    expect(heardDiff(ex, [["hello,", 0, 0.4], ["World", 0.5, 0.9]])).toEqual([]);
    expect(heardDiffLine([], 2, 2)).toBe("Heard vs the edit's words: the same 2 words");
  });
  it("a word heard differently, one not heard, one extra: each place with its time", () => {
    const ex = "today we are going to build a website from scratch".split(" ").map((t, i) => ({ text: t, at: i * 0.4 }));
    const heard: [string, number, number][] = "today we are gonna build a web site from scratch um".split(" ").map((t, i) => [t, i * 0.4 + 0.01, i * 0.4 + 0.3]);
    const d = heardDiff(ex, heard)!;
    expect(d.map((x) => [x.expected.join(" "), x.heard.join(" ")])).toEqual([["going to", "gonna"], ["website", "web site"], ["", "um"]]);
    expect(heardDiffLine(d, heard.length, ex.length)).toMatch(/^Heard vs the edit's words: 3 places differ .*: 0:01\.21 heard "gonna" for "going to"; 0:02\.41 heard "web site" for "website"; 0:04\.01 heard "um" \(not in the edit's words\)$/);
    expect(heardDiff(ex, [], 3)).toBeNull(); // more differences than asked to list
  });
  it("the words the edit plays: in edit order, cut and muted words left out", () => {
    const s = edit(raw(), clips(["a", 0, 2.45], ["b", 6, 12]), { op: "cut_words", wordIds: [words[13].id] } as EditOp);
    const w = wordsAsPlayed(viewOf(s), () => words, isCut(s));
    expect(w.slice(0, 5).map((x) => x.text)).toEqual(["word0", "word1", "word2", "word3", "word11"]);
    expect(w.some((x) => x.text === "word13")).toBe(false);
    // With the word edges: a word plays where the middle of its sound does. word4's sound (2.48-2.92) has its middle
    // past clip a's end (2.45), so it is not one the edit plays, though it starts in it; word11 starts at 5.98 in the
    // sound, so it is heard from b's start.
    const late = new Map(aligned);
    expect(wordsAsPlayed(viewOf(s), () => words, isCut(s), () => late).slice(3, 5).map((x) => [x.text, +x.at.toFixed(2)])).toEqual([["word3", 1.98], ["word11", 2.45]]);
    const text = editCheck(s, tr, { videoId: "v", heard: { status: "done", words: w.map((x) => [x.text, x.at, x.at + 0.3]) } });
    expect(text).toMatch(/^Heard vs the edit's words: the same \d+ words$/m);
    expect(editCheck(s, tr, { videoId: "v", heard: { status: "transcribing" } })).toMatch(/being transcribed again/);
  });
});

describe("speech where words should play, from the word edges", () => {
  it("a stretch the file has silent is flagged only where the words' sound (not the transcriber's times) says speech", () => {
    // Clip a ends at 2.45, inside word4 (sound 2.48-2.92 in the alignment, so none of it plays); clip b from 6.
    const s = edit(raw(), clips(["a", 0, 2.45], ["b", 6, 12]));
    const v = viewOf(s);
    // The file is silent from 2.40 to 2.70: the end of word3's sound (to 2.42) and the start of b (word11 from 5.98).
    const measured: FileMeasure = { videoSeconds: v.total, audioSeconds: v.total, black: [], silences: [{ start: 2.4, end: 2.7 }], lufs: -14, peakDb: -2, graphics: [] };
    // The transcriber says word11 starts at 6.0, at b's start (edit 2.45); the alignment says 5.98, also at the start: the
    // 0.25 s silent from 2.45 is where words should play either way.
    expect(editCheck(s, tr, { measured, videoId: "v" })).toMatch(/silent 0\.30s at 0:02\.4 where words should play/);
    // Word edges where the sound really starts 0.3 s later (6.3): the silence is before the speech, not over it.
    const later = new Map(aligned);
    later.set(words[11].id, { s: 6.3, e: 6.42, c: 0.9 });
    expect(editCheck(s, tr, { measured, videoId: "v", aligned: { v: later } })).not.toMatch(/where words should play/);
  });
});
