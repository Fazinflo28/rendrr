// A final from local footage reads the original the user gave. A renamed or re-saved copy is fine; a different video
// (another length) is refused before rendering, with both lengths, and deleted so the next export asks again.
// Needs ffmpeg, a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import { buildRawTimeline, FINAL_RENDER_STEPS, stubTranscript, type Snapshot } from "@rendrr/shared";

const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET && !!process.env.REDIS_URL;
const run6 = Math.random().toString(36).slice(2, 8);

describe("the original of local footage", { skip: !db && "needs a database, Redis and storage" }, () => {
  let dir = "", userId = "", projectId = "", videoId = "";
  const SECONDS = 3;
  const make = (name: string, d: number, vf = "null") => { const p = join(dir, name); execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${d}`, "-f", "lavfi", "-i", `sine=d=${d}`, "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", p]); return p; };
  // A small grey frame at t, to compare which way pictures face.
  const grey = (file: string, t: number) => new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=48:48:flags=area,format=gray", "-f", "rawvideo", "-"]));

  before(async () => {
    dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "orig-"));
    const { prisma } = await import("@rendrr/db");
    const { uploadFile } = await import("@rendrr/core");
    userId = (await prisma.user.create({ data: { clerkId: `orig_${run6}`, email: `orig-${run6}@test.rendrr.dev`, name: "Orig" } })).id;
    const folderId = (await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Orig's Workspace" } })).id;
    const proxyKey = `proxies/${userId}/talk.mp4`;
    await uploadFile(proxyKey, make("proxy.mp4", SECONDS), "video/mp4");
    const tr = stubTranscript(SECONDS);
    videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds: SECONDS, width: 640, height: 360, fps: 30, source: "local", status: "ready", hasAudio: true, proxyKey, originalName: "talk-compressed.mp4", originalSize: BigInt(1000),
      analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [] } } } })).id;
    const snap: Snapshot = { timeline: buildRawTimeline(tr, SECONDS, [], videoId), name: "Orig", aspect: "16:9", styleId: null };
    projectId = (await prisma.project.create({ data: { userId, folderId, videoId, name: "Orig", timeline: snap.timeline as never, aspect: "16:9", versions: { create: { v: 1, note: "test", timeline: snap as never, createdBy: "user" } } } })).id;
  });
  after(async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, redis } = await import("@rendrr/core");
    await prisma.tempOriginal.deleteMany({ where: { projectId } });
    await prisma.render.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await deletePrefix(`proxies/${userId}/`).catch(() => {});
    await deletePrefix(`temp-raw/${userId}/`).catch(() => {});
    await deletePrefix(`renders/${userId}/`).catch(() => {});
    await redis().quit().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const finalWith = async (file: string) => {
    const { prisma } = await import("@rendrr/db");
    const { uploadFile } = await import("@rendrr/core");
    const { PREFIX } = await import("@rendrr/shared");
    const key = `${PREFIX.tempRaw}${userId}/${projectId}-${Date.now()}.mp4`;
    await uploadFile(key, file, "video/mp4");
    const orig = await prisma.tempOriginal.create({ data: { projectId, videoId, key, uploadId: null, sizeBytes: BigInt(1), completed: true, expiresAt: new Date(Date.now() + 3600_000) } });
    const renderId = (await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "queued", steps: [...FINAL_RENDER_STEPS], quality: "1080p" } })).id;
    const { renderJob } = await import("../src/jobs/render");
    let thrown: Error | null = null;
    try { await renderJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { renderId } } } as unknown as Job); } catch (e) { thrown = e as Error; }
    return { thrown, origLeft: await prisma.tempOriginal.count({ where: { id: orig.id } }), render: await prisma.render.findUniqueOrThrow({ where: { id: renderId } }) };
  };

  it("a different video (another length) is refused with both lengths, and deleted", { timeout: 120_000 }, async () => {
    const { thrown, origLeft } = await finalWith(make("other.mp4", 7));
    console.log(thrown?.message);
    assert.match(thrown?.message || "", /^The file you gave is 0:07\.0 long; the footage is 0:03\.0, so it is a different video\. Export final again and pick 'talk-compressed\.mp4'\.$/);
    assert.equal((thrown as { code?: string })?.code, "wrong-file");
    assert.equal(origLeft, 0, "the wrong file is deleted, so the next export asks again");
  });

  it("a copy stored upside down still makes a final that faces like the preview", { timeout: 240_000 }, async () => {
    const { likeness } = await import("../src/lib/orient");
    const { downloadFile } = await import("@rendrr/core");
    const { thrown, render } = await finalWith(make("camera file upside down.mp4", SECONDS, "hflip,vflip"));
    assert.equal(thrown, null, thrown?.message);
    assert.equal(render.status, "done", render.error ?? "");
    const out = join(dir, "final.mp4");
    await downloadFile(render.outputKey!, out);
    const like = likeness(grey(out, 1.5), grey(join(dir, "proxy.mp4"), 1.5));
    console.log(`final vs preview copy at 1.5 s: likeness ${like.toFixed(2)}`);
    assert.ok(like > 0.8, `the final faces like the preview copy (${like})`);
  });

  it("a renamed copy of the same length makes the final", { timeout: 240_000 }, async () => {
    const { thrown, render } = await finalWith(make("talk FINAL renamed.mp4", SECONDS));
    assert.equal(thrown, null, thrown?.message);
    assert.equal(render.status, "done", render.error ?? "");
  });
});
