// The database move: the API in maintenance mode (health up, every other request a plain 503 the web app can read,
// nothing touching the database) and Supabase's Transaction pooler address made safe for Prisma.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dbHost, poolerUrl } from "@rendrr/db";
import { maintenanceOn, MAINTENANCE_MESSAGE } from "@rendrr/core";
import { buildMaintenanceServer } from "../src/maintenance";

describe("database move", () => {
  test("maintenance mode: /health stays up, everything else is a 503 with a plain message, readable from the web app", async () => {
    process.env.WEB_ORIGINS = "https://app.rendrr.live";
    const app = await buildMaintenanceServer();
    const h = await app.inject({ method: "GET", url: "/health" });
    assert.equal(h.statusCode, 200);
    assert.equal(h.json().maintenance, true);
    for (const [method, url] of [["GET", "/projects"], ["POST", "/projects/p1/render"], ["GET", "/billing/overview"], ["POST", "/mcp/tools/apply_edits"]] as const) {
      const r = await app.inject({ method, url, headers: { origin: "https://app.rendrr.live" }, payload: method === "POST" ? {} : undefined });
      assert.equal(r.statusCode, 503, `${method} ${url}`);
      assert.deepEqual(r.json(), { error: { message: MAINTENANCE_MESSAGE, code: "maintenance" } });
      assert.equal(r.headers["access-control-allow-origin"], "https://app.rendrr.live");
    }
    const pre = await app.inject({ method: "OPTIONS", url: "/projects", headers: { origin: "https://app.rendrr.live", "access-control-request-method": "POST" } });
    assert.equal(pre.statusCode, 204);
    await app.close();
  });

  test("MAINTENANCE values that turn it on, and off", () => {
    for (const v of ["1", "on", "true", "YES", " 1 "]) assert.equal(maintenanceOn(v), true, v);
    for (const v of ["", "0", "off", "false", undefined]) assert.equal(maintenanceOn(v), false, String(v));
  });

  test("Supabase's Transaction pooler gets pgbouncer=true and a small pool; other addresses are left alone", () => {
    const tx = "postgresql://postgres.abc:pw123@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    const u = new URL(poolerUrl(tx, "8")!);
    assert.equal(u.searchParams.get("pgbouncer"), "true");
    assert.equal(u.searchParams.get("connection_limit"), "8");
    assert.equal(u.username, "postgres.abc");
    assert.equal(u.password, "pw123");
    // Already set by the user: kept as given.
    const given = new URL(poolerUrl(tx + "?pgbouncer=true&connection_limit=3", "8")!);
    assert.equal(given.searchParams.get("connection_limit"), "3");
    // The Session pooler (migrations, the copy) and Railway's Postgres: unchanged.
    const session = "postgresql://postgres.abc:pw123@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    assert.equal(poolerUrl(session), session);
    const railway = "postgresql://postgres:secret@postgres.railway.internal:5432/railway";
    assert.equal(poolerUrl(railway), railway);
    assert.equal(poolerUrl(undefined), undefined);
    assert.equal(poolerUrl("not a url"), "not a url");
  });

  test("logs name the database's host, never the user or password", () => {
    assert.equal(dbHost("postgresql://postgres.abc:pw123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"), "aws-0-us-east-1.pooler.supabase.com:6543");
    assert.equal(dbHost(undefined), "unknown");
  });
});
