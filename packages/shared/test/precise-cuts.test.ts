// Cuts to the millisecond: the sound is cut exactly where the edit says; the picture goes on the nearest frame and
// shows the footage frame its sound is playing, never more than half a frame off, however many cuts.
import { describe, expect, it } from "vitest";
import { applyOp, buildRawTimeline, sequenceView, STYLES, stubTranscript, type EditContext, type EditOp, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender } from "../src/renderPlan";

const tr = stubTranscript(30);
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: (id) => STYLES.find((s) => s.id === id) };
const raw = (): Snapshot => ({ timeline: buildRawTimeline(tr, 30, [], "v"), name: "t", aspect: "16:9", styleId: null });
const edit = (s: Snapshot, ...ops: EditOp[]) => applyOp(s, { op: "batch", ops }, ctx).snap;
const FPS = 30;
const plan = (s: Snapshot, fps = 30) => planRender({ kind: fps === 30 ? "preview" : "final", snapshot: s, transcript: tr, source: { width: 1920, height: 1080, fps, seconds: 30, hasAudio: true }, videoId: "v" });
const soundAt = (p: ReturnType<typeof plan>, t: number) => { const s = p.sound.find((x) => t >= x.start - 1e-9 && t < x.end - 1e-9)!; return s.srcIn + (t - s.start); };

describe("cuts to the millisecond", () => {
  it("a cut keeps its millisecond times and the sound is cut exactly there", () => {
    const s = edit(raw(), { op: "cut_words", from: 5.1234, to: 5.4567 });
    const p = plan(s);
    const at = p.sound.findIndex((x) => Math.abs(x.srcOut - 5.123) < 1e-9);
    expect(at).toBeGreaterThanOrEqual(0); // the sound before the cut ends at 5.123
    expect(p.sound[at + 1].srcIn).toBeCloseTo(5.457, 9); // and the next starts at 5.457
    expect(p.sound[at + 1].start).toBeCloseTo(p.sound[at].end, 9); // back to back
    const g = ffmpegArgs(p, { source: "/m.mp4", output: "/o.mp4" }, { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true }, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toMatch(/atrim=start=0\.000000:end=5\.123000/);
    expect(g).toMatch(/atrim=start=5\.457000:end=/);
  });

  it("1 ms can be taken out, and it is", () => {
    const before = plan(raw());
    const s = edit(raw(), { op: "cut_words", from: 12.3, to: 12.301 });
    const p = plan(s);
    const cut = p.sound.find((x) => Math.abs(x.srcIn - 12.301) < 1e-9);
    expect(cut).toBeTruthy();
    expect(p.sound.reduce((a, x) => a + (x.end - x.start), 0)).toBeCloseTo(before.sound.reduce((a, x) => a + (x.end - x.start), 0) - 0.001, 6);
  });

  for (const fps of [30, 25, 24000 / 1001]) {
    it(`picture within half a frame of its sound at every cut, no drift over 60 cuts (${fps.toFixed(3)} fps)`, () => {
      // 60 cuts at millisecond times on no grid.
      let s = raw(), seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const cuts: [number, number][] = [];
      for (let i = 0; i < 60; i++) { const a = Math.round((0.5 + i * 0.48 + rnd() * 0.2) * 1000) / 1000; cuts.push([a, Math.round((a + 0.05 + rnd() * 0.15) * 1000) / 1000]); }
      for (const [a, b] of [...cuts].reverse()) s = edit(s, { op: "cut_words", from: a, to: b });
      const p = plan(s, fps);
      const F = 1 / p.fps;
      // The exact edit (no frames): where each part starts and which footage it plays, to the millisecond.
      const exact = sequenceView(s.timeline, words, { seconds: { v: 30 } });
      expect(Math.abs(p.outputSeconds - exact.total)).toBeLessThanOrEqual(F / 2 + 0.0005); // whole frames, no drift
      expect(Math.abs(p.outputSeconds - Math.round(p.outputSeconds * p.fps) / p.fps)).toBeLessThanOrEqual(0.0005);
      // The sound is the exact edit.
      const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
      // (the last part stops at the footage's last whole frame, which at 23.976 fps is 29.988 s, not 30 s)
      expect(p.sound.slice(0, -1).map((x) => [x.srcIn, x.srcOut, x.start].map(r6))).toEqual(exact.sound.slice(0, -1).map((x) => [x.srcIn, x.srcOut, x.start].map(r6)));
      let frames = 0;
      for (const part of p.parts) {
        expect(Math.abs(part.start * p.fps - Math.round(part.start * p.fps))).toBeLessThan(0.0005 * p.fps + 1e-6); // on a frame (times shown to the ms)
        const e = exact.picture.find((x) => x.videoId === part.videoId && x.srcIn <= part.srcIn + 2 * F && x.srcOut >= part.srcOut - 2 * F && Math.abs(x.start - part.start) <= F)!;
        expect(Math.abs(part.start - e.start)).toBeLessThanOrEqual(F / 2 + 0.0005 + 1e-6); // the cut is within half a frame
        // Every frame shows the footage frame its sound plays at that moment (the frame that covers it).
        const n = Math.round((part.end - part.start) * p.fps);
        for (let j = 0; j < n; j++) {
          const t = part.start + j * F;
          const off = e.srcIn + (t - e.start) - (part.srcIn + (t - part.start));
          expect(off).toBeGreaterThanOrEqual(-0.001);
          expect(off).toBeLessThan(F + 0.001);
          frames++;
        }
      }
      expect(frames).toBe(Math.round(p.outputSeconds * p.fps));
    });
  }

  it("cut_silences keep 0 takes every pause out and leaves every word; the default leaves 80 ms", () => {
    const tight = edit(raw(), { op: "cut_silences", overSeconds: 0.001, keep: 0 });
    const v = sequenceView(tight.timeline, words);
    const heard = (w: { t: number; end: number }) => v.pieces.some((x) => x.srcIn <= w.t + 1e-6 && x.srcOut >= w.end - 1e-6);
    expect(words.every(heard)).toBe(true); // short words are not lost
    const talk = words.reduce((a, w) => a + (w.end - w.t), 0);
    expect(v.total).toBeCloseTo(talk, 2); // nothing but speech is left
    const loose = sequenceView(edit(raw(), { op: "cut_silences", overSeconds: 0.001 }).timeline, words);
    expect(loose.total).toBeGreaterThan(v.total + 0.1); // 80 ms each side of each pause stays
  });

  it("the sound and the picture of the file end together", () => {
    const s = edit(raw(), { op: "cut_words", from: 29.4567, to: 30 });
    const p = plan(s);
    const g = ffmpegArgs(p, { source: "/m.mp4", output: "/o.mp4" }, { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true }, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toContain(`apad=whole_dur=${p.outputSeconds.toFixed(6)},atrim=end=${p.outputSeconds.toFixed(6)}[acat]`);
  });
});
