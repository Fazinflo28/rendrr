// The MCP server's calls to the API: accepted with INTERNAL_API_SECRET, or (when the MCP server has none set) with the
// secret worked out from the Clerk secret key both services hold; anything else is refused. Needs a database (.env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.CLERK_SECRET_KEY = "sk_test_internal_secret_check";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("the MCP server's secret", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { internalSecretFromClerk, redis } = await import("@rendrr/core");
  const { internalSecretFromClerk: fromMcp } = await import("../../mcp/src/secret");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  const clerkId = `isec_${run}`;
  const call = (secret: string) => app.inject({ method: "GET", url: "/folders", headers: { "x-internal-secret": secret, "x-rendrr-clerk-id": clerkId } });
  before(async () => {
    app = await buildServer();
    // Already a user (else the API asks Clerk who it is, and the test key is not real).
    const u = await prisma.user.create({ data: { clerkId, email: `isec-${run}@test.rendrr.dev`, name: "Isec" } });
    await prisma.folder.create({ data: { userId: u.id, name: "Edits", workspace: "Isec's Workspace" } });
  });
  after(async () => {
    await prisma.folder.deleteMany({ where: { user: { clerkId } } });
    await prisma.user.deleteMany({ where: { clerkId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("the MCP server works it out exactly as the API does", () => {
    assert.equal(fromMcp("sk_test_internal_secret_check"), internalSecretFromClerk("sk_test_internal_secret_check"));
    assert.notEqual(internalSecretFromClerk("sk_a"), internalSecretFromClerk("sk_b"));
    assert.match(internalSecretFromClerk("sk_a"), /^[0-9a-f]{64}$/);
  });

  it("accepts the secret set, and the one from the Clerk key; refuses anything else", async () => {
    assert.equal((await call("test-internal-secret")).statusCode, 200);
    assert.equal((await call(internalSecretFromClerk("sk_test_internal_secret_check"))).statusCode, 200);
    assert.equal((await call("wrong")).statusCode, 401);
    assert.equal((await call(internalSecretFromClerk("sk_some_other_key"))).statusCode, 401);
  });
});
