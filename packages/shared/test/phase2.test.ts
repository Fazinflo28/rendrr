// Phase 2: the sequence (model B). Clips from any video in any order, repeats, J/L cuts, rolling/slip/slide, edit-time
// ops, the A -> B migration (same plan as the old planner), the player's clock, the check's sequence line.
import { describe, expect, it } from "vitest";
import {
  applyOp, buildInitialTimeline, buildInitialTimelineA, editCheck, layoutTimeline, liveFrame, removeRangeFromTrack, sequenceClock, sequenceView,
  normalizeTimeline, STYLES, stubTranscript, summarizeTimeline, toModelB, TimelineSchema, timelineProblems,
  type Clip, type EditContext, type Snapshot, type Timeline, type Transcript,
} from "../src/index";
import { ffmpegArgs, planRender } from "../src/renderPlan";
import { planRenderA } from "../src/renderPlanA";
import { convertChecked, planDifferences } from "../src/migrate";

const tr = stubTranscript(40);
const words = tr.flatMap((l) => l.words);
// A second video ("v2nd", 20 s) with its own transcript.
const tr2: Transcript = [{ id: "l0", start: 1, end: 3, gapBefore: 0, words: [{ id: "w0", text: "Other", t: 1, end: 1.5, filler: false }, { id: "w1", text: "video", t: 1.6, end: 2.2, filler: false }] }];
const ctx: EditContext = {
  videoId: "vid1", transcript: tr, silences: [], sceneCuts: [], duration: 40, getStyle: (id) => STYLES.find((s) => s.id === id),
  getVideo: (id) => (id === "v2nd" ? { id, name: "Second camera", seconds: 20, ready: true } : id === "brl" ? { id, name: "B-roll", seconds: 10, ready: true } : undefined),
  getGraphic: (id) => (id === "gt_title_card" ? { id, name: "Title card", durationSec: 3 } : undefined),
  sources: { v2nd: { transcript: tr2, silences: [] } },
};
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 40, "clean", [], "vid1"), name: "t", aspect: "16:9", styleId: "s2" });
type Seq = Clip & { sourceVideoId: string; sourceIn: number; sourceOut: number; audioStart?: number; audioMuted?: boolean; anchorId?: string };
const v1 = (s: Snapshot) => s.timeline.tracks.v1 as Seq[];
const source = { width: 1920, height: 1080, fps: 30, seconds: 40, hasAudio: true };
const sources = { v2nd: { width: 1280, height: 720, fps: 25, seconds: 20, hasAudio: true } };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "vid1", sources, transcripts: { v2nd: tr2 } });
const edit = (s: Snapshot, ...ops: Parameters<typeof applyOp>[1][]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);

describe("the sequence: clips from any video, in any order, repeats", () => {
  it("a new edit is a sequence of the footage in footage order", () => {
    const s = snap();
    expect(s.timeline.model).toBe("B");
    expect(v1(s).every((c) => c.sourceVideoId === "vid1")).toBe(true);
    expect(timelineProblems(s.timeline)).toEqual([]);
    expect(TimelineSchema.safeParse(s.timeline).success).toBe(true);
  });
  it("add_clip puts another video on V1; it renders from both files, each part fitted", () => {
    const r = edit(snap(), { op: "add_clip", videoId: "v2nd", from: 1, to: 3, index: 1 });
    expect(r.summary).toMatch(/added clip .* \("Second camera" 1.00–3.00s\) at position 2/);
    const s = r.snap;
    expect(v1(s)[1]).toMatchObject({ sourceVideoId: "v2nd", sourceIn: 1, sourceOut: 3 });
    expect(v1(s)[1].start).toBeCloseTo(v1(s)[0].end, 2); // back to back
    const p = plan(s);
    expect(p.sources).toEqual(["vid1", "v2nd"]);
    expect(p.outputSeconds).toBeCloseTo(42, 1);
    const { args, filterGraph } = ffmpegArgs(p, { source: "/main.mp4", videos: { v2nd: "/second.mp4" }, output: "/o.mp4" }, source);
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(filterGraph).toMatch(/\[1:v\]fps=30\[sv1\]/);
    expect(filterGraph).toMatch(/concat=n=3:v=1:a=0\[vcat\]/);
    expect(filterGraph).toMatch(/\[sv1\]trim=[^;]*scale=960:540:force_original_aspect_ratio=increase[^;]*\[v1\]/); // fitted on its own
    expect(p.captions.some((c) => /Other video/i.test(c.text))).toBe(true); // its own words captioned
    expect(editCheck(s, tr, { transcripts: { v2nd: tr2 } })).toMatch(/Sequence: 4 clips from 2 videos \(main 3, v2nd 1\)/);
  });
  it("add_clip at an edit time splits the clip playing there (insert edit)", () => {
    const s = snap();
    const r = edit(s, { op: "add_clip", from: 0, to: 2, at: 5 }).snap;
    expect(v1(r)).toHaveLength(v1(s).length + 2);
    expect(v1(r)[1]).toMatchObject({ sourceIn: 0, sourceOut: 2 }); // between the two halves
    expect(v1(r)[1].start).toBeCloseTo(5, 2);
    expect(plan(r).outputSeconds).toBeCloseTo(42, 1);
  });
  it("the same footage can play twice; its captions show twice", () => {
    const s = edit(snap(), { op: "add_clip", from: 0.4, to: 3.5 }).snap;
    const p = plan(s);
    const first = p.captions[0].text;
    expect(p.captions.filter((c) => c.text === first)).toHaveLength(2);
    expect(editCheck(s, tr)).toMatch(/1 repeat/);
  });
  it("move_clip reorders; clips hanging on it move with it", () => {
    const s0 = edit(snap(), { op: "add_zoom", start: 30, end: 31, scale: 1.2 }).snap; // in the last clip
    const last = v1(s0)[v1(s0).length - 1];
    const z0 = s0.timeline.tracks.v2[0] as Seq;
    expect(z0.anchorId).toBe(last.id);
    const s = edit(s0, { op: "move_clip", clipId: last.id, index: 0 }).snap;
    expect(v1(s)[0].id).toBe(last.id);
    const z = s.timeline.tracks.v2[0];
    expect(z.start).toBeCloseTo(30 - last.sourceIn, 2); // same footage moment, now near the start of the edit
    expect(editCheck(s, tr)).toMatch(/Sequence: 3 clips, 2 moved|Sequence: 3 clips, 1 moved/);
    const byTime = edit(s0, { op: "move_clip", clipId: last.id, at: 0.3 }).snap;
    expect(v1(byTime)[0].id).toBe(last.id);
  });
});

describe("J and L cuts", () => {
  const two = () => snap();
  it("set_audio_offset start < 0: the clip's sound starts before its picture (J)", () => {
    const s = two();
    const b = v1(s)[1];
    const r = edit(s, { op: "set_audio_offset", clipId: b.id, start: -0.5 });
    expect(r.summary).toMatch(/its sound starts 0.50s before its picture \(J cut\)/);
    const a1 = r.snap.timeline.tracks.a1;
    expect(a1[1].start).toBeCloseTo(b.start - 0.5, 2);
    expect(a1[0].end).toBeCloseTo(b.start - 0.5, 2); // the clip before is cut short there
    const p = plan(r.snap);
    const mid = b.start - 0.25;
    const f = liveFrame(p, mid);
    expect(f.videoId).toBe("vid1");
    expect(f.src).toBeCloseTo(v1(s)[0].sourceOut - 0.25, 1); // picture: still the first clip
    expect(f.sound!.src).toBeCloseTo(b.sourceIn - 0.25, 1); // sound: the second clip's footage, early
    expect(editCheck(r.snap, tr)).toMatch(/1 J cut/);
    expect(summarizeTimeline(r.snap, tr)).toMatch(/J -0.50/);
  });
  it("end > 0: the clip's sound runs into the next one (L); muted silences it", () => {
    const s = two();
    const a = v1(s)[0];
    const r = edit(s, { op: "set_audio_offset", clipId: a.id, end: 0.4 }, { op: "set_audio_offset", clipId: v1(s)[2].id, muted: true });
    expect(r.summary).toMatch(/runs 0.40s into the next clip \(L cut\)/);
    expect(r.snap.timeline.tracks.a1[0].end).toBeCloseTo(a.end + 0.4, 2);
    const p = plan(r.snap);
    expect(p.dialogueMutes).toHaveLength(1);
    const g = ffmpegArgs(p, { source: "/m.mp4", output: "/o.mp4" }, source).filterGraph;
    expect(g).toMatch(/anullsrc=r=48000:cl=stereo,atrim=end_sample=\d+/); // the muted clip is silence
    expect(g).toMatch(/concat=n=\d+:v=0:a=1\[acat\]/);
    expect(editCheck(r.snap, tr)).toMatch(/1 L cut, 1 muted/);
  });
  it("refuses offsets the footage cannot give, and on the first or last clip", () => {
    const s = two();
    expect(() => edit(s, { op: "set_audio_offset", clipId: v1(s)[0].id, start: -0.5 })).toThrow(/first clip/);
    expect(() => edit(s, { op: "set_audio_offset", clipId: v1(s)[2].id, end: 0.5 })).toThrow(/last clip/);
    const late = edit(s, { op: "add_clip", from: 0.2, to: 2 }).snap; // starts 0.2 s into the footage
    expect(() => edit(late, { op: "set_audio_offset", clipId: v1(late)[3].id, start: -0.5 })).toThrow(/Only 0.20s of footage/);
  });
  it("trim_clip on A1 with linked false moves the sound cuts (J/L)", () => {
    const s = two();
    const b = v1(s)[1];
    const r = edit(s, { op: "trim_clip", track: "a1", clipId: b.id, start: b.sourceIn - 0.3, end: b.sourceOut, linked: false }).snap;
    expect(r.timeline.tracks.a1[1].start).toBeCloseTo(b.start - 0.3, 2);
  });
});

describe("rolling, slip and slide keep the edit's length", () => {
  it("roll_edit moves the cut between two clips", () => {
    const s = edit(snap(), { op: "set_clips", track: "v1", clips: [{ start: 2, end: 8, label: "a" }, { start: 12, end: 20, label: "b" }] }).snap;
    const r = edit(s, { op: "roll_edit", clipId: v1(s)[0].id, by: 1 }).snap;
    expect(v1(r).map((c) => [c.sourceIn, c.sourceOut])).toEqual([[2, 9], [13, 20]]);
    expect(plan(r).outputSeconds).toBeCloseTo(plan(s).outputSeconds, 2);
    expect(() => edit(s, { op: "roll_edit", clipId: v1(s)[1].id, by: 1 })).toThrow(/last clip/);
  });
  it("slip_clip changes the footage, not the place", () => {
    const s = edit(snap(), { op: "set_clips", track: "v1", clips: [{ start: 2, end: 8, label: "a" }, { start: 12, end: 20, label: "b" }] }).snap;
    const r = edit(s, { op: "slip_clip", clipId: v1(s)[0].id, by: -1.5 }).snap;
    expect(v1(r)[0]).toMatchObject({ sourceIn: 0.5, sourceOut: 6.5, start: 0, end: 6 });
    expect(() => edit(s, { op: "slip_clip", clipId: v1(s)[0].id, by: -3 })).toThrow(/at most 2.00s earlier/);
  });
  it("slide_clip moves a clip between its neighbours", () => {
    const s = edit(snap(), { op: "set_clips", track: "v1", clips: [{ start: 0, end: 5, label: "a" }, { start: 10, end: 12, label: "b" }, { start: 20, end: 30, label: "c" }] }).snap;
    const r = edit(s, { op: "slide_clip", clipId: v1(s)[1].id, by: 1 }).snap;
    expect(v1(r).map((c) => [c.sourceIn, c.sourceOut])).toEqual([[0, 6], [10, 12], [21, 30]]);
    expect(v1(r)[1].start).toBeCloseTo(6, 2);
    expect(plan(r).outputSeconds).toBeCloseTo(plan(s).outputSeconds, 2);
  });
});

describe("old ops keep working; edit:true takes edit seconds", () => {
  it("cut_words by id, by footage range and by edit range", () => {
    const s = snap();
    const byId = edit(s, { op: "cut_words", wordIds: [words[3].id] }).snap;
    expect(plan(byId).outputSeconds).toBeLessThan(40);
    const cutA = edit(s, { op: "add_clip", from: 10, to: 12 }).snap; // 10-12 plays twice
    const range = edit(cutA, { op: "cut_words", from: 10, to: 12 }).snap; // gone from both places
    expect(plan(range).outputSeconds).toBeCloseTo(38, 1);
    const e = edit(cutA, { op: "cut_words", from: 40.5, to: 41.5, edit: true }).snap; // only the repeat
    expect(plan(e).outputSeconds).toBeCloseTo(41, 1);
  });
  it("add_zoom with edit:true lands at that edit time", () => {
    const s = edit(snap(), { op: "cut_words", from: 0, to: 5 }).snap;
    const z1 = edit(s, { op: "add_zoom", start: 6, end: 7, scale: 1.2 }).snap.timeline.tracks.v2[0];
    expect(z1.start).toBeCloseTo(1, 1); // footage 6 s plays at edit 1 s
    const z2 = edit(s, { op: "add_zoom", start: 6, end: 7, scale: 1.2, edit: true }).snap.timeline.tracks.v2[0];
    expect(z2.start).toBeCloseTo(6, 2);
  });
  it("deleting a V1 clip removes what hangs inside it and shortens what reaches past it", () => {
    const s0 = snap();
    const [a, b] = v1(s0);
    const s = edit(s0, { op: "add_zoom", start: a.sourceIn + 1, end: a.sourceIn + 2, scale: 1.2 }, { op: "add_graphic", graphicId: "gt_title_card", start: a.sourceOut - 1, end: a.sourceOut + 2, params: {} }).snap;
    const r = edit(s, { op: "delete_clip", track: "v1", clipId: a.id }).snap;
    expect(r.timeline.tracks.v2).toHaveLength(0);
    const g = r.timeline.tracks.v3.find((c) => (c as Record<string, unknown>).graphicId)!;
    expect(g.start).toBeCloseTo(0, 2);
    expect(g.end - g.start).toBeCloseTo(2, 1);
    expect((g as Seq).anchorId).toBe(b.id);
  });
  it("apply_style rebuilds a plain cut, and keeps a rearranged sequence", () => {
    const plain = edit(snap(), { op: "apply_style", styleId: "s1" }).snap;
    expect(v1(plain).length).toBeGreaterThan(0);
    const moved = edit(snap(), { op: "move_clip", clipId: v1(snap())[2].id, index: 0 }).snap;
    const styled = edit(moved, { op: "apply_style", styleId: "s1" }).snap;
    expect(v1(styled)[0].sourceIn).toBeGreaterThan(v1(styled)[1].sourceIn); // still out of footage order
  });
  it("set_rotation on some clips turns only those (each part fitted on its own)", () => {
    const s = snap();
    const r = edit(s, { op: "set_rotation", degrees: 90, clipIds: [v1(s)[1].id] });
    expect(r.summary).toMatch(/turned 1 clip 90°/);
    const p = plan(r.snap);
    expect(p.parts.map((x) => x.rotate)).toEqual([0, 90, 0]);
    expect(ffmpegArgs(p, { source: "a", output: "b" }, source).filterGraph).toMatch(/\[sv1\]trim=[^;]*transpose=1,fps=30,scale/);
    expect(editCheck(r.snap, tr)).toMatch(/footage turned 90° \(1 of 3 clips\)/);
  });
  it("split_clip with edit:true splits at that moment of the edit", () => {
    const s = edit(snap(), { op: "cut_words", from: 0, to: 2 }).snap;
    const c = v1(s)[0];
    const r = edit(s, { op: "split_clip", track: "v1", clipId: c.id, at: 1, edit: true }).snap;
    expect(v1(r)[0].sourceOut).toBeCloseTo(3, 2); // edit 1 s = footage 3 s
  });
});

describe("the player follows picture and sound parts", () => {
  it("knows the video and the moment at any edit time, and a J cut's early sound", () => {
    const s0 = edit(snap(), { op: "add_clip", videoId: "v2nd", from: 5, to: 9, index: 1 }).snap;
    const next = v1(s0)[2];
    const s = edit(s0, { op: "set_audio_offset", clipId: next.id, start: -1 }).snap;
    const p = plan(s);
    const clock = sequenceClock(p);
    const t = next.start - 0.5; // the last half second of the second camera's clip
    expect(clock.picture(t)).toMatchObject({ videoId: "v2nd" });
    expect(clock.picture(t)!.src).toBeCloseTo(8.5, 1);
    const f = liveFrame(p, t, clock);
    expect(f.sound).toMatchObject({ videoId: "vid1", muted: false });
    expect(f.sound!.src).toBeCloseTo(next.sourceIn - 0.5, 1);
    expect(liveFrame(p, v1(s0)[1].start + 0.5, clock).sound!.videoId).toBe("v2nd");
  });
});

// ---------------------------------------------------------------------------------------------
// Migration: every model A timeline converts to a sequence that renders the same.
// ---------------------------------------------------------------------------------------------
function rng(seed: number) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A random model A timeline: cuts, removed ranges, an A1 hole, zooms, b-roll, graphics, music, sound effects, a turn. */
function randomA(seed: number): Timeline {
  const rand = rng(seed);
  let tl = buildInitialTimelineA(tr, 40, "clean");
  tl = { ...tl, cut: words.filter(() => rand() < 0.15).map((w) => w.id) };
  for (let k = 0; k < 3; k++) {
    const a = r2(rand() * 38), b = r2(a + 0.2 + rand() * 2);
    tl = { ...tl, tracks: { ...tl.tracks, v1: removeRangeFromTrack(tl.tracks.v1, a, b), a1: removeRangeFromTrack(tl.tracks.a1, a, b) } };
  }
  if (rand() < 0.6) { const c = tl.tracks.a1[Math.floor(rand() * tl.tracks.a1.length)]; if (c && c.end - c.start > 1) tl.tracks.a1 = tl.tracks.a1.map((x) => (x.id === c.id ? { ...x, end: r2(x.end - 0.8) } : x)); }
  const span = () => { const a = r2(rand() * 37), b = r2(a + 0.3 + rand() * 3); return { start: a, end: Math.min(40, b) }; };
  const v2: Clip[] = [], v3: Clip[] = [...tl.tracks.v3], a2: Clip[] = [], a3: Clip[] = [];
  for (let k = 0; k < 4; k++) v2.push({ id: `z${k}`, ...span(), label: "Zoom", kind: "zoom", zoom: 1.2, mode: rand() < 0.3 ? "push" : "punch" } as Clip);
  v2.push({ id: "b0", ...span(), label: "B", kind: "broll", videoId: "brl", sourceStart: 1 } as Clip);
  for (let k = 0; k < 2; k++) v3.push({ id: `g${k}`, ...span(), label: "G", kind: "graphic", graphicId: "gt_title_card", params: {} } as Clip);
  a2.push(rand() < 0.5 ? { id: "m0", start: 0, end: 40, label: "Bed", trackId: "m_lofi" } as Clip : { id: "m0", ...span(), label: "Bed", trackId: "m_lofi" } as Clip);
  for (let k = 0; k < 2; k++) a3.push({ id: `x${k}`, ...span(), label: "Whoosh", sfxId: "sfx_whoosh" } as Clip);
  const out = { ...tl, tracks: { ...tl.tracks, v2, v3, a2, a3 } } as Timeline;
  if (rand() < 0.3) out.rotate = 90;
  if (rand() < 0.3) out.framing = { scale: 1.15, x: 0, y: 0.3 };
  if (rand() < 0.3) out.tracks.v1 = [...out.tracks.v1, { id: "ov", start: 3, end: 6, label: "overlap" }]; // overlaps an existing clip
  return normalizeTimeline(out); // as model A stored it
}

describe("migration A -> B", () => {
  const brollSeconds = { brl: 10 };
  it("the paragraph cut converts to the same plan", () => {
    const a: Snapshot = { timeline: buildInitialTimelineA(tr, 40, "clean"), name: "t", aspect: "9:16", styleId: "s2" };
    const r = convertChecked(a, tr, { videoId: "vid1", source, brollSeconds });
    expect(r.differences).toEqual([]);
    expect(r.timeline.model).toBe("B");
  });
  it("500 random model A edits convert to sequences that render the same", () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const a: Snapshot = { timeline: randomA(seed), name: "t", aspect: seed % 2 ? "9:16" : "16:9", styleId: "s2" };
      const r = convertChecked(a, tr, { videoId: "vid1", source: { ...source, seconds: 39.5 }, brollSeconds });
      if (r.differences.length) bad.push(`seed ${seed}: ${r.differences.slice(0, 3).join(" | ")}`);
      expect(timelineProblems(r.timeline)).toEqual([]);
    }
    expect(bad).toEqual([]);
  });
  it("a timeline left in model A renders with the old planner", () => {
    const a: Snapshot = { timeline: randomA(7), name: "t", aspect: "16:9", styleId: "s2" };
    const p = planRender({ kind: "preview", snapshot: a, transcript: tr, source, videoId: "vid1" });
    expect(p.model).toBe("A");
    expect(planDifferences(p, planRenderA({ kind: "preview", snapshot: a, transcript: tr, source, videoId: "vid1" }))).toEqual([]);
  });
  it("the first edit of a model A project makes it a sequence", () => {
    const a: Snapshot = { timeline: randomA(9), name: "t", aspect: "16:9", styleId: "s2" };
    const r = applyOp(a, { op: "rename", name: "x" }, ctx).snap;
    expect(r.timeline.model).toBe("B");
    expect(planDifferences(planRenderA({ kind: "preview", snapshot: a, transcript: tr, source, videoId: "vid1", brollSeconds }), planRender({ kind: "preview", snapshot: r, transcript: tr, source, videoId: "vid1", brollSeconds }))).toEqual([]);
  });
  it("conversion is stable: converting, laying out and normalizing again changes nothing", () => {
    const b = toModelB(randomA(11), words, "vid1");
    expect(JSON.stringify(layoutTimeline(b, words))).toBe(JSON.stringify(b));
    expect(sequenceView(b, words).total).toBeGreaterThan(0);
  });
});
