// Phase 1: ripple, linked clips, the player plays the plan, the check measures the file, and the op fixes.
import { describe, expect, it } from "vitest";
import {
  applyOp, buildInitialTimeline, editCheck, layoutTimeline, liveFrame, MCP_TOOLS, outputDuration, parseMeasureLog,
  playerGraphicHtml, sequenceClock, sequenceView, STYLES, stripLayout, stubTranscript, transcriptAsText, zoomAt,
  type Clip, type EditContext, type FileMeasure, type Snapshot, type Transcript,
} from "../src/index";
import { ffmpegArgs, planRender, zoomExpr } from "../src/renderPlan";

const tr = stubTranscript(40);
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "vid1", transcript: tr, silences: [], sceneCuts: [], duration: 40, getStyle: (id) => STYLES.find((s) => s.id === id), getVideo: () => undefined, getGraphic: (id) => (id === "gt_title_card" ? { id, name: "Title card", durationSec: 3 } : undefined) };
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 40, "clean", [], "vid1"), name: "t", aspect: "16:9", styleId: "s2" });
type Seq = Clip & { sourceVideoId: string; sourceIn: number; sourceOut: number; rotate?: number; framing?: { scale: number; x: number; y: number } };
const seq = (s: Snapshot) => s.timeline.tracks.v1 as Seq[];
const at = (c: Clip) => c as Clip & { timelineStart: number; timelineEnd: number; sourceVideoId: string; sourceIn: number; sourceOut: number; linkId?: string };
const v1Len = (s: Snapshot) => s.timeline.tracks.v1.reduce((a, c) => a + c.end - c.start, 0);
const source = { width: 1920, height: 1080, fps: 30, seconds: 40, hasAudio: true };

describe("ripple: the edit has no gaps", () => {
  it("deleting a V1 clip closes the gap and the edit is shorter by exactly its length", () => {
    const s = applyOp(snap(), { op: "rename", name: "x" }, ctx).snap;
    const c = s.timeline.tracks.v1[1];
    const r = applyOp(s, { op: "delete_clip", track: "v1", clipId: c.id }, ctx).snap;
    expect(outputDuration(s.timeline, words) - outputDuration(r.timeline, words)).toBeCloseTo(c.end - c.start, 1);
    const v1 = r.timeline.tracks.v1.map(at);
    expect(v1[0].timelineStart).toBe(0);
    for (let i = 1; i < v1.length; i++) expect(v1[i].timelineStart).toBeCloseTo(v1[i - 1].timelineEnd, 2); // back to back
    expect(v1[v1.length - 1].timelineEnd).toBeCloseTo(outputDuration(r.timeline, words), 1); // timeline length = output length
  });
  it("trimming a V1 clip moves everything after it", () => {
    const s = applyOp(snap(), { op: "rename", name: "x" }, ctx).snap;
    const [a, b] = s.timeline.tracks.v1.map(at);
    const r = applyOp(s, { op: "trim_clip", track: "v1", clipId: a.id, start: a.start, end: a.end - 1 }, ctx).snap;
    expect(at(r.timeline.tracks.v1[1]).timelineStart).toBeCloseTo(b.timelineStart - 1, 2);
  });
  it("every clip stores its source and its place in the edit; derived fields never make a difference", () => {
    const r = applyOp(snap(), { op: "add_zoom", start: 3, end: 4, scale: 1.2 }, ctx).snap;
    for (const k of ["v1", "v2", "v3", "a1"] as const) for (const c of r.timeline.tracks[k].map(at)) {
      expect(c.sourceVideoId).toBe("vid1");
      expect(c.sourceOut - c.sourceIn).toBeCloseTo(c.end - c.start, 2);
      expect(c.timelineEnd).toBeGreaterThanOrEqual(c.timelineStart);
    }
    expect(stripLayout(r.timeline).tracks.v1[0]).not.toHaveProperty("timelineStart");
    expect(JSON.stringify(stripLayout(layoutTimeline(r.timeline, words)))).toBe(JSON.stringify(stripLayout(r.timeline)));
  });
});

describe("linked clips: picture and dialogue edit together", () => {
  const first = () => { const s = applyOp(snap(), { op: "rename", name: "x" }, ctx).snap; return { s, c: s.timeline.tracks.v1[0], d: s.timeline.tracks.a1[0] }; };
  it("V1 and its A1 carry the same link id", () => {
    const { c, d } = first();
    expect(at(c).linkId).toBeTruthy();
    expect(at(d).linkId).toBe(at(c).linkId);
  });
  it("split, trim and delete change both; linked:false changes one", () => {
    const { s, c } = first();
    const mid = (c.start + c.end) / 2;
    const sp = applyOp(s, { op: "split_clip", track: "v1", clipId: c.id, at: mid }, ctx).snap;
    expect(sp.timeline.tracks.v1.length).toBe(s.timeline.tracks.v1.length + 1);
    expect(sp.timeline.tracks.a1.length).toBe(s.timeline.tracks.a1.length + 1);
    // Trimming A1 trims the picture (its footage); deleting A1 deletes the clip.
    const tr2 = applyOp(s, { op: "trim_clip", track: "a1", clipId: s.timeline.tracks.a1[0].id, start: c.start + 0.5, end: c.end }, ctx).snap;
    expect(seq(tr2)[0].sourceIn).toBeCloseTo(c.start + 0.5, 2);
    expect(tr2.timeline.tracks.v1[0].start).toBe(0); // the edit starts with it, 0.5 s shorter
    const del = applyOp(s, { op: "delete_clip", track: "a1", clipId: s.timeline.tracks.a1[0].id }, ctx).snap;
    expect(del.timeline.tracks.v1.find((x) => x.id === c.id)).toBeUndefined();
    // In the sequence the dialogue always follows its picture.
    const solo = applyOp(s, { op: "split_clip", track: "v1", clipId: c.id, at: mid, linked: false }, ctx).snap;
    expect(solo.timeline.tracks.a1.length).toBe(s.timeline.tracks.a1.length + 1);
  });
  it("set_link is kept for old callers: the dialogue follows its picture", () => {
    const { s, c } = first();
    const un = applyOp(s, { op: "set_link", track: "v1", clipId: c.id, linked: false }, ctx);
    expect(un.summary).toMatch(/always follows its picture/);
    expect(at(un.snap.timeline.tracks.v1[0]).linkId).toBeTruthy();
    expect(() => applyOp(s, { op: "set_link", track: "v2", clipId: "x", linked: false }, ctx)).toThrow();
  });
  it("set_clips takes plain start/end (no ids), in that order, and A1 follows", () => {
    const r = applyOp(snap(), { op: "set_clips", track: "v1", clips: [{ start: 1, end: 5, label: "" }, { start: 8, end: 12, label: "" }] }, ctx).snap;
    expect(seq(r).map((c) => [c.sourceIn, c.sourceOut])).toEqual([[1, 5], [8, 12]]);
    expect(r.timeline.tracks.v1.map((c) => [c.start, c.end])).toEqual([[0, 4], [4, 8]]);
    expect(r.timeline.tracks.a1.map((c) => [c.start, c.end])).toEqual([[0, 4], [4, 8]]);
    expect(r.timeline.tracks.v1.every((c) => c.id)).toBe(true);
  });
});

describe("op fixes", () => {
  // Speech starts 1.5 s in; the second clip starts 0.4 s before its first word; silence after 5 s.
  const t2: Transcript = [
    { id: "l0", start: 1.5, end: 3, gapBefore: 0, words: [{ id: "w0", text: "Hello", t: 1.5, end: 2, filler: false }, { id: "w1", text: "there.", t: 2.1, end: 3, filler: false }] },
    { id: "l1", start: 3.6, end: 5, gapBefore: 0, words: [{ id: "w2", text: "Second", t: 3.6, end: 4, filler: false }, { id: "w3", text: "part.", t: 4.1, end: 5, filler: false }] },
  ];
  const c2: EditContext = { ...ctx, transcript: t2, duration: 10 };
  it("cut_silences removes silence at the start and end of every clip", () => {
    const tl = buildInitialTimeline(t2, 10, "clean", [], "vid1");
    const clip = (id: string, a: number, b: number) => ({ id, start: a, end: b, label: "", sourceVideoId: "vid1", sourceIn: a, sourceOut: b });
    const s: Snapshot = { timeline: { ...tl, tracks: { ...tl.tracks, v1: [clip("a", 0, 3.2), clip("b", 3.2, 10)] } }, name: "t", aspect: "16:9", styleId: "s2" };
    const r = applyOp(s, { op: "cut_silences", overSeconds: 1 }, c2).snap; // no pause between words is over 1 s
    expect(seq(r).map((c) => [c.sourceIn, c.sourceOut])).toEqual([[1.4, 3.2], [3.5, 5.15]]); // clip a: head; clip b: head and tail
    expect(r.timeline.tracks.a1.map((c) => [c.start, c.end])).toEqual(r.timeline.tracks.v1.map((c) => [c.start, c.end]));
    const off = applyOp(s, { op: "cut_silences", overSeconds: 1, edges: false }, c2).snap;
    expect(seq(off).map((c) => c.sourceIn)).toEqual([0, 3.2]);
  });
  it("cut_words with a time range works when the range has no words", () => {
    const s: Snapshot = { timeline: buildInitialTimeline(t2, 10, "clean", [], "vid1"), name: "t", aspect: "16:9", styleId: "s2" };
    const before = outputDuration(s.timeline, allW(t2));
    const r = applyOp(s, { op: "cut_words", from: 5.5, to: 9 }, c2);
    expect(before - outputDuration(r.snap.timeline, allW(t2))).toBeCloseTo(3.5, 2);
    expect(r.summary).toMatch(/no words/);
    const w = applyOp(s, { op: "cut_words", from: 3, to: 5 }, c2);
    expect(before - outputDuration(w.snap.timeline, allW(t2))).toBeCloseTo(2, 2); // exactly the range, words too
    expect(w.summary).toMatch(/2 words/);
  });
  it("the transcript gives word end times", () => {
    expect(transcriptAsText(t2, undefined, "words")).toContain("Hello(w0@1.50-2.00)");
  });
});
const allW = (t: Transcript) => t.flatMap((l) => l.words);

describe("the live player plays what renders", () => {
  const edited = applyOp(snap(), { op: "batch", ops: [{ op: "cut_silences", overSeconds: 0.4 }, { op: "add_zoom", start: 5, end: 6, scale: 1.3 }, { op: "add_graphic", graphicId: "gt_title_card", start: 8, end: 11, params: {} }] }, ctx).snap;
  const plan = planRender({ kind: "preview", snapshot: edited, transcript: tr, source });
  const clock = sequenceClock(plan);
  it("edit time and footage time round trip over the picture parts", () => {
    expect(clock.total).toBeCloseTo(plan.outputSeconds, 2);
    for (const t of [0, 1.234, plan.outputSeconds / 2, plan.outputSeconds - 0.1]) { const p = clock.picture(t)!; expect(clock.toEdit(p.i, p.src)).toBeCloseTo(t, 3); expect(p.videoId).toBe("vid1"); }
    expect(plan.parts.length).toBeGreaterThan(1);
  });
  it("captions, zoom and graphics at a moment match the plan", () => {
    const cap = plan.captions[2];
    expect(liveFrame(plan, (cap.start + cap.end) / 2, clock).caption).toBe(cap.text);
    const z = plan.zooms[0];
    const mid = (z.start + z.end) / 2;
    // The same curve as the render's FFmpeg expression.
    const expr = zoomExpr(plan.zooms).replace(/between\(t,([\d.]+),([\d.]+)\)/g, (_, a, b) => `(t>=${a}&&t<=${b})`).replace(/if\(/g, "iff(");
    const iff = (c: boolean, a: number, b: number) => (c ? a : b);
    const evalAt = (t: number) => new Function("t", "iff", "min", `return ${expr}`)(t, iff, Math.min);
    expect(zoomAt(plan.zooms, mid)).toBeCloseTo(evalAt(mid), 4);
    expect(zoomAt(plan.zooms, z.start + 0.03)).toBeCloseTo(evalAt(z.start + 0.03), 4);
    const g = plan.graphics[0];
    expect(liveFrame(plan, g.start + 0.5, clock).graphics[0]).toMatchObject({ graphicId: "gt_title_card", t: 0.5 });
  });
  it("mutes picture that has no dialogue under it, like the render", () => {
    const s = applyOp(snap(), { op: "rename", name: "x" }, ctx).snap;
    const d = s.timeline.tracks.a1[0];
    const un = applyOp(s, { op: "delete_clip", track: "a1", clipId: d.id, linked: false }, ctx).snap;
    const p = planRender({ kind: "preview", snapshot: un, transcript: tr, source });
    expect(p.dialogueMutes.length).toBe(1);
    expect(liveFrame(p, p.dialogueMutes[0].start + 0.1).muted).toBe(true);
    expect(liveFrame(p, p.dialogueMutes[0].end + 0.1).muted).toBe(false);
  });
  it("draws a template with the recorder's HTML and clock, no network", () => {
    const h = playerGraphicHtml("gt_title_card", { title: "Hi" }, 640, 360, 3);
    expect(h).toContain("__rendrrAdvance");
    expect(h).toContain("default-src 'none'");
    expect(h).toContain("Hi");
  });
});

describe("the check measures the rendered file", () => {
  const s = applyOp(snap(), { op: "rename", name: "x" }, ctx).snap;
  const total = outputDuration(s.timeline, words);
  const clean: Transcript = tr.map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) })); // nothing else to flag
  const ok: FileMeasure = { videoSeconds: total, audioSeconds: total, black: [], silences: [], lufs: -14, peakDb: -1.5, graphics: [] };
  it("reads blackdetect, silencedetect and ebur128 output", () => {
    const log = [
      "[blackdetect @ 0x1] black_start:0 black_end:0.4 black_duration:0.4",
      "[silencedetect @ 0x2] silence_start: 3.5", "[silencedetect @ 0x2] silence_end: 3.9 | silence_duration: 0.4",
      "[silencedetect @ 0x2] silence_start: 9.8",
      "[Parsed_ebur128_1 @ 0x3] Summary:", "  Integrated loudness:", "    I:         -15.3 LUFS", "  True peak:", "    Peak:       -0.7 dBFS",
    ].join("\n");
    const m = parseMeasureLog(log, 10.1);
    expect(m.black).toEqual([{ start: 0, end: 0.4 }]);
    expect(m.silences).toEqual([{ start: 3.5, end: 3.9 }, { start: 9.8, end: 10.1 }]);
    expect(m).toMatchObject({ lufs: -15.3, peakDb: -0.7 });
  });
  it("says Flags: none only when the file and the edit agree", () => {
    expect(editCheck(s, clean, { measured: ok })).toMatch(/Flags: none$/);
    expect(editCheck(s, clean, { measured: ok })).toMatch(/^CHECK file /);
  });
  it("flags every disagreement: length, sync, black, silence under words, missing graphics", () => {
    const g = applyOp(s, { op: "add_graphic", graphicId: "gt_title_card", start: 2, end: 4, params: {} }, ctx).snap;
    const out = editCheck(g, tr, { measured: { ...ok, videoSeconds: total + 0.5, audioSeconds: total, black: [{ start: 1, end: 1.3 }], silences: [{ start: 0.5, end: 1.5 }] } });
    expect(out).toMatch(/file is .* but the edit is/);
    expect(out).toMatch(/audio .* vs video/);
    expect(out).toMatch(/black 0.30s at 0:01/);
    expect(out).toMatch(/silent 1.00s at 0:00.5 where words should play/);
    expect(out).toMatch(/graphic "Title card" .* is not in the file/);
    expect(out).not.toMatch(/Flags: none/);
  });
  it("flags picture without its dialogue and lists pauses from 0.15 s", () => {
    const d = s.timeline.tracks.a1[0];
    const un = applyOp(s, { op: "set_audio_offset", clipId: d.id, muted: true }, ctx).snap;
    const out = editCheck(un, tr, { measured: ok });
    expect(out).toMatch(/of picture without its dialogue/);
    expect(out).toMatch(/Pauses over 0.15s/);
  });
  it("says so when the file was not measured", () => {
    expect(editCheck(s, tr, { measured: { ...ok, error: "measuring the file took longer than 60s" } })).toMatch(/File: not measured \(measuring the file took longer than 60s\)/);
  });
});

describe("connector: text first", () => {
  it("get_footage and create_graphic send images only when asked", () => {
    const gf = MCP_TOOLS.find((t) => t.name === "get_footage")!;
    expect(Object.keys(gf.input.shape)).toContain("images");
    expect(Object.keys(gf.input.shape)).not.toContain("pictures");
    expect(Object.keys(MCP_TOOLS.find((t) => t.name === "create_graphic")!.input.shape)).toContain("images");
  });
  it("kept parts used by the check are the same ones the render plays", () => {
    const s = applyOp(snap(), { op: "cut_silences", overSeconds: 0.4 }, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source });
    expect(plan.parts.length).toBe(sequenceView(s.timeline, words).picture.length);
  });
});

describe("footage filmed sideways", () => {
  it("set_rotation turns the footage before the fit, and 0 puts it back", () => {
    const s = applyOp(snap(), { op: "set_rotation", degrees: 90 }, ctx);
    expect(seq(s.snap).every((c) => c.rotate === 90)).toBe(true); // every clip of the footage
    expect(s.summary).toMatch(/turned the footage 90° clockwise/);
    const plan = planRender({ kind: "preview", snapshot: { ...s.snap, aspect: "9:16" }, transcript: tr, source });
    expect(plan.rotate).toBe(90);
    expect(plan.operations.join("\n")).toMatch(/Turn the footage 90° clockwise, then fit to 9:16/);
    const graph = ffmpegArgs(plan, { source: "in.mp4", output: "out.mp4" }, source, { loudnessGainDb: 0 }).filterGraph;
    expect(graph).toMatch(/\[vcat\]transpose=1,fps=30,scale=/);
    expect(editCheck(s.snap, tr)).toMatch(/footage turned 90°/);
    const back = applyOp(s.snap, { op: "set_rotation", degrees: 0 }, ctx).snap;
    expect(seq(back).some((c) => "rotate" in c)).toBe(false);
    expect(ffmpegArgs(planRender({ kind: "preview", snapshot: back, transcript: tr, source }), { source: "a", output: "b" }, source, { loudnessGainDb: 0 }).filterGraph).not.toMatch(/transpose|hflip/);
    expect(ffmpegArgs(planRender({ kind: "preview", snapshot: applyOp(snap(), { op: "set_rotation", degrees: 270 }, ctx).snap, transcript: tr, source }), { source: "a", output: "b" }, source, { loudnessGainDb: 0 }).filterGraph).toMatch(/transpose=2,/);
  });
});

describe("footage position and scale", () => {
  it("set_framing scales and moves the footage in the render, keeps fields left out, and resets", () => {
    const s = applyOp({ ...snap(), aspect: "9:16" }, { op: "set_framing", scale: 1.15, y: 0.34 }, ctx);
    expect(seq(s.snap).map((c) => c.framing)).toEqual(seq(s.snap).map(() => ({ scale: 1.15, x: 0, y: 0.34 })));
    expect(s.summary).toMatch(/framed the footage: scale 1.15, moved down 34%/);
    const plan = planRender({ kind: "preview", snapshot: s.snap, transcript: tr, source });
    const graph = ffmpegArgs(plan, { source: "a", output: "b" }, source, { loudnessGainDb: 0 }).filterGraph;
    // 540x960 preview: scaled to 622x1104, centred (-41, -72) then 34% down (+326) => (-41, 254)
    expect(graph).toMatch(/color=c=black:s=540x960:r=30\[fcanvas\]/);
    expect(graph).toMatch(/\[vfit\]scale=622:1104,setsar=1\[fscaled\]/);
    expect(graph).toMatch(/overlay=x=-41:y=254:shortest=1/);
    expect(editCheck(s.snap, tr)).toMatch(/footage framed scale 1.15, moved down 34%/);
    const x = applyOp(s.snap, { op: "set_framing", x: -0.1 }, ctx).snap;
    expect(seq(x)[0].framing).toEqual({ scale: 1.15, x: -0.1, y: 0.34 });
    const back = applyOp(x, { op: "set_framing", scale: 1, x: 0, y: 0 }, ctx).snap;
    expect(seq(back).some((c) => "framing" in c)).toBe(false);
    expect(ffmpegArgs(planRender({ kind: "preview", snapshot: back, transcript: tr, source }), { source: "a", output: "b" }, source, { loudnessGainDb: 0 }).filterGraph).not.toMatch(/fcanvas/);
  });
});
