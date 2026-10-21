import { enqueue, newRedis, signGet, type FramesJob } from "@rendrr/core";
import { QUEUES } from "@rendrr/shared";
import { QueueEvents } from "bullmq";

let events: QueueEvents | null = null;
/** Frames at exact output times from a finished render. The worker has FFmpeg; we wait up to 45 s. */
export async function framesFor(renderId: string, times: number[]): Promise<string[]> {
  events ||= new QueueEvents(QUEUES.frames.name, { connection: newRedis() });
  const job = await enqueue<FramesJob>("frames", { renderId, times: times.slice(0, 5) });
  const keys = (await job.waitUntilFinished(events, 45_000).catch(() => [])) as string[];
  return Promise.all((keys || []).map((k) => signGet(k, 900)));
}
