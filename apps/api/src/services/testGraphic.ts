// Engine Part 5: test_graphic. A few seconds of a graphic over the footage at 540p, made by the worker's test queue;
// the tool waits under 10 s for it. The same test asked again within a day answers from the kept result.
import { AppError, enqueue, getBytes, newRedis, notFound, signGet, type TestGraphicJob, type TestGraphicResult } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { findTemplate, PREFIX, QUEUES, type Aspect } from "@rendrr/shared";
import { QueueEvents } from "bullmq";
import { createHash } from "node:crypto";

/** Changes when the test draws differently, so kept results are made again. */
const VERSION = "t1";
/** How long the tool waits for the worker (clients drop calls after about a minute, some sooner). */
export const TEST_WAIT_MS = 9_500;
let events: QueueEvents | null = null;

type Input = { graphicId: string; params?: Record<string, unknown>; at?: number; seconds?: number; length?: number; over?: { videoId: string; time: number }; aspect?: Aspect };
const shape = (w?: number | null, h?: number | null): Aspect | undefined => (w && h ? (w < h ? "9:16" : w === h ? "1:1" : "16:9") : undefined);
const pc = (x: number) => (x === 0 ? "0" : x < 1 ? x.toFixed(1) : String(Math.round(x)));

export async function testGraphic(userId: string, i: Input): Promise<{ text: string; images: string[] }> {
  // Checked here first, so a wrong id or a graphic still recording answers at once.
  const tpl = findTemplate(i.graphicId);
  let name = tpl?.name ?? "", gShape: ReturnType<typeof shape>;
  if (!tpl) {
    const g = await prisma.graphic.findUnique({ where: { id: i.graphicId }, select: { ownerId: true, name: true, status: true, width: true, height: true, error: true } });
    if (!g || (g.ownerId && g.ownerId !== userId)) throw notFound("That graphic does not exist. list_graphics shows the templates and yours.");
    if (g.status === "failed") return { text: `Graphic ${i.graphicId} failed to record: ${g.error ?? "unknown error"}. Fix the code and call create_graphic again.`, images: [] };
    if (g.status !== "ready") return { text: `Graphic ${i.graphicId} is still recording: get_graphic shows how far it got. Test it once it is ready.`, images: [] };
    name = g.name; gShape = shape(g.width, g.height);
  }
  let videoName = "";
  let aspect = i.aspect;
  if (i.over) {
    const v = await prisma.video.findUnique({ where: { id: i.over.videoId }, select: { userId: true, name: true, width: true, height: true, status: true } });
    if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
    videoName = v.name;
    aspect ??= shape(v.width, v.height);
  }
  aspect ??= gShape ?? "16:9";
  const job: Omit<TestGraphicJob, "key"> = { userId, graphicId: i.graphicId, ...(i.params && Object.keys(i.params).length ? { params: i.params } : {}), at: i.at ?? 0, seconds: Math.min(5, Math.max(3, i.seconds ?? 4)), ...(i.length ? { length: i.length } : {}), aspect, ...(i.over ? { over: i.over } : {}) };
  const key = createHash("sha256").update(JSON.stringify([VERSION, job])).digest("hex").slice(0, 24);
  const t0 = Date.now();
  // The same test asked again within a day: the kept result.
  let r: TestGraphicResult | null = await getBytes(`${PREFIX.tests}${userId}/${key}.json`).then((b) => JSON.parse(b.toString()) as TestGraphicResult).catch(() => null);
  const kept = !!r;
  if (!r) {
    events ||= new QueueEvents(QUEUES.test.name, { connection: newRedis() });
    const j = await enqueue<TestGraphicJob>("test", { ...job, key }, { jobId: `test-${key}`, removeOnComplete: true, removeOnFail: true });
    try { r = (await j.waitUntilFinished(events, TEST_WAIT_MS)) as TestGraphicResult; }
    catch (e) {
      const msg = (e as Error).message || "";
      if (/timed out/i.test(msg)) return { text: `The test of "${name}" is still being drawn (over ${Math.round(TEST_WAIT_MS / 1000)} s: the worker is busy, or the graphic is slow to record). It keeps going: call test_graphic again with the same settings in a few seconds.`, images: [] };
      throw new AppError(`The test did not work: ${msg.slice(0, 300)}`, 400, "test-failed");
    }
  }
  const images = await Promise.all(r.frames.map((k) => signGet(k, 900)));
  const clip = await signGet(r.clip, 3600);
  const end = Math.round((r.from + r.seconds) * 100) / 100;
  const cover = r.cover ? `Of the frame: min ${pc(r.cover.min)}%, avg ${pc(r.cover.avg)}%, max ${pc(r.cover.max)}%, shows in ${r.cover.visible} of ${r.cover.samples} moments${r.cover.visible === 0 ? " (INVISIBLE: fully transparent at every moment)" : ""}` : "Its picture could not be measured";
  const face = r.face === undefined ? "" : r.face === null ? "; no face under it" : `; over the face up to ${pc(r.face.max)}% (at ${r.face.at}s of the test)`;
  const how = kept ? `the same test as before (kept a day), answered in ${((Date.now() - t0) / 1000).toFixed(1)} s` : `${r.recordedMs ? `recorded in ${(r.recordedMs / 1000).toFixed(1)} s, ` : ""}done in ${(r.totalMs / 1000).toFixed(1)} s`;
  return {
    text: `TEST "${name}"${job.params ? ` with ${JSON.stringify(job.params).slice(0, 200)}` : ""}: ${r.from}-${end}s of it over ${i.over ? `"${videoName}" from ${i.over.time}s` : "a plain grey frame"}, ${r.width}x${r.height} (${aspect}); ${how}. ${cover}${face}. 3 frames attached (${r.times.map((t) => `${t}s`).join(", ")} of the test). Clip (1 hour): ${clip}${r.warnings.length ? ` Warning: ${r.warnings.join(" ")}` : ""} Nothing was changed.`,
    images,
  };
}
