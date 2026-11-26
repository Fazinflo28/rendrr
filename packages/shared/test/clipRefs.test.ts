import { describe, expect, it } from "vitest";
import { clipRef, clipRefParts, clipRefs, clipRefsPlain, mentionAt } from "../src";

describe("clip references in comments", () => {
  it("puts the clip's id in the text and reads it back", () => {
    const t = `Use ${clipRef("Gym squat (wide).mp4", "cmabc123")} here, then ${clipRef("Knee [close]", "cmdef456")}`;
    expect(t).toContain("@[Gym squat wide .mp4](clip:cmabc123)");
    expect(clipRefs(t)).toEqual([{ name: "Gym squat wide .mp4", id: "cmabc123" }, { name: "Knee close", id: "cmdef456" }]);
    expect(clipRefsPlain(t)).toBe('Use @"Gym squat wide .mp4" here, then @"Knee close"');
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
});
