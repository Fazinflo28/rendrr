// Phase 2 in the API: projects stored in model A are converted to sequences at start-up (backed up first, only when
// the render stays the same), new edits are sequences, the AI tools read and edit sequences with clips from other
// videos, and the check knows them. Needs a database and Redis (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("the sequence model in the API", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { buildInitialTimelineA, removeRangeFromTrack, isSequence, stubTranscript } = await import("@rendrr/shared");
  const { planRender } = await import("@rendrr/shared/renderPlan");
  const { planDifferences } = await import("@rendrr/shared/migrate");
  const { migrateToSequences } = await import("../src/services/sequence");
  const { projectFull } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");

  let userId = "", projectId = "", videoId = "", otherId = "";
  const tr = stubTranscript(30);
  const words = tr.flatMap((l) => l.words);
  const c = () => ({ userId, ai: "claude" as const, clerkId: `seq_${run}` });
  let aTimeline: ReturnType<typeof buildInitialTimelineA>;
  const changed = new Date("2026-01-02T03:04:05Z");

  before(async () => {
    const u = await prisma.user.create({ data: { clerkId: `seq_${run}`, email: `seq-${run}@test.rendrr.dev`, name: "Seq" } });
    userId = u.id;
    const folder = await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Seq's Workspace" } });
    const v = await prisma.video.create({ data: { userId, name: `Main ${run}`, seconds: 30, width: 1920, height: 1080, source: "local", status: "ready", analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [] } } } });
    videoId = v.id;
    const o = await prisma.video.create({ data: { userId, name: `Second camera ${run}`, seconds: 12, width: 1280, height: 720, source: "local", status: "ready", analysis: { create: { transcriber: "stub", transcript: stubTranscript(12) as never, silences: [], sceneCuts: [], keyFrames: [] } } } });
    otherId = o.id;
    // An edit stored before Phase 2: model A with cut words, a removed range and a zoom.
    let a = buildInitialTimelineA(tr, 30, "clean", [words[4].id, words[5].id]);
    a = { ...a, tracks: { ...a.tracks, v1: removeRangeFromTrack(a.tracks.v1, 12, 14), a1: removeRangeFromTrack(a.tracks.a1, 12, 14), v2: [{ id: "z1", start: 16, end: 18, label: "Zoom", kind: "zoom", zoom: 1.2 } as never] } };
    aTimeline = a;
    const p = await prisma.project.create({ data: { userId, folderId: folder.id, videoId, styleId: "s2", name: `Old edit ${run}`, timeline: a as never, updatedAt: changed,
      versions: { create: { v: 1, note: "Footage as recorded", timeline: { timeline: a, name: "Old", aspect: "16:9", styleId: "s2" } as never, createdBy: "user", sealed: true } } } });
    projectId = p.id;
  });

  after(async () => {
    await prisma.timelineBackup.deleteMany({ where: { projectId } });
    await prisma.user.deleteMany({ where: { clerkId: `seq_${run}` } });
    await prisma.$disconnect();
    redis().disconnect();
  });

  it("converts a model A project at start-up: backed up first, same render, its place in the list kept", async () => {
    await migrateToSequences();
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.ok(isSequence(p.timeline as never));
    assert.equal(p.updatedAt.toISOString(), changed.toISOString());
    const backup = await prisma.timelineBackup.findFirstOrThrow({ where: { projectId } });
    assert.equal(backup.model, "A");
    assert.deepEqual(backup.timeline, JSON.parse(JSON.stringify(aTimeline)));
    const source = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };
    const before = planRender({ kind: "preview", snapshot: { timeline: aTimeline, name: "x", aspect: "16:9", styleId: "s2" }, transcript: tr, source, videoId });
    const after = planRender({ kind: "preview", snapshot: { timeline: p.timeline as never, name: "x", aspect: "16:9", styleId: "s2" }, transcript: tr, source, videoId });
    assert.equal(before.model, "A");
    assert.equal(after.model, "B");
    assert.deepEqual(planDifferences(before, after), []);
    // A second start changes nothing.
    assert.equal((await migrateToSequences()).converted, 0);
    assert.equal(await prisma.timelineBackup.count({ where: { projectId } }), 1);
  });

  it("the AI adds another video's clip, sets a J cut and reads the sequence back", async () => {
    const p0 = await projectFull(userId, projectId);
    const v1 = (p0.timeline as { tracks: { v1: { id: string }[] } }).tracks.v1;
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "add_clip", videoId: otherId, from: 1, to: 4, index: 1 }, { op: "set_audio_offset", clipId: v1[1].id, start: -0.4 }] });
    assert.match(r.text, /Done \(v2/);
    assert.match(r.text, /added clip/);
    const read = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(read.text, new RegExp(`${otherId} 1.00-4.00 @`));
    assert.match(read.text, /J -0.40/);
    const full = await projectFull(userId, projectId);
    assert.ok((full as { videos: Record<string, { name: string }> }).videos[otherId], "the editor gets the other video");
  });

  it("Phase 3: the AI sets the sound in one call; get_project reads it back; the editor gets the music file", async () => {
    const p0 = await projectFull(userId, projectId);
    const v1 = (p0.timeline as { tracks: { v1: { id: string }[] } }).tracks.v1;
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [
      { op: "set_audio", cleanup: "voice", duck: 10, fadeOut: 1 },
      { op: "add_music", trackId: "m_lofi" },
      { op: "set_clip_audio", clipId: v1[0].id, gainDb: 3, fadeIn: 0.2 },
    ] });
    assert.match(r.text, /Done \(v3/);
    const read = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(read.text, /Sound: cleanup voice, -14 LUFS \/ -1 dBTP, music 10 dB down under speech, mix fades in 0s, out 1s/);
    assert.match(read.text, /dialogue \+3 dB/);
    const full = (await projectFull(userId, projectId)) as { audioMedia: Record<string, string> };
    assert.deepEqual(Object.keys(full.audioMedia), ["assets/music/m_lofi.m4a"]);
    assert.match(full.audioMedia["assets/music/m_lofi.m4a"], /^https?:\/\/.+m_lofi\.m4a/);
  });

  it("Phase 4: save_style keeps a full caption style; apply_style gives it to an edit; text layers read back", async () => {
    const { presetStyle } = await import("@rendrr/shared");
    const saved = await TOOL_HANDLERS.save_style(c(), { name: `Yellow words ${run}`, rules: { captions: { on: true, look: "bold", style: { ...presetStyle("bold", "16:9"), font: "Montserrat", weight: 900, highlight: "#FFD400" } } } });
    assert.match(saved.text, /Captions: Montserrat 900, [\d.]+% size, #0A0A0C, box #FCFDFF 100%, upper case, active word #FFD400/);
    const styleId = (saved.data as { styleId: string }).styleId;
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "apply_style", styleId }, { op: "add_text", text: "Hello", start: 1, end: 3, preset: "callout" }] });
    assert.match(r.text, /Done \(v4/);
    const read = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(read.text, /Captions on \(own style: Montserrat 900/);
    assert.match(read.text, /text="Hello" \(Inter 800, 5% size, #0A0A0C, box #FFD400 100%/);
    await prisma.style.delete({ where: { id: styleId } });
  });

  it("Phase 5: speed, a freeze, a transition and keyframes in one call; get_project reads them back", async () => {
    const before = await TOOL_HANDLERS.get_project(c(), { projectId });
    const rows = Array.from(before.text.matchAll(/^ {2}(\S+) main ([\d.]+)-[\d.]+ @/gm));
    const ids = rows.map((m) => m[1]);
    assert.ok(ids.length >= 2, "two clips on V1");
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [
      { op: "set_speed", clipId: ids[0], speed: 2 },
      { op: "set_transition", clipId: ids[1], type: "dip-black", duration: 0.4 },
      { op: "set_keyframes", clipId: ids[1], keys: [{ t: 0, scale: 1 }, { t: 0.5, scale: 1.2, ease: "out" }] },
      { op: "freeze_frame", clipId: ids[1], at: Number(rows[1][2]), length: 0.5 },
    ] });
    assert.match(r.text, /Done \(v5/);
    assert.match(r.text, /2x \(sound pitch kept\)/);
    const read = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(read.text, new RegExp(`${ids[0]} main .* 2x \\(sound pitch kept\\)`));
    assert.match(read.text, /freeze 0\.5s \(silent\)/);
    assert.match(read.text, /dip-black 0\.4s in/);
    assert.match(read.text, /keys 0\.00,0\.50s/);
    // A bad op is refused with the reason, and nothing is saved.
    await assert.rejects(async () => TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "set_speed", clipId: ids[0], speed: 50 }] }), /speed number must be less than or equal to 10/);
    assert.match((await TOOL_HANDLERS.get_project(c(), { projectId })).text, /v5/);
  });

  it("Phase 6: a grade with an imported LUT, a key, masks, blur and match_color measured by the worker; get_project and the check read them back", async (t) => {
    const { putObject } = await import("@rendrr/core");
    // Storage and FFmpeg are needed (the worker reads frames of the clips' preview copies to measure them).
    try { await putObject(`luts/${userId}/probe.txt`, "x", "text/plain"); } catch { t.skip("needs the storage in .env (S3_ENDPOINT)"); return; }
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Worker } = await import("bullmq");
    const { newRedis, uploadFile } = await import("@rendrr/core");
    const { QUEUES } = await import("@rendrr/shared");
    const { framesJob } = await import("../../worker/src/jobs/frames");
    const dir = mkdtempSync(join(tmpdir(), "p6-api-"));
    // The main footage's preview copy: a dark blue picture; the second camera's: brighter and warmer.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=30,format=gbrp,geq=r='20+X*0.2':g='30+Y*0.4':b='80+X*0.3'", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "main.mp4")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=12,format=gbrp,geq=r='120+X*0.3':g='80+Y*0.4':b='40+X*0.2'", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "other.mp4")]);
    await uploadFile(`proxies/${userId}/${videoId}.mp4`, join(dir, "main.mp4"), "video/mp4");
    await uploadFile(`proxies/${userId}/${otherId}.mp4`, join(dir, "other.mp4"), "video/mp4");
    await prisma.video.update({ where: { id: videoId }, data: { proxyKey: `proxies/${userId}/${videoId}.mp4`, hdr: "pq" } });
    await prisma.video.update({ where: { id: otherId }, data: { proxyKey: `proxies/${userId}/${otherId}.mp4` } });
    const conn = newRedis();
    const worker = new Worker(QUEUES.frames.name, async (job) => framesJob({ job, dir, signal: new AbortController().signal, isLastAttempt: true } as never), { connection: conn });
    try {
      // An imported LUT, as the upload route stores it.
      const cube = ["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b}`)))].join("\n");
      const lut = await prisma.lut.create({ data: { userId, name: "Identity", key: `luts/${userId}/id.cube`, kind: "3d", size: 2 } });
      await putObject(lut.key, cube, "text/plain");
      const before = await TOOL_HANDLERS.get_project(c(), { projectId });
      assert.match(before.text, new RegExp(`Your LUTs \\(set_grade lut id\\): ${lut.id} "Identity"`));
      assert.match(before.text, /HDR PQ: the final keeps it/);
      const ids = Array.from(before.text.matchAll(/^ {2}(\S+) (main|\S+) ([\d.]+)-[\d.]+ @/gm)).map((m) => ({ id: m[1], video: m[2] }));
      const main = ids.find((x) => x.video === "main")!.id, other = ids.find((x) => x.video === otherId)!.id;
      const r = await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [
        { op: "set_grade", clipId: other, exposure: 0.3, lut: { id: lut.id, amount: 0.5 } },
        { op: "match_color", clipIds: [main], to: other },
        { op: "set_key", clipId: other, color: "#00B140" },
        { op: "set_masks", clipId: other, masks: [{ shape: "ellipse", x: 0.1, y: 0.1, w: 0.8, h: 0.8, feather: 0.05 }] },
        { op: "set_effects", clipId: main, effects: [{ type: "blur", amount: 20, area: { shape: "rect", x: 0, y: 0, w: 0.3, h: 0.3 } }] },
      ] });
      assert.match(r.text, /grade exposure \+0\.3, LUT "Identity" 50%/);
      assert.match(r.text, /matched to .* \(measured\): /);
      const read = await TOOL_HANDLERS.get_project(c(), { projectId });
      // The dark blue clip got curves that lift it towards the warm reference (red up, blue down at the middle).
      const proj = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const g = (proj.timeline as { tracks: { v1: { id: string; grade?: { curves?: Record<string, [number, number][]> } }[] } }).tracks.v1.find((x) => x.id === main)!.grade!;
      const mid = (ch: string) => g.curves![ch][2];
      assert.ok(mid("r")[1] > mid("r")[0] + 0.2, `red lifted (${mid("r")})`);
      assert.ok(mid("b")[1] < mid("b")[0], `blue lowered (${mid("b")})`);
      assert.match(read.text, /Looks: grade (saturation \d+%, )?curves r\/g\/b on [^;]+; grade exposure \+0\.3, LUT "Identity" 50% on /);
      assert.match(read.text, /key #00B140 similarity 0\.25 blend 0\.1 spill 0\.5 on /);
      assert.match(read.text, /look: grade, key, 1 mask/);
      // A clip that is not there: refused, with the reason.
      await assert.rejects(async () => TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "match_color", clipIds: ["nope"], to: main }] }), /no clip "nope"/);
    } finally {
      await worker.close();
      conn.disconnect();
      await (await import("../src/services/color")).closeColorEvents();
      rmSync(dir, { recursive: true, force: true });
      await prisma.lut.deleteMany({ where: { userId } });
    }
  });
});

