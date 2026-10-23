// Several logins, one account: the website login and the AI connector's login must see the same projects.
// Needs a database and Redis (DATABASE_URL, REDIS_URL, as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);
const email = `same-${run}@test.rendrr.dev`;

describe("same email in the website and the AI connector", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { buildInitialTimeline, stubTranscript } = await import("@rendrr/shared");
  const { ensureUser } = await import("../src/auth");
  const { createLinkCode, redeemLinkCode } = await import("../src/services/logins");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");

  const ids = { web: `test_web_${run}`, mcp: `test_mcp_${run}`, other: `test_other_${run}` };
  let webUserId = "", projectId = "", videoId = "";

  before(async () => {
    // The website account, with footage and an edit.
    const web = await prisma.user.create({ data: { clerkId: ids.web, email, name: "Web" } });
    webUserId = web.id;
    const folder = await prisma.folder.create({ data: { userId: web.id, name: "My edits", workspace: "Web's Workspace" } });
    const tr = stubTranscript(20);
    const v = await prisma.video.create({ data: { userId: web.id, name: `Founders day ${run}`, seconds: 20, source: "local", status: "ready", analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [] } } } });
    videoId = v.id;
    const p = await prisma.project.create({ data: { userId: web.id, folderId: folder.id, videoId: v.id, styleId: "s2", name: `IMG edit ${run}`, timeline: buildInitialTimeline(tr, 20, "clean") as never } });
    projectId = p.id;
    // The connector's login with the same email: its own empty account, made on first sight.
    const mcp = await prisma.user.create({ data: { clerkId: ids.mcp, email, name: "Web" } });
    await prisma.folder.create({ data: { userId: mcp.id, name: "My edits", workspace: "Web's Workspace" } });
  });

  after(async () => {
    await prisma.userLogin.deleteMany({ where: { clerkId: { in: Object.values(ids) } } });
    await prisma.user.deleteMany({ where: { clerkId: { in: Object.values(ids) } } }); // cascades to folders, edits, videos
    await prisma.$disconnect();
    redis().disconnect();
  });

  const projectsOf = async (clerkId: string) => {
    const u = await ensureUser(clerkId);
    return (await TOOL_HANDLERS.list_projects({ userId: u.id, loginId: clerkId, ai: "claude" }, {})).text;
  };

  it("before linking, the connector's login sees an empty account (the bug)", async () => {
    assert.ok((await projectsOf(ids.web)).includes(projectId));
    assert.ok(!(await projectsOf(ids.mcp)).includes(projectId));
  });

  it("after linking with a code from the website, both logins return the same projects and footage", async () => {
    const { code } = await createLinkCode(webUserId);
    const r = await redeemLinkCode(ids.mcp, code);
    assert.equal(r.userId, webUserId);
    assert.equal(r.removedEmpty, true);
    assert.equal((await ensureUser(ids.mcp)).id, webUserId);
    assert.equal(await projectsOf(ids.mcp), await projectsOf(ids.web));
    const footage = await TOOL_HANDLERS.list_footage({ userId: (await ensureUser(ids.mcp)).id, ai: "claude" }, {});
    assert.ok(footage.text.includes(videoId));
    assert.equal(await prisma.user.count({ where: { clerkId: ids.mcp } }), 0, "the empty account is gone");
  });

  it("a code works once", async () => {
    const { code } = await createLinkCode(webUserId);
    await redeemLinkCode(ids.mcp, code);
    await assert.rejects(redeemLinkCode(ids.mcp, code), /wrong or has expired/);
  });

  it("never removes an account that has its own data", async () => {
    const other = await prisma.user.create({ data: { clerkId: ids.other, email, name: "Other" } });
    await prisma.video.create({ data: { userId: other.id, name: "keep me", source: "local", status: "ready" } });
    const { code } = await createLinkCode(webUserId);
    await assert.rejects(redeemLinkCode(ids.other, code), /already has its own videos/);
    assert.equal(await prisma.video.count({ where: { userId: other.id } }), 1);
    assert.equal((await ensureUser(ids.other)).id, other.id);
  });
});

describe("one account per email: duplicates merge, empty ones only", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { ensureUser, verifiedEmail } = await import("../src/auth");
  const { mergeDuplicateAccounts } = await import("../src/services/logins");
  const r2 = Math.random().toString(36).slice(2, 8);
  const mail = `Dup-${r2}@test.rendrr.dev`;
  const ids = { web: `dup_web_${r2}`, mcp: `dup_mcp_${r2}`, other: `dup_other_${r2}`, unverified: `dup_unv_${r2}`, full1: `dup_f1_${r2}`, full2: `dup_f2_${r2}` };
  const all = Object.values(ids);
  after(async () => {
    await prisma.userLogin.deleteMany({ where: { clerkId: { in: all } } });
    await prisma.user.deleteMany({ where: { clerkId: { in: all } } });
  });

  it("uses only a verified email", () => {
    assert.equal(verifiedEmail({ primaryEmailAddress: { emailAddress: "A@B.co", verification: { status: "verified" } }, emailAddresses: [] }), "a@b.co");
    assert.equal(verifiedEmail({ primaryEmailAddress: { emailAddress: "a@b.co", verification: { status: "unverified" } }, emailAddresses: [] }), null);
  });

  it("moves the logins of empty duplicates to the account with the edits, and keeps unverified ones apart", async () => {
    const web = await prisma.user.create({ data: { clerkId: ids.web, email: mail, name: "Web" } });
    await prisma.video.create({ data: { userId: web.id, name: "mine", source: "local", status: "ready" } });
    for (const k of ["mcp", "other", "unverified"] as const) {
      const u = await prisma.user.create({ data: { clerkId: ids[k], email: mail.toLowerCase(), name: k } });
      await prisma.folder.create({ data: { userId: u.id, name: "My edits", workspace: "x" } }); // made on first sight
    }
    const r = await mergeDuplicateAccounts(async (clerkId) => clerkId !== ids.unverified);
    assert.equal(r.merged.filter((m) => m.into === web.id).length, 2);
    assert.ok(r.skipped.some((s) => s.reason.includes(ids.unverified)));
    for (const k of ["mcp", "other"] as const) {
      assert.equal(await prisma.user.count({ where: { clerkId: ids[k] } }), 0, "empty duplicate removed");
      assert.equal((await ensureUser(ids[k])).id, web.id, "its login opens the account with the edits");
    }
    assert.notEqual((await ensureUser(ids.unverified)).id, web.id);
    assert.equal(await prisma.video.count({ where: { userId: web.id } }), 1);
    const again = await mergeDuplicateAccounts(async (clerkId) => clerkId !== ids.unverified);
    assert.equal(again.merged.length, 0, "safe to run again");
  });

  it("leaves two accounts that both hold data alone", async () => {
    const m2 = `full-${r2}@test.rendrr.dev`;
    for (const k of ["full1", "full2"] as const) {
      const u = await prisma.user.create({ data: { clerkId: ids[k], email: m2, name: k } });
      await prisma.video.create({ data: { userId: u.id, name: k, source: "local", status: "ready" } });
    }
    const r = await mergeDuplicateAccounts(async () => true);
    assert.ok(r.skipped.some((s) => s.email === m2 && /merge them by hand/.test(s.reason)));
    assert.equal(await prisma.user.count({ where: { email: m2 } }), 2);
  });
});
