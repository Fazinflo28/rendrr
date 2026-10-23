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
export type GraphicJob = { graphicId: string };
export type MaintenanceJob = { task: "cleanup" | "ensure-assets" };
/** Frames at given times: from a render (output times) or from footage / a reference (original times). */
export type FramesJob = { renderId?: string; videoId?: string; times: number[] };
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
export type RenderProgress = { status: "queued" | "running" | "done" | "failed"; step: number; steps: string[]; percent: number; error?: string; code?: string };
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
export async function publishProject(id: string, msg: { version: number; by: string; text?: string }) {
  await redis().publish(projectChannel(id), JSON.stringify(msg));
}
