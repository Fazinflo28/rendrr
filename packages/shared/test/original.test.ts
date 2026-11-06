// Is a file the original of local footage? Name and size, else the same length (a renamed or re-saved copy).
import { describe, expect, it } from "vitest";
import { lengthTolerance, notOriginalMessage, sameFileName, sameOriginal } from "../src/original";

const want = { originalName: "Ranking cold outreaching methods-compressed.mp4", originalSize: 1_482_000_000, seconds: 658.7 };

describe("sameOriginal", () => {
  it("the same name and size is the original", () => {
    expect(sameOriginal({ name: want.originalName, size: want.originalSize }, want)).toEqual({ ok: true, by: "name" });
  });
  it("names compare as people see them (case, Unicode form, a no-break space)", () => {
    expect(sameFileName("Ranking cold outreaching methods-compressed.MP4", want.originalName)).toBe(true);
    expect(sameFileName("Résumé.mp4", "Résumé.mp4")).toBe(true);
    expect(sameFileName("other.mp4", want.originalName)).toBe(false);
  });
  it("a renamed or re-saved copy of the same length is the original", () => {
    expect(sameOriginal({ name: "Ranking cold outreaching methods.mp4", size: 6_100_000_000, seconds: 658.68 }, want)).toEqual({ ok: true, by: "length" });
    expect(sameOriginal({ name: want.originalName, size: 1_481_999_000, seconds: 658.9 }, want).ok).toBe(true);
  });
  it("a different size and no length, or another length, is not", () => {
    expect(sameOriginal({ name: want.originalName, size: 1_481_999_000 }, want).ok).toBe(false);
    expect(sameOriginal({ name: "other.mp4", size: 9_000_000, seconds: 31 }, want).ok).toBe(false);
    expect(sameOriginal({ name: want.originalName, size: 1, seconds: 658.7 + lengthTolerance(658.7) + 0.1 }, want).ok).toBe(false);
  });
  it("the message says what was picked next to what is needed", () => {
    const m = notOriginalMessage({ name: "other.mp4", size: 9_000_000, seconds: 31 }, want);
    expect(m).toBe("That is a different video. You picked 'other.mp4' (9 MB, 0:31.0); we need 'Ranking cold outreaching methods-compressed.mp4' (1482 MB, 10:58.7).");
  });
});
