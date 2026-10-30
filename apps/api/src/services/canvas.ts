import { AppError, enqueue, newRedis, type CanvasJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { aspectSize, CANVAS_MAX_SECONDS, canvasFileSeconds, orientationOf, QUEUES, type Aspect } from "@rendrr/shared";
import { QueueEvents } from "bullmq";

// An edit made from scratch (no footage, like a composition in After Effects): its V1 is a blank canvas, a solid colour
// with a silent sound track, made by the worker in a few seconds. Graphics, text, music and sound effects go on top,
// and everything else (the editor, renders, checks) works as with footage. The canvas is hidden from the library.

let events: QueueEvents | null = null;
const WAIT_MS = 45_000;

export async function createCanvas(userId: string, o: { seconds: number; aspect: Aspect; color?: string; name: string }) {
  if (!(o.seconds >= 1 && o.seconds <= CANVAS_MAX_SECONDS)) throw new AppError(`A blank edit lasts 1 s to ${CANVAS_MAX_SECONDS / 60} minutes.`, 400, "invalid-input");
  const color = (o.color || "#000000").toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw new AppError("The canvas colour is #RRGGBB, for example #0B0B10.", 400, "invalid-input");
  const { width, height } = aspectSize(o.aspect, 1080);
  const seconds = canvasFileSeconds(o.seconds);
  const v = await prisma.video.create({ data: {
    userId, name: `${o.name.slice(0, 180)} (canvas)`, kind: "canvas", source: "canvas", status: "processing", seconds, width, height, fps: 30,
    orientation: orientationOf(width, height), hasAudio: true, art: "a",
  } });
  events ||= new QueueEvents(QUEUES.test.name, { connection: newRedis() });
  const job = await enqueue<CanvasJob>("test", { kind: "canvas", videoId: v.id, width, height, seconds, color });
  try {
    await job.waitUntilFinished(events, WAIT_MS);
  } catch (e) {
    await prisma.video.update({ where: { id: v.id }, data: { status: "failed", error: "The canvas could not be made" } }).catch(() => {});
    const msg = (e as Error).message || "";
    throw new AppError(/timed out/i.test(msg) ? "Making the blank canvas took too long. Try again in a moment." : `Could not make the blank canvas: ${msg.slice(0, 200)}`, 503, "canvas");
  }
  return prisma.video.findUniqueOrThrow({ where: { id: v.id }, include: { analysis: true } });
}

export async function closeCanvasEvents() { await events?.close(); events = null; }
