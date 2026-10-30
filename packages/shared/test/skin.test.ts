// Skin retouch: the skin's colour, the numbers at a picture's size (they follow the face), the retouch_skin op (natural
// defaults, values kept, the face's area measured by the server, off), the look lines, the render plan's skin and the
// FFmpeg graph (before the grade, on YUV; at the working size or only its change above it).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, FACE_AREA, skinChroma, skinParams, summarizeTimeline, SKIN_DEFAULTS, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const skinOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as (SeqClip & { skin?: unknown })[]).find((c) => c.id === id)!.skin as Record<string, unknown> | undefined;
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
const face = { shape: "ellipse" as const, x: 0.35, y: 0.05, w: 0.3, h: 0.7, feather: 0.04 };

describe("the skin's colour", () => {
  it("skin of light and dark tones counts; a beige wall, an orange suit, blue and grey do not", () => {
    // 8-bit BT.709 (Cb, Cr) measured on portraits: cheeks of three people, then what sits around them.
    for (const [cb, cr] of [[113, 144], [112, 145], [116, 142], [105, 150], [110, 147]]) expect(skinChroma(cb, cr)).toBeGreaterThan(0.95);
    for (const [cb, cr] of [[124, 133], [100, 182], [150, 132], [128, 128]]) expect(skinChroma(cb, cr)).toBeLessThan(0.05);
  });
});

describe("the numbers", () => {
  const sk = { ...SKIN_DEFAULTS };
  it("work at 540 at most, and above it only the change is added", () => {
    const p = skinParams(sk, 1920, 1080), q = skinParams(sk, 960, 540), r = skinParams(sk, 1080, 1920);
    expect([p.ww, p.wh, q.ww, q.wh, r.ww, r.wh]).toEqual([960, 540, 960, 540, 540, 960]);
    expect(p.brighten).toBeNull();
    expect(skinParams({ ...sk, smooth: 0, blemishes: 0, even: 0, brighten: 0 }, 960, 540)).toMatchObject({ smooth: null, blemishes: null, even: null, brighten: null });
  });
  it("sizes follow the face: a face twice as tall gets twice the blur", () => {
    const small = skinParams({ ...sk, area: { ...face, h: 0.35 }, face: true }, 1920, 1080), big = skinParams({ ...sk, area: face, face: true }, 1920, 1080);
    expect(big.smooth!.sigmaS / small.smooth!.sigmaS).toBeCloseTo(2, 1);
    expect(big.even!.sigma / small.even!.sigma).toBeCloseTo(2, 1);
    // A drawn area (not a face) leaves the sizes at a talking head's.
    expect(skinParams({ ...sk, area: face }, 1920, 1080).smooth).toEqual(skinParams(sk, 1920, 1080).smooth);
    expect(FACE_AREA.h).toBeGreaterThan(1);
  });
});

describe("retouch_skin", () => {
  it("without values: every V1 clip, the natural defaults, on each clip's face", () => {
    const r = edit(base(), { op: "retouch_skin", faceAreas: { a: face, b: null } } as Op);
    expect(skinOf(r.snap, "a")).toEqual({ ...SKIN_DEFAULTS, area: face, face: true });
    expect(skinOf(r.snap, "b")).toEqual({ ...SKIN_DEFAULTS });
    expect(r.summary).toMatch(/^2 clips: skin retouch: smooth 35, blemishes 40, even 35, brighten 0, on the face; no face measured on b: the skin is found over the whole picture there$/);
  });
  it("needs the faces measured unless it is told the area, and says how", () => {
    expect(() => edit(base(), { op: "retouch_skin" } as Op)).toThrow(/needs the faces measured: send it through apply_edits/);
    const r = edit(base(), { op: "retouch_skin", clipId: "a", area: "frame", smooth: 60 } as Op);
    expect(skinOf(r.snap, "a")).toEqual({ ...SKIN_DEFAULTS, smooth: 60 });
    expect(skinOf(r.snap, "b")).toBeUndefined();
  });
  it("values left out keep theirs, and so does the area; off and all zeros remove it", () => {
    let s = edit(base(), { op: "retouch_skin", clipId: "a", faceAreas: { a: face } } as Op).snap;
    s = edit(s, { op: "retouch_skin", clipId: "a", brighten: 30 } as Op).snap;
    expect(skinOf(s, "a")).toEqual({ ...SKIN_DEFAULTS, brighten: 30, area: face, face: true });
    expect(summarizeTimeline(s, tr)).toMatch(/skin retouch: smooth 35, blemishes 40, even 35, brighten 30, on the face on a/);
    expect(skinOf(edit(s, { op: "retouch_skin", clipId: "a", off: true } as Op).snap, "a")).toBeUndefined();
    expect(skinOf(edit(s, { op: "retouch_skin", clipId: "a", smooth: 0, blemishes: 0, even: 0, brighten: 0 } as Op).snap, "a")).toBeUndefined();
  });
  it("copy_grade carries it with: skin", () => {
    const s = edit(base(), { op: "retouch_skin", clipId: "a", area: "frame", even: 70 } as Op).snap;
    expect(skinOf(edit(s, { op: "copy_grade", from: "a", to: ["b"], with: ["skin"] } as Op).snap, "b")).toEqual({ ...SKIN_DEFAULTS, even: 70 });
  });
});

describe("the render", () => {
  const graph = (s: Snapshot, kind: "preview" | "final") => {
    const p = planRender({ kind, snapshot: s, transcript: tr, source, videoId: "v" });
    const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
    return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", looks } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph };
  };
  it("the plan carries it and says so; the graph retouches before the grade, on YUV, merging on the skin at the working size", () => {
    let s = edit(base(), { op: "retouch_skin", clipId: "a", faceAreas: { a: face }, brighten: 20 } as Op).snap;
    s = edit(s, { op: "set_grade", clipId: "a", exposure: 0.5 } as Op).snap;
    const { p, g } = graph(s, "preview");
    expect(p.looks!.a.skin!.p.ww).toBe(p.width);
    expect(p.operations.join("\n")).toMatch(/Skin: a smooth 35, blemishes 40, even 35, brighten 20, on the face/);
    const area = p.looks!.a.skin!.file!;
    expect(lookFileData(p.lookFiles![area], p)).toBeInstanceOf(Uint8Array);
    for (const f of ["lut2=c0='255*clip(", "bilateral=sigmaS=", "gblur=sigma=", "dilation=coordinates=255", "lutyuv=y='16+219*pow(", "maskedmerge[ko"]) expect(g).toContain(f);
    expect(g.indexOf("bilateral")).toBeLessThan(g.indexOf("lut3d"));
    expect(g).not.toContain("grainmerge");
    expect(p.looks!.b).toBeUndefined();
  });
  it("a 1080p final works at 540 and adds only the change", () => {
    const s = edit(edit(base(), { op: "retouch_skin", all: true, area: "frame" } as Op).snap, { op: "set_export", resolution: "1080p" } as Op).snap;
    const { p, g } = graph(s, "final");
    expect([p.width, p.looks!.a.skin!.p.ww]).toEqual([1920, 960]);
    expect(g).toContain("blend=all_mode=grainextract");
    expect(g).toContain(`scale=1920:1080:flags=bicubic`);
    expect(g).toContain("blend=all_mode=grainmerge");
  });
});
