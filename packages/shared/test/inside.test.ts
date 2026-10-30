// Phase 2b (Premiere parity): video inside text (a track matte) and text cut out of its card. The op (inside, cutout on
// add_text and set_text; a library video only; not both; a cut-out needs a card), get_project's line, the plan (each
// such layer drawn from its own mask, left out of the plain subtitle passes; a video not in the library leaves plain
// letters and says so), the masks' ASS, and the FFmpeg graph's order on each side of the person.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, customParamsSchema, graphicDefaults, summarizeTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = {
  videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined,
  getVideo: (id) => (id === "br" ? { id, name: "waves.mp4", seconds: 6, ready: true } : id === "slow" ? { id, name: "slow.mp4", seconds: 9, ready: false } : undefined),
  getGraphic: (id) => (id === "gc" ? { id, name: "Card", durationSec: 20, custom: true, params: graphicDefaults(customParamsSchema({ n: 1 })) } : undefined),
} as EditContext;
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" },
  { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
type T = { id: string; kind?: string; card?: { color: string } | null; inside?: { videoId: string; from: number }; cutout?: boolean };
const textsOf = (s: Snapshot) => (s.timeline.tracks.v3 as T[]).filter((c) => c.kind === "text");
const source = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };
const plan = (s: Snapshot, brollSeconds: Record<string, number> = { br: 6 }) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", brollSeconds });
const big = { font: "Anton", size: 25 };

describe("the op", () => {
  it("add_text inside: the video in the letters; the result says so; set_text inside null takes it out", () => {
    const r = edit(base(), { op: "add_text", text: "WAVES", start: 1, end: 4, inside: { videoId: "br", from: 2 }, ...big } as Op);
    expect(textsOf(r.snap)[0].inside).toEqual({ videoId: "br", from: 2 });
    expect(r.summary).toMatch(/waves\.mp4 plays inside the letters from 2s \(looped when shorter than the text\)/);
    const id = textsOf(r.snap)[0].id;
    const off = edit(r.snap, { op: "set_text", clipId: id, inside: null } as Op);
    expect(textsOf(off.snap)[0].inside).toBeUndefined();
    expect(off.summary).toMatch(/no video inside the letters/);
    // A later set_text that does not name it keeps it.
    expect(textsOf(edit(r.snap, { op: "set_text", clipId: id, color: "#FF0000" } as Op).snap)[0].inside).toEqual({ videoId: "br", from: 2 });
  });
  it("a library video only, ready, from inside it; not both inside and cutout", () => {
    const add = (x: object) => () => edit(base(), { op: "add_text", text: "X", start: 1, end: 4, ...x } as Op);
    expect(add({ inside: { videoId: "nope" } })).toThrow(/not in your library/);
    expect(add({ inside: { videoId: "slow" } })).toThrow(/not ready yet/);
    expect(add({ inside: { videoId: "br", from: 7 } })).toThrow(/only 6\.0s long/);
    expect(add({ inside: { videoId: "br" }, cutout: true })).toThrow(/not both/);
    expect(add({ cutout: true, card: null })).toThrow(/keep a card/);
  });
  it("cutout: cut out of its card (black when it has none); one takes the other's place; a card removed ends it", () => {
    const r = edit(base(), { op: "add_text", text: "SHOT", start: 1, end: 4, cutout: true } as Op);
    const t = textsOf(r.snap)[0];
    expect(t.cutout).toBe(true);
    expect(t.card).toEqual({ color: "#000000", opacity: 1 });
    expect(r.summary).toMatch(/cut out of its card \(#000000\): the picture under it shows through the letters/);
    const swapped = edit(r.snap, { op: "set_text", clipId: t.id, inside: { videoId: "br" } } as Op);
    expect(textsOf(swapped.snap)[0]).toMatchObject({ inside: { videoId: "br", from: 0 } });
    expect(textsOf(swapped.snap)[0].cutout).toBeUndefined();
    const noCard = edit(r.snap, { op: "set_text", clipId: t.id, card: null } as Op);
    expect(textsOf(noCard.snap)[0].cutout).toBeUndefined();
    expect(noCard.summary).toMatch(/no card, so no longer cut out/);
  });
  it("get_project shows both", () => {
    let s = edit(base(), { op: "add_text", text: "In", start: 1, end: 3, inside: { videoId: "br", from: 1 } } as Op).snap;
    s = edit(s, { op: "add_text", text: "Out", start: 4, end: 6, cutout: true, card: { color: "#112233", opacity: 1 } } as Op).snap;
    const out = summarizeTimeline(s, tr);
    expect(out).toMatch(/text="In" .*video br@1 inside the letters/);
    expect(out).toMatch(/text="Out" .*card #112233 cut out of the card/);
  });
});

describe("the plan", () => {
  const snap = () => {
    let s = edit(base(), { op: "add_text", text: "WAVES", start: 1, end: 4, inside: { videoId: "br", from: 4 }, card: { color: "#0000FF", opacity: 1 }, ...big } as Op).snap;
    s = edit(s, { op: "add_text", text: "SHOT", start: 5, end: 7, cutout: true, card: { color: "#FF00FF", opacity: 0.8 }, anim: "fade", ...big } as Op).snap;
    return edit(s, { op: "add_text", text: "plain", start: 2, end: 3 } as Op).snap;
  };
  it("each layer from its own mask, out of the plain pass, said in the operations", () => {
    const p = plan(snap());
    expect(p.textMattes).toHaveLength(2);
    const [inside, cut] = p.textMattes!;
    // 3 s from 4 s into a 6 s video: it loops.
    expect(inside).toMatchObject({ start: 1, end: 4, behind: false, inside: { videoId: "br", from: 4, seconds: 6 } });
    expect(cut).toMatchObject({ start: 5, end: 7, cut: "#FF00FF" });
    expect(p.ass).toMatch(/plain/);
    expect(p.ass).not.toMatch(/WAVES|SHOT/);
    expect(p.operations.join("\n")).toMatch(/Inside the letters: \w+ video br from 4s \(looped\); \w+ cut out of its card #FF00FF \(the picture shows through\)/);
  });
  it("the masks: the letters white from 0 (a video), or the card white with the letters black and whole (a cut-out)", () => {
    const [inside, cut] = plan(snap()).textMattes!;
    // Video inside: one white style, no outline, no card; timed from the layer's start.
    expect(inside.mask).toMatch(/Style: T0,RC Anton 400,[\d.]+,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,/);
    expect(inside.mask).not.toMatch(/\\p1/);
    expect(inside.mask).toMatch(/Dialogue: 1,0:00:00\.00,0:00:03\.00,T0,/);
    // What goes round the letters: the card as it is, the letters clear (primary alpha FF), in edit time.
    expect(inside.decor).toMatch(/Style: T0,RC Anton 400,[\d.]+,&HFFFFFFFF,&HFFFFFFFF,/);
    expect(inside.decor).toMatch(/Dialogue: 0,0:00:01\.00,0:00:04\.00,Card,.*\\1c&HFF0000&/);
    // Cut-out: the card white at its opacity (fading in and out), the letters black with no fade.
    expect(cut.mask).toMatch(/Dialogue: 0,0:00:00\.00,0:00:02\.00,Card,.*\\1c&HFFFFFF&\\1a&H33&\\fad\(250,250\)/);
    expect(cut.mask).toMatch(/Style: T0,RC Anton 400,[\d.]+,&H00000000,&H00000000,/);
    expect(cut.mask).toMatch(/Dialogue: 1,0:00:00\.00,0:00:02\.00,T0,,0,0,0,,\{\\pos\([\d.]+,[\d.]+\)\}SHOT/);
    expect(cut.decor).toBeNull();
  });
  it("plain letters without a card or outline need nothing round them; a video not in the library leaves plain letters", () => {
    const s = edit(base(), { op: "add_text", text: "BARE", start: 1, end: 3, inside: { videoId: "br" }, stroke: null, shadow: null } as Op).snap;
    expect(plan(s).textMattes![0].decor).toBeNull();
    const p = plan(s, {});
    expect(p.textMattes).toBeUndefined();
    expect(p.ass).toMatch(/BARE/);
    expect(p.operations.join("\n")).toMatch(/Inside the letters: \w+: its video is not in the library or not ready: plain letters instead/);
  });
  it("behind the person: drawn on that side, and the person is laid back over it", () => {
    const s = edit(base(), { op: "add_text", text: "BACK", start: 1, end: 4, inside: { videoId: "br" }, behind: true } as Op).snap;
    const p = plan(s);
    expect(p.textMattes![0].behind).toBe(true);
    expect(p.person?.windows.length).toBeGreaterThan(0);
    expect(p.assBehind ?? null).toBeNull();
  });
});

describe("the FFmpeg graph", () => {
  it("behind: graphics, masked text, plain text, the person; in front: graphics, masked text, plain text and captions", () => {
    let s = edit(base(), { op: "add_graphic", graphicId: "gc", start: 1, end: 4, behind: true } as Op).snap;
    s = edit(s, { op: "add_text", text: "BACK", start: 1, end: 4, inside: { videoId: "br", from: 4.5 }, behind: true, card: { color: "#000000", opacity: 0.5 } } as Op).snap;
    s = edit(s, { op: "add_text", text: "back plain", start: 1, end: 4, behind: true } as Op).snap;
    s = edit(s, { op: "add_graphic", graphicId: "gc", start: 5, end: 7 } as Op).snap;
    s = edit(s, { op: "add_text", text: "FRONT", start: 5, end: 7, cutout: true } as Op).snap;
    s = edit(s, { op: "add_text", text: "front plain", start: 5, end: 7 } as Op).snap;
    const p = plan(s);
    const [back, front] = p.textMattes!;
    const files: PlanFiles = {
      source: "/in.mp4", output: "/out.mp4", assPath: "/c.ass", assBehindPath: "/b.ass", fontsDir: "/fonts",
      graphics: Object.fromEntries(p.graphics.map((g) => [g.clipId, `/g-${g.clipId}.webm`])),
      mattes: Object.fromEntries(Object.keys(p.mattes!).map((n) => [n, `/${n}.txt`])),
      textMasks: { [back.clipId]: "/mb.ass", [front.clipId]: "/mf.ass" }, textDecor: { [back.clipId]: "/db.ass" }, insides: { [back.clipId]: "/waves.mp4" },
    };
    const { args, filterGraph: fg } = ffmpegArgs(p, files, source, { loudnessGainDb: 0 });
    // The video looped (1.5 s left of 6 for a 3 s text), cut at 4.5 s after the loop, fitted to the frame, in the letters.
    const at = args.indexOf("/waves.mp4");
    expect(args.slice(at - 3, at + 1)).toEqual(["-stream_loop", "-1", "-i", "/waves.mp4"]);
    expect(fg).toMatch(/\[\d+:v\]trim=start=4\.500,setpts=PTS-STARTPTS,fps=30,scale/);
    // (A preview: 960 x 540.)
    expect(fg).toMatch(/color=c=black:s=960x540:r=30:d=[\d.]+,format=yuv420p,ass=filename='?\/mb\.ass'?:fontsdir='?\/fonts'?,format=gray,trim=end_frame=90\[tm0\]/);
    expect(fg).toMatch(/scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1,trim=end_frame=90,setpts=PTS-STARTPTS,format=yuva420p\[tv0\]/);
    expect(fg).toMatch(/\[tv0\]\[tm0\]alphamerge,setpts=PTS-STARTPTS\+1\.000\/TB\[tl0\]/);
    // The cut-out: the card's colour, the mask as its alpha.
    expect(fg).toMatch(/color=c=0x000000:s=960x540:r=30:d=[\d.]+,trim=end_frame=60,format=yuva420p\[tv1\]/);
    const pos = (re: RegExp) => fg.search(re);
    const gi = (behind: boolean) => p.graphics.findIndex((g) => !!g.behind === behind);
    const order = [
      pos(new RegExp(`\\[gr${gi(true)}\\]overlay`)), pos(/ass=filename='?\/db\.ass/), pos(/\[tl0\]overlay=enable='between\(t,1(\.0+)?,/), pos(/ass=filename='?\/b\.ass/), pos(/\[vperson\]overlay/),
      pos(new RegExp(`\\[gr${gi(false)}\\]overlay`)), pos(/\[tl1\]overlay=enable='between\(t,5(\.0+)?,/), pos(/ass=filename='?\/c\.ass/),
    ];
    expect(order.every((x) => x >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("a video long enough is not looped: read from `from` at once", () => {
    const s = edit(base(), { op: "add_text", text: "LONG", start: 1, end: 3, inside: { videoId: "br", from: 1 } } as Op).snap;
    const p = plan(s), m = p.textMattes![0];
    const { args, filterGraph } = ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", textMasks: { [m.clipId]: "/m.ass" }, insides: { [m.clipId]: "/waves.mp4" } }, source, { loudnessGainDb: 0 });
    const at = args.indexOf("/waves.mp4");
    expect(args.slice(at - 3, at + 1)).toEqual(["-ss", "1.000", "-i", "/waves.mp4"]);
    expect(args).not.toContain("-stream_loop");
    expect(filterGraph).not.toMatch(/:v\]trim=start=[\d.]+,setpts=PTS-STARTPTS,fps/);
  });
  it("without such text, nothing of it is in the graph", () => {
    const p = plan(edit(base(), { op: "add_text", text: "plain", start: 2, end: 3 } as Op).snap);
    expect(p.textMattes).toBeUndefined();
    expect(ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", assPath: "/c.ass" }, source, { loudnessGainDb: 0 }).filterGraph).not.toMatch(/alphamerge|\[tm\d/);
  });
});
