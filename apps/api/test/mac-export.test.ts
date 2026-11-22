// The AI's export goes to the user's Mac when the Rendrr Mac app is open: the app pings, render_final queues the final
// for it and says so, and the app takes it (once) when it is done, with a link that saves the file. With the app
// closed (or to: drive), render_final says it is switching to Rendrr's cloud server and to ask which Google Drive
// folder. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("export to the Mac app, else the cloud and Drive", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { queue, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "";
  const clerkId = `mac_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `mac-${run}@test.rendrr.dev`, name: "Mac" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
  });
  after(async () => {
    for (const j of await queue("render").getJobs(["waiting", "delayed", "prioritized"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await redis().del(`mac:on:${userId}`, `mac:devices:${userId}`, `mac:choice:${userId}`, `mac:exports:${userId}`).catch(() => {});
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("with the Mac app closed: switches to the cloud server and asks which Drive folder", async () => {
    const st = (await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json();
    assert.equal(st.online, false);
    const proj = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(proj.text, /Exports: Renders run on Rendrr's cloud server\. The Rendrr app \(Mac or Windows\) is not open, so finals your AI exports go to Google Drive/);
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Rendrr app \(Mac or Windows\) is not open/);
    assert.match(r.text, /Where: Rendering on Rendrr's cloud server \(US East\), not on your computer\./, "the answer says where it renders");
    assert.match(r.text, /Switching to Rendrr's cloud server/);
    assert.match(r.text, /ask which Google Drive folder/);
    assert.equal(Object.keys(await redis().hgetall(`mac:exports:${userId}`)).length, 0, "nothing queued for the Mac");
    await prisma.render.updateMany({ where: { userId }, data: { status: "done", outputKey: `renders/test-${run}/a.mp4` } });
  });

  it("with the Mac app silent since this morning: Claude hears when and where it was last seen, and what to check", async () => {
    const { noteMacDevice } = await import("@rendrr/core");
    await noteMacDevice(userId, { id: "air-12345678", name: "MacBook Air", platform: "mac", version: "0.1.40", render: null });
    // Its last ping was 3 hours ago.
    const raw = JSON.parse((await redis().hget(`mac:devices:${userId}`, "air-12345678"))!);
    await redis().hset(`mac:devices:${userId}`, "air-12345678", JSON.stringify({ ...raw, at: Date.now() - 3 * 3600_000 }));
    await redis().del(`mac:on:${userId}`);
    const st = (await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json();
    assert.equal(st.online, false);
    assert.equal(st.lastSeen.name, "MacBook Air");
    const proj = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(proj.text, /is not open, so finals your AI exports go to Google Drive \(or a download link\)\. Rendrr last heard from the Rendrr Mac app on "MacBook Air" 3 hours ago/);
    const r = await TOOL_HANDLERS.render_preview(c(), { projectId, newRequest: true });
    assert.match(r.text, /^Rendering on Rendrr's cloud server: no Rendrr app is open now\. Rendrr last heard from the Rendrr Mac app on "MacBook Air" 3 hours ago/);
    await redis().del(`mac:devices:${userId}`);
    await prisma.render.updateMany({ where: { userId, status: { in: ["queued", "running"] } }, data: { status: "done", outputKey: `renders/test-${run}/b.mp4` } });
  });

  it("with an older Mac app open (it cannot render): made in the cloud, exported to the Mac, which takes the final once it is done", async () => {
    const ping = await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.1.7", device: "Studio-Mac.local" } });
    assert.equal(ping.statusCode, 200, ping.body);
    const st = (await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json();
    assert.equal(st.online, true); assert.equal(st.device, "Studio Mac", "the Mac's name, readable"); assert.equal(st.version, "0.1.7");
    const proj = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(proj.text, /Exports: Renders run on Rendrr's cloud server \(this Mac app cannot render yet: update it\)\. The Rendrr Mac app is open on "Studio Mac", so finals your AI exports go to that Mac's Downloads\./);
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Exporting to the user's Mac/);
    assert.match(r.text, /It renders on Rendrr's cloud server \(US East\) \(this Mac app cannot render yet: update it\); the Rendrr Mac app on "Studio Mac" is open/, "the AI is told it renders in the cloud, and why");
    assert.match(r.text, /Where: Rendering on Rendrr's cloud server \(US East\), not on your computer\. Goes to the Rendrr Mac app on "Studio Mac": it saves the file to Downloads the moment it is done\./);
    const renderId = (r.data as { renderId?: string })?.renderId ?? (await prisma.render.findFirstOrThrow({ where: { userId, status: { in: ["queued", "running"] } } })).id;
    let list = (await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json();
    assert.equal(list.length, 1); assert.equal(list[0].renderId, renderId);
    assert.ok(!list[0].url, "no link while it renders");
    await prisma.render.update({ where: { id: renderId }, data: { status: "done", outputKey: `renders/test-${run}/b.mp4` } });
    list = (await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json();
    assert.ok(list[0].url && /\.mp4$/.test(list[0].fileName), "done: a link that saves the file, with its name");
    const first = (await app.inject({ method: "POST", url: `/desktop/exports/${renderId}/claim`, headers: headers() })).json();
    const second = (await app.inject({ method: "POST", url: `/desktop/exports/${renderId}/claim`, headers: headers() })).json();
    assert.equal(first.claimed, true); assert.equal(second.claimed, false, "only one window saves it");
    assert.equal((await app.inject({ method: "GET", url: "/desktop/exports", headers: headers() })).json().length, 0);
    const d = (await prisma.render.findUniqueOrThrow({ where: { id: renderId } })).delivery as { to: string; device: string; state: string };
    assert.deepEqual([d.to, d.device, d.state], ["mac", "Studio Mac", "sent"], "the render remembers it went to that Mac");
    const after = await TOOL_HANDLERS.get_render(c(), { renderId });
    assert.match(after.text, /Where: Rendered on Rendrr's cloud server \(US East\), not on your computer\. Sent to the Rendrr Mac app on "Studio Mac": saved in its Downloads folder\./);
    // The web app's status and the Claude card say the same.
    const web = (await app.inject({ method: "GET", url: `/renders/${renderId}`, headers: headers() })).json();
    assert.deepEqual([web.where.renders, web.where.delivery.to, web.where.delivery.state], ["cloud", "mac", "sent"]);
    const { appProject } = await import("../src/services/claudeApp");
    const view = await appProject(userId, projectId, renderId);
    assert.deepEqual(view.mac, { online: true, device: "Studio Mac", renders: false, platform: "mac" });
    assert.equal(view.preview?.where, 'Made in the cloud · Saved to "Studio Mac"');
  });

  it("with a Mac app that renders: the final is made on that Mac and kept in its Downloads, and every answer says so", async () => {
    await prisma.render.updateMany({ where: { userId, status: { in: ["queued", "running"] } }, data: { status: "done", outputKey: `renders/test-${run}/m.mp4` } });
    const render = { protocol: 1, ready: true, enabled: true, busy: false, cpus: 10, have: ["libx264", "ass", "lut3d"], ffmpeg: "8.0" };
    await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.2.0", device: "Studio-Mac.local", render } });
    const st = (await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json();
    assert.deepEqual([st.online, st.renders, st.why], [true, true, null]);
    const proj = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(proj.text, /Exports: Renders run on the user's Mac: the Rendrr Mac app is open on "Studio Mac", so previews and finals are made there/);
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Exporting on the user's Mac: the Rendrr Mac app on "Studio Mac" is open, so the final is made on that Mac/);
    // The worker hands it to the Mac and the Mac makes it (as core/macRender.ts records): the render says so.
    const renderId = (r.data as { renderId?: string })?.renderId ?? (await prisma.render.findFirstOrThrow({ where: { userId, status: { in: ["queued", "running"] } } })).id;
    await prisma.render.update({ where: { id: renderId }, data: { status: "done", outputKey: `renders/test-${run}/n.mp4`, made: { on: "mac", device: "Studio Mac", why: null }, delivery: { to: "mac", device: "Studio Mac", state: "sent", at: Date.now(), saved: "Promo final v1.mp4" } } });
    const after = await TOOL_HANDLERS.get_render(c(), { renderId });
    assert.match(after.text, /Where: Rendered on your Mac \("Studio Mac"\) by the Rendrr Mac app \(graphics and checks on Rendrr's cloud server\)\. Saved in that Mac's Downloads folder; it downloads from Rendrr too\./);
    const web = (await app.inject({ method: "GET", url: `/renders/${renderId}`, headers: headers() })).json();
    assert.deepEqual([web.where.renders, web.where.device], ["mac", "Studio Mac"]);
    const { appProject } = await import("../src/services/claudeApp");
    assert.equal((await appProject(userId, projectId, renderId)).preview?.where, 'Made on "Studio Mac" · Saved to Downloads');
    // Turned off in the Mac app: back to the cloud, saying why.
    await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.2.0", device: "Studio-Mac.local", render: { ...render, enabled: false } } });
    assert.equal((await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json().why, "rendering on the Mac is turned off in the Mac app");
  });

  it("with the Windows app: said as a PC everywhere (status, the AI's answers, where a final was made, the card)", async () => {
    await prisma.render.updateMany({ where: { userId, status: { in: ["queued", "running"] } }, data: { status: "done", outputKey: `renders/test-${run}/w.mp4` } });
    const render = { protocol: 1, ready: true, enabled: true, busy: false, cpus: 16, have: ["libx264", "ass"], ffmpeg: "8.0" };
    await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.1.1", device: "GAMING-PC", platform: "windows", render } });
    const st = (await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json();
    assert.deepEqual([st.online, st.renders, st.platform, st.device], [true, true, "windows", "GAMING PC"]);
    assert.match((await TOOL_HANDLERS.get_project(c(), { projectId })).text, /Exports: Renders run on the user's PC: the Rendrr Windows app is open on "GAMING PC"/);
    const r = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(r.text, /Exporting on the user's PC: the Rendrr Windows app on "GAMING PC" is open, so the final is made on that PC/);
    const renderId = (r.data as { renderId?: string })?.renderId ?? (await prisma.render.findFirstOrThrow({ where: { userId, status: { in: ["queued", "running"] } } })).id;
    assert.equal(((await prisma.render.findUniqueOrThrow({ where: { id: renderId } })).delivery as { platform?: string }).platform, "windows", "the final remembers it goes to a PC");
    await prisma.render.update({ where: { id: renderId }, data: { status: "done", outputKey: `renders/test-${run}/x.mp4`, made: { on: "mac", device: "GAMING PC", why: null, platform: "windows" }, delivery: { to: "mac", device: "GAMING PC", state: "sent", at: Date.now(), platform: "windows" } } });
    assert.match((await TOOL_HANDLERS.get_render(c(), { renderId })).text, /Where: Rendered on your PC \("GAMING PC"\) by the Rendrr Windows app .* Saved in that PC's Downloads folder/);
    const web = (await app.inject({ method: "GET", url: `/renders/${renderId}`, headers: headers() })).json();
    assert.deepEqual([web.where.renders, web.where.platform], ["mac", "windows"]);
    const { appProject } = await import("../src/services/claudeApp");
    const card = await appProject(userId, projectId, renderId);
    assert.deepEqual([card.preview?.machine, card.mac?.platform], ["PC", "windows"]);
    await app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.1.1", device: "GAMING-PC", platform: "windows", render: { ...render, enabled: false } } });
    assert.equal((await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json().why, "rendering on the PC is turned off in the Windows app");
    await redis().del(`mac:on:${userId}`, `mac:devices:${userId}`);
  });

  it("to: drive goes to the cloud even with the Mac app open", async () => {
    await prisma.render.updateMany({ where: { userId, status: { in: ["queued", "running"] } }, data: { status: "done", outputKey: `renders/test-${run}/c.mp4` } });
    const r = await TOOL_HANDLERS.render_final(c(), { projectId, to: "drive" });
    assert.match(r.text, /Switching to Rendrr's cloud server/);
    assert.doesNotMatch(r.text, /Exporting to the user's Mac/);
  });
});
