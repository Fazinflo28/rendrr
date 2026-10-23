// What the editor's live player shows at a moment of the edit, read from the same plan the renderer uses
// (planRender), so the player and the rendered file agree: which footage moment plays, the caption on screen,
// the zoom, the b-roll and graphics on top, and whether the dialogue is muted. Times are edit seconds.
import type { Range } from "./sequence";
import type { RenderPlan, ZoomOp } from "./renderPlan";

/** The zoom at edit time t: the same curve as zoomExpr() draws in the render (punch ramps, slow push). */
export function zoomAt(zooms: ZoomOp[], t: number): number {
  let sum = 0;
  for (const z of zooms) {
    if (t < z.start || t > z.end) continue;
    const s = z.scale - 1;
    if (z.mode === "push") sum += (s * (t - z.start)) / Math.max(0.1, z.end - z.start);
    else {
      const ramp = Math.min(0.12, (z.end - z.start) / 3);
      sum += s * Math.min(1, (t - z.start) / ramp) * Math.min(1, (z.end - t) / ramp);
    }
  }
  return Math.min(2, 1 + sum);
}

/** Edit time <-> footage time over the kept parts, with the part index (the player jumps from part to part). */
export function keptClock(kept: Range[]) {
  const offsets: number[] = [];
  let acc = 0;
  for (const k of kept) { offsets.push(acc); acc += k.end - k.start; }
  const total = acc;
  /** The part that plays at edit time t (the last part at the very end). */
  const partAt = (t: number) => {
    for (let i = 0; i < kept.length; i++) if (t < offsets[i] + (kept[i].end - kept[i].start)) return i;
    return kept.length - 1;
  };
  const toSource = (t: number) => { if (!kept.length) return 0; const i = partAt(Math.max(0, t)); return Math.min(kept[i].end, kept[i].start + Math.max(0, t - offsets[i])); };
  const toOutput = (src: number, i = -1) => {
    if (i >= 0 && i < kept.length) return offsets[i] + Math.min(kept[i].end - kept[i].start, Math.max(0, src - kept[i].start));
    for (let k = 0; k < kept.length; k++) { if (src < kept[k].start) return offsets[k]; if (src <= kept[k].end) return offsets[k] + (src - kept[k].start); }
    return total;
  };
  return { kept, offsets, total, partAt, toSource, toOutput };
}

export type LiveFrame = {
  src: number;                 // the footage moment that plays (seconds in the original)
  caption: string | null;
  zoom: number;
  muted: boolean;              // no A1 dialogue under this part of the picture
  broll: { clipId: string; videoId: string; src: number } | null;
  graphics: { clipId: string; graphicId: string; t: number; start: number; end: number }[];
};

const inside = (t: number, r: { start: number; end: number }) => t >= r.start && t < r.end;

export function liveFrame(plan: RenderPlan, t: number, clock = keptClock(plan.kept)): LiveFrame {
  const cap = plan.captions.find((c) => inside(t, c));
  // The last b-roll overlay drawn wins, as in the render (each one is laid over the ones before).
  const br = [...plan.broll].reverse().find((b) => inside(t, b) && b.videoId);
  return {
    src: clock.toSource(t),
    caption: cap ? cap.text : null,
    zoom: zoomAt(plan.zooms, t),
    muted: plan.dialogueMutes.some((m) => inside(t, m)),
    broll: br ? { clipId: br.clipId, videoId: br.videoId!, src: br.sourceStart + (t - br.start) } : null,
    graphics: plan.graphics.filter((g) => inside(t, g) && g.graphicId).map((g) => ({ clipId: g.clipId, graphicId: g.graphicId!, t: t - g.start, start: g.start, end: g.end })),
  };
}
