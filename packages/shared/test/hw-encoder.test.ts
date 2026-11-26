// The user's own computer encodes with its graphics chip when its app reported one that works: H.264 previews and
// standard finals; best quality, HEVC and HDR stay on the software encoders. No chip reported: nothing changes.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, type EditContext, type Snapshot } from "../src/index";
import { ffmpegArgs, hwVideoArgs, pickHwEncoder, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 15, getStyle: () => undefined, getVideo: () => undefined, getGraphic: () => undefined } as unknown as EditContext;
const src = { width: 1920, height: 1080, fps: 30, seconds: 15, hasAudio: true };
function plan(kind: "preview" | "final", best = false) {
  let s: Snapshot = { timeline: buildInitialTimeline(tr, 15, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] as never }, ctx).snap;
  const p = planRender({ kind, snapshot: s, transcript: tr, source: src, videoId: "v" });
  if (best) (p as { best?: boolean }).best = true;
  const files: PlanFiles = { source: "/in.mp4", output: "/out.mp4" };
  return { p, files };
}
const enc = (args: string[]) => args[args.indexOf("-c:v", args.lastIndexOf("-filter_complex_script")) + 1];

describe("hardware encoders on the user's computer", () => {
  it("picks the first one reported, Apple's first; none: null", () => {
    expect(pickHwEncoder(["libx264", "h264_nvenc", "h264_videotoolbox"])).toBe("h264_videotoolbox");
    expect(pickHwEncoder(["h264_qsv"])).toBe("h264_qsv");
    expect(pickHwEncoder(["libx264"])).toBeNull();
    expect(pickHwEncoder(undefined)).toBeNull();
  });
  it("a bitrate from the picture: 12 Mb/s at 1080p30 for a final, less for a preview", () => {
    const a = hwVideoArgs("h264_videotoolbox", { width: 1920, height: 1080, fps: 30, preview: false, rate: "30", gop: "60" });
    expect(a.slice(0, 2)).toEqual(["-c:v", "h264_videotoolbox"]);
    expect(a[a.indexOf("-b:v") + 1]).toBe("12442k");
    const b = hwVideoArgs("h264_nvenc", { width: 960, height: 540, fps: 30, preview: true, rate: "30", gop: "60" });
    expect(b).toContain("p3");
    expect(a).not.toContain("-crf");
  });
  it("in the render command: hardware for a preview and a standard final, x264 for best quality and with none", () => {
    const pv = plan("preview"), fn = plan("final"), best = plan("final", true);
    expect(enc(ffmpegArgs(pv.p, pv.files, src, { hwEncoder: "h264_videotoolbox" }).args)).toBe("h264_videotoolbox");
    expect(enc(ffmpegArgs(fn.p, fn.files, src, { hwEncoder: "h264_nvenc" }).args)).toBe("h264_nvenc");
    expect(enc(ffmpegArgs(best.p, best.files, src, { hwEncoder: "h264_videotoolbox" }).args)).toBe("libx264");
    expect(enc(ffmpegArgs(fn.p, fn.files, src, {}).args)).toBe("libx264");
  });
});
