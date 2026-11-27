// An edit whose only V1 clip was set to another video (Recreate puts the talking head over its blank canvas this way):
// the render reads that video's own file, picture and sound, not the canvas the edit was made on.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const ctx = {
  videoId: "canvas", transcript: [], silences: [], sceneCuts: [], duration: 33.6, getStyle: () => undefined, getGraphic: () => undefined,
  getVideo: (id: string) => (id === "talk" ? { id, name: "talk", seconds: 280, ready: true } : undefined),
} as unknown as EditContext;

describe("V1 set to another video over a blank canvas", () => {
  it("reads that video's file for its picture and sound", () => {
    let s: Snapshot = { timeline: buildInitialTimeline([], 33.6, "clean", [], "canvas"), name: "t", aspect: "9:16", styleId: null };
    const id = (s.timeline.tracks.v1 as { id: string }[])[0].id;
    s = applyOp(s, { op: "set_clips", track: "v1", clips: [{ id, videoId: "talk", start: 0, end: 29.3, label: "talking head" }] } as Op, ctx).snap;
    const canvas = { width: 1080, height: 1920, fps: 30, seconds: 33.6, hasAudio: false };
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source: canvas, videoId: "canvas", sources: { talk: { ...canvas, seconds: 280, hasAudio: true } } });
    expect(plan.sources).toEqual(["talk"]);
    const files = { source: "/canvas.mp4", output: "/out.mp4", assPath: "/c.ass", fontsDir: "/fonts", broll: {}, graphics: {}, graphicSeconds: {}, audio: {}, videos: { talk: "/talk.mp4" }, under: {}, looks: {} } as unknown as PlanFiles;
    const { args, filterGraph } = ffmpegArgs(plan, files, canvas, { loudnessGainDb: 0 });
    const inputs = args.filter((_, i) => args[i - 1] === "-i");
    expect(inputs).toContain("/talk.mp4");
    expect(inputs).not.toContain("/canvas.mp4");
    expect(filterGraph).toMatch(/atrim/); // its sound is in the mix, not a silent stand-in
  });
});
