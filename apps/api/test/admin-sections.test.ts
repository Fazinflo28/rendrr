// The admin panel's sections modelled on Dragly's: client folders, billing, render health, the audit log (with the
// reason for each change), connections, system health and the gallery. Team only: every one answers 403 to a normal
// account and 401 with no login. Needs a database and Redis (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("admin sections like Dragly's", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", adminId = "", folderId = "", projectId = "";
  const clerk = `admsec_${run}`, adminClerk = `admsecadm_${run}`;
  const as = (c: string) => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": c });
  const SECTIONS = ["/admin/folders", "/admin/billing", "/admin/renders?days=7", "/admin/audit", "/admin/connections", "/admin/health", "/admin/gallery"];

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId: clerk, email: `admsec-${run}@test.rendrr.dev`, name: `Sec ${run}` } })).id;
    adminId = (await prisma.user.create({ data: { clerkId: adminClerk, email: `admsecadm-${run}@test.rendrr.dev`, name: "Admin", role: "admin", plan: "comp", billingStatus: "active" } })).id;
    folderId = (await prisma.folder.create({ data: { userId, name: `Client ${run}`, workspace: "Studio" } })).id;
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1080, height: 1920, source: "drive", status: "ready" } })).id;
    projectId = (await prisma.project.create({ data: { userId, folderId, videoId, name: `Edit ${run}`, timeline: {} } })).id;
    await prisma.render.createMany({ data: [
      { projectId, userId, kind: "final", version: 1, status: "done", seconds: 30, made: { on: "mac" }, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() },
      { projectId, userId, kind: "preview", version: 1, status: "failed", error: `ffmpeg broke ${run}`, errorCode: "render_failed" },
    ] });
    await prisma.billingInvoice.create({ data: { userId, number: `RENDRR-${run}`, periodStart: new Date(Date.now() - 30 * 86400_000), periodEnd: new Date(), baseCents: 500, usageCents: 120, totalCents: 620, status: "paid", paidAt: new Date() } });
    await prisma.aiConnection.create({ data: { userId, client: "claude", clientName: "Claude" } });
  });
  after(async () => {
    await prisma.adminAction.deleteMany({ where: { OR: [{ adminId }, { targetId: userId }] } });
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.billingInvoice.deleteMany({ where: { userId } });
    await prisma.aiConnection.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("team only: a normal account gets 403 and no login gets 401 on every section", async () => {
    for (const url of SECTIONS) {
      assert.equal((await app.inject({ method: "GET", url, headers: as(clerk) })).statusCode, 403, url);
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
    }
    assert.equal((await app.inject({ method: "POST", url: `/admin/users/${userId}`, headers: as(clerk), payload: { plan: "comp", reason: "x" } })).statusCode, 403);
  });

  it("every section answers an admin", async () => {
    for (const url of SECTIONS) { const r = await app.inject({ method: "GET", url, headers: as(adminClerk) }); assert.equal(r.statusCode, 200, `${url}: ${r.body.slice(0, 300)}`); }
  });

  it("client folders: the folder with its owner, edits and finals; search by owner", async () => {
    const r = (await app.inject({ method: "GET", url: `/admin/folders?q=admsec-${run}`, headers: as(adminClerk) })).json();
    assert.equal(r.total, 1);
    const f = r.folders[0];
    assert.equal(f.id, folderId); assert.equal(f.owner.id, userId); assert.equal(f.edits, 1); assert.equal(f.finals30, 1);
  });

  it("billing: the paid bill is listed with who paid; filters by status", async () => {
    const b = (await app.inject({ method: "GET", url: "/admin/billing?status=paid", headers: as(adminClerk) })).json();
    const mine = b.invoices.find((i: { number: string }) => i.number === `RENDRR-${run}`);
    assert.ok(mine); assert.equal(mine.total, 6.2); assert.equal(mine.user.id, userId);
    assert.ok(Array.isArray(b.plans) && b.plans.some((p: { plan: string }) => p.plan === "starter"));
    const failed = (await app.inject({ method: "GET", url: "/admin/billing?status=failed", headers: as(adminClerk) })).json();
    assert.ok(!failed.invoices.some((i: { number: string }) => i.number === `RENDRR-${run}`));
  });

  it("render health: split by kind and where it was made, with why it failed", async () => {
    const h = (await app.inject({ method: "GET", url: "/admin/renders?days=1", headers: as(adminClerk) })).json();
    assert.ok(h.groups.some((g: { key: string; done: number }) => g.key === "final:computer" && g.done >= 1));
    assert.ok(h.groups.some((g: { key: string; reasons: { reason: string }[] }) => g.key === "preview:cloud" && g.reasons.some((x) => x.reason === "render_failed")));
    assert.ok(h.recentFailures.some((f: { error: string; user: { id: string } }) => f.error === `ffmpeg broke ${run}` && f.user.id === userId));
    assert.equal(h.perDay.length, 1);
  });

  it("the audit log: a change made with a reason shows who, to whom, what and why; searchable by the reason", async () => {
    const ch = await app.inject({ method: "POST", url: `/admin/users/${userId}`, headers: as(adminClerk), payload: { bonusExportMinutes: 12, reason: `Render broke ${run}` } });
    assert.equal(ch.statusCode, 200, ch.body);
    const a = await prisma.adminAction.findFirstOrThrow({ where: { targetId: userId }, orderBy: { createdAt: "desc" } });
    assert.equal(a.action, "bonusExportMinutes"); // the reason is not a change
    const log = (await app.inject({ method: "GET", url: `/admin/audit?q=${encodeURIComponent(`Render broke ${run}`)}`, headers: as(adminClerk) })).json();
    assert.equal(log.total, 1);
    assert.equal(log.rows[0].reason, `Render broke ${run}`); assert.equal(log.rows[0].admin.id, adminId); assert.equal(log.rows[0].target.id, userId);
    assert.deepEqual(log.rows[0].change, { bonusExportMinutes: 12 });
    const byEmail = (await app.inject({ method: "GET", url: `/admin/audit?q=admsec-${run}`, headers: as(adminClerk) })).json();
    assert.ok(byEmail.total >= 1);
    // A reason alone changes nothing.
    assert.equal((await app.inject({ method: "POST", url: `/admin/users/${userId}`, headers: as(adminClerk), payload: { reason: "nothing" } })).statusCode, 400);
  });

  it("connections, system health and the gallery", async () => {
    const c = (await app.inject({ method: "GET", url: "/admin/connections", headers: as(adminClerk) })).json();
    assert.ok(c.ai.some((x: { user: { id: string }; client: string }) => x.user.id === userId && x.client === "claude"));
    const h = (await app.inject({ method: "GET", url: "/admin/health", headers: as(adminClerk) })).json();
    assert.equal(h.live.db.ok, true); assert.equal(h.live.redis.ok, true);
    assert.equal(typeof h.keys.storage, "boolean"); assert.ok(h.queues.render);
    const g = (await app.inject({ method: "GET", url: "/admin/gallery", headers: as(adminClerk) })).json();
    assert.ok(Array.isArray(g.items));
    const o = (await app.inject({ method: "GET", url: "/admin/overview", headers: as(adminClerk) })).json();
    assert.ok(o.product.folders >= 1 && o.product.finals30 >= 1 && o.product.onComputers30 >= 1);
  });
});
