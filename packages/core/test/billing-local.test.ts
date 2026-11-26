// Local-first billing: with LOCAL_RENDERS_FREE on, a render made on the user's own computer bills 0 minutes; a cloud
// render bills as before. Off (the default), nothing changes.
import { describe, expect, it } from "vitest";

process.env.S3_BUCKET ||= "test-bucket"; process.env.S3_REGION ||= "auto"; process.env.S3_ENDPOINT ||= "https://storage.example.com";
process.env.S3_ACCESS_KEY_ID ||= "test-key"; process.env.S3_SECRET_ACCESS_KEY ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://test@localhost:5432/test"; process.env.REDIS_URL ||= "redis://localhost:6379";

describe("billable minutes", () => {
  it("off by default: every render bills as before", async () => {
    const { billableMinutes } = await import("../src/billing");
    delete process.env.LOCAL_RENDERS_FREE;
    expect(billableMinutes({ minutes: 3, multiplier: 2, on: "mac" })).toBe(6);
    expect(billableMinutes({ minutes: 3, on: "cloud" })).toBe(3);
  });
  it("on: the user's computer is free, the cloud is billed", async () => {
    const { billableMinutes } = await import("../src/billing");
    process.env.LOCAL_RENDERS_FREE = "1";
    expect(billableMinutes({ minutes: 3, multiplier: 2, on: "mac" })).toBe(0);
    expect(billableMinutes({ minutes: 3, multiplier: 2, on: "cloud" })).toBe(6);
    delete process.env.LOCAL_RENDERS_FREE;
  });
});
