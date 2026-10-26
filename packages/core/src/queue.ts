import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES } from "@rendrr/shared";
import { env } from "./env";

// BullMQ needs its own connections; pub/sub needs dedicated ones too.
let conn: Redis | null = null;
export function redis(): Redis {
  if (!conn) conn = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, family: 0 });
  return conn;
}
export function newRedis(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, family: 0 });
}

export type QueueName = keyof typeof QUEUES;
const queues = new Map<string, Queue>();
export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) { q = new Queue(QUEUES[name].name, { connection: redis() }); queues.set(name, q); }
  return q;
}

export type ProxyJob = { videoId: string };
export type AnalyzeJob = { videoId: string };
export type RenderJob = { renderId: string };
/** params: record a variant of a custom graphic with these window.params (all of them, defaults filled in). */
export type GraphicJob = { graphicId: string; params?: Record<string, unknown> };
export type MaintenanceJob = { task: "cleanup" | "ensure-assets" };
/** Frames at given times: from a render (output times) or from footage / a reference (original times). */
export type FramesJob = { renderId?: string; videoId?: string; times: number[]; colorSamples?: ColorSampleJob };
/** Phase 6: small frames of clips as the editor shows them (turned, fitted), for shot matching. fitY: 0.4 for V1
 *  (40% down, like the render's fit), 0.5 for b-roll. */
export type ColorSampleJob = { w: number; h: number; clips: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: number; fitY: number }[] };
export type ColorSamples = Record<string, { w: number; h: number; rgb: string }>;
export type BreakdownJob = { videoId: string };

export async function enqueue<T extends object>(name: QueueName, data: T, opts: JobsOptions = {}) {
  const def = QUEUES[name];
  return queue(name).add(name, data, {
    attempts: def.attempts,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 7 * 86400, count: 2000 },
    removeOnFail: { age: 14 * 86400, count: 2000 },
    ...opts,
  });
}

// ---- live progress (renders, footage processing, project edits) ----
/** etaSec (Phase 7): seconds left, estimated; null while there is nothing to estimate from yet. */
export type RenderProgress = { status: "queued" | "running" | "done" | "failed"; step: number; steps: string[]; percent: number; etaSec?: number | null; error?: string; code?: string };
export const renderChannel = (id: string) => `render:${id}`;
export const projectChannel = (id: string) => `project:${id}`;

export async function publishRender(id: string, p: RenderProgress) {
  const r = redis();
  await r.set(renderChannel(id), JSON.stringify(p), "EX", 6 * 3600);
  await r.publish(renderChannel(id), JSON.stringify(p));
}
export async function readRender(id: string): Promise<RenderProgress | null> {
  const s = await redis().get(renderChannel(id));
  return s ? (JSON.parse(s) as RenderProgress) : null;
}
/** A custom graphic's recording progress, for list_graphics and create_graphic (kept an hour). */
export type GraphicProgress = { percent: number; etaSec: number | null };
const graphicKey = (id: string) => `graphic:${id}:progress`;
export async function publishGraphic(id: string, p: GraphicProgress) {
  await redis().set(graphicKey(id), JSON.stringify(p), "EX", 3600);
}
export async function readGraphic(id: string): Promise<GraphicProgress | null> {
  const s = await redis().get(graphicKey(id)).catch(() => null);
  return s ? (JSON.parse(s) as GraphicProgress) : null;
}

export async function publishProject(id: string, msg: { version: number; by: string; text?: string }) {
  await redis().publish(projectChannel(id), JSON.stringify(msg));
}
