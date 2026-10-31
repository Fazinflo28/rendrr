// Premiere parity, phase 18: remove_background on b-roll and on reversed clips. The op (b-roll over the picture yes,
// b-roll behind V1 no), the plan (the b-roll's own matte over the stretch it plays, its own line), the graph (the
// b-roll's matte through its trim, mirror and fit; a reversed clip's matte backwards in pieces; a mirrored clip's matte
// mirrored) and the person behind text on a reversed clip.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const SEC = 20;
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined,
  getVideo: (id) => (id === "br" ? { id, name: "person", seconds: 30, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 6, label: "" }, { id: "b", start: 8, end: 12, label: "" }] }] } as never, ctx).snap;
const run = (s: Snapshot, ...ops: Op[]) => applyOp(s, (ops.length === 1 ? ops[0] : { op: "batch", ops }) as never, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: SEC, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { br: 30 } });
const graph = (s: Snapshot) => {
  const p = plan(s);
  const files = { source: "/in.mp4", output: "/o.mp4", looks: {}, mattes: Object.fromEntries(Object.keys(p.mattes ?? {}).map((n) => [n, `/m/${n}.txt`])), broll: Object.fromEntries(p.broll.map((b) => [b.clipId, "/br.mp4"])), assPath: "/c.ass" } as PlanFiles;
  return { p, g: ffmpegArgs(p, files, source, { loudnessGainDb: 0 }).filterGraph };
};

describe("remove_background on b-roll", () => {
  const withBroll = () => run(base(), { op: "add_broll", videoId: "br", start: 2, end: 5, sourceStart: 12, edit: true } as Op).snap;
  it("cuts the b-roll's person out over the picture, from its own video's matte over the stretch it plays", () => {
    const s0 = withBroll(), id = (s0.timeline.tracks.v2 as { id: string }[])[0].id;
    const r = run(s0, { op: "remove_background", clipId: id, soft: 10 } as Op);
    expect(r.summary).toMatch(/background removed/);
    expect(r.summary).not.toMatch(/set_background/);
    const { p, g } = graph(r.snap);
    const look = p.looks![id];
    expect(look.subject).toMatchObject({ soft: 10 });
    expect(p.mattes![look.subject!.matte]).toEqual({ videoId: "br", blocks: [1] });
    expect(p.operations.join("\n")).toMatch(new RegExp(`Background: b-roll ${id} .*the picture under it shows round them|Background: b-roll ${id} .*the picture under it shows around them`));
    expect(g).toMatch(/trim=start=12\.000000:end=15\.0\d+,setpts=PTS-STARTPTS,fps=30,scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1,tpad=stop_mode=clone:stop=2,trim=end_frame=90,format=gray\[smfb0\]/);
  });
  it("b-roll laid behind V1 is refused", () => {
    const s0 = withBroll(), id = (s0.timeline.tracks.v2 as { id: string }[])[0].id;
    const u = run(s0, { op: "set_under", clipId: id, under: true } as Op).snap;
    expect(() => run(u, { op: "remove_background", clipId: id } as Op)).toThrow(/behind V1 \(set_under\)/);
  });
});

describe("remove_background on reversed and mirrored clips", () => {
  it("a reversed clip reads its matte in the picture's 1 s pieces, each played backwards", () => {
    const s = run(base(), { op: "set_speed", clipId: "a", reverse: true } as Op, { op: "remove_background", clipId: "a" } as Op).snap;
    const { g } = graph(s);
    for (let j = 0; j < 5; j++) expect(g).toContain(`[mrc0_${j}]`);
    expect(g).toMatch(/\[mrc0_0\]\[mrc0_1\]\[mrc0_2\]\[mrc0_3\]\[mrc0_4\]concat=n=5:v=1:a=0,settb=1\/30,setpts=ceil\(N\/1-0\.000001\),fps=30,fps=30,tpad=stop_mode=clone:stop=2,trim=end_frame=150,format=gray\[mf0\]/);
  });
  it("a mirrored clip's matte is mirrored like its picture", () => {
    const s = run(base(), { op: "set_flip", clipId: "a", flip: "h" } as Op, { op: "remove_background", clipId: "a" } as Op).snap;
    expect(graph(s).g).toMatch(/hflip,fps=30,scale=960:540:force_original_aspect_ratio=increase,crop=960:540:\(iw-ow\)\/2:\(ih-oh\)\*0\.4,setsar=1,format=gray\[mf0\]/);
  });
  it("text behind the person over a reversed clip: the person is drawn there now", () => {
    let s = run(base(), { op: "set_speed", clipId: "a", reverse: true } as Op).snap;
    s = run(s, { op: "add_text", text: "BIG", start: 1, end: 3, edit: true, behind: true } as Op).snap;
    const p = plan(s);
    expect(p.person?.left.some((x) => x.why === "reversed")).toBe(false);
    expect(Object.keys(p.person?.parts ?? {})).toContain("0");
  });
});
