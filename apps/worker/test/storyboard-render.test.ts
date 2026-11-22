// Storyboard mode, drawn by the real render job: a board left to Rendrr gets its panels from the plan (the opening, the
// scenes, the title), each panel's picture is stored and says what is on screen, and the style sheet is read from the
// edit (captions, fonts, colours, the board's palette first). A board with its own panels keeps their words and draws
// its clip panel as a clip. A comment's drawing goes on its panel's picture for Claude (the frames job).
// Needs ffmpeg with libass, a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import { applyOp, buildInitialTimeline, STORYBOARD_STEPS, stubTranscript, type EditContext, type Op, type SamplePlan, type Snapshot } from "@rendrr/shared";

const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET && !!process.env.REDIS_URL;
const run6 = Math.random().toString(36).slice(2, 8);
const SECONDS = 20;

describe("a storyboard drawn by the render job", { skip: !db && "needs a database, Redis and storage" }, () => {
  let dir = "", userId = "", projectId = "", videoId = "";
  before(async () => {
    dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "board-"));
    const { prisma } = await import("@rendrr/db");
    const { uploadFile } = await import("@rendrr/core");
    userId = (await prisma.user.create({ data: { clerkId: `board_${run6}`, email: `board-${run6}@test.rendrr.dev`, name: "Board" } })).id;
    const folderId = (await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Board's Workspace" } })).id;
    const proxy = join(dir, "proxy.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=d=${SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", proxy]);
    const proxyKey = `proxies/${userId}/talk.mp4`;
    await uploadFile(proxyKey, proxy, "video/mp4");
    const tr = stubTranscript(SECONDS);
    videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds: SECONDS, width: 640, height: 360, fps: 30, source: "drive", status: "ready", hasAudio: true, proxyKey,
      analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [] } } } })).id;
    const ctx = { videoId, transcript: tr, silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined } as unknown as EditContext;
    // Three scenes (0-5, 8-13, 15-19 s of footage: 14 s), captions on with a green spoken word, a title at 6 s.
    const snap = applyOp({ timeline: buildInitialTimeline(tr, SECONDS, "clean", [], videoId), name: "Board", aspect: "16:9", styleId: null }, { op: "batch", ops: [
      { op: "set_clips", track: "v1", clips: [{ start: 0, end: 5, label: "" }, { start: 8, end: 13, label: "" }, { start: 15, end: 19, label: "" }] },
      { op: "set_captions", on: true }, { op: "set_caption_style", highlight: "#34C759", wordsAtOnce: 3 },
      { op: "add_text", text: "Meet Fontora", start: 6, end: 8, edit: true, anim: "fade", font: "Poppins", color: "#0B3D2E", y: 0.3 },
      { op: "set_audio", loudness: null },
    ] } as Op, ctx).snap as Snapshot;
    projectId = (await prisma.project.create({ data: { userId, folderId, videoId, name: "Board", timeline: snap.timeline as never, aspect: "16:9", outputSeconds: 14, versions: { create: { v: 1, note: "test", timeline: snap as never, createdBy: "user" } } } })).id;
  });
  after(async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, redis } = await import("@rendrr/core");
    await prisma.render.deleteMany({ where: { projectId } });
    await prisma.projectComment.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await deletePrefix(`proxies/${userId}/`).catch(() => {});
    await deletePrefix(`previews/${userId}/`).catch(() => {});
    await deletePrefix(`comments/${userId}/`).catch(() => {});
    await redis().quit().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const draw = async (samples: SamplePlan) => {
    const { prisma } = await import("@rendrr/db");
    const { renderJob } = await import("../src/jobs/render");
    const renderId = (await prisma.render.create({ data: { projectId, userId, kind: "sample", version: 1, status: "queued", steps: [...STORYBOARD_STEPS], quality: "540p", plan: { samples } as never } })).id;
    await renderJob({ signal: new AbortController().signal, dir: await mkdtemp(join(dir, "job-")), isLastAttempt: true, job: { data: { renderId } } } as unknown as Job);
    const r = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
    return { r, sp: (r.plan as { samples: SamplePlan }).samples };
  };

  it("left to Rendrr: panels from the plan, each picture stored with what is on screen, and the style sheet", { timeout: 300_000 }, async () => {
    const { headObject } = await import("@rendrr/core");
    const { r, sp } = await draw({ items: [], board: { title: "Board", rules: ["Captions 3 words at a time"], palette: [{ hex: "#0B3D2E", name: "ink" }], auto: true, status: "review" } });
    assert.equal(r.status, "done", r.error ?? "");
    assert.deepEqual(sp.items.map((x) => x.title), ["Opening", "Meet Fontora", "Scene 3"]);
    assert.equal(sp.done?.length, 3);
    for (const d of sp.done!) assert.ok(await headObject(d.still), `the picture of ${d.title} is stored`);
    assert.match(sp.done![1].onScreen ?? "", /^Meet Fontora/);
    assert.match(sp.done![0].onScreen ?? "", /\w/, "a caption is on screen at the opening");
    const st = sp.board!.style!;
    assert.equal(st.captions?.highlight, "#34C759");
    assert.equal(st.captions?.animation, "3 words at a time, the spoken word lit in #34C759");
    assert.deepEqual(st.fonts.map((f) => f.font), ["Inter", "Poppins"]);
    assert.deepEqual(st.colors[0], { hex: "#0B3D2E", name: "ink, title text" });
    assert.deepEqual(st.texts, { count: 1, animations: ["fade"] });
    assert.equal(st.pacing, "2 cuts in 0:14 (8.6 a minute)");
    assert.equal(sp.board!.status, "review");
    assert.deepEqual(sp.board!.rules, ["Captions 3 words at a time"]);
  });

  it("its own panels keep their words, a clip panel is a clip; a drawing goes on its panel's picture for Claude", { timeout: 300_000 }, async () => {
    const { headObject, putObject } = await import("@rendrr/core");
    const { framesJob } = await import("../src/jobs/frames");
    const { sp, r } = await draw({ items: [{ kind: "frame", at: 1, title: "Hook", caption: "Still downloading icons?" }, { kind: "clip", at: 6, end: 8, title: "Title", shot: "The title fades in" }], board: { title: "Mine", rules: [], palette: [], status: "review" } });
    assert.equal(r.status, "done", r.error ?? "");
    assert.deepEqual(sp.done!.map((x) => [x.kind, x.title, x.caption ?? x.shot]), [["frame", "Hook", "Still downloading icons?"], ["clip", "Title", "The title fades in"]]);
    assert.ok(sp.done![1].clip && await headObject(sp.done![1].clip), "the clip panel's video is stored");
    // A red stroke drawn on panel 1, laid on its picture.
    const png = join(dir, "ink.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black@0.0:s=640x360,format=rgba,drawbox=x=100:y=100:w=200:h=20:color=red@1:t=fill", "-frames:v", "1", png]);
    const { readFile } = await import("node:fs/promises");
    const inkKey = `comments/${userId}/${projectId}/k1/drawing-test.png`;
    await putObject(inkKey, await readFile(png), "image/png");
    const keys = await framesJob({ signal: new AbortController().signal, dir: await mkdtemp(join(dir, "frames-")), isLastAttempt: true, job: { data: { renderId: r.id, times: [], stills: [{ key: sp.done![0].still, overlay: inkKey }] } } } as unknown as Job) as string[];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /-s0-drawn-drawing-test\.jpg$/);
    assert.ok(await headObject(keys[0]));
    const { prisma } = await import("@rendrr/db");
    assert.ok(((await prisma.render.findUniqueOrThrow({ where: { id: r.id } })).framesKeys as string[]).includes(keys[0]), "kept with the storyboard's files");
  });
});
