import { enqueue, newRedis, signGet, type FramesJob } from "@rendrr/core";
import { QUEUES } from "@rendrr/shared";
import { QueueEvents } from "bullmq";

let events: QueueEvents | null = null;
async function take(data: FramesJob): Promise<string[]> {
  events ||= new QueueEvents(QUEUES.frames.name, { connection: newRedis() });
  const job = await enqueue<FramesJob>("frames", data);
  const keys = (await job.waitUntilFinished(events, 45_000).catch(() => [])) as string[];
  return Promise.all((keys || []).map((k) => signGet(k, 900)));
}

/** Frames at exact output times from a finished render. The worker has FFmpeg; we wait up to 45 s. */
export const framesFor = (renderId: string, times: number[], overlays?: (string | null)[]) => take({ renderId, times: times.slice(0, 5), ...(overlays ? { overlays: overlays.slice(0, 5) } : {}) });

/** Frames at exact times (original seconds) from a video's preview copy: footage or a reference. */
export const videoFramesFor = (videoId: string, times: number[]) => take({ videoId, times: times.slice(0, 8) });

/** A storyboard's panel pictures with a comment's drawing laid on each (kept with the storyboard's files). */
export const stillsFor = (renderId: string, stills: { key: string; overlay: string }[]) => take({ renderId, times: [], stills: stills.slice(0, 6) });
