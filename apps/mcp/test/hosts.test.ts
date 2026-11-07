// The connector logs which address an AI chat connects through, once an hour per user and address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostLine } from "../src/hosts";

test("the address an AI chat connects through is logged once an hour per user and address", () => {
  const t = 1_000_000_000;
  assert.equal(hostLine("mcp.rendrr.live", "user_1", "Claude", t), "[mcp] Claude connects through mcp.rendrr.live (user_1)");
  assert.equal(hostLine("mcp.rendrr.live", "user_1", "Claude", t + 60_000), null);
  assert.match(hostLine("mcp-production-7fa0.up.railway.app", "user_1", "Claude", t + 60_000) || "", /connects through mcp-production-7fa0\.up\.railway\.app/);
  assert.match(hostLine("mcp.rendrr.live", "user_2", "ChatGPT", t + 60_000) || "", /ChatGPT connects through mcp\.rendrr\.live \(user_2\)/);
  assert.ok(hostLine("mcp.rendrr.live", "user_1", "Claude", t + 3601_000));
});
