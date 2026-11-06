// Reconnecting Google Drive (another account) is used at once: the cached access token belongs to the old
// connection, so the next Drive call asks Google again; a disconnected Drive is refused at once.
// Needs a database (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.GOOGLE_CLIENT_ID ||= "test-client";
process.env.GOOGLE_CLIENT_SECRET ||= "test-secret";
const ready = !!process.env.DATABASE_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("Drive access tokens follow the connection", { skip: !ready && "needs DATABASE_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { drive, encrypt } = await import("@rendrr/core");
  const realFetch = globalThis.fetch;
  let userId = "";
  const asked: string[] = [];

  before(async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/token/.test(url)) {
        const refresh = new URLSearchParams(String(init?.body || "")).get("refresh_token") || "";
        asked.push(refresh);
        return new Response(JSON.stringify({ access_token: `access-for-${refresh}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;
    userId = (await prisma.user.create({ data: { clerkId: `dtk_${run}`, email: `dtk-${run}@test.rendrr.dev`, name: "Dtk" } })).id;
    await prisma.driveConnection.create({ data: { userId, googleEmail: "old@gmail.test", refreshToken: encrypt("old-refresh"), scopes: "drive.readonly" } });
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("uses the cached token, then the new account's token right after a reconnect", async () => {
    assert.equal(await drive.accessTokenFor(userId), "access-for-old-refresh");
    assert.equal(await drive.accessTokenFor(userId), "access-for-old-refresh");
    assert.equal(asked.length, 1, "cached the second time");
    await prisma.driveConnection.update({ where: { userId }, data: { googleEmail: "new@gmail.test", refreshToken: encrypt("new-refresh") } });
    assert.equal(await drive.accessTokenFor(userId), "access-for-new-refresh");
    assert.deepEqual(asked, ["old-refresh", "new-refresh"]);
  });

  it("a disconnected Drive is refused at once, even with a token in the cache", async () => {
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await assert.rejects(drive.accessTokenFor(userId), /Connect Google Drive first/);
  });
});
