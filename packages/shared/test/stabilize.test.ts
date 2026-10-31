// Premiere parity, phase 7: Warp Stabilizer. The op (V1 clips, smooth, off), get_project, the plan (a part per
// stabilized clip at normal speed, keyed by clip and footage start; another speed plays as filmed and says so) and the
// graph (vidstabtransform on the part's own frames, the uniform fast path left).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, summarizeTimeline, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, stabilizeKey, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined, getVideo: (id) => (id === "br" ? { id, name: "b", seconds: 8, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const clipOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as (SeqClip & { stabilize?: { smooth: number } })[]).find((c) => c.id === id)!;
const source = { width: 1280, height: 720, fps: 30, seconds: 12, hasAudio: true };

describe("stabilize", () => {
  it("on a clip, with its smoothness; every V1 clip by default; off removes it; get_project says so", () => {
    let s = edit(base(), { op: "stabilize", clipId: "a", smooth: 70 } as Op).snap;
    expect(clipOf(s, "a").stabilize).toEqual({ smooth: 70 });
    expect(clipOf(s, "b").stabilize).toBeUndefined();
    expect(summarizeTimeline(s, tr)).toMatch(/stabilized 70/);
    const all = edit(base(), { op: "stabilize" } as Op);
    expect(all.summary).toMatch(/^2 clips: stabilized, smooth 50/);
    s = edit(s, { op: "stabilize", clipId: "a", off: true } as Op).snap;
    expect(clipOf(s, "a").stabilize).toBeUndefined();
  });
  it("the plan: a part per stabilized clip at normal speed; another speed plays as filmed and says so", () => {
    let s = edit(base(), { op: "stabilize", smooth: 60 } as Op).snap;
    s = edit(s, { op: "set_speed", clipId: "b", speed: 2 } as Op).snap;
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    const keys = Object.keys(p.stabilize ?? {});
    expect(keys).toEqual([stabilizeKey(p.parts[0])]);
    expect(p.stabilize![keys[0]]).toMatchObject({ videoId: "v", srcIn: 1, srcOut: 5, smoothing: 18 });
    expect(p.stabilize![keys[0]].file).toMatch(/^stab_\w+\.trf$/);
    expect(p.operations.join("\n")).toMatch(/Stabilized \(Warp Stabilizer, zoomed in to hide the edges\): a; as filmed where a clip plays at another speed: b/);
  });
  it("the graph: the part's own frames smoothed by its shake; no stabilize, the fast path as before", () => {
    const plain = planRender({ kind: "preview", snapshot: base(), transcript: tr, source, videoId: "v" });
    expect(ffmpegArgs(plain, { source: "/in.mp4", output: "/o.mp4" } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph).not.toMatch(/vidstab/);
    const s = edit(base(), { op: "stabilize", clipId: "a" } as Op).snap;
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    const k = Object.keys(p.stabilize!)[0];
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", stabilize: { [k]: "/tmp/a.trf" } } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toMatch(/trim=start=1\.000000:end=5\.000000,setpts=PTS-STARTPTS,vidstabtransform=input='\/tmp\/a\.trf':smoothing=15:optzoom=1:interpol=bicubic/);
    expect(g.match(/vidstabtransform/g)).toHaveLength(1);
  });
});
