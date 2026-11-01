// The user's own audio file through the connector: add_audio upload gives a link, the file sent to it (as curl -T does)
// is made into AAC by the worker's job and measured; apply_edits set_voice plays it in place of the edit's sound and
// get_project says so; a used link and a file that is not audio say why. Needs a database, Redis, storage and ffmpeg.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("the user's own audio", { skip: (!ready || !ff) && "needs a database, Redis, storage and FFmpeg" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { MCP_TOOLS, QUEUES, stubTranscript } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { createProject } = await import("../src/services/projects");
  const { closeSoundEvents } = await import("../src/services/sounds");
  const { buildServer } = await import("../src/server");
  const { deletePrefix, newRedis, redis } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { soundJob } = await import("../../worker/src/jobs/sound");

  let userId = "", projectId = "", worker: InstanceType<typeof Worker> | null = null;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const dir = mkdtempSync(join(tmpdir(), "own-audio-"));
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const linkOf = (text: string) => /(https?:\/\/\S+\/audio\/upload\/[\w-]+)/.exec(text)![1];
  const send = (link: string, body: Buffer, q = "") => app.inject({ method: "PUT", url: new URL(link).pathname + q, payload: body, headers: { "content-type": "audio/mpeg" } });

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId: `aud_${run}`, email: `aud-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Cold Outreaching ${run}` })).id;
    worker = new Worker(QUEUES.test.name, async (job) => soundJob({ job, dir, signal: new AbortController().signal, isLastAttempt: true } as never), { connection: newRedis() as never });
    // The "enhanced" voice: 6.5 s of tone as an mp3 (as Adobe Podcast gives one).
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=6.5:sample_rate=44100", "-c:a", "libmp3lame", "-b:a", "128k", join(dir, "enhanced.mp3")]);
  });
  after(async () => {
    await worker?.close();
    await closeSoundEvents();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } }); // its sounds go with it
    await deletePrefix(`sounds/${userId}`).catch(() => {});
    await app.close();
    await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("an upload link takes the file from the AI's workspace; it is ready with its length and how to use it", async () => {
    const out = await tool("add_audio", { upload: true, name: "Cold Outreaching enhanced" });
    assert.match(out.text, /^Upload link for one audio file, for 30 minutes: \S+\/audio\/upload\/[\w-]+\nSend the file from your code workspace \(up to 500 MB\):\n  curl -sS -T "<file>" "\S+"\n/);
    const r = await send(linkOf(out.text), readFileSync(join(dir, "enhanced.mp3")));
    assert.equal(r.statusCode, 200, r.body);
    const j = JSON.parse(r.body) as { id: string; seconds: number; status: string; text: string };
    assert.equal(j.status, "ready");
    assert.ok(Math.abs(j.seconds - 6.5) < 0.1, `its length (${j.seconds})`);
    assert.match(j.text, new RegExp(`^Added audio "Cold Outreaching enhanced" ${j.id}: 6\\.\\ds \\(6\\.\\d{3}s\\)\\. Use it with apply_edits: set_voice\\{soundId: "${j.id}"\\}`));
    const s = await prisma.sound.findUniqueOrThrow({ where: { id: j.id } });
    assert.equal(s.key, `sounds/${userId}/${s.id}.m4a`);
    // Kept as AAC 48 kHz stereo.
    const { signGet } = await import("@rendrr/core");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", await signGet(s.key, 600)]).toString()) as { streams: { codec_name: string; sample_rate: string; channels: number }[] };
    assert.deepEqual([probe.streams[0].codec_name, probe.streams[0].sample_rate, probe.streams[0].channels], ["aac", "48000", 2]);
    // The link works once.
    const again = await send(linkOf(out.text), readFileSync(join(dir, "enhanced.mp3")));
    assert.equal(again.statusCode, 404);
    assert.match(again.body, /expired or was used already/);
  });

  it("set_voice puts it in place of the edit's sound; get_project and the list say so", async () => {
    const s = await prisma.sound.findFirstOrThrow({ where: { userId, status: "ready" } });
    const r = await tool("apply_edits", { projectId, edits: [{ op: "set_voice", soundId: s.id }] });
    assert.match(r.text, /the edit's sound is now "Cold Outreaching enhanced" \(6\.\d+s, from 0\.00s of the edit/, r.text);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.equal((p.timeline as { voice?: { soundId: string } }).voice?.soundId, s.id);
    const gp = await tool("get_project", { projectId, clipsLimit: 2 });
    assert.match(gp.text, new RegExp(`\\nVoice: "Cold Outreaching enhanced" \\(6\\.\\d{3}s\\) plays in place of every clip's own sound, from 0s of the edit`));
    assert.match(gp.text, new RegExp(`\\nYour audio files \\(set_voice / add_music soundId\\): ${s.id} "Cold Outreaching enhanced"`));
    assert.match((await tool("add_audio", {})).text, new RegExp(`^Your audio files \\(newest first\\): ${s.id} "Cold Outreaching enhanced" 0:07|^Your audio files \\(newest first\\): ${s.id} "Cold Outreaching enhanced" 6\\.\\ds`));
    // Back to the clips' own sound.
    assert.match((await tool("apply_edits", { projectId, edits: [{ op: "set_voice", soundId: null }] })).text, /the edit plays its clips' own sound again/);
  });

  it("a chat whose tool list is older than add_audio: apply_edits set_voice takes the file itself", async () => {
    // upload: true answers with a link and changes nothing.
    const before = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersion;
    let link = "";
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "set_voice", upload: true }] }), (e: Error) => {
      assert.match(e.message, /^Nothing changed yet\. Upload link for the audio file, for 30 minutes: \S+\/audio\/upload\/[\w-]+\n/);
      link = linkOf(e.message);
      return true;
    });
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersion, before);
    const j = JSON.parse((await send(link, readFileSync(join(dir, "enhanced.mp3")), "?name=Old chat voice")).body) as { id: string; status: string };
    assert.equal(j.status, "ready");
    const r = await tool("apply_edits", { projectId, edits: [{ op: "set_voice", soundId: j.id }] });
    assert.match(r.text, /the edit's sound is now "Old chat voice"/);
    // Unknown id and no file: says how to bring one in from here.
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "set_voice", soundId: "nope" }] }), /set_voice takes the file itself: url \(a share link\), driveFileId, or upload: true/);
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "set_voice" }] }), /set_voice needs the file/);
    await tool("apply_edits", { projectId, edits: [{ op: "set_voice", soundId: null }] });
  });

  it("music in a chat whose tool list is older than add_audio: add_music upload gives a link, then the file goes under the edit", async () => {
    let link = "";
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "add_music", upload: true }] }), (e: Error) => {
      assert.match(e.message, /^Nothing changed yet\. Upload link for the audio file/);
      link = linkOf(e.message);
      return true;
    });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=12:sample_rate=44100", "-c:a", "libmp3lame", "-b:a", "128k", join(dir, "song.mp3")]);
    const j = JSON.parse((await send(link, readFileSync(join(dir, "song.mp3")), "?name=Client song")).body) as { id: string; status: string };
    assert.equal(j.status, "ready");
    const r = await tool("apply_edits", { projectId, edits: [{ op: "add_music", soundId: j.id, gainDb: -16 }] });
    assert.match(r.text, /Client song/, r.text);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const a2 = (p.timeline as { tracks: { a2: { soundId?: string; gainDb?: number }[] } }).tracks.a2;
    assert.ok(a2.some((m) => m.soundId === j.id && m.gainDb === -16), "under the edit as music");
  });

  it("a file that is not audio says why, and nothing is left half made", async () => {
    const out = await tool("add_audio", { upload: true });
    const r = await send(linkOf(out.text), Buffer.from("this is not audio at all, just text".repeat(50)), "?name=notes.txt");
    assert.equal(r.statusCode, 200, r.body);
    const j = JSON.parse(r.body) as { status: string; text: string };
    assert.equal(j.status, "failed");
    assert.match(j.text, /^Rendrr could not use "notes": That file has no sound Rendrr can read\./);
  });
});
