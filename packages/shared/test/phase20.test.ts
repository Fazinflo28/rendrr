// Premiere parity, phase 20: Iris Box, Iris Cross, Venetian Blinds, Checker Wipe and Wedge Wipe, and GIFs up to ten
// minutes. The op (types, the blinds' direction kept), the render's xfade expressions, the player's shapes, the
// checker's SVG mask, and the GIF rules (gifSpec).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, checkerMask, gifSpec, TRANSITIONS, transitionAt, wipeCovers, xfadeOf, type EditContext, type Op, type Snapshot } from "../src/index";

const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 20, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], 20, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 7, end: 11, label: "" }] } as Op, ctx).snap;

describe("shape wipes", () => {
  it("are transitions; the blinds keep their direction", () => {
    for (const t of ["box", "cross", "blinds", "checker", "wedge"]) expect(TRANSITIONS).toContain(t);
    const r = applyOp(base(), { op: "set_transition", clipId: "b", type: "blinds", dir: "left", duration: 0.8 } as Op, ctx);
    expect((r.snap.timeline.tracks.v1 as { id: string; transition?: unknown }[]).find((c) => c.id === "b")!.transition).toEqual({ type: "blinds", duration: 0.8, dir: "left" });
    const box = applyOp(base(), { op: "set_transition", clipId: "b", type: "box", dir: "left", duration: 0.8 } as Op, ctx);
    expect((box.snap.timeline.tracks.v1 as { id: string; transition?: unknown }[]).find((c) => c.id === "b")!.transition).toEqual({ type: "box", duration: 0.8 });
  });
  it("the render's expressions", () => {
    expect(xfadeOf("box")).toBe("custom:expr='if(lt(max(abs(X/W-0.5),abs(Y/H-0.5)),(1-P)/2),B,A)'");
    expect(xfadeOf("blinds")).toContain("mod(Y*8/H,1)");
    expect(xfadeOf("blinds", "right")).toContain("mod(X*8/W,1)");
    expect(xfadeOf("checker")).toContain("floor(X*8/W)+floor(Y*6/H)");
    expect(xfadeOf("wedge")).toContain("abs(atan2(X-W/2,H/2-Y))");
    expect(xfadeOf("wipe")).toBe("wipeleft");
  });
  it("the player's shapes: box and cross as clip paths, the rest as masks; at the start nothing of B, at the end all of it", () => {
    expect(transitionAt({ type: "box" }, 0.5, 960, 540).clip).toBe("inset(25% 25% 25% 25%)");
    expect(transitionAt({ type: "cross" }, 0.5, 960, 540).clip).toMatch(/^polygon\(25% 0%, 75% 0%, 75% 25%, 100% 25%, 100% 75%/);
    expect(transitionAt({ type: "blinds" }, 0.5, 960, 540).mask).toBe("repeating-linear-gradient(to bottom, #000 0 6.25%, transparent 6.25% 12.5%)");
    expect(transitionAt({ type: "wedge" }, 0.25, 960, 540).mask).toBe("conic-gradient(from -45deg at 50% 50%, #000 0 90deg, transparent 0)");
    expect(decodeURIComponent(checkerMask(0.25))).toMatch(/<rect x='0' y='0' width='0.5' height='1'\/>/);
    expect(decodeURIComponent(checkerMask(0.25))).not.toMatch(/<rect x='1' y='0'/);
    for (const t of ["box", "cross", "blinds", "checker", "wedge"] as const) {
      expect(wipeCovers(t, 0.001, 480, 270, 960, 540) && t !== "box" && t !== "cross" && t !== "wedge" && t !== "blinds" && t !== "checker").toBe(false);
      expect([[10, 10], [950, 530], [480, 270], [100, 500]].every(([x, y]) => wipeCovers(t, 1, x, y, 960, 540))).toBe(true);
    }
  });
});

describe("GIFs up to ten minutes", () => {
  it("fewer frames and smaller as they get longer", () => {
    expect(gifSpec(30, 1920, 1080)).toEqual({ fps: 15, width: 640 });
    expect(gifSpec(60, 1080, 1920)).toEqual({ fps: 15, width: 480 });
    expect(gifSpec(120, 1920, 1080)).toEqual({ fps: 10, width: 480 });
    expect(gifSpec(400, 1080, 1920)).toEqual({ fps: 6, width: 270 });
  });
});
