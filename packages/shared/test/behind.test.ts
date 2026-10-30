// Phase 2 (Premiere parity): text layers and graphics behind the person. The op (behind on add_text, set_text,
// add_graphic; behind_person for layers already there; captions refused), get_project's lines, the plan (the person's
// matte for the parts under the layers, not over b-roll; a framed clip says why it is left in front), the behind text
// in its own subtitle pass, and the FFmpeg graph's order: behind graphics, behind text, the person, then the rest.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, clipsUnderBehind, customParamsSchema, graphicDefaults, matteAllowanceMs, summarizeTimeline, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = {
  videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined,
  getVideo: (id) => (id === "br" ? { id, name: "bg.mp4", seconds: 20, ready: true } : undefined),
  getGraphic: (id) => (id === "gc" ? { id, name: "Card", durationSec: 20, custom: true, params: graphicDefaults(customParamsSchema({ n: 1 })) } : undefined),
} as EditContext;
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" },
  { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 10, label: "" }, { id: "b", start: 12, end: 25, label: "" }] }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const v3 = (s: Snapshot) => s.timeline.tracks.v3 as { id: string; kind?: string; behind?: boolean }[];
const source = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", brollSeconds: { br: 20 } });

describe("the op", () => {
  it("add_text and add_graphic take behind; the result says what it means", () => {
    const t = edit(base(), { op: "add_text", text: "BIG", start: 1, end: 4, behind: true } as Op);
    expect(v3(t.snap).find((c) => c.kind === "text")!.behind).toBe(true);
    expect(t.summary).toMatch(/the person is drawn over it from an AI matte/);
    const g = edit(t.snap, { op: "add_graphic", graphicId: "gc", start: 2, end: 5, behind: true } as Op);
    expect(v3(g.snap).find((c) => c.kind === "graphic")!.behind).toBe(true);
  });
  it("behind_person puts layers already there behind, off brings them back; captions are refused; set_text behind false", () => {
    let s = edit(base(), { op: "add_text", text: "One", start: 1, end: 3 } as Op).snap;
    s = edit(s, { op: "add_graphic", graphicId: "gc", start: 2, end: 4 } as Op).snap;
    const layers = (x: Snapshot) => v3(x).filter((c) => c.kind === "text" || c.kind === "graphic");
    const ids = layers(s).map((c) => c.id);
    const on = edit(s, { op: "behind_person", clipIds: ids } as Op);
    expect(layers(on.snap).every((c) => c.behind)).toBe(true);
    expect(on.summary).toMatch(/^behind the person: text "One" \(\w+\), graphic Card \(\w+\)/);
    const off = edit(on.snap, { op: "behind_person", clipIds: [ids[1]], off: true } as Op);
    expect(layers(off.snap).map((c) => !!c.behind)).toEqual([true, false]);
    expect(off.summary).toMatch(/in front of the person again/);
    expect(layers(edit(on.snap, { op: "set_text", clipId: ids[0], behind: false } as Op).snap)[0].behind).toBeUndefined();
    expect(() => edit(s, { op: "behind_person", clipIds: ["nope"] } as Op)).toThrow(/no clip "nope" on V3/);
    // Captions are one caption system over everything: they cannot go behind.
    const cap = v3(s).find((c) => c.kind === "caption");
    if (cap) expect(() => edit(s, { op: "behind_person", clipIds: [cap.id] } as Op)).toThrow(/is a caption/);
  });
  it("get_project shows it", () => {
    const s = edit(base(), { op: "add_text", text: "Hi", start: 1, end: 3, behind: true } as Op).snap;
    expect(summarizeTimeline(s, tr)).toMatch(/text="Hi" .*behind the person/);
  });
});

describe("the plan", () => {
  const snap = () => {
    let s = edit(base(), { op: "add_text", text: "TITLE", start: 1, end: 4, behind: true, card: { color: "#0000FF", opacity: 1 } } as Op).snap;
    s = edit(s, { op: "add_graphic", graphicId: "gc", start: 13, end: 16, behind: true } as Op).snap;
    return edit(s, { op: "add_text", text: "front", start: 2, end: 3 } as Op).snap;
  };
  it("names the matte of the parts under the layers, keeps behind text in its own pass, and says so", () => {
    const p = plan(snap());
    expect(p.person!.windows.length).toBeGreaterThan(0);
    // Both clips have a layer over them: each part reads a matte, and the plan lists them for the worker.
    expect(Object.keys(p.person!.parts).length).toBe(p.parts.length);
    for (const name of Object.values(p.person!.parts)) expect(p.mattes![name]).toBeTruthy();
    expect(p.assBehind).toMatch(/TITLE/);
    expect(p.assBehind).not.toMatch(/front/);
    expect(p.ass).toMatch(/front/);
    expect(p.ass).not.toMatch(/TITLE/);
    expect(p.operations.join("\n")).toMatch(/Behind the person: 1 graphics, 1 text layers \(the person laid back over them from an AI matte, 0:01-0:04/);
  });
  it("not over b-roll; a clip framed smaller is left in front and named", () => {
    let s = snap();
    s = edit(s, { op: "add_broll", videoId: "br", start: 2, end: 3, sourceStart: 0 } as Op).snap;
    s = edit(s, { op: "set_framing", clipIds: ["b"], scale: 0.6 } as Op).snap;
    const p = plan(s);
    // 1-4 minus the b-roll at 2-3.
    expect(p.person!.windows.filter((w) => w.end <= 5).map((w) => [w.start, w.end])).toEqual([[1, 2], [3, 4]]);
    expect(p.person!.left).toEqual([{ clipId: "b", why: "framed smaller or moved" }]);
    expect(p.operations.join("\n")).toMatch(/in front instead on b \(framed smaller or moved\)/);
  });
  it("clipsUnderBehind finds the V1 clips under the layers (for making their mattes ahead); the render's time allows for them", () => {
    const s = edit(base(), { op: "add_text", text: "T", start: 14, end: 16, behind: true } as Op).snap;
    expect(Array.from(clipsUnderBehind(s.timeline, tr.flatMap((l) => l.words)))).toEqual(["b"]);
    expect(matteAllowanceMs(s.timeline)).toBeGreaterThan(0);
    expect(matteAllowanceMs(base().timeline)).toBe(0);
  });
});

describe("the FFmpeg graph", () => {
  it("behind graphics, behind text, the person (matte joined over the edit), then the front layers and captions", () => {
    const s = edit(edit(base(), { op: "add_graphic", graphicId: "gc", start: 1, end: 4, behind: true } as Op).snap, { op: "add_text", text: "TITLE", start: 1, end: 4, behind: true } as Op).snap;
    const s2 = edit(edit(s, { op: "add_graphic", graphicId: "gc", start: 13, end: 16 } as Op).snap, { op: "add_text", text: "front", start: 2, end: 3 } as Op).snap;
    const p = plan(s2);
    const gs = Object.fromEntries(p.graphics.map((g) => [g.clipId, `/g-${g.clipId}.webm`]));
    const files: PlanFiles = { source: "/in.mp4", output: "/out.mp4", graphics: gs, assPath: "/c.ass", assBehindPath: "/b.ass", mattes: Object.fromEntries(Object.keys(p.mattes!).map((n) => [n, `/${n}.txt`])) };
    const { filterGraph: fg } = ffmpegArgs(p, files, source, { loudnessGainDb: 0 });
    // The person's matte per part, joined like the picture.
    expect(fg).toMatch(/\[mp0\]\[mp1\]concat=n=2:v=1:a=0,settb=1\/30\[pmatte\]/);
    // Split off the picture before b-roll and graphics, the matte as its alpha.
    expect(fg).toMatch(/split\[vbase\]\[vpsrc\]/);
    expect(fg).toMatch(/\[vpsrc\]\[pmatte\]alphamerge\[vperson\]/);
    const behindG = p.graphics.find((g) => g.behind)!, frontG = p.graphics.find((g) => !g.behind)!;
    const at = (re: RegExp) => fg.search(re);
    const order = [at(new RegExp(`\\[gr${p.graphics.indexOf(behindG)}\\]overlay`)), at(/ass=filename='?\/b\.ass/), at(/\[vperson\]overlay=enable=/), at(new RegExp(`\\[gr${p.graphics.indexOf(frontG)}\\]overlay`)), at(/ass=filename='?\/c\.ass/)];
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Laid back only while the layers are on screen.
    expect(fg).toMatch(/\[vperson\]overlay=enable='between\(t,1(\.0+)?,3\.98/);
    // Not the one-look shortcut.
    expect(fg).not.toMatch(/\[vfit\]/);
  });
  it("without layers behind the person, nothing of it is in the graph", () => {
    const p = plan(edit(base(), { op: "add_text", text: "front", start: 2, end: 3 } as Op).snap);
    expect(p.person).toBeUndefined();
    expect(p.assBehind).toBeUndefined();
    const fg = ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", assPath: "/c.ass" }, source, { loudnessGainDb: 0 }).filterGraph;
    expect(fg).not.toMatch(/pmatte|vperson/);
  });
});

// Unused import guard (SeqClip is the V1 clip type the plan reads).
export type _V1 = SeqClip;
