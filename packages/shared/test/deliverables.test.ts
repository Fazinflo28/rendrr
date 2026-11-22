// Premiere parity, phase 12 (deliverables): SRT and WebVTT from the edit's words, YouTube chapters from chapter marks,
// and the export's format, bitrate and frame rate (the op, the plan, the encode).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, chapterProblems, chaptersText, formatFile, isSoundFormat, SOUND_QUALITY, srtText, vttText, withExportFormat, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 6 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 22, getStyle: () => undefined };
const base = (captions = false): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 22, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: captions }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 22, label: "" }] }] } as never, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx).snap;
const source = { width: 1920, height: 1080, fps: 29.97, seconds: 22, hasAudio: true };
const plan = (s: Snapshot, kind: "preview" | "final" = "final") => planRender({ kind, snapshot: s, transcript: tr, source, videoId: "v" });
const args = (s: Snapshot, out = "/o.mp4") => { const p = plan(s); return { p, ...ffmpegArgs(p, { source: "/in.mp4", output: out } as PlanFiles, source, { loudnessGainDb: 0 }) }; };

describe("captions files and chapters", () => {
  it("SRT and WebVTT carry the words with their times, captions drawn or not", () => {
    const cues = [{ start: 0.5, end: 1.25, text: "Hello there" }, { start: 61.004, end: 62.5, text: "Second\\Nline" }];
    expect(srtText(cues)).toBe("1\n00:00:00,500 --> 00:00:01,250\nHello there\n\n2\n00:01:01,004 --> 00:01:02,500\nSecond\nline\n");
    expect(vttText(cues)).toBe("WEBVTT\n\n00:00:00.500 --> 00:00:01.250\nHello there\n\n00:01:01.004 --> 00:01:02.500\nSecond\nline\n");
    const off = plan(base(false), "preview"), on = plan(base(true), "preview");
    expect(off.captions).toHaveLength(0);
    expect(off.subtitles!.length).toBeGreaterThan(3);
    expect(off.subtitles!.map((c) => c.text).join(" ")).toMatch(/^w0 w1 .* w39$/);
    expect(on.subtitles!.map((c) => [c.start, c.end])).toEqual(on.captions.map((c) => [c.start, c.end]));
  });
  it("chapters come from chapter marks in edit time; the first is at 0:00; what YouTube needs is said", () => {
    let s = base();
    s = edit(s, { op: "add_marks", marks: [{ kind: "chapter", start: 0, label: "Hook" }, { kind: "chapter", start: 8, label: "The method" }, { kind: "chapter", start: 15, label: "Wrap up" }] } as Op);
    const p = plan(s);
    expect(p.chapters).toEqual([{ at: 0, title: "Hook" }, { at: 8, title: "The method" }, { at: 15, title: "Wrap up" }]);
    expect(chaptersText(p.chapters!)).toBe("0:00 Hook\n0:08 The method\n0:15 Wrap up");
    expect(chapterProblems(p.chapters!, p.outputSeconds)).toEqual(["each chapter at least 10 s long (Hook, The method, Wrap up are shorter)"]);
    expect(p.operations.join("\n")).toMatch(/Chapters: 3 \(0:00 Hook, 0:08 The method, 0:15 Wrap up\); YouTube shows none until there are: each chapter/);
    // A cut before a chapter moves it with its footage.
    const cut = edit(s, { op: "cut_words", from: 2, to: 5 } as Op);
    expect(plan(cut).chapters![1].at).toBeCloseTo(5, 1);
    expect(chaptersText([{ at: 12, title: "Only" }])).toBe("0:00 Intro\n0:12 Only");
  });
});

describe("export format, bitrate and frame rate", () => {
  it("set_export stores them and says them; mp4 and null go back to the defaults", () => {
    const r = applyOp(base(), { op: "set_export", format: "gif", fps: 25, bitrate: 12 } as Op, ctx);
    expect(r.snap.timeline.export).toEqual({ format: "gif", fps: 25, bitrate: 12 });
    expect(r.summary).toBe("export: the final as a GIF (up to 10 min: 15 fps to a minute, 10 fps to three, 6 fps beyond), 12 Mbit/s, 25 fps");
    const back = edit(r.snap, { op: "set_export", format: "mp4", fps: null, bitrate: null } as Op);
    expect(back.timeline.export).toBeUndefined();
  });
  it("a final at a set frame rate and bitrate; a preview keeps 30 fps and quality", () => {
    const s = edit(base(), { op: "set_export", fps: 25, bitrate: 8 } as Op);
    const { p, args: a } = args(s);
    expect([p.fps, p.rate, p.bitrate]).toEqual([25, "25", 8]);
    expect(a.join(" ")).toMatch(/-c:v libx264 -preset veryfast -b:v 8M -maxrate 12M -bufsize 16M -pix_fmt yuv420p -r 25/);
    expect(p.operations.join("\n")).toMatch(/Deliverable: MP4, 8 Mbit\/s, 25 fps/);
    expect(p.operations.join("\n")).toMatch(/Frame rate: 25 fps, as the export asks \(the footage is 29\.97 fps\)/);
    const pv = plan(s, "preview");
    expect([pv.fps, pv.bitrate]).toEqual([30, undefined]);
  });
  it("sound only writes the mix straight to its file (no picture made); a long GIF gets fewer frames, past ten minutes refused", () => {
    const w = args(edit(base(), { op: "set_export", format: "wav" } as Op), "/o.wav"), a = w.args.join(" ");
    expect(a).toMatch(/-map \[aout\] -c:a pcm_s16le -ar 48000 -t [\d.]+ .*\/o\.wav$/);
    // No picture at all: as heavy as the video before (a 4K final ran out of memory making a WAV).
    expect(a).not.toMatch(/\[vout\]|-f null/);
    expect(w.filterGraph).not.toMatch(/\[vout\]|scale=|\[0:v\]/);
    const m = args(edit(base(), { op: "set_export", format: "audio" } as Op), "/o.m4a").args.join(" ");
    expect(m).toMatch(/-map \[aout\] -c:a aac -b:a 256k/);
    // Phase 20: a GIF over a minute is made at fewer frames and smaller; over ten minutes it is refused.
    const gifOf = (secs: number) => applyOp({ timeline: buildInitialTimeline(tr, secs + 10, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: secs, label: "" }] }, { op: "set_export", format: "gif" }] } as never, { ...ctx, duration: secs + 10 }).snap;
    const p80 = planRender({ kind: "final", snapshot: gifOf(80), transcript: tr, source: { ...source, seconds: 90 }, videoId: "v" });
    expect(p80.operations.join("\n")).toMatch(/Deliverable: GIF 480 px wide, 10 fps .*over a minute: fewer frames and smaller/);
    const p300 = planRender({ kind: "final", snapshot: gifOf(300), transcript: tr, source: { ...source, seconds: 310 }, videoId: "v" });
    expect(p300.operations.join("\n")).toMatch(/Deliverable: GIF 360 px wide, 6 fps/);
    expect(() => planRender({ kind: "final", snapshot: gifOf(700), transcript: tr, source: { ...source, seconds: 710 }, videoId: "v" })).toThrow(/A GIF can be up to 10 minutes; this edit is 11:[34]\d/);
  });
  it("a sound-only final for one export (render_final format): the edit's own settings untouched", () => {
    const video = edit(base(), { op: "set_export", resolution: "4k", fps: 25 } as Op);
    const once = withExportFormat(video, "audio");
    expect(once).not.toBe(video);
    expect(video.timeline.export).toEqual({ resolution: "4k", fps: 25 });
    expect(once.timeline.export).toEqual({ resolution: "4k", fps: 25, format: "audio" });
    expect(plan(once).format).toBe("audio");
    expect(args(once, "/o.m4a").args.join(" ")).toMatch(/-map \[aout\] -c:a aac -b:a 256k/);
    expect(withExportFormat(video, null)).toBe(video);
    expect(withExportFormat(once, "audio")).toBe(once);
    expect(formatFile("audio")).toEqual({ ext: "m4a", type: "audio/mp4" });
    expect([isSoundFormat("audio"), isSoundFormat("wav"), isSoundFormat("mp4"), isSoundFormat(null)]).toEqual([true, true, false, false]);
    expect(SOUND_QUALITY).toEqual({ audio: "Sound only (.m4a)", wav: "Sound only (WAV)" });
  });

  it("the overlay export: the picture as one colour, b-roll and zooms left out, a lossless pass", () => {
    const s = edit(base(true), { op: "set_export", format: "overlay" } as Op);
    const p = plan(s);
    expect(p.format).toBe("overlay");
    const r = ffmpegArgs(p, { source: "/in.mp4", output: "/b.mkv", assPath: "/c.ass" } as PlanFiles, source, { loudnessGainDb: 0, pictureAs: "white" });
    expect(r.filterGraph).toMatch(/color=c=white:s=1920x1080:r=29\.97|color=c=white:s=1920x1080:r=30000\/1001/);
    expect(r.filterGraph).toMatch(/\[vdrop\]nullsink/);
    expect(r.filterGraph).toMatch(/\[vplain\]ass=filename/);
    expect(r.args.join(" ")).toMatch(/-c:v ffv1 -level 3 -g 1 -pix_fmt yuv444p .* -c:a pcm_s16le .*\/b\.mkv$/);
    expect(p.operations.join("\n")).toMatch(/Deliverable: the graphics, text and captions on transparency \(ProRes 4444/);
  });
});
