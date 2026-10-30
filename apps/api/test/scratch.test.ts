// An edit from scratch (no footage): create_project blank makes a blank canvas (the worker's real canvas job, FFmpeg)
// and an edit on it that plays the length asked; the canvas is hidden from the library and the AI's footage list,
// and graphics and text go on it like on footage. Needs a database, Redis, storage and FFmpeg.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("edits from scratch", { skip: (!ready || !ff) && "needs a database, Redis, storage and FFmpeg" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { MCP_TOOLS, QUEUES } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { closeCanvasEvents } = await import("../src/services/canvas");
  const { deletePrefix, downloadFile, newRedis, redis } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { canvasJob } = await import("../../worker/src/jobs/canvas");

  let userId = "";
  const dir = mkdtempSync(join(tmpdir(), "scratch-"));
  let worker: InstanceType<typeof Worker> | null = null;
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `scr_${run}`, email: `scr-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    worker = new Worker(QUEUES.test.name, async (job) => canvasJob({ job, dir, signal: new AbortController().signal, isLastAttempt: true } as never), { connection: newRedis() as never });
  });
  after(async () => {
    await worker?.close();
    await closeCanvasEvents();
    const vids = await prisma.video.findMany({ where: { userId }, select: { id: true } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    for (const v of vids) await deletePrefix(`canvas/${v.id}`).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("makes a blank canvas of the shape and colour, and an edit that plays the length asked", async () => {
    const t0 = Date.now();
    const out = await tool("create_project", { blank: { seconds: 12, color: "#112233" }, aspect: "9:16", name: `Launch ${run}` });
    const id = (out.data as { projectId: string }).projectId;
    assert.match(out.text, new RegExp(`^Created edit "Launch ${run}" \\(${id}\\) from scratch: a blank 12s canvas, #112233, 9:16 \\(final 1080x1920\\), silent; V1 is the canvas clip \\w+ \\(trim_clip it to change the length, up to 72s\\)\\.`));
    assert.ok(Date.now() - t0 < 30_000, "made in seconds");
    const p = await prisma.project.findUniqueOrThrow({ where: { id }, include: { video: true, versions: true } });
    assert.equal(p.aspect, "9:16");
    assert.equal(p.video.kind, "canvas");
    assert.equal(p.video.status, "ready");
    assert.equal(p.video.previewExpiresAt, null);
    assert.equal(p.versions[0].note, "Blank canvas, 12 s");
    const v1 = (p.timeline as unknown as { tracks: { v1: { sourceIn: number; sourceOut: number }[] } }).tracks.v1;
    assert.deepEqual(v1.map((c) => [c.sourceIn, c.sourceOut]), [[0, 12]]);
    // The file: 1080x1920, 30 fps, 72 s, the colour asked, with a silent sound track.
    const file = join(dir, "canvas-check.mp4");
    await downloadFile(p.video.proxyKey!, file);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", file]).toString();
    const j = JSON.parse(probe) as { streams: { codec_type: string; width?: number; height?: number; r_frame_rate: string }[]; format: { duration: string } };
    const vs = j.streams.find((s) => s.codec_type === "video")!;
    assert.deepEqual([vs.width, vs.height, vs.r_frame_rate], [1080, 1920, "30/1"]);
    assert.ok(j.streams.some((s) => s.codec_type === "audio"));
    assert.ok(Math.abs(Number(j.format.duration) - 72) < 0.1, j.format.duration);
    const px = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "scale=1:1:in_color_matrix=bt709:in_range=tv,format=rgb24", "-f", "rawvideo", "pipe:1"]);
    assert.ok(Math.abs(px[0] - 0x11) <= 3 && Math.abs(px[1] - 0x22) <= 3 && Math.abs(px[2] - 0x33) <= 3, `colour ${[...px].join(",")}`);
  });

  it("graphics and text go on it, the length changes with trim_clip, and the canvas is not footage in any list", async () => {
    const out = await tool("create_project", { blank: { seconds: 20 }, name: `Explainer ${run}` });
    const id = (out.data as { projectId: string }).projectId;
    const clip = ((await prisma.project.findUniqueOrThrow({ where: { id } })).timeline as unknown as { tracks: { v1: { id: string }[] } }).tracks.v1[0].id;
    const r = await tool("apply_edits", { projectId: id, edits: [{ op: "add_text", text: "Ship faster", start: 0.5, end: 3, preset: "title" }, { op: "trim_clip", track: "v1", clipId: clip, start: 0, end: 30 }] });
    assert.match(r.text, /^Done \(v2, 30\.0s of 80\.0s\)/);
    const list = await tool("list_footage", {});
    assert.doesNotMatch(list.text, /canvas/);
    assert.doesNotMatch(list.text, new RegExp(`Explainer ${run}`));
    const gp = await tool("get_project", { projectId: id, clipsLimit: 2 });
    assert.match(gp.text, /Export \(final\): 1080p 1920x1080 16:9, H\.264, 30 fps \(the footage's\)\.$/m); // no "scaled up": a canvas has no picture to scale
  });

  it("refuses footage with blank, and lengths outside 1 s to an hour", async () => {
    await assert.rejects(tool("create_project", { blank: { seconds: 10 }, videoId: "x" }), /without videoId/);
    assert.throws(() => MCP_TOOLS.find((t) => t.name === "create_project")!.input.parse({ blank: { seconds: 4000 } }));
    assert.throws(() => MCP_TOOLS.find((t) => t.name === "create_project")!.input.parse({ blank: { seconds: 10, color: "red" } }));
  });
});
