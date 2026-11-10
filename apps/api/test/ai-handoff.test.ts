// "Send to Claude" in the Rendrr app: the editor sends the open comments to the connected AI. The app opens that AI's
// chat with the message ready (url), Rendrr tells that AI once on its next tool call, get_project says it is waiting,
// get_comments names the comments sent and marks them read, and the editor shows each comment as sent.
// Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("send comments to Claude from the Rendrr app", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "", noteA = "", noteB = "", done = "", clientC = "";
  const clerkId = `handoff_${run}`;
  const headers = (ai?: string) => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId, ...(ai ? { "x-rendrr-ai": ai } : {}) });
  const tool = (name: string, payload: object, ai = "claude") => app.inject({ method: "POST", url: `/internal/tools/${name}`, headers: headers(ai), payload });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `handoff-${run}@test.rendrr.dev`, name: "Hand Off" } })).id;
    const folder = await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(30) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 30, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
    noteA = (await prisma.projectComment.create({ data: { projectId, userId, time: 12.4, text: "Cut the cough here" } })).id;
    noteB = (await prisma.projectComment.create({ data: { projectId, userId, time: 3, text: "Bigger captions", images: [{ key: "x.png", w: 10, h: 10 }] as never } })).id;
    done = (await prisma.projectComment.create({ data: { projectId, userId, time: 20, text: "Already fixed", resolved: true } })).id;
    const review = await prisma.review.create({ data: { token: `tok_${run}`, userId, projectId, folderId: folder.id } });
    clientC = (await prisma.reviewComment.create({ data: { reviewToken: review.token, projectId, time: 8, text: "Music is too loud", author: "Client" } })).id;
    await prisma.aiConnection.create({ data: { userId, client: "claude", clientName: "Claude" } });
  });
  after(async () => {
    await prisma.aiHandoff.deleteMany({ where: { userId } });
    await prisma.review.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.usageEvent.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.aiConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("refuses an AI it does not know, and an edit with nothing open", async () => {
    const bad = await app.inject({ method: "POST", url: `/projects/${projectId}/comments/send`, headers: headers(), payload: { ai: "gemini" } });
    assert.equal(bad.statusCode, 400);
    const none = await app.inject({ method: "POST", url: `/projects/${projectId}/comments/send`, headers: headers(), payload: { ai: "claude", ids: [done] } });
    assert.equal(none.statusCode, 409, "a resolved comment is not sent");
    assert.match(none.json().error.message, /no open comments/);
  });

  it("sends the open comments: a chat link with the message ready, in video order", async () => {
    const r = await app.inject({ method: "POST", url: `/projects/${projectId}/comments/send`, headers: headers(), payload: { ai: "claude" } });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.ai, "claude"); assert.equal(b.name, "Claude"); assert.equal(b.count, 3); assert.equal(b.connected, true);
    assert.deepEqual(b.commentIds, [noteB, clientC, noteA], "client comments too, the resolved one left out, in video order");
    assert.ok(b.url.startsWith("https://claude.ai/new?q="), b.url);
    assert.equal(decodeURIComponent(b.url.slice("https://claude.ai/new?q=".length)), b.prompt);
    assert.match(b.prompt, new RegExp(`the 3 open comments on my Rendrr edit "Promo ${run}" \\(project ${projectId}\\)`));
    assert.match(b.prompt, /- 0:03 Bigger captions \(1 picture\)\n- 0:08 Music is too loud\n- 0:12 Cut the cough here/);
    assert.match(b.prompt, /Read them with get_comments \(images true shows the drawings and pictures\)/);
    assert.ok(!b.prompt.includes("Already fixed"));
  });

  it("the editor shows each sent comment as sent to Claude", async () => {
    const full = (await app.inject({ method: "GET", url: `/projects/${projectId}`, headers: headers() })).json();
    const by = Object.fromEntries(full.comments.map((c: { id: string; sent?: { to: string; at: number } }) => [c.id, c.sent]));
    assert.equal(by[noteA]?.to, "claude"); assert.equal(by[clientC]?.to, "claude");
    assert.ok(by[noteA].at > Date.now() - 60_000);
    assert.equal(by[done], undefined, "the resolved one was not sent");
  });

  it("ChatGPT is not told about a send to Claude", async () => {
    const r = await tool("list_styles", {}, "chatgpt");
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(!/From the Rendrr app/.test(r.json().text));
  });

  it("Claude is told once, on its next Rendrr tool call", async () => {
    const first = (await tool("list_styles", {})).json().text as string;
    assert.match(first, new RegExp(`From the Rendrr app: the user sent you 3 comments on "Promo ${run}" \\(project ${projectId}\\) (just now|1 min ago)\\. Tell them, and once this request is done read them with get_comments and fix them`));
    const second = (await tool("list_styles", {})).json().text as string;
    assert.ok(!/From the Rendrr app/.test(second), "only once");
  });

  it("get_project says comments are waiting; get_comments names them and marks them read", async () => {
    const p1 = (await tool("get_project", { projectId })).json().text as string;
    assert.match(p1, /Sent from the Rendrr app: 3 comments to fix, (just now|1 min ago) \(get_comments\)\./);
    const gc = (await tool("get_comments", { projectId })).json().text as string;
    assert.match(gc, new RegExp(`The user sent these 3 comments to you from the Rendrr app (just now|1 min ago), to be fixed: ${noteB}, ${clientC}, ${noteA}\\.`));
    assert.match(gc, /Music is too loud/);
    const gc2 = (await tool("get_comments", { projectId })).json().text as string;
    assert.ok(!/from the Rendrr app/.test(gc2), "read: not said again");
    const p2 = (await tool("get_project", { projectId })).json().text as string;
    assert.ok(!/Sent from the Rendrr app/.test(p2));
    assert.equal(await prisma.aiHandoff.count({ where: { userId, seenAt: null } }), 0);
  });

  it("only the comments picked, to ChatGPT: its chat link, and ChatGPT is told", async () => {
    const r = (await app.inject({ method: "POST", url: `/projects/${projectId}/comments/send`, headers: headers(), payload: { ai: "chatgpt", ids: [noteA] } })).json();
    assert.equal(r.count, 1); assert.equal(r.connected, true, "ChatGPT called a Rendrr tool above, so it counts as connected");
    assert.ok(r.url.startsWith("https://chatgpt.com/?q="));
    assert.match(r.prompt, /the 1 open comment on my Rendrr edit/);
    assert.ok(!/images true/.test(r.prompt), "no pictures in the one sent");
    const note = (await tool("list_styles", {}, "chatgpt")).json().text as string;
    assert.match(note, /From the Rendrr app: the user sent you 1 comment on/);
  });

  it("another user cannot send this edit's comments", async () => {
    const other = await prisma.user.create({ data: { clerkId: `other_${run}`, email: `other-${run}@test.rendrr.dev`, name: "Other" } });
    try {
      const r = await app.inject({ method: "POST", url: `/projects/${projectId}/comments/send`, headers: { ...headers(), "x-rendrr-clerk-id": `other_${run}` }, payload: { ai: "claude" } });
      assert.equal(r.statusCode, 404);
    } finally { await prisma.user.delete({ where: { id: other.id } }); }
  });
});
