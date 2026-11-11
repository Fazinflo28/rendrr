// One account open on several computers (Macs and Windows PCs) at once: Rendrr sees every one online, and when two or
// more can render, the AI is asked which one (or Rendrr's cloud server) before anything renders. The pick is kept for
// the next renders; a render goes only to the computer picked (its task is that computer's alone); a final made from an
// original kept on one computer goes to that one; a final made in the cloud is saved by the computer it is for.
// Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("several computers on one account", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const core = await import("@rendrr/core");
  const { macExports, claimMacExport, queueMacExport } = await import("../src/services/macExport");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "", videoId = "";
  const clerkId = `macdev_${run}`;
  const A = `devA${run}xxxxxxxx`, B = `devB${run}xxxxxxxx`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const render = (cpus: number) => ({ protocol: 1, ready: true, enabled: true, busy: false, cpus, have: ["libx264", "ass"], ffmpeg: "9.0" });
  const ping = (deviceId: string, device: string, cpus = 8, platform = "mac", r: unknown = render(cpus)) => app.inject({ method: "POST", url: "/desktop/ping", headers: headers(), payload: { version: "0.2.0", device, platform, deviceId, render: r } });
  const finish = () => prisma.render.updateMany({ where: { userId, status: { in: ["queued", "running"] } }, data: { status: "done", outputKey: `renders/test-${run}/x.mp4` } });
  const latest = () => prisma.render.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `macdev-${run}@test.rendrr.dev`, name: "Dev" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1280, height: 720, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Promo ${run}` })).id;
  });
  after(async () => {
    for (const j of await core.queue("render").getJobs(["waiting", "delayed", "prioritized"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await core.redis().del(`mac:on:${userId}`, `mac:devices:${userId}`, `mac:choice:${userId}`, `mac:exports:${userId}`, `mac:tasks:${userId}`).catch(() => {});
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close(); await core.redis().quit().catch(() => {});
  });

  it("every computer online is seen, by name and kind", async () => {
    await ping(A, "M1", 8); await ping(B, "M3", 12);
    const st = (await app.inject({ method: "GET", url: "/desktop/status", headers: headers() })).json();
    assert.deepEqual(st.devices.map((d: { id: string; name: string; renders: boolean }) => [d.id, d.name, d.renders]).sort(), [[A, "M1", true], [B, "M3", true]]);
    assert.equal(st.choice, null);
    assert.match((await TOOL_HANDLERS.get_project(c(), { projectId })).text, /2 of the user's computers can render now: "M\d" \(Mac\) and "M\d" \(Mac\), or Rendrr's cloud server\. The next render asks which one/);
  });

  it("two can render and none was picked: the AI is asked which, and nothing renders", async () => {
    const r = await TOOL_HANDLERS.render_preview(c(), { projectId });
    assert.match(r.text, /^2 of the user's computers can render this now: "M\d" \(Mac\) and "M\d" \(Mac\), or Rendrr's cloud server\. Nothing was rendered yet: ask the user which one to use, then call render_preview again with device/);
    assert.equal(await prisma.render.count({ where: { userId } }), 0, "nothing rendered");
    const bad = await TOOL_HANDLERS.render_preview(c(), { projectId, device: "Kitchen PC" });
    assert.match(bad.text, /"Kitchen PC" is not one of the user's computers connected to Rendrr now/);
  });

  it("the user picks one: the render goes to it alone, and the pick is kept for the next render", async () => {
    const r = await TOOL_HANDLERS.render_preview(c(), { projectId, device: "m3" });
    assert.match(r.text, /^Rendering on "M3" \(Mac\) \(the user's pick: pass device to switch, or "cloud"\)\./);
    assert.equal((await latest()).target, B);
    assert.equal(await core.renderChoice(userId), B);
    await finish();
    const f = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.doesNotMatch(f.text, /can render this now/, "not asked again");
    assert.match(f.text, /Exporting on the user's Mac: the Rendrr Mac app on "M3" is open, so the final is made on that Mac/);
    const fin = await latest();
    assert.equal(fin.target, B);
    assert.deepEqual([(fin.delivery as { device?: string }).device], ["M3"], "the final goes to the computer that makes it");
    await finish();
  });

  it("the cloud, when the user says so", async () => {
    const r = await TOOL_HANDLERS.render_samples(c(), { projectId, frames: [1], device: "cloud" });
    assert.ok(!/can render this now/.test(r.text));
    assert.equal((await latest()).target, "cloud");
    assert.equal(await core.renderChoice(userId), "cloud");
    assert.deepEqual(await core.macForRender(userId, [], "cloud"), { info: null, why: "the user chose Rendrr's cloud server" });
    await finish();
  });

  it("a render meant for one computer is that computer's alone to take", async () => {
    const spec = { renderId: "r-" + run, userId, kind: "preview", label: "Preview", inputs: [], commands: [{ args: ["-version"] }], outputs: [{ name: "o.mp4", key: "k", type: "video/mp4" }], needs: [], deviceId: A };
    const id = await core.createMacTask(spec);
    const forB = (await app.inject({ method: "GET", url: `/desktop/tasks?device=${B}`, headers: headers() })).json();
    assert.ok(!forB.tasks.some((t: { id: string }) => t.id === id), "the other computer does not see it");
    const forA = (await app.inject({ method: "GET", url: `/desktop/tasks?device=${A}`, headers: headers() })).json();
    assert.ok(forA.tasks.some((t: { id: string }) => t.id === id), "its computer does");
    const byB = (await app.inject({ method: "POST", url: `/desktop/tasks/${id}/claim`, headers: headers(), payload: { device: "M3", deviceId: B } })).json();
    assert.equal(byB.task, null, "the other computer cannot take it");
    const byA = (await app.inject({ method: "POST", url: `/desktop/tasks/${id}/claim`, headers: headers(), payload: { device: "M1", deviceId: A } })).json();
    assert.ok(byA.task, "its computer takes it");
    // The worker's pick: the one asked for, else the free one with the most cores.
    assert.equal((await core.macForRender(userId, [], A)).info?.id, A);
    assert.equal((await core.macForRender(userId, [])).info?.id, B, "12 cores before 8");
    assert.match(String((await core.macForRender(userId, [], "gone")).why), /not connected/);
  });

  it("a final made in the cloud is saved by the computer it is for", async () => {
    const rend = (await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "running", steps: [], quality: "1080p" } })).id;
    await queueMacExport(userId, rend, "f.mp4", "M1", "mac", A);
    const mine = async (dev: string) => (await macExports(userId, dev)).some((x) => x.renderId === rend);
    assert.equal(await mine(B), false, "not listed for the other computer");
    assert.equal(await claimMacExport(userId, rend, B), false);
    assert.equal(await mine(A), true);
    assert.equal(await claimMacExport(userId, rend, A), true);
    await prisma.render.update({ where: { id: rend }, data: { status: "done", outputKey: `renders/test-${run}/q.mp4` } });
  });

  it("the original kept on one computer: its final goes there, whatever was picked; another computer cannot make it", async () => {
    await prisma.video.update({ where: { id: videoId }, data: { source: "local", macOriginal: { device: "M1", deviceId: A, size: 1000, name: "talk.mov", width: 1920, height: 1080, fps: 30, seconds: 20, hasAudio: true, at: Date.now() } } });
    await core.setRenderChoice(userId, B);
    const f = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.match(f.text, /Rendering on "M1" \(Mac\): it keeps this footage's original\./);
    assert.equal((await latest()).target, A);
    await finish();
    const other = await TOOL_HANDLERS.render_final(c(), { projectId, device: "M3" });
    assert.match(other.text, /The original of this footage stays on "M1" \(Mac\) .* so only that computer can make this final\. Call render_final again with device "M1"/);
    await prisma.video.update({ where: { id: videoId }, data: { source: "drive", macOriginal: null as never } });
  });

  it("the web app's Export window: a computer by id, or refused when it is not there; one computer left: no question", async () => {
    const r = await app.inject({ method: "POST", url: `/projects/${projectId}/renders`, headers: headers(), payload: { kind: "final", device: A } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await latest()).target, A);
    await finish();
    const gone = await app.inject({ method: "POST", url: `/projects/${projectId}/renders`, headers: headers(), payload: { kind: "final", device: "Office PC" } });
    assert.equal(gone.statusCode, 409);
    assert.match(gone.json().error.message, /"Office PC" is not one of the user's computers/);
    // Settings: "Ask each time" clears the pick.
    const cleared = (await app.inject({ method: "POST", url: "/desktop/choice", headers: headers(), payload: { device: "" } })).json();
    assert.equal(cleared.choice, null);
    // Only one computer still online (the other closed): it renders, nothing asked.
    await core.redis().hdel(`mac:devices:${userId}`, B);
    const one = await TOOL_HANDLERS.render_final(c(), { projectId });
    assert.doesNotMatch(one.text, /can render this now/);
    assert.equal((await latest()).target, A);
  });
});
