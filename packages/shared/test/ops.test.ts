import { describe, expect, it } from "vitest";
import {
  applyOp, buildInitialTimeline, buildTranscript, cutRegions, keptRanges, makeTimeMap, markFillers, outputDuration, sentencesFromWords,
  STYLES, stubTranscript, subtractRanges, TimelineSchema, type EditContext, type Snapshot,
} from "../src/index";
import { buildAss, ffmpegArgs, outputSize, planRender, zoomExpr } from "../src/renderPlan";

const tr = stubTranscript(40);
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { transcript: tr, silences: [], sceneCuts: [], duration: 40, getStyle: (id) => STYLES.find((s) => s.id === id), getVideo: () => undefined, getGraphic: (id) => (id === "gt_title_card" ? { id, name: "Title card", durationSec: 3 } : undefined) };
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 40, "clean"), name: "t", aspect: "16:9", styleId: "s2" });

describe("transcript", () => {
  it("marks fillers including 'you know'", () => {
    const w = ["So", "um,", "you", "know", "basically", "it", "works"].map((text, i) => ({ text, start: i, end: i + 0.5 }));
    expect(markFillers(w)).toEqual([false, true, true, true, true, false, false]);
  });
  it("splits sentences and keeps stable ids", () => {
    const t = buildTranscript(sentencesFromWords([{ text: "Hi.", start: 0, end: 0.3 }, { text: "There", start: 2, end: 2.3 }]));
    expect(t.map((l) => l.id)).toEqual(["l0", "l1"]);
    expect(t[1].words[0].id).toBe("w1");
    expect(t[1].gapBefore).toBeGreaterThan(1);
  });
});

describe("cut maths (same as the UI's cutRegions)", () => {
  it("merges adjacent cut words into one region", () => {
    const r = cutRegions(words, new Set([words[0].id, words[1].id, words[5].id]));
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ start: words[0].t, end: words[2].t });
  });
  it("subtracts ranges and maps source to output time", () => {
    const kept = subtractRanges([{ start: 0, end: 10 }], [{ start: 2, end: 4 }]);
    expect(kept).toEqual([{ start: 0, end: 2 }, { start: 4, end: 10 }]);
    const m = makeTimeMap(kept);
    expect(m.total).toBe(8);
    expect(m.toOutput(5)).toBe(3);
    expect(m.toOutput(3)).toBe(2); // inside a cut snaps to the next kept moment
    expect(m.toSource(3)).toBe(5);
  });
});

describe("render plan timing", () => {
  it("keeps every part on the 30 fps frame grid", () => {
    const s = snap();
    s.timeline.cut = words.filter((_, i) => i % 3 === 1).map((w) => w.id);
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: { width: 1280, height: 720, fps: 25, seconds: 40, hasAudio: true } });
    for (const k of plan.kept) {
      expect(Math.abs(k.start * 30 - Math.round(k.start * 30))).toBeLessThan(1e-6);
      expect(Math.abs(k.end * 30 - Math.round(k.end * 30))).toBeLessThan(1e-6);
    }
    expect(Math.abs(plan.outputSeconds * 30 - Math.round(plan.outputSeconds * 30))).toBeLessThan(0.05);
  });
  it("spreads a rewritten caption line over distinct times", () => {
    const s = snap();
    const line = tr[1];
    s.timeline.captionText = { [line.id]: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen" };
    s.timeline.cut = line.words.slice(1).map((w) => w.id); // only one word of the line is left
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [line], source: { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true }, captionRules: { wordsAtOnce: 3 } });
    const shown = plan.captions.map((c) => c.text).join(" ");
    expect(shown.split(" ").length).toBe(14);
  });
});

describe("ops", () => {
  it("splits the same clip twice with unique ids", () => {
    let s = snap();
    const first = s.timeline.tracks.v1[0];
    const mid = (first.start + first.end) / 2;
    s = applyOp(s, { op: "split_clip", track: "v1", clipId: first.id, at: mid }, ctx).snap;
    s = applyOp(s, { op: "split_clip", track: "v1", clipId: first.id, at: (first.start + mid) / 2 }, ctx).snap;
    const ids = s.timeline.tracks.v1.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(snap().timeline.tracks.v1.length + 2);
  });
  it("audio clips only ever point at built-in tracks", () => {
    const s0 = snap();
    const s = applyOp(s0, { op: "set_clips", track: "a2", clips: [
      { id: "m1", start: 0, end: 5, label: "x", assetKey: "audio/someone-else/video.m4a" },
      { id: "m2", start: 5, end: 9, label: "y", trackId: "m_lofi", assetKey: "proxies/someone-else/v.mp4" },
    ] } as never, ctx).snap;
    const [a, b] = s.timeline.tracks.a2 as { assetKey?: string; trackId?: string }[];
    expect(a.assetKey).toBeUndefined();
    expect(b.assetKey).toBe("assets/music/m_lofi.m4a");
    const fx = applyOp(s, { op: "set_clips", track: "a3", clips: [{ id: "x1", start: 1, end: 2, label: "w", sfxId: "sfx_whoosh" }] } as never, ctx).snap;
    expect((fx.timeline.tracks.a3[0] as { assetKey?: string }).assetKey).toBe("assets/sfx/sfx_whoosh.m4a");
    const plan = planRender({ kind: "preview", snapshot: fx, transcript: tr, source: { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true } } as never);
    expect(plan.audio.map((x) => x.assetKey).sort()).toEqual(["assets/music/m_lofi.m4a", "assets/sfx/sfx_whoosh.m4a"]);
  });
  it("builds a valid first timeline", () => {
    const t = buildInitialTimeline(tr, 40, "bold");
    expect(TimelineSchema.safeParse(t).success).toBe(true);
    expect(t.tracks.v1[0].start).toBe(0);
    expect(t.tracks.v1[t.tracks.v1.length - 1].end).toBe(40);
    expect(t.tracks.v3.length).toBe(tr.length);
  });
  it("cut_words and restore_words round trip", () => {
    const a = applyOp(snap(), { op: "cut_words", wordIds: [words[3].id, words[4].id] }, ctx);
    expect(a.snap.timeline.cut).toHaveLength(2);
    const b = applyOp(a.snap, { op: "restore_words", wordIds: [words[3].id] }, ctx);
    expect(b.snap.timeline.cut).toEqual([words[4].id]);
  });
  it("cut_words by time range removes exactly that range", () => {
    const before = outputDuration(snap().timeline, words);
    const a = applyOp(snap(), { op: "cut_words", from: 0, to: 2 }, ctx);
    expect(before - outputDuration(a.snap.timeline, words)).toBeCloseTo(2, 2);
    expect(a.summary).toMatch(/cut 0.00s to 2.00s/);
  });
  it("refuses unknown words with a friendly message", () => {
    expect(() => applyOp(snap(), { op: "cut_words", wordIds: ["nope"] }, ctx)).toThrow(/None of those words/);
  });
  it("cut_silences shortens the output and never breaks the timeline", () => {
    const before = outputDuration(snap().timeline, words);
    const a = applyOp(snap(), { op: "cut_silences", overSeconds: 0.3 }, ctx);
    expect(outputDuration(a.snap.timeline, words)).toBeLessThan(before);
    expect(TimelineSchema.safeParse(a.snap.timeline).success).toBe(true);
    const again = applyOp(a.snap, { op: "cut_silences", overSeconds: 0.3 }, ctx);
    expect(again.summary).toMatch(/no pauses/);
  });
  it("apply_style twice does not stack automatic zooms and music", () => {
    const a = applyOp(snap(), { op: "apply_style", styleId: "s1" }, ctx);
    const b = applyOp(a.snap, { op: "apply_style", styleId: "s1" }, ctx);
    expect(b.snap.timeline.tracks.v2.length).toBe(a.snap.timeline.tracks.v2.length);
    expect(b.snap.timeline.tracks.a2.length).toBe(1);
    expect(b.snap.timeline.captionLook).toBe("bold");
  });
  it("apply_style keeps clips placed by hand", () => {
    const z = applyOp(snap(), { op: "add_zoom", start: 3, end: 4, scale: 1.3 }, ctx);
    const s = applyOp(z.snap, { op: "apply_style", styleId: "s3" }, ctx);
    expect(s.snap.timeline.tracks.v2.some((c) => (c as { zoom?: number }).zoom === 1.3)).toBe(true);
  });
  it("split, trim and delete clips", () => {
    const s = snap();
    const c = s.timeline.tracks.v1[0];
    const mid = (c.start + c.end) / 2;
    const a = applyOp(s, { op: "split_clip", track: "v1", clipId: c.id, at: mid }, ctx);
    expect(a.snap.timeline.tracks.v1.length).toBe(s.timeline.tracks.v1.length + 1);
    expect(() => applyOp(s, { op: "split_clip", track: "v1", clipId: c.id, at: c.end + 1 }, ctx)).toThrow(/inside the clip/);
    const b = applyOp(a.snap, { op: "delete_clip", track: "v1", clipId: c.id }, ctx);
    expect(b.snap.timeline.tracks.v1.find((x) => x.id === c.id)).toBeUndefined();
  });
  it("music by mood, graphics by id", () => {
    const m = applyOp(snap(), { op: "add_music", trackId: "lofi" }, ctx);
    expect(m.snap.timeline.tracks.a2[0].label).toBe("Soft lo-fi 01");
    expect(() => applyOp(snap(), { op: "add_music", trackId: "polka" }, ctx)).toThrow(/No music/);
    const g = applyOp(snap(), { op: "add_graphic", graphicId: "gt_title_card", start: 1, end: 3, params: { title: "Hi" } }, ctx);
    expect(g.snap.timeline.tracks.v3.some((c) => (c as { kind?: string }).kind === "graphic")).toBe(true);
  });
});

describe("render plan", () => {
  it("sizes outputs by shape", () => {
    expect(outputSize("9:16", "final")).toEqual({ width: 1080, height: 1920 });
    expect(outputSize("16:9", "preview")).toEqual({ width: 960, height: 540 });
    expect(outputSize("1:1", "final")).toEqual({ width: 1080, height: 1080 });
  });
  it("plans cuts, captions and audio in output time", () => {
    const s = applyOp(snap(), { op: "apply_style", styleId: "s1" }, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: { ...s, aspect: "9:16" }, transcript: tr, source: { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true } });
    expect(plan.outputSeconds).toBeLessThan(40);
    expect(plan.captions.length).toBeGreaterThan(0);
    for (let i = 0; i + 1 < plan.captions.length; i++) expect(plan.captions[i].end).toBeLessThanOrEqual(plan.captions[i + 1].start);
    expect(plan.captions.every((c) => c.end <= plan.outputSeconds + 0.01)).toBe(true);
    expect(plan.audio.some((a) => a.kind === "music")).toBe(true);
    const { args, filterGraph } = ffmpegArgs(plan, { source: "/in.mp4", output: "/out.mp4", assPath: "/c.ass", audio: Object.fromEntries(plan.audio.map((a) => [a.clipId, "/m.m4a"])) }, { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true }, { loudnessGainDb: 0 });
    expect(filterGraph).toContain(`concat=n=${plan.kept.length}`);
    expect(filterGraph).toMatch(/volume='pow\(10,-12\*\(min\(1,clip\(/); // music 12 dB down under speech (an envelope)
    expect(filterGraph).toMatch(/aresample=192000,alimiter=limit=0\.7943:attack=5:release=50:level=disabled,aresample=48000\[aout\]/); // -1 dBTP ceiling, 1 dB margin
    expect(args).toContain("-filter_complex_script");
  });
  it("refuses an edit with everything cut", () => {
    const s = snap();
    // Only the middle of the talking is kept on V1, and every word is cut: nothing is left.
    s.timeline = { ...s.timeline, cut: words.map((w) => w.id), tracks: { ...s.timeline.tracks, v1: [{ id: "x", start: 0, end: 5, label: "", sourceVideoId: "main", sourceIn: 5, sourceOut: 10 }] } };
    expect(() => planRender({ kind: "preview", snapshot: s, transcript: tr, source: { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true } })).toThrow(/Nothing is left/);
  });
  it("captions follow edited text and the caption track", () => {
    const s = snap();
    s.timeline.captionText.l0 = "Totally new words here";
    s.timeline.tracks.v3 = s.timeline.tracks.v3.filter((c) => (c as { lineId?: string }).lineId !== "l1");
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: { width: 1280, height: 720, fps: 30, seconds: 40, hasAudio: true } });
    expect(plan.captions[0].text).toMatch(/Totally/);
    const l1 = tr[1].words.map((w) => w.text).join(" ");
    expect(plan.captions.some((c) => l1.startsWith(c.text))).toBe(false);
  });
  it("writes valid ASS and zoom expressions", () => {
    const ass = buildAss([{ start: 0, end: 1.5, text: "Hello {world}" }], "bold", 1080, 1920);
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Cap");
    expect(ass).not.toContain("{world}");
    expect(zoomExpr([])).toBe("1");
    expect(zoomExpr([{ start: 1, end: 2, scale: 1.2, mode: "punch" }])).toContain("between(t,1.000,2.000)");
  });
});
