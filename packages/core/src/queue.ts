import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type Aspect } from "@rendrr/shared";
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
/** A finished final copied into the user's Google Drive (the render's driveSave says where). */
export type DriveSaveJob = { renderId: string };
/** params: record a variant of a custom graphic with these window.params (all of them, defaults filled in). */
export type GraphicJob = { graphicId: string; params?: Record<string, unknown> };
/** remove_background: one block of a video's matte (footage k x MATTE_BLOCK s on), made ahead of the render. */
export type MatteJob = { videoId: string; userId: string; k: number; turn: number };
export type MaintenanceJob = { task: "cleanup" | "ensure-assets" | "stuck" | "storage" };
/** Frames at given times: from a render (output times) or from footage / a reference (original times). */
/** overlays: a PNG (storage key) laid over the frame at the same index, the drawing on a comment (the app in the chat). */
export type FramesJob = { renderId?: string; videoId?: string; times: number[]; overlays?: (string | null)[]; colorSamples?: ColorSampleJob; faces?: FaceJob; track?: TrackJob };
/** Object tracking: a box drawn at footage second `at` on a clip's fitted frame (shares), followed over [srcIn, srcOut]. */
export type TrackJob = { videoId: string; srcIn: number; srcOut: number; rotate: number; fitY: number; focus?: { x: number; y: number }; w: number; h: number; at: number; box: { x: number; y: number; w: number; h: number } };
/** Phase 6: small frames of clips as the editor shows them (turned, fitted), for shot matching. fitY: 0.4 for V1
 *  (40% down, like the render's fit), 0.5 for b-roll; focus: a reframed V1 clip's (the fit cuts around it). */
export type ColorSampleJob = { w: number; h: number; clips: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: number; fitY: number; focus?: { x: number; y: number } }[] };
export type ColorSamples = Record<string, { w: number; h: number; rgb: string }>;
/** Where the face is in V1 clips (set_framing fitFaceTo), found on 3 frames per clip turned and fitted at w x h. */
export type FaceJob = ColorSampleJob;
/** By clip: the face's centre (u across, v down, 0-1 of the fitted frame) and half its height as a share of the
 *  frame's, the median of the frames it was found on (found of `of`); null when no frame had a face. */
export type FaceSamples = Record<string, { u: number; v: number; r: number; found: number; of: number } | null>;
export type BreakdownJob = { videoId: string };
/** The deeper measurements of a video (sound every 10 ms, word alignment, faces and picture). */
/** force: measure again even when the video already has this version's measurements (its analysis just ran). */
export type DeepJob = { videoId: string; force?: boolean };
/** Engine Part 5: test_graphic. A few seconds of a graphic (a template or a custom graphic, with these params) over a
 *  video at a time, or a plain frame, at 540p. key: the test's hash (its files and result are kept under it a day). */
/** One picture of a page drawn by the graphics browser (a library item's preview frame, a sheet of icons), stored at
 *  `${PREFIX.tests}${userId}/${key}.png`. Sent on the test queue: `kind` tells it from a TestGraphicJob. */
/** Engine Part 4.4: measure a reference video into the style file row styleFileId. */
export type StyleJob = { styleFileId: string };
/** A blank canvas for an edit made from scratch: a solid colour, silent, at the edit's shape (the test queue). */
export type CanvasJob = { kind: "canvas"; videoId: string; width: number; height: number; seconds: number; color: string };
/** The user's own audio file (add_audio): the file as sent (srcKey) made into AAC 48 kHz stereo, its length measured. */
export type SoundJob = { kind: "sound"; soundId: string; srcKey: string };
/** An element (a logo or overlay picture, Assets page): the picture as sent (srcKey, kept) made into a 1 s transparent
 *  WebM that plays as a graphic, and a small PNG thumbnail (the test queue). */
export type ElementJob = { kind: "element"; graphicId: string; srcKey: string };
/** Phase 22: read the start timecode of videos whose timecode was never read (made before it was read on probe). */
export type TimecodeJob = { kind: "timecode"; videoIds: string[] };
export type SnapshotJob = { kind: "snapshot"; userId: string; key: string; html: string; width: number; height: number; at: number };
export type SnapshotResult = { image: string; width: number; height: number; errors: string[]; ms: number };
/** fresh: a custom graphic drawn from its code for this test (rerecord), not from a kept recording. */
export type TestGraphicJob = { userId: string; key: string; graphicId: string; params?: Record<string, unknown>; fresh?: boolean; at: number; seconds: number; length?: number; aspect: Aspect; over?: { videoId: string; time: number } };
/** Storage keys of the clip and its frames (at `times`, test seconds); how long the graphic took to record (0: it had
 *  a recording) and the whole test; what of the frame and of the face it covers (Engine Part 3's measures). */
export type TestGraphicResult = {
  clip: string; frames: string[]; times: number[]; width: number; height: number; from: number; seconds: number; recordedMs: number; totalMs: number;
  cover: { min: number; avg: number; max: number; samples: number; visible: number } | null; face: { max: number; at: number; of: number } | null | undefined; warnings: string[];
};
/** Engine Part 3: a finished preview's sound transcribed again (its render's plan keeps it as `heard`). */
export type HeardJob = { renderId: string };
/** Where a video's deeper measurements are: the step, its percent and the time left (Redis, an hour). */
export type DeepProgress = { step: string; percent: number; etaSec: number | null };
const deepKey = (videoId: string) => `deep:${videoId}:progress`;
export async function writeDeepProgress(videoId: string, p: DeepProgress | null) {
  if (p) await redis().set(deepKey(videoId), JSON.stringify(p), "EX", 3600).catch(() => {});
  else await redis().del(deepKey(videoId)).catch(() => {});
}
export async function readDeepProgress(videoId: string): Promise<DeepProgress | null> {
  const s = await redis().get(deepKey(videoId)).catch(() => null);
  return s ? (JSON.parse(s) as DeepProgress) : null;
}

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
/** on: where the render is being made now ("mac": the user's Mac app took it; device: that Mac's name). */
export type RenderProgress = { status: "queued" | "running" | "done" | "failed"; step: number; steps: string[]; percent: number; etaSec?: number | null; error?: string; code?: string; on?: "mac" | "cloud"; device?: string | null };
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
