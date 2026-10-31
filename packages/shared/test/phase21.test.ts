// Phase 21: Warp Stabilizer on b-roll and on V1 clips at other speeds (ramps, reversed, freezes). Such a clip reads a
// stabilized copy of its footage (the plan's stabilized, by clip id), smoothed as one through its speed changes; normal
// speed V1 clips keep the in-render path (plan.stabilize). The op, the plan, the graph and a sample of a slowed clip.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, windowPlan, type PlanFiles } from "../src/renderPlan";

const SEC = 20;
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined,
  getVideo: (id) => (id === "shaky" ? { id, name: "shaky", seconds: 12, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" },
  { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 8, end: 12, label: "" }] }] } as never, ctx).snap;
const run = (s: Snapshot, ...ops: Op[]) => applyOp(s, (ops.length === 1 ? ops[0] : { op: "batch", ops }) as never, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: SEC, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { shaky: 12 } });
const graph = (p: ReturnType<typeof plan>) => ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", broll: Object.fromEntries(p.broll.map((b) => [b.clipId, "/b.mp4"])), stableCopies: Object.fromEntries(Object.entries(p.stabilized ?? {}).map(([id, st]) => [id, `/tmp/${st.copy}`])), stabilize: Object.fromEntries(Object.entries(p.stabilize ?? {}).map(([k, st]) => [k, `/tmp/${st.file}`])) } as PlanFiles, source, { loudnessGainDb: 0 });

describe("stabilize at other speeds and on b-roll", () => {
  it("a slowed clip reads a stabilized copy of its footage, a second either side; a clip at normal speed keeps the in-render path", () => {
    const r = run(base(), { op: "set_speed", clipId: "b", speed: 0.5 } as Op, { op: "stabilize", clipIds: ["a", "b"], smooth: 60 } as Op);
    expect(r.summary).toMatch(/b through its speed changes/);
    const p = plan(r.snap);
    expect(Object.keys(p.stabilize ?? {})).toHaveLength(1);
    expect(p.stabilized?.b).toMatchObject({ clipId: "b", videoId: "v", srcIn: 7, srcOut: 13, smoothing: 18 });
    expect(p.stabilized!.b.copy).toMatch(/^stable_[0-9a-f]+\.mkv$/);
    expect(p.operations.join("\n")).toMatch(/Stabilized \(Warp Stabilizer[^\n]*a, b \(at its speeds, from a stabilized copy\)/);
    const { args, filterGraph } = graph(p);
    // The copy is read as a video of its own, its time from the copy's start: footage 8 s is copy second 1.
    expect(args).toContain(`/tmp/${p.stabilized!.b.copy}`);
    expect(filterGraph).toMatch(/trim=start=1\.000000:end=5\.033333,settb=1\/30,setpts=ceil\(N\/0\.5/);
    expect(filterGraph.match(/vidstabtransform/g)).toHaveLength(1);
  });
  it("a transition at a fast clip's cut reads further past it: the copy reaches that far", () => {
    const r = run(base(), { op: "set_speed", clipId: "b", speed: 4 } as Op, { op: "stabilize", clipIds: ["b"], smooth: 60 } as Op, { op: "set_transition", clipId: "b", type: "dissolve", duration: 1 } as Op);
    const c = plan(r.snap).stabilized!.b;
    // b shows footage from 8 s: a 1 s dissolve at 4x reads up to 4 s past each cut (a second was all before).
    expect(c.srcIn).toBeLessThanOrEqual(8 - 4);
    expect(c.srcIn).toBeGreaterThan(3);
  });
  it("a ramp is one copy for the whole clip; reversed and frozen clips too", () => {
    const ramp = plan(run(base(), { op: "set_speed", clipId: "b", ramp: [{ at: 8, speed: 1 }, { at: 9, speed: 0.4 }, { at: 12, speed: 0.4 }] } as Op, { op: "stabilize", clipId: "b" } as Op).snap);
    expect(ramp.parts.filter((x) => x.clipIds[0] === "b").length).toBeGreaterThan(1);
    expect(Object.keys(ramp.stabilized ?? {})).toEqual(["b"]);
    expect(ramp.stabilize).toBeUndefined();
    const rev = plan(run(base(), { op: "set_speed", clipId: "b", reverse: true } as Op, { op: "stabilize", clipId: "b" } as Op).snap);
    expect(rev.stabilized?.b).toBeDefined();
    const { args } = graph(rev);
    // Reversed: read in 1 s pieces from the copy (footage 11-12 s is copy 4-5 s).
    expect(args.join(" ")).toMatch(new RegExp(`-ss 4\\.000000 -t 1\\.250 -i /tmp/${rev.stabilized!.b.copy}`));
  });
  it("b-roll: stabilize takes its id; the overlay reads its copy from the right second", () => {
    let s = run(base(), { op: "add_broll", videoId: "shaky", start: 2, end: 5, sourceStart: 3, edit: true } as Op).snap;
    const id = (s.timeline.tracks.v2 as { id: string }[])[0].id;
    const r = run(s, { op: "stabilize", clipId: id, smooth: 40 } as Op);
    expect(r.summary).toMatch(/b-roll from its own footage/);
    s = r.snap;
    const p = plan(s);
    expect(p.stabilized?.[id]).toMatchObject({ videoId: "shaky", srcIn: 2, srcOut: 7, broll: true });
    const { args } = graph(p);
    expect(args.join(" ")).toMatch(new RegExp(`-ss 1\\.000 -t 3\\.000 -i /tmp/${p.stabilized![id].copy}`));
    expect(() => run(s, { op: "stabilize", clipId: "nope" } as Op)).toThrow();
  });
  it("a sample of a slowed stabilized clip reads the copy too, and may cut it anywhere", () => {
    const p = plan(run(base(), { op: "set_speed", clipId: "b", speed: 0.5 } as Op, { op: "stabilize", clipId: "b" } as Op).snap);
    const b = p.parts.find((x) => x.clipIds[0] === "b")!;
    const w = windowPlan(p, b.start + 2, b.start + 4);
    expect(w.stabilized?.b).toBeDefined();
    expect(w.parts[0].srcIn).toBeCloseTo(9, 6);
    const only = windowPlan(p, 0.5, 2);
    expect(only.stabilized).toBeUndefined();
  });
});
