import { describe, expect, it } from "vitest";
import { ASSET_SECTIONS, elementKeys, isAssetSection, isAssetType, TRASH_DAYS, trashCutoff, trashDaysLeft, videoSection } from "../src/assets";

describe("the Assets page", () => {
  it("has the sections in the side bar's order", () => {
    expect(ASSET_SECTIONS.map((s) => s.id)).toEqual(["all", "videos", "images", "elements", "audio", "favorites", "trash"]);
    expect(isAssetSection("elements")).toBe(true); expect(isAssetSection("library")).toBe(false);
    expect(isAssetType("audio")).toBe(true); expect(isAssetType("graphic")).toBe(false);
    expect(videoSection({ still: true })).toBe("images"); expect(videoSection({ still: false })).toBe("videos");
  });

  it("counts the days left in the Trash", () => {
    const now = Date.UTC(2026, 10, 10, 12);
    expect(trashDaysLeft(now, now)).toBe(TRASH_DAYS);
    expect(trashDaysLeft(now - 29.5 * 86_400_000, now)).toBe(1);
    expect(trashDaysLeft(now - 31 * 86_400_000, now)).toBe(0);
    expect(trashCutoff(now).getTime()).toBe(now - TRASH_DAYS * 86_400_000);
  });

  it("puts an element in a corner at about a fifth of the frame", () => {
    const [k] = elementKeys({ width: 400, height: 200 }, { width: 1920, height: 1080 }, "top-right");
    // As large as it fits: 1920 wide; a fifth of the longer side (0.18 x 1920 = 345.6) -> scale 0.18.
    expect(k.scale).toBeCloseTo(0.18, 3);
    expect(k.x!).toBeGreaterThan(0.35); expect(k.x!).toBeLessThan(0.5);
    expect(k.y!).toBeLessThan(-0.35); expect(k.y!).toBeGreaterThan(-0.5);
    const [bl] = elementKeys({ width: 400, height: 200 }, { width: 1080, height: 1920 }, "bottom-left");
    expect(bl.x!).toBeLessThan(0); expect(bl.y!).toBeGreaterThan(0);
    // A tall logo on a wide frame: kept inside the frame.
    const [tall] = elementKeys({ width: 200, height: 800 }, { width: 1920, height: 1080 });
    const fh = 1080 * tall.scale!; expect(fh).toBeLessThanOrEqual(0.18 * 1920 + 1);
    expect(elementKeys({ width: 10, height: 10 }, { width: 1920, height: 1080 }, "center")[0]).toMatchObject({ x: 0, y: 0 });
  });
});
