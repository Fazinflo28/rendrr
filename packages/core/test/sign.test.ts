// Signed links to stored files stay the same within a time slot (so a list refreshed every few seconds keeps the
// pictures the browser has), change in the next slot, and are always good for at least the life asked for.
import { describe, expect, it } from "vitest";

process.env.S3_BUCKET ||= "test-bucket"; process.env.S3_REGION ||= "auto"; process.env.S3_ENDPOINT ||= "https://storage.example.com";
process.env.S3_ACCESS_KEY_ID ||= "test-key"; process.env.S3_SECRET_ACCESS_KEY ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://test@localhost:5432/test"; process.env.REDIS_URL ||= "redis://localhost:6379";

describe("signGet", () => {
  it("the same link within a slot, a new one in the next; always good for the life asked for", async () => {
    const { signGet, signSlot } = await import("../src/storage");
    const t0 = Date.UTC(2026, 10, 4, 14, 0, 10);
    const a = await signGet("thumbs/u/v.jpg", 3600, { now: t0 }), b = await signGet("thumbs/u/v.jpg", 3600, { now: t0 + 600_000 });
    expect(b).toBe(a);
    expect(await signGet("thumbs/u/w.jpg", 3600, { now: t0 })).not.toBe(a);
    expect(signSlot(3600)).toBe(900); expect(signSlot(600)).toBe(150); expect(signSlot(6 * 3600)).toBe(3600); expect(signSlot(60)).toBe(60);
    const c = await signGet("thumbs/u/v.jpg", 3600, { now: t0 + 900_000 });
    expect(c).not.toBe(a);
    // Good for at least the life asked for, from any moment in the slot.
    for (const [life, at] of [[3600, t0 + 899_000], [600, t0 + 149_000], [6 * 3600, t0 + 3_599_000]] as const) {
      const u = new URL(await signGet("x.mp4", life, { now: at }));
      const d = u.searchParams.get("X-Amz-Date")!, start = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));
      const until = start + Number(u.searchParams.get("X-Amz-Expires")) * 1000;
      expect(start).toBeLessThanOrEqual(at);
      expect(until - at).toBeGreaterThanOrEqual(life * 1000);
      expect(until - at).toBeLessThanOrEqual((life + signSlot(life)) * 1000);
    }
  });
});
