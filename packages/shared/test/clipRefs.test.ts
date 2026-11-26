import { describe, expect, it } from "vitest";
import { clipLabel, clipRef, clipRefParts, clipRefs, clipRefsPlain, decodeClipPicks, encodeClipPicks, mentionAt } from "../src";

describe("clip references in comments", () => {
  it("puts the clip's id in the text and reads it back", () => {
    const t = `Use ${clipRef("Gym squat (wide).mp4", "cmabc123")} here, then ${clipRef("Knee [close]", "cmdef456")}`;
    expect(t).toContain("@[Gym squat wide .mp4](clip:cmabc123)");
    expect(clipRefs(t)).toEqual([{ name: "Gym squat wide .mp4", id: "cmabc123" }, { name: "Knee close", id: "cmdef456" }]);
    expect(clipRefsPlain(t)).toBe('Use @"Gym squat wide" here, then @"Knee close"');
  });
  it("names each clip once and splits the text for chips", () => {
    const t = `${clipRef("A", "id1")} and ${clipRef("A", "id1")}!`;
    expect(clipRefs(t)).toHaveLength(1);
    expect(clipRefParts(t)).toEqual([{ name: "A", id: "id1" }, " and ", { name: "A", id: "id1" }, "!"]);
    expect(clipRefParts("plain")).toEqual(["plain"]);
    expect(clipRefs(null)).toEqual([]);
  });
  it("finds the @ being typed, not an email address", () => {
    expect(mentionAt("add @", 5)).toEqual({ start: 4, query: "" });
    expect(mentionAt("add @gym sq", 11)).toEqual({ start: 4, query: "gym sq" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail me@x.com", 13)).toBeNull();
    expect(mentionAt("done @[A](clip:id1) ", 20)).toBeNull();
    expect(mentionAt("add @gym  then", 14)).toBeNull();
  });
  it("shows a short clean name in the box and sends the clip's id", () => {
    expect(clipLabel("3d-animated-human-skeleton-running-with-glowing-x-2026-01-28-03-35-04-utc")).toBe("3d animated human skeleton running with");
    expect(clipLabel("knee_close_2.MOV")).toBe("knee close 2");
    const picks = [{ label: "Gym squat", id: "v1", name: "Gym squat.mp4" }, { label: "Gym squat wide", id: "v2", name: "Gym squat wide.mp4" }];
    const enc = encodeClipPicks("use @Gym squat wide then @Gym squat, ok", picks);
    expect(enc).toBe("use @[Gym squat wide.mp4](clip:v2) then @[Gym squat.mp4](clip:v1), ok");
    const dec = decodeClipPicks(enc);
    expect(dec.text).toBe("use @Gym squat wide then @Gym squat, ok");
    expect(encodeClipPicks(dec.text, dec.picks)).toBe(enc);
  });
});
