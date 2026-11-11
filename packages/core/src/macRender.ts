// Rendering on the user's Mac. While the Rendrr Mac app is open, signed in and able to render (its ping says so), the
// worker still prepares a render (footage, graphics, the person's cut-out, the sound's loudness) but hands the encode
// itself to the Mac: it writes a task here, the Mac app claims it, downloads the files by signed link, runs FFmpeg,
// uploads the result and says it is done. A task the Mac does not pick up within CLAIM_MS, stops reporting on, or
// fails is made on Rendrr's cloud server instead, so a render never waits on a Mac that has gone.
//
// Redis, per task (all kept MAC_TASK_TTL_S):
//   mac:task:<id>         the task as the worker wrote it (never changed)
//   mac:task:<id>:owner   who took it: "mac" (claimed) or "cloud" (given up on); set once (NX)
//   mac:task:<id>:run     the Mac's side: state, progress, outputs, error (the API writes it)
//   mac:task:<id>:stop    why the Mac must stop (the worker writes it: stopped by the user, or the Mac went quiet)
//   mac:tasks:<userId>    the user's tasks still waiting for a Mac
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mediaRequest } from "./drive";
import { redis } from "./queue";
import { signGet, signPut } from "./storage";

export const MAC_RENDER_PROTOCOL = 1;
export const MAC_TASK_TTL_S = 6 * 3600;
/** How long a task waits for the Mac app to take it before the cloud makes it. */
export const MAC_CLAIM_MS = Number(process.env.MAC_CLAIM_MS || 20_000);
/** How long the Mac may go without a word (downloading, rendering or uploading) before the cloud takes over. */
export const MAC_QUIET_MS = Number(process.env.MAC_QUIET_MS || 60_000);
/** A ping older than this does not count for handing a render to the Mac (the app pings every 20 s). */
const PING_FRESH_MS = 45_000;

/** What the Mac app says it can do, sent with its ping. have: the FFmpeg filters, encoders and decoders it has. */
export type MacRenderInfo = { protocol: number; ready: boolean; enabled: boolean; busy: boolean; cpus: number; have: string[]; ffmpeg: string | null; why: string | null };

/** A file the Mac needs: from storage (key), inline (data, base64) or the user's Google Drive (drive). */
export type MacInput = { name: string; key?: string; size?: number; etag?: string; data?: string; drive?: { fileId: string } };
/** One FFmpeg run: its arguments ("__FILTER_SCRIPT__" stands for the graph's file) with paths relative to the job's folder. */
export type MacCommand = { args: string[]; graph?: string; seconds?: number };
/** A file the Mac uploads when done (to key); save: also kept in the Mac's Downloads under this name. */
export type MacOutput = { name: string; key: string; type: string; save?: string };
export type MacTaskSpec = {
  renderId: string; userId: string; kind: string; label: string;
  inputs: MacInput[]; fonts?: { name: string; key: string; size: number }[];
  commands: MacCommand[]; outputs: MacOutput[];
  /** FFmpeg features this task uses (the Mac must have them all, or the cloud makes it). */
  needs: string[];
  stallSec?: number;
};
export type MacTask = MacTaskSpec & { id: string; createdAt: number };
export type MacRun = {
  state: "running" | "done" | "failed"; device: string | null; claimedAt: number; at: number; tokenHash: string;
  phase?: "download" | "render" | "upload"; frac?: number; cmd?: number; seconds?: number;
  outputs?: Record<string, number>; saved?: string | null; error?: string | null;
};
/** What the worker sees of a task: who has it, how far it is, and whether it was told to stop. */
export type MacTaskView = { owner: "mac" | "cloud" | null; run: MacRun | null; stop: string | null };

const k = {
  task: (id: string) => `mac:task:${id}`, owner: (id: string) => `mac:task:${id}:owner`, run: (id: string) => `mac:task:${id}:run`,
  stop: (id: string) => `mac:task:${id}:stop`, waiting: (userId: string) => `mac:tasks:${userId}`, on: (userId: string) => `mac:on:${userId}`,
};
/** The AI's finals waiting for the Mac app to save (apps/api services/macExport.ts). */
export const macExportsKey = (userId: string) => `mac:exports:${userId}`;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

/** The Mac app's render abilities from its last ping (null: closed, an older app, or the ping is stale). */
export async function macRenderInfo(userId: string): Promise<(MacRenderInfo & { device: string | null }) | null> {
  const on = parse<{ at?: number; device?: string | null; render?: Partial<MacRenderInfo> }>(await redis().get(k.on(userId)).catch(() => null));
  const r = on?.render;
  if (!on || !r || r.protocol !== MAC_RENDER_PROTOCOL || !on.at || Date.now() - on.at > PING_FRESH_MS) return null;
  return { protocol: r.protocol, ready: !!r.ready, enabled: r.enabled !== false, busy: !!r.busy, cpus: Math.max(1, Math.min(64, Math.round(Number(r.cpus) || 4))), have: Array.isArray(r.have) ? r.have.map(String) : [], ffmpeg: r.ffmpeg ? String(r.ffmpeg) : null, why: r.why ? String(r.why) : null, device: on.device ?? null };
}

/** The Mac that can make a render with these FFmpeg features now, or why not (null reason: it can). */
export async function macForRender(userId: string, needs: string[]): Promise<{ info: MacRenderInfo & { device: string | null } | null; why: string | null }> {
  if (process.env.MAC_RENDER === "off") return { info: null, why: "off on this server" };
  const info = await macRenderInfo(userId);
  if (!info) return { info: null, why: "the Mac app is not open" };
  if (!info.enabled) return { info, why: "rendering on the Mac is turned off in the Mac app" };
  if (!info.ready) return { info, why: info.why || "the Mac app is not ready to render" };
  if (info.busy) return { info, why: "the Mac is busy with another render" };
  const missing = needs.filter((n) => !info.have.includes(n));
  if (missing.length) return { info, why: `the Mac's FFmpeg lacks ${missing.join(", ")}` };
  return { info, why: null };
}

/** A new task for the user's Mac; its id. */
export async function createMacTask(spec: MacTaskSpec): Promise<string> {
  const id = randomUUID();
  const r = redis();
  await r.set(k.task(id), JSON.stringify({ ...spec, id, createdAt: Date.now() } satisfies MacTask), "EX", MAC_TASK_TTL_S);
  await r.sadd(k.waiting(spec.userId), id);
  await r.expire(k.waiting(spec.userId), MAC_TASK_TTL_S);
  return id;
}

export async function readMacTask(id: string): Promise<MacTask | null> { return parse<MacTask>(await redis().get(k.task(id))); }

export async function viewMacTask(id: string): Promise<MacTaskView> {
  const [owner, run, stop] = await redis().mget(k.owner(id), k.run(id), k.stop(id));
  return { owner: owner === "mac" || owner === "cloud" ? owner : null, run: parse<MacRun>(run), stop: stop || null };
}

/** The user's tasks still waiting for a Mac (newest last), for the Mac app to take. */
export async function listMacTasks(userId: string): Promise<{ id: string; renderId: string; kind: string; label: string; createdAt: number }[]> {
  const r = redis();
  const ids = await r.smembers(k.waiting(userId));
  const out: { id: string; renderId: string; kind: string; label: string; createdAt: number }[] = [];
  for (const id of ids) {
    const [t, owner] = await Promise.all([readMacTask(id), r.get(k.owner(id))]);
    if (!t || owner) { await r.srem(k.waiting(userId), id); continue; }
    out.push({ id, renderId: t.renderId, kind: t.kind, label: t.label, createdAt: t.createdAt });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The Mac app takes a task (only the first to ask gets it, and only while the cloud has not given up on it). */
export async function claimMacTask(userId: string, id: string, device: string | null): Promise<{ task: MacTask; token: string } | null> {
  const r = redis();
  const task = await readMacTask(id);
  if (!task || task.userId !== userId) return null;
  if ((await r.set(k.owner(id), "mac", "EX", MAC_TASK_TTL_S, "NX")) !== "OK") return null;
  await r.srem(k.waiting(userId), id);
  const token = randomBytes(32).toString("base64url"), now = Date.now();
  const run: MacRun = { state: "running", device, claimedAt: now, at: now, tokenHash: hashOf(token), phase: "download", frac: 0 };
  await r.set(k.run(id), JSON.stringify(run), "EX", MAC_TASK_TTL_S);
  return { task, token };
}

/** The cloud gives up waiting for the Mac (true), unless the Mac took the task first (false). */
export async function expireMacTask(id: string): Promise<boolean> {
  const r = redis();
  const ok = (await r.set(k.owner(id), "cloud", "EX", MAC_TASK_TTL_S, "NX")) === "OK";
  const t = ok ? await readMacTask(id) : null;
  if (t) await r.srem(k.waiting(t.userId), id);
  return ok;
}

/** Tells the Mac to stop (the user stopped the render, or the Mac went quiet and the cloud takes over). */
export async function stopMacTask(id: string, why: string) {
  const r = redis();
  await r.set(k.stop(id), why, "EX", MAC_TASK_TTL_S);
  await r.set(k.owner(id), "cloud", "EX", MAC_TASK_TTL_S, "NX");
  const t = await readMacTask(id);
  if (t) await r.srem(k.waiting(t.userId), id);
}

async function runFor(id: string, token: string): Promise<MacRun | null> {
  const run = parse<MacRun>(await redis().get(k.run(id)));
  if (!run || !token) return null;
  const a = Buffer.from(run.tokenHash, "hex"), b = Buffer.from(hashOf(token), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? run : null;
}

export type MacReport = { phase?: "download" | "render" | "upload"; frac?: number; cmd?: number; seconds?: number };
/** The Mac's progress (null: not its task); stop: why it must stop now, if it must. */
export async function reportMacTask(id: string, token: string, p: MacReport): Promise<{ stop: string | null } | null> {
  const run = await runFor(id, token);
  if (!run) return null;
  const stop = await redis().get(k.stop(id));
  if (run.state !== "running") return { stop: stop || "finished" };
  const next: MacRun = { ...run, at: Date.now(),
    ...(p.phase && ["download", "render", "upload"].includes(p.phase) ? { phase: p.phase } : {}),
    ...(Number.isFinite(p.frac) ? { frac: Math.max(0, Math.min(1, Number(p.frac))) } : {}),
    ...(Number.isInteger(p.cmd) && p.cmd! >= 0 ? { cmd: p.cmd } : {}),
    ...(Number.isFinite(p.seconds) && p.seconds! >= 0 ? { seconds: Number(p.seconds) } : {}) };
  await redis().set(k.run(id), JSON.stringify(next), "EX", MAC_TASK_TTL_S);
  return { stop: stop || null };
}

/** The Mac made it: each output's size (bytes); saved: the file name it kept in Downloads, if it kept one. */
export async function finishMacTask(id: string, token: string, outputs: Record<string, number>, saved: string | null): Promise<boolean> {
  const run = await runFor(id, token);
  const task = run ? await readMacTask(id) : null;
  if (!run || !task || run.state !== "running") return false;
  // Every output the task asked for, with its size.
  const sizes: Record<string, number> = {};
  for (const o of task.outputs) { const n = Number(outputs?.[o.name]); if (!(n > 0)) return false; sizes[o.name] = n; }
  await redis().set(k.run(id), JSON.stringify({ ...run, state: "done", at: Date.now(), outputs: sizes, saved: saved ? String(saved).slice(0, 200) : null } satisfies MacRun), "EX", MAC_TASK_TTL_S);
  return true;
}

export async function failMacTask(id: string, token: string, error: string): Promise<boolean> {
  const run = await runFor(id, token);
  if (!run || run.state !== "running") return false;
  await redis().set(k.run(id), JSON.stringify({ ...run, state: "failed", at: Date.now(), error: String(error || "The Mac could not render it").slice(0, 500) } satisfies MacRun), "EX", MAC_TASK_TTL_S);
  return true;
}

/** What the Mac app runs: the task with signed links (good for its whole life) and the token it reports with. */
export async function macManifest(task: MacTask, token: string, api: string) {
  const life = MAC_TASK_TTL_S;
  const inputs = await Promise.all(task.inputs.map(async (i) => {
    if (i.data != null) return { name: i.name, data: i.data };
    if (i.drive) { const m = await mediaRequest(task.userId, i.drive.fileId); return { name: i.name, url: m.url, headers: { authorization: m.headers.authorization }, size: i.size }; }
    return { name: i.name, url: await signGet(i.key!, life), size: i.size, cache: `${i.key}#${i.etag || i.size || ""}` };
  }));
  const fonts = await Promise.all((task.fonts ?? []).map(async (f) => ({ name: f.name, url: await signGet(f.key, life), size: f.size })));
  const outputs = await Promise.all(task.outputs.map(async (o) => ({ name: o.name, url: await signPut(o.key, o.type, life), type: o.type, ...(o.save ? { save: o.save } : {}) })));
  return { v: MAC_RENDER_PROTOCOL, id: task.id, token, api: api.replace(/\/$/, ""), renderId: task.renderId, kind: task.kind, label: task.label, inputs, fonts, commands: task.commands, outputs, stallSec: task.stallSec ?? 120 };
}
