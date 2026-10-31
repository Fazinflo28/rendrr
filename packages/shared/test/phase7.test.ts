// Phase 7: export settings (resolution, codec), the final keeping its footage's frame rate (sequence, graph and
// encoder on that rate; previews unchanged at 30), time limits by quality, the export line, graphics held to the clip.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, editCheck, qualityLabel, renderTimeoutMs, summarizeTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { exportText, ffmpegArgs, outputRate, outputSize, planRender, timeBase, type PlanFiles } from "../src/renderPlan";

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: () => undefined, getGraphic: (id) => (id === "gc" ? { id, name: "custom" } : undefined) } as EditContext;
const base = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" });
const edit = (s: Snapshot, ...ops: Op[]) => applyOp(s, ops.length === 1 ? ops[0] : { op: "batch", ops: ops as never }, ctx);
// Clip edges on no frame grid in particular: alignment has to put them on the output's.
const cuts = () => edit(base(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1.013, end: 4.371, label: "" }, { id: "b", start: 6.207, end: 9.9, label: "" }, { id: "c", start: 12.33, end: 15.07, label: "" }, { id: "d", start: 17.77, end: 21.123, label: "" }] } as Op).snap;
const src = (fps: number) => ({ width: 1920, height: 1080, fps, seconds: 30, hasAudio: true });
const files: PlanFiles = { source: "/in.mp4", output: "/out.mp4" };

describe("the final's frame rate", () => {
  it("is the footage's, snapped to the nearest standard rate; previews are 30", () => {
    expect(outputRate("final", 29.97)).toMatchObject({ rate: "30000/1001", capped: false });
    expect(outputRate("final", 30)).toMatchObject({ rate: "30", fps: 30 });
    expect(outputRate("final", 23.98)).toMatchObject({ rate: "24000/1001" });
    expect(outputRate("final", 24)).toMatchObject({ rate: "24" });
    expect(outputRate("final", 25)).toMatchObject({ rate: "25" });
    expect(outputRate("final", 29.92)).toMatchObject({ rate: "30000/1001" }); // a phone's variable rate
    expect(outputRate("final", 59.94)).toMatchObject({ rate: "60000/1001" });
    expect(outputRate("final", 120)).toMatchObject({ rate: "60", capped: true });
    expect(outputRate("final", 15)).toMatchObject({ rate: "15", fps: 15 });
    expect(outputRate("final", 12.5)).toMatchObject({ rate: "12500/1000" });
    expect(outputRate("preview", 25)).toMatchObject({ rate: "30", fps: 30 });
    expect(timeBase("30000/1001")).toBe("1001/30000");
    expect(timeBase("25")).toBe("1/25");
  });
  for (const fps of [25, 24000 / 1001, 30000 / 1001, 60]) {
    it(`aligns every part to whole frames at ${fps.toFixed(3)} fps and runs the graph on that rate`, () => {
      const p = planRender({ kind: "final", snapshot: cuts(), transcript: tr, source: src(fps), videoId: "v" });
      expect(p.fps).toBeCloseTo(fps, 6);
      for (const x of p.parts) {
        // Footage times (what the trims use) are exact; edit times are kept to the millisecond.
        const m = (x.srcOut - x.srcIn) * p.fps;
        expect(Math.abs(m - Math.round(m))).toBeLessThan(1e-6);
        const n = (x.end - x.start) * p.fps;
        expect(Math.abs(n - Math.round(n))).toBeLessThan(p.fps * 0.0011);
        expect(Math.round(n)).toBe(Math.round(m));
      }
      const { args, filterGraph } = ffmpegArgs(p, files, src(fps), { loudnessGainDb: 0 });
      expect(filterGraph).not.toMatch(/fps=30[^0]|settb=1\/30\b|r=30:/);
      expect(filterGraph).toContain(`fps=${p.rate}`);
      expect(args.join(" ")).toContain(`-r ${p.rate} -g ${Math.round(fps * 2)}`);
      expect(p.operations.join("\n")).toMatch(/Frame rate: [\d.]+ fps, the footage's/);
    });
  }
  it("leaves previews on 30 fps and the 540p size", () => {
    const p = planRender({ kind: "preview", snapshot: edit(cuts(), { op: "set_export", resolution: "4k", codec: "hevc" } as Op).snap, transcript: tr, source: src(25), videoId: "v" });
    expect([p.fps, p.rate, p.width, p.height, p.codec]).toEqual([30, "30", 960, 540, "h264"]);
    const { args } = ffmpegArgs(p, files, src(25), { loudnessGainDb: 0 });
    expect(args.join(" ")).toContain("-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 30 -g 60");
  });
});

describe("export settings", () => {
  it("set_export stores only what differs from the defaults and says what changed", () => {
    const a = edit(base(), { op: "set_export", resolution: "4k", codec: "hevc" } as Op);
    expect(a.snap.timeline.export).toEqual({ resolution: "4k", codec: "hevc" });
    expect(a.summary).toBe("export: final 4K, HEVC");
    const b = edit(a.snap, { op: "set_export", resolution: "1080p", codec: "h264" } as Op);
    expect(b.snap.timeline.export).toBeUndefined();
    expect(() => edit(base(), { op: "set_export" } as Op)).toThrow(/needs hdr, resolution, codec, format, bitrate or fps/);
    expect(edit(base(), { op: "set_export", resolution: "720p", hdr: "sdr" } as Op).snap.timeline.export).toEqual({ resolution: "720p", hdr: "sdr" });
  });
  it("sizes the final by resolution in every shape", () => {
    expect(outputSize("16:9", "final", "4k")).toEqual({ width: 3840, height: 2160 });
    expect(outputSize("9:16", "final", "4k")).toEqual({ width: 2160, height: 3840 });
    expect(outputSize("1:1", "final", "720p")).toEqual({ width: 720, height: 720 });
    expect(outputSize("9:16", "final", "720p")).toEqual({ width: 720, height: 1280 });
    expect(outputSize("16:9", "final")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("16:9", "preview", "4k")).toEqual({ width: 960, height: 540 });
  });
  it("encodes HEVC with Apple's tag and BT.709, one preset faster at 4K", () => {
    const s = edit(cuts(), { op: "set_export", codec: "hevc" } as Op, { op: "set_aspect", aspect: "9:16" } as Op).snap;
    const p = planRender({ kind: "final", snapshot: s, transcript: tr, source: src(30), videoId: "v" });
    const a = ffmpegArgs(p, files, src(30), { loudnessGainDb: 0 }).args.join(" ");
    expect(a).toContain("-c:v libx265 -preset fast -crf 22 -pix_fmt yuv420p -tag:v hvc1 -x265-params log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited -r 30 -g 60");
    expect(p.operations.join("\n")).toContain("Encode final: HEVC, 1080x1920, 30 fps");
    const k = planRender({ kind: "final", snapshot: edit(s, { op: "set_export", resolution: "4k" } as Op).snap, transcript: tr, source: src(30), videoId: "v" });
    expect([k.width, k.height]).toEqual([2160, 3840]);
    expect(ffmpegArgs(k, files, src(30), { loudnessGainDb: 0 }).args.join(" ")).toContain("-preset faster");
    expect(k.operations.join("\n")).toContain("Size: scaled up from the footage's 1920x1080 to 2160x3840");
  });
  it("time limits grow with 4K and HEVC; the label names them", () => {
    expect(qualityLabel({})).toBe("1080p");
    expect(qualityLabel({ resolution: "4k", codec: "hevc" })).toBe("4K HEVC");
    expect(qualityLabel({ resolution: "720p", hdr: true })).toBe("720p HEVC HDR");
    expect(renderTimeoutMs("final", 1200, "1080p")).toBe(1200 * 1500);
    expect(renderTimeoutMs("final", 1200, "4K HEVC")).toBe(1200 * 1500 * 6);
    expect(renderTimeoutMs("final", 60, "4K")).toBe(45 * 60_000);
    expect(renderTimeoutMs("preview", 1200, "4K HEVC")).toBe(1200 * 300);
  });
  it("get_project and the check say what the final will be", () => {
    const s = edit(cuts(), { op: "set_export", resolution: "4k" } as Op).snap;
    expect(exportText(s, { fps: 29.97, width: 3840, height: 2160 })).toBe("Export (final): 4K 3840x2160 16:9, H.264, 29.97 fps (the footage's)");
    expect(exportText(s, { fps: 120, width: 1920, height: 1080 })).toBe("Export (final): 4K 3840x2160 16:9, H.264, 60 fps (the footage is 120; finals go up to 60), scaled up from the footage's 1920x1080");
    expect(exportText(base(), { fps: 25, hdr: true })).toBe("Export (final): 1080p 1920x1080 16:9, HEVC 10-bit HDR, 25 fps (the footage's)");
    expect(summarizeTimeline(s, tr, 60, "v", undefined, { fps: 25 })).toContain("Export (final): 4K 3840x2160 16:9, H.264, 25 fps (the footage's).");
    expect(editCheck(s, tr, { videoId: "v", footage: { fps: 23.976 } })).toContain("Export (final): 4K 3840x2160 16:9, H.264, 23.976 fps (the footage's)");
  });
});

describe("graphics as long as their clip", () => {
  const withGraphic = () => edit(cuts(), { op: "add_graphic", graphicId: "gc", start: 1.5, end: 9, edit: true } as Op).snap;
  it("a file shorter than its clip holds its last frame; a long enough one plays as recorded", () => {
    const s = withGraphic();
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source: src(30), videoId: "v" });
    const g = p.graphics[0];
    const short = ffmpegArgs(p, { ...files, graphics: { [g.clipId]: "/g.webm" }, graphicSeconds: { [g.clipId]: 3 } }, src(30), { loudnessGainDb: 0 }).filterGraph;
    expect(short).toMatch(new RegExp(`fps=30,tpad=stop_mode=clone:stop=-1,trim=end_frame=${Math.round((g.end - g.start) * 30)},format=yuva420p`));
    const full = ffmpegArgs(p, { ...files, graphics: { [g.clipId]: "/g.webm" }, graphicSeconds: { [g.clipId]: g.end - g.start } }, src(30), { loudnessGainDb: 0 }).filterGraph;
    expect(full).not.toContain("stop=-1");
    const keyed = planRender({ kind: "preview", snapshot: edit(s, { op: "set_keyframes", track: "v3", clipId: g.clipId, keys: [{ t: 0, scale: 1 }, { t: 2, scale: 1.2 }] } as Op).snap, transcript: tr, source: src(30), videoId: "v" });
    expect(ffmpegArgs(keyed, { ...files, graphics: { [g.clipId]: "/g.webm" }, graphicSeconds: { [g.clipId]: 3 } }, src(30), { loudnessGainDb: 0 }).filterGraph).toContain("tpad=stop_mode=clone:stop=-1");
  });
});
