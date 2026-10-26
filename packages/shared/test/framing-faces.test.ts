// Item 6: set_framing fitFaceTo puts each clip's measured face where it is asked, with the render's own framing math;
// set_clips takes each V1 clip's framing; edits that make clips name their ids in the result.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, type EditContext, type Op, type Snapshot } from "../src/index";
const seqClips = (tl: Snapshot["timeline"]) => tl.tracks.v1 as unknown as { id: string; framing?: { scale: number; x: number; y: number } }[];
import { planRender } from "../src/renderPlan";

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: (id) => (id === "b" ? { id, name: "broll", seconds: 10, ready: true } : undefined), getGraphic: () => undefined } as EditContext;
const base = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" });
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const three = () => edit(base(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }, { id: "c", start: 12, end: 16, label: "" }] } as Op).snap;
const framingOf = (s: Snapshot, id: string) => seqClips(s.timeline).find((c) => c.id === id)!.framing;

describe("set_framing fitFaceTo", () => {
  it("puts the face where asked: centre at x, y and half its height r, per clip", () => {
    const faces = { a: { u: 0.3, v: 0.35, r: 0.1 }, b: { u: 0.62, v: 0.5, r: 0.2 }, c: null };
    const r = edit(three(), { op: "set_framing", fitFaceTo: { x: 0.5, y: 0.4, r: 0.2 }, faces } as Op);
    // a: twice as big; the face (0.3, 0.35) lands at (1 - 2) / 2 + x + 0.3 * 2 = 0.5 across, and 0.4 down.
    expect(framingOf(r.snap, "a")).toEqual({ scale: 2, x: 0.4, y: 0.2 });
    expect(framingOf(r.snap, "b")).toEqual({ scale: 1, x: -0.12, y: -0.1 });
    for (const id of ["a", "b"] as const) {
      const f = framingOf(r.snap, id)!, face = faces[id];
      expect((1 - f.scale) / 2 + f.x + face.u * f.scale).toBeCloseTo(0.5, 3);
      expect((1 - f.scale) / 2 + f.y + face.v * f.scale).toBeCloseTo(0.4, 3);
      expect(face.r * f.scale).toBeCloseTo(0.2, 3);
    }
    expect(framingOf(r.snap, "c")).toBeUndefined();
    expect(r.summary).toBe("put the face at 0.5, 0.4 (radius 0.2 of the frame) in 2 clips; no face found in c: left as it was; b no longer fills the frame (an edge shows black)");
    // The render draws what the edit says.
    const p = planRender({ kind: "preview", snapshot: r.snap, transcript: tr, source: { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true }, videoId: "v" });
    expect(p.parts.find((x) => x.clipIds.includes("a"))!.framing).toEqual({ scale: 2, x: 0.4, y: 0.2 });
  });

  it("says when a face cannot get there within the limits, and goes as close as allowed", () => {
    const r = edit(three(), { op: "set_framing", fitFaceTo: { x: 0.5, y: 0.5, r: 0.45 }, faces: { a: { u: 0.5, v: 0.5, r: 0.05 } }, clipIds: ["a"] } as Op);
    expect(framingOf(r.snap, "a")).toEqual({ scale: 4, x: 0, y: 0 });
    expect(r.summary).toMatch(/a could not get there within scale 0\.25-4 and offset -1 to 1 \(as close as allowed\)/);
  });

  it("needs the faces measured, and is not mixed with scale, x and y", () => {
    expect(() => edit(three(), { op: "set_framing", fitFaceTo: { x: 0.5, y: 0.4, r: 0.2 } } as Op)).toThrow(/needs the faces measured: send it through apply_edits/);
    expect(() => edit(three(), { op: "set_framing", fitFaceTo: { x: 0.5, y: 0.4, r: 0.2 }, scale: 1.2, faces: {} } as Op)).toThrow(/send one or the other/);
  });
});

describe("set_clips framing per clip", () => {
  it("keeps each V1 clip's own framing, null fills the frame again, and a bad one is refused with the reason", () => {
    const s = edit(base(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "", framing: { scale: 1.5, x: 0.1, y: -0.05 } }, { id: "b", start: 6, end: 10, label: "", framing: { scale: 1, x: 0, y: 0 } }] } as Op).snap;
    expect(framingOf(s, "a")).toEqual({ scale: 1.5, x: 0.1, y: -0.05 });
    expect(framingOf(s, "b")).toBeUndefined(); // the plain framing is no framing
    const again = edit(s, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "", framing: null }, { id: "b", start: 6, end: 10, label: "" }] } as Op).snap;
    expect(framingOf(again, "a")).toBeUndefined();
    expect(() => edit(base(), { op: "set_clips", track: "v1", clips: [{ start: 1, end: 5, label: "", framing: { scale: 9, x: 0, y: 0 } }] } as Op)).toThrow(/Clip 1's framing is \{scale 0\.25-4, x -1 to 1, y -1 to 1\}: scale/);
  });
});

describe("new clip ids in the result", () => {
  it("names the clips an edit makes", () => {
    const s = three();
    const r1 = edit(s, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { start: 20, end: 22, label: "" }] } as Op);
    const fresh = seqClips(r1.snap.timeline).find((c) => c.id !== "a")!.id;
    expect(r1.summary).toBe(`set 2 clips on V1 (new clip: ${fresh})`);
    const zoom = edit(s, { op: "add_zoom", start: 2, end: 3, scale: 1.2 } as Op);
    expect(zoom.summary).toMatch(new RegExp(`\\(clip ${zoom.snap.timeline.tracks.v2.at(-1)!.id}\\)$`));
    const text = edit(s, { op: "add_text", text: "Hello", start: 2, end: 3 } as Op);
    expect(text.summary).toMatch(new RegExp(`\\(clip ${text.snap.timeline.tracks.v3.filter((c) => c.kind === "text").at(-1)!.id}; `));
    const music = edit(s, { op: "add_music", trackId: "m_lofi" } as Op);
    expect(music.summary).toBe(`added music: Soft lo-fi 01 (clip ${music.snap.timeline.tracks.a2[0].id})`);
    const v2 = edit(s, { op: "set_clips", track: "v2", clips: [{ start: 2, end: 3, label: "", kind: "zoom", zoom: 1.3 }] } as Op);
    expect(v2.summary).toMatch(/^set 1 clip on V2 \(new clip: \S+\)$/);
  });
});
