// Phase 6: colour and compositing. The grade as numbers (curves, white balance, exposure, contrast, saturation, LUTs),
// .cube files both ways, mask pictures, FFmpeg's key and despill formulas, shot matching from measured pixels, the ops,
// the render plan's looks and files, the FFmpeg graph (look chain, b-roll under V1, HDR) and the check's lines.
import { describe, expect, it } from "vitest";
import {
  applyOp, buildInitialTimeline, buildLut, buildTranscript, colorStats, cubeText, curveFn, despillPx, editCheck, gradeFn, hdrLut, keyAlpha, liveFrame, maskPicture,
  matchGrade, parseCube, sampleLut, sdrToHdr, summarizeTimeline, type EditContext, type Grade, type Lut, type Op, type SeqClip, type Snapshot,
} from "../src/index";
import { ffmpegArgs, hdrAss, lookFileData, planRender, type PlanFiles } from "../src/renderPlan";

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const LUT: Lut = parseCube(["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)))].join("\n"));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: (id) => (id === "br" ? { id, name: "bg.mp4", seconds: 20, ready: true } : undefined), getLut: (id) => (id === "inv" ? { id, name: "Invert" } : undefined), lutData: (id) => (id === "inv" ? LUT : undefined) };
const base = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" });
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);
const clips = (s: Snapshot) => s.timeline.tracks.v1 as SeqClip[];
const source = { width: 1280, height: 720, fps: 30, seconds: 30, hasAudio: true };
const plan = (s: Snapshot, more: Record<string, unknown> = {}) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", brollSeconds: { br: 20 }, luts: { inv: LUT }, ...more });
const three = () => edit(base(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 2, end: 6, label: "" }, { id: "b", start: 8, end: 12, label: "" }, { id: "c", start: 14, end: 18, label: "" }] } as Op).snap;
const graph = (p: ReturnType<typeof plan>, src: typeof source = source) => {
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  const files: PlanFiles = { source: "/in.mp4", output: "/out.mp4", looks, broll: Object.fromEntries(p.broll.map((b) => [b.clipId, "/b.mp4"])), under: Object.fromEntries((p.under ?? []).map((b) => [b.clipId, "/u.mp4"])) };
  return ffmpegArgs(p, files, src, { loudnessGainDb: 0 });
};
const b64 = (px: number[]) => Buffer.from(Uint8Array.from(px)).toString("base64");

describe("the grade as numbers", () => {
  it("curves go through their points, stay monotone and add the ends", () => {
    const f = curveFn([[0.25, 0.4], [0.75, 0.8]]);
    expect(f(0)).toBe(0); expect(f(1)).toBe(1);
    expect(f(0.25)).toBeCloseTo(0.4, 6); expect(f(0.75)).toBeCloseTo(0.8, 6);
    for (let x = 0; x < 1; x += 0.01) expect(f(x + 0.01)).toBeGreaterThanOrEqual(f(x) - 1e-9);
  });
  it("a neutral grade changes nothing; exposure, saturation, contrast and temperature do what they say", () => {
    const id = gradeFn({});
    for (const v of [0, 0.2, 0.5, 0.9]) expect(id(v, v / 2, 1 - v)).toEqual([v, v / 2, 1 - v]);
    // +1 stop doubles the light (gamma 2.4).
    const up = gradeFn({ exposure: 1 })(0.5, 0.5, 0.5);
    expect(Math.pow(up[0], 2.4) / Math.pow(0.5, 2.4)).toBeCloseTo(2, 3);
    const grey = gradeFn({ saturation: 0 })(0.8, 0.2, 0.4);
    expect(grey[0]).toBeCloseTo(grey[1], 9); expect(grey[1]).toBeCloseTo(grey[2], 9);
    expect(gradeFn({ contrast: 100 })(0.75, 0.5, 0.25)).toEqual([1, 0.5, 0]);
    const warm = gradeFn({ temperature: 60 })(0.5, 0.5, 0.5);
    expect(warm[0]).toBeGreaterThan(0.5); expect(warm[2]).toBeLessThan(0.5);
    const cool = gradeFn({ temperature: -60 })(0.5, 0.5, 0.5);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });
  it("an imported LUT applies first or last, by its amount", () => {
    expect(gradeFn({ lut: { id: "inv" } }, LUT)(0.2, 0.3, 0.9).map((x) => +x.toFixed(6))).toEqual([0.8, 0.7, 0.1]);
    expect(gradeFn({ lut: { id: "inv", amount: 0.5 } }, LUT)(0.2, 0.4, 1)[0]).toBeCloseTo(0.5, 6);
    // Input LUT: inverted first, then the exposure acts on the inverted picture.
    const first = gradeFn({ exposure: 1, lut: { id: "inv", input: true } }, LUT)(0.8, 0.8, 0.8)[0];
    expect(first).toBeCloseTo(Math.min(1, Math.pow(Math.pow(0.2, 2.4) * 2, 1 / 2.4)), 5);
  });
  it("a LUT round-trips through a .cube file, 3D and 1D, and bad files are refused plainly", () => {
    const g: Grade = { exposure: 0.4, contrast: 20, curves: { r: [[0.5, 0.6]] } };
    const data = buildLut(g, null, 9);
    const back = parseCube(cubeText(data, 9));
    expect(back.size).toBe(9);
    for (let i = 0; i < data.length; i++) expect(back.data[i]).toBeCloseTo(data[i], 5);
    // Between the grid points the table interpolates the grade closely.
    const f = gradeFn(g), s = sampleLut(back, 0.33, 0.61, 0.12), e = f(0.33, 0.61, 0.12);
    for (let c = 0; c < 3; c++) expect(Math.abs(s[c] - e[c])).toBeLessThan(0.02);
    const one = parseCube("LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n0.5 1 1\n");
    expect(sampleLut(one, 1, 0.5, 0)).toEqual([0.5, 0.5, 0]);
    expect(() => parseCube("hello")).toThrow(/no LUT_3D_SIZE/);
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 zero\n")).toThrow(/not a \.cube/);
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toThrow(/should have 8 rows/);
  });
});

describe("mask pictures", () => {
  const W = 100, H = 50;
  const at = (px: Uint8Array, x: number, y: number) => px[y * W + x];
  it("a rectangle is solid inside and empty outside, with a half value on its edge", () => {
    const m = maskPicture([{ shape: "rect", x: 0.2, y: 0.2, w: 0.4, h: 0.4 }], W, H);
    expect(at(m, 40, 20)).toBe(255); expect(at(m, 5, 5)).toBe(0); expect(at(m, 70, 20)).toBe(0);
  });
  it("feather ramps across the edge; invert and subtract and intersect combine as named", () => {
    const f = maskPicture([{ shape: "rect", x: 0.2, y: 0, w: 0.6, h: 1, feather: 0.4 }], W, H);
    // Edge at x = 20 px, feather 20 px, pixel centres at x + 0.5: 22.5% at 14, 47.5% at 19, 72.5% at 24.
    expect(at(f, 14, 25)).toBe(Math.round(255 * 0.225)); expect(at(f, 19, 25)).toBe(Math.round(255 * 0.475)); expect(at(f, 24, 25)).toBe(Math.round(255 * 0.725));
    const inv = maskPicture([{ shape: "ellipse", x: 0, y: 0, w: 1, h: 1, invert: true }], W, H);
    expect(at(inv, 50, 25)).toBe(0); expect(at(inv, 1, 1)).toBe(255);
    const sub = maskPicture([{ shape: "rect", x: 0, y: 0, w: 1, h: 1 }, { shape: "rect", x: 0.4, y: 0, w: 0.2, h: 1, mode: "subtract" }], W, H);
    expect(at(sub, 10, 25)).toBe(255); expect(at(sub, 50, 25)).toBe(0);
    const and = maskPicture([{ shape: "rect", x: 0, y: 0, w: 0.6, h: 1 }, { shape: "rect", x: 0.4, y: 0, w: 0.6, h: 1, mode: "intersect" }], W, H);
    expect(at(and, 10, 25)).toBe(0); expect(at(and, 50, 25)).toBe(255); expect(at(and, 90, 25)).toBe(0);
  });
  it("a path is a polygon (inside by even-odd), with its edge at the half value", () => {
    const m = maskPicture([{ shape: "path", points: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]] }], W, H);
    expect(at(m, 50, 20)).toBe(255); expect(at(m, 5, 45)).toBe(0); expect(at(m, 95, 45)).toBe(0);
  });
});

describe("key and despill: FFmpeg's formulas", () => {
  it("colorkey: alpha from the RGB distance, similarity and blend", () => {
    const k = { color: "#00FF00", similarity: 0.2, blend: 0.1, spill: 0 };
    expect(keyAlpha(0, 255, 0, k)).toBe(0);
    expect(keyAlpha(255, 255, 255, k)).toBe(255);
    // distance sqrt((60^2) / (3 * 255^2)) = 0.1359: under similarity, keyed out.
    expect(keyAlpha(60, 255, 0, k)).toBe(0);
    // distance 0.25: half way through the blend -> 127 (FFmpeg truncates).
    const d = Math.round(0.25 * 255 * Math.sqrt(3));
    expect(keyAlpha(d, 255, 0, k)).toBe(Math.trunc(Math.min(1, (Math.sqrt(d * d / (3 * 255 * 255)) - 0.2) / 0.1) * 255));
    expect(keyAlpha(0, 255, 0, { ...k, blend: 0 })).toBe(0);
  });
  it("despill takes the green over the mean of red and blue away, by spill", () => {
    expect(despillPx(100, 200, 100, { color: "#00FF00", similarity: 0.2, blend: 0.1, spill: 1 })).toEqual([100, 100, 100]);
    expect(despillPx(100, 200, 100, { color: "#00FF00", similarity: 0.2, blend: 0.1, spill: 0.5 })).toEqual([100, 150, 100]);
    expect(despillPx(100, 100, 200, { color: "#0000FF", similarity: 0.2, blend: 0.1, spill: 1 })).toEqual([100, 100, 100]);
  });
});

describe("shot matching from measured pixels", () => {
  it("finds the grade that brings a darker, bluer, flatter shot onto the reference", () => {
    // The reference: a range of colours. The target: the same scene darker, bluer and less saturated.
    const ref: number[] = [];
    for (let i = 0; i < 4000; i++) { const t = (i % 200) / 199, h = Math.floor(i / 200) / 20; ref.push(Math.round(255 * (0.1 + 0.8 * t)), Math.round(255 * (0.1 + 0.7 * t * (0.5 + h))), Math.round(255 * (0.1 + 0.6 * t * (1 - h * 0.5)))); }
    const bad = gradeFn({ exposure: -0.7, temperature: -40, saturation: 70 });
    const target: number[] = [];
    for (let i = 0; i < ref.length; i += 3) target.push(...bad(ref[i] / 255, ref[i + 1] / 255, ref[i + 2] / 255).map((v) => Math.round(v * 255)));
    const m = matchGrade(target, ref);
    const after = colorStats(target, gradeFn(m.grade)), want = colorStats(ref);
    for (let c = 0; c < 3; c++) { expect(Math.abs(after.mid[c] - want.mid[c])).toBeLessThan(0.02); expect(Math.abs(after.hi[c] - want.hi[c])).toBeLessThan(0.03); }
    expect(Math.abs(after.sat - want.sat)).toBeLessThan(0.02);
    expect(m.text).toMatch(/levels .* → /);
  });
});

describe("the ops", () => {
  it("set_grade patches, removes with null, resets; copy_grade copies; get_project groups the looks", () => {
    let s = edit(three(), { op: "set_grade", clipIds: ["a"], exposure: 0.5, contrast: 10, curves: { master: [[0.5, 0.6]] } } as Op).snap;
    expect(clips(s)[0].grade).toEqual({ exposure: 0.5, contrast: 10, curves: { master: [[0.5, 0.6]] } });
    s = edit(s, { op: "set_grade", clipId: "a", contrast: null, lut: { id: "inv", amount: 0.5 } } as Op).snap;
    expect(clips(s)[0].grade).toEqual({ exposure: 0.5, curves: { master: [[0.5, 0.6]] }, lut: { id: "inv", amount: 0.5 } });
    expect(() => edit(s, { op: "set_grade", clipId: "a", lut: { id: "nope" } } as Op)).toThrow(/no LUT "nope"/);
    s = edit(s, { op: "copy_grade", from: "a", all: true } as Op).snap;
    expect(clips(s).map((c) => c.grade?.exposure)).toEqual([0.5, 0.5, 0.5]);
    expect(summarizeTimeline(s, tr, 60, "v")).toMatch(/Looks: grade exposure \+0.5, curves master, LUT "?inv"? 50% on a, b, c/);
    s = edit(s, { op: "set_grade", clipIds: ["b"], reset: true, saturation: 100 } as Op).snap;
    expect(clips(s)[1].grade).toBeUndefined();
  });
  it("set_key needs a colour once and keeps the defaults; masks, effects, under and export", () => {
    expect(() => edit(three(), { op: "set_key", clipId: "a" } as Op)).toThrow(/key colour/);
    let s = edit(three(), { op: "set_key", clipId: "a", color: "#00b140" } as Op).snap;
    expect(clips(s)[0].key).toEqual({ color: "#00B140", similarity: 0.25, blend: 0.1, spill: 0.5 });
    s = edit(s, { op: "set_key", clipId: "a", similarity: 0.4 } as Op).snap;
    expect(clips(s)[0].key!.similarity).toBe(0.4);
    s = edit(s, { op: "set_masks", clipId: "b", masks: [{ shape: "ellipse", x: 0.2, y: 0.1, w: 0.6, h: 0.8, feather: 0.05 }] } as Op, { op: "set_effects", clipId: "c", effects: [{ type: "blur", amount: 40, area: { shape: "rect", x: 0.4, y: 0.1, w: 0.2, h: 0.3 } }] } as Op).snap;
    expect(clips(s)[1].masks).toHaveLength(1); expect(clips(s)[2].effects![0].type).toBe("blur");
    expect(() => edit(s, { op: "set_masks", clipId: "b", masks: [{ shape: "path", points: [[0, 0], [1, 1]] }] } as Op)).toThrow();
    s = edit(s, { op: "add_broll", videoId: "br", start: 3, end: 5, sourceStart: 0 } as Op).snap;
    const bid = s.timeline.tracks.v2[0].id;
    s = edit(s, { op: "set_under", clipId: bid, under: true } as Op, { op: "set_grade", clipId: bid, saturation: 50 } as Op, { op: "set_export", hdr: "sdr" } as Op).snap;
    expect((s.timeline.tracks.v2[0] as { under?: boolean }).under).toBe(true);
    expect(s.timeline.export).toEqual({ hdr: "sdr" });
    s = edit(s, { op: "set_key", clipId: "a", off: true } as Op, { op: "set_masks", clipId: "b", masks: [] } as Op).snap;
    expect(clips(s)[0].key).toBeUndefined(); expect(clips(s)[1].masks).toBeUndefined();
  });
  it("match_color uses the measured frames the server sends, against the reference as graded", () => {
    const s0 = edit(three(), { op: "set_grade", clipId: "a", exposure: 0.3 } as Op).snap;
    expect(() => edit(s0, { op: "match_color", clipIds: ["b"], to: "a" } as Op)).toThrow(/measured by the server/);
    const px = (k: number) => Array.from({ length: 300 }, (_, i) => Math.round(((i % 100) / 99) * 255 * k));
    const s = edit(s0, { op: "match_color", clipIds: ["b"], to: "a", measured: { a: { w: 10, h: 10, rgb: b64(px(1)) }, b: { w: 10, h: 10, rgb: b64(px(0.6)) } } } as Op);
    expect(clips(s.snap)[1].grade?.curves?.r).toBeTruthy();
    expect(s.summary).toMatch(/matched to .* \(measured\): b: levels/);
  });
});

describe("render plan and FFmpeg graph", () => {
  it("each look becomes LUT, key, mask and effect steps; files are named by content and shared", () => {
    const s = edit(three(), { op: "set_grade", all: true, exposure: 0.5, lut: { id: "inv", amount: 0.8 } } as Op, { op: "set_key", clipId: "b", color: "#00FF00" } as Op,
      { op: "set_masks", clipId: "b", masks: [{ shape: "ellipse", x: 0.1, y: 0.1, w: 0.8, h: 0.8 }] } as Op, { op: "set_effects", clipId: "c", effects: [{ type: "pixelate", amount: 20, area: { shape: "rect", x: 0, y: 0, w: 0.5, h: 0.5 } }] } as Op).snap;
    const p = plan(s);
    expect(Object.keys(p.looks!)).toEqual(["a", "b", "c"]);
    expect(p.looks!.a.lut).toBe(p.looks!.c.lut); // one file for one grade
    expect(p.looks!.b.alpha).toBe(true);
    expect(p.looks!.c.effects![0].px).toBe(11); // 2% of 540
    expect(p.operations.join("\n")).toMatch(/Color: 3 clips graded .*LUT inv 80%/);
    expect(p.operations.join("\n")).toMatch(/Key: b #00FF00/);
    const { filterGraph: g } = graph(p);
    expect(g).toMatch(/colorkey=0x00FF00:0.25:0.1/);
    expect(g).toMatch(/despill=type=green:mix=0.5:expand=0:red=0:green=-0.5/);
    expect(g).toMatch(/lut3d=file='\/tmp\/lut_[0-9a-f]{16}\.cube':interp=trilinear/);
    expect(g).toMatch(/pixelize=width=11:height=11:mode=avg/);
    expect(g).toMatch(/maskedmerge/);
    expect(g).toMatch(/alphamerge/);
    // The LUT file holds the grade with its LUT; the mask file is a PGM at the plan's size.
    const cube = lookFileData(p.lookFiles![p.looks!.a.lut!], p, { inv: LUT }) as string;
    expect(cube).toMatch(/^TITLE .*\nLUT_3D_SIZE 33\n/);
    const pgmData = lookFileData(p.lookFiles![p.looks!.b.mask!], p) as Uint8Array;
    expect(new TextDecoder().decode(pgmData.slice(0, 15))).toBe("P5\n960 540\n255\n");
  });
  it("an edit without looks draws exactly as before", () => {
    const p = plan(three());
    expect(p.looks).toEqual({});
    expect(graph(p).filterGraph).not.toMatch(/lut3d|colorkey|maskedmerge|alphamerge/);
  });
  it("one grade on every clip of one video is drawn once after the fit", () => {
    const s = edit(base(), { op: "set_grade", all: true, saturation: 120 } as Op).snap;
    const { filterGraph: g } = graph(plan(s));
    expect(g.match(/lut3d/g)).toHaveLength(1);
    expect(g).toMatch(/\[vfit\]scale=in_color_matrix=bt709/);
  });
  it("b-roll under V1 is drawn behind a keyed clip; the live frame lists it", () => {
    let s = edit(three(), { op: "set_key", clipId: "a", color: "#00FF00" } as Op, { op: "add_broll", videoId: "br", start: 2, end: 6, sourceStart: 1 } as Op).snap;
    s = edit(s, { op: "set_under", clipId: s.timeline.tracks.v2[0].id, under: true } as Op).snap;
    const p = plan(s);
    expect(p.under).toHaveLength(1); expect(p.broll).toHaveLength(0);
    const { filterGraph: g, args } = graph(p);
    expect(g).toMatch(/\[bs0\]\[ub0u0\]overlay/);
    expect(args.join(" ")).toMatch(/-ss 1.000 -t .* -i \/u\.mp4/);
    const f = liveFrame(p, 1);
    expect(f.under[0]).toMatchObject({ videoId: "br" }); expect(f.under[0].src).toBeCloseTo(2, 6);
    expect(f.lookId).toBe("a");
  });
  it("HDR: a final of HDR footage stays HDR (HEVC 10-bit, BT.2020, PQ); SDR is placed at 203 nits; sdr converts", () => {
    const hdrSrc = { ...source, hdr: true, transfer: "pq" as const };
    const s = edit(three(), { op: "set_grade", clipId: "b", exposure: 0.3 } as Op).snap;
    const p = planRender({ kind: "final", snapshot: s, transcript: tr, source: hdrSrc, videoId: "v" });
    expect(p.hdr?.transfer).toBe("pq");
    expect(p.operations.join("\n")).toMatch(/HDR: kept \(PQ.*b graded or keyed in SDR/);
    const { args, filterGraph: g } = graph(p, hdrSrc);
    expect(args.join(" ")).toMatch(/-c:v libx265 .*-pix_fmt yuv420p10le .*transfer=smpte2084.*-color_trc smpte2084/);
    expect(g).toMatch(/format=yuv420p10le/);
    // Clip b is graded in SDR (tone-mapped first), the others stay HDR with no tone-map.
    expect(g.match(/tonemap=tonemap=hable/g)).toHaveLength(1);
    expect(lookFileData(p.lookFiles![p.hdr!.lut], p)).toMatch(/TITLE "SDR into HDR"/);
    const sdr = planRender({ kind: "final", snapshot: edit(s, { op: "set_export", hdr: "sdr" } as Op).snap, transcript: tr, source: hdrSrc, videoId: "v" });
    expect(sdr.hdr).toBeNull();
    expect(sdr.operations.join("\n")).toMatch(/HDR: converted to SDR/);
    const pre = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", hdrFootage: { v: "pq" } });
    expect(pre.operations.join("\n")).toMatch(/HDR: footage is HDR; this preview and the editor show it tone-mapped to SDR; the final keeps HDR; b graded/);
  });
  it("SDR white is 203 nits in PQ and 75% in HLG; captions take those colours", () => {
    expect(sdrToHdr(1, 1, 1, "pq")[0]).toBeCloseTo(0.5806, 3);
    expect(sdrToHdr(1, 1, 1, "hlg")[0]).toBeCloseTo(0.75, 2);
    expect(sdrToHdr(0, 0, 0, "pq")[0]).toBeLessThan(1e-6);
    const ass = hdrAss("Style: Cap,Inter,40,&H00FFFFFF,&H80000000\n{\\c&H00FF00&}x", "pq");
    expect(ass).toMatch(/^Style: Cap,Inter,40,&H00949494,&H80000000\n\{\\c&H[0-9A-F]{6}&\}x$/);
    expect(ass).not.toContain("&H00FF00&");
    expect(hdrLut("pq", undefined, 2).length).toBe(24);
  });
  it("the check lists the looks and what the render said about HDR", () => {
    const s = edit(three(), { op: "set_grade", clipId: "a", exposure: 0.5 } as Op, { op: "set_effects", clipId: "b", effects: [{ type: "blur", amount: 30 }] } as Op).snap;
    const out = editCheck(s, tr, { videoId: "v", renderNotes: ["HDR: footage is HDR; this preview and the editor show it tone-mapped to SDR; the final keeps HDR"] });
    expect(out).toMatch(/Looks: grade exposure \+0.5 on a; blur 30 on b/);
    expect(out).toMatch(/HDR: footage is HDR/);
  });
});
