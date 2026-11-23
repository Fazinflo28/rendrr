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
//
// Per user (one account can be open on several computers, Macs and Windows PCs, at once):
//   mac:devices:<userId>  each computer's last ping by its id: name, platform, version, what it can render (7 days)
//   mac:choice:<userId>   the computer the user picked to render on, or "cloud" (6 hours; Claude asks again after)
// A task names the one computer that may take it (deviceId): the one the user picked, or the best free one.
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

/** A file the Mac needs: from storage (key), inline (data, base64), the user's Google Drive (drive; version: when it last
 *  changed there), or the original that stays on that Mac (local: the Mac app knows where it keeps it, by its video, and
 *  checks it is the same size). */
export type MacInput = { name: string; key?: string; size?: number; etag?: string; data?: string; drive?: { fileId: string; version?: string }; local?: { videoId: string; size: number } };
/** One FFmpeg run: its arguments ("__FILTER_SCRIPT__" stands for the graph's file) with paths relative to the job's folder. */
export type MacCommand = { args: string[]; graph?: string; seconds?: number };
/** A file the Mac uploads when done (to key); save: also kept in the Mac's Downloads under this name. */
export type MacOutput = { name: string; key: string; type: string; save?: string };
export type MacTaskSpec = {
  renderId: string; userId: string; kind: string; label: string;
  /** The only computer that may take it (its id); none: any of the user's computers. */
  deviceId?: string;
  inputs: MacInput[]; fonts?: { name: string; key: string; size: number }[];
  commands: MacCommand[]; outputs: MacOutput[];
  /** FFmpeg features this task uses (the Mac must have them all, or the cloud makes it). */
  needs: string[];
  stallSec?: number;
};
export type MacTask = MacTaskSpec & { id: string; createdAt: number };
export type MacRun = {
  state: "running" | "done" | "failed"; device: string | null; claimedAt: number; at: number; tokenHash: string;
  /** The computer that took it: a Mac or a Windows PC (for the words). */
  platform?: "mac" | "windows";
  phase?: "download" | "render" | "upload"; frac?: number; cmd?: number; seconds?: number;
  outputs?: Record<string, number>; saved?: string | null; error?: string | null;
};
/** What the worker sees of a task: who has it, how far it is, and whether it was told to stop. */
export type MacTaskView = { owner: "mac" | "cloud" | null; run: MacRun | null; stop: string | null };

const k = {
  task: (id: string) => `mac:task:${id}`, owner: (id: string) => `mac:task:${id}:owner`, run: (id: string) => `mac:task:${id}:run`,
  stop: (id: string) => `mac:task:${id}:stop`, waiting: (userId: string) => `mac:tasks:${userId}`, on: (userId: string) => `mac:on:${userId}`,
  devices: (userId: string) => `mac:devices:${userId}`, choice: (userId: string) => `mac:choice:${userId}`,
};
/** The AI's finals waiting for the Mac app to save (apps/api services/macExport.ts). */
export const macExportsKey = (userId: string) => `mac:exports:${userId}`;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

/** One of the user's computers with the Rendrr app open: its id, name, platform, app version, last ping and what it
 *  can render (null: an app too old to render). */
export type MacDevice = { id: string; name: string | null; platform: "mac" | "windows"; version: string | null; at: number; render: MacRenderInfo | null };
/** A computer that can be handed a render: what it can do, with its id, name and platform. */
export type MacTarget = MacRenderInfo & { id: string; device: string | null; platform: "mac" | "windows" };
/** The app pings every 20 s: a computer silent for longer than this counts as closed. */
export const DEVICE_ONLINE_MS = 75_000;
const DEVICE_KEEP_S = 7 * 86400;
const CHOICE_S = 6 * 3600;

/** A computer's ping (apps/api services/macExport.ts macPing): kept by its id. */
export async function noteMacDevice(userId: string, d: Omit<MacDevice, "at">) {
  const r = redis(), at = Date.now();
  await r.hset(k.devices(userId), d.id, JSON.stringify({ ...d, at }));
  await r.expire(k.devices(userId), DEVICE_KEEP_S);
  // The single-computer key older servers read (kept while one may still be running).
  await r.set(k.on(userId), JSON.stringify({ at, version: d.version, device: d.name, platform: d.platform, ...(d.render ? { render: d.render } : {}) }), "EX", 75);
}

/** The user's computers that pinged within freshMs, the most recent first (ones silent for a day are forgotten). */
export async function macDevices(userId: string, freshMs = DEVICE_ONLINE_MS): Promise<MacDevice[]> {
  const r = redis();
  const all = await r.hgetall(k.devices(userId)).catch(() => ({} as Record<string, string>));
  const now = Date.now(), out: MacDevice[] = [];
  for (const [id, raw] of Object.entries(all)) {
    const d = parse<MacDevice>(raw);
    if (!d || !d.at || now - d.at > 86400_000) { await r.hdel(k.devices(userId), id).catch(() => {}); continue; }
    if (now - d.at > freshMs) continue;
    const ri = d.render && d.render.protocol === MAC_RENDER_PROTOCOL ? d.render : null;
    out.push({ id, name: d.name ?? null, platform: d.platform === "windows" ? "windows" : "mac", version: d.version ?? null, at: d.at,
      render: ri ? { protocol: ri.protocol, ready: !!ri.ready, enabled: ri.enabled !== false, busy: !!ri.busy, cpus: Math.max(1, Math.min(64, Math.round(Number(ri.cpus) || 4))), have: Array.isArray(ri.have) ? ri.have.map(String) : [], ffmpeg: ri.ffmpeg ? String(ri.ffmpeg) : null, why: ri.why ? String(ri.why) : null } : null });
  }
  return out.sort((x, y) => y.at - x.at);
}

/** The computer Rendrr heard from last when none is open now (it pinged within the day): for saying when and where
 *  the app was last seen, so the AI can tell the user what to check. null: one is open, or none pinged today. */
export async function macLastSeen(userId: string): Promise<MacDevice | null> {
  const all = await macDevices(userId, 86400_000);
  if (!all.length || Date.now() - all[0].at <= DEVICE_ONLINE_MS) return null;
  return all[0];
}

/** Why this computer cannot make a render needing these FFmpeg features now (null: it can). */
export function deviceWhy(d: MacDevice, needs: string[] = []): string | null {
  const m = d.platform === "windows" ? "PC" : "Mac", app = d.platform === "windows" ? "Windows app" : "Mac app";
  const r = d.render;
  if (!r) return `this ${app} cannot render yet: update it`;
  if (!r.enabled) return `rendering on the ${m} is turned off in the ${app}`;
  if (!r.ready) return r.why || `the ${app} is not ready to render`;
  if (r.busy) return `the ${m} is busy with another render`;
  const missing = needs.filter((n) => !r.have.includes(n));
  return missing.length ? `the ${m}'s FFmpeg lacks ${missing.join(", ")}` : null;
}
const targetOf = (d: MacDevice): MacTarget => ({ ...(d.render as MacRenderInfo), id: d.id, device: d.name, platform: d.platform });

/** The computer the user picked to render on ("cloud": Rendrr's cloud server), while the pick lasts. */
export async function renderChoice(userId: string): Promise<string | null> { return (await redis().get(k.choice(userId)).catch(() => null)) || null; }
export async function setRenderChoice(userId: string, choice: string | null) {
  if (choice) await redis().set(k.choice(userId), choice, "EX", CHOICE_S); else await redis().del(k.choice(userId));
}

/** The best computer for a render now (null: none; why says why not): one the user picked (target: its id), "cloud"
 *  (none), or with no target the free computer that can make it with the most cores. */
export async function macForRender(userId: string, needs: string[], target?: string | null): Promise<{ info: MacTarget | null; why: string | null }> {
  if (process.env.MAC_RENDER === "off") return { info: null, why: "off on this server" };
  if (target === "cloud") return { info: null, why: "the user chose Rendrr's cloud server" };
  const devices = await macDevices(userId, PING_FRESH_MS);
  if (target) {
    const d = devices.find((x) => x.id === target);
    if (!d) return { info: null, why: "the computer picked for it is not connected" };
    const why = deviceWhy(d, needs);
    return { info: d.render ? targetOf(d) : null, why };
  }
  const able = devices.filter((d) => !deviceWhy(d, needs)).sort((x, y) => (y.render!.cpus - x.render!.cpus));
  if (able.length) return { info: targetOf(able[0]), why: null };
  if (!devices.length) return { info: null, why: "the Rendrr app is not open" };
  const d = devices[0];
  return { info: d.render ? targetOf(d) : null, why: deviceWhy(d, needs) };
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

/** The user's tasks still waiting for a computer (newest last), for the app to take; deviceId: only those this
 *  computer may take (a task for another computer is left for it). */
export async function listMacTasks(userId: string, deviceId?: string | null): Promise<{ id: string; renderId: string; kind: string; label: string; createdAt: number }[]> {
  const r = redis();
  const ids = await r.smembers(k.waiting(userId));
  const out: { id: string; renderId: string; kind: string; label: string; createdAt: number }[] = [];
  for (const id of ids) {
    const [t, owner] = await Promise.all([readMacTask(id), r.get(k.owner(id))]);
    if (!t || owner) { await r.srem(k.waiting(userId), id); continue; }
    if (t.deviceId && deviceId && t.deviceId !== deviceId) continue;
    out.push({ id, renderId: t.renderId, kind: t.kind, label: t.label, createdAt: t.createdAt });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The Mac app takes a task (only the first to ask gets it, and only while the cloud has not given up on it).
 *  platform: the computer the app runs on (a Windows PC says "windows"). */
export async function claimMacTask(userId: string, id: string, device: string | null, platform?: string | null, deviceId?: string | null): Promise<{ task: MacTask; token: string } | null> {
  const r = redis();
  const task = await readMacTask(id);
  if (!task || task.userId !== userId) return null;
  // A task for one computer is only that computer's to take.
  if (task.deviceId && deviceId && task.deviceId !== deviceId) return null;
  if ((await r.set(k.owner(id), "mac", "EX", MAC_TASK_TTL_S, "NX")) !== "OK") return null;
  await r.srem(k.waiting(userId), id);
  const token = randomBytes(32).toString("base64url"), now = Date.now();
  const run: MacRun = { state: "running", device, platform: platform === "windows" || platform === "win32" ? "windows" : "mac", claimedAt: now, at: now, tokenHash: hashOf(token), phase: "download", frac: 0 };
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

/** The Mac's cache key for an original in Drive: the file, its size and when it last changed there. */
export const driveKeep = (d: { fileId: string; version?: string }, size: number) => `drive:${d.fileId}#${size}#${d.version ?? ""}`;

/**
 * A fresh link for one of a running task's files (the Mac asks when the one it has is refused: a Google Drive sign-in
 * lasts an hour, and a big original can take longer to fetch). Null: not its task, not running, or no such file.
 */
export async function macInputLink(id: string, token: string, name: string): Promise<{ url: string; headers?: { authorization: string } } | null> {
  const run = await runFor(id, token);
  if (!run || run.state !== "running") return null;
  const task = await readMacTask(id);
  const i = task?.inputs.find((x) => x.name === name);
  if (!task || !i) return null;
  if (i.drive) { const m = await mediaRequest(task.userId, i.drive.fileId); return { url: m.url, headers: { authorization: m.headers.authorization } }; }
  if (i.key) return { url: await signGet(i.key, MAC_TASK_TTL_S) };
  return null;
}

/** What the Mac app runs: the task with signed links (good for its whole life) and the token it reports with. */
export async function macManifest(task: MacTask, token: string, api: string) {
  const life = MAC_TASK_TTL_S;
  const inputs = await Promise.all(task.inputs.map(async (i) => {
    if (i.data != null) return { name: i.name, data: i.data };
    if (i.local) return { name: i.name, local: { videoId: i.local.videoId, size: i.local.size } };
    // An original in Drive is kept in the Mac's cache too (keep: by the file, its size and when it last changed), so the
    // next final of the same footage fetches nothing. (An older Mac app ignores keep and fetches it each time.)
    if (i.drive) { const m = await mediaRequest(task.userId, i.drive.fileId); return { name: i.name, url: m.url, headers: { authorization: m.headers.authorization }, size: i.size, ...(i.size ? { keep: driveKeep(i.drive, i.size) } : {}) }; }
    return { name: i.name, url: await signGet(i.key!, life), size: i.size, cache: `${i.key}#${i.etag || i.size || ""}` };
  }));
  const fonts = await Promise.all((task.fonts ?? []).map(async (f) => ({ name: f.name, url: await signGet(f.key, life), size: f.size })));
  const outputs = await Promise.all(task.outputs.map(async (o) => ({ name: o.name, url: await signPut(o.key, o.type, life), type: o.type, ...(o.save ? { save: o.save } : {}) })));
  return { v: MAC_RENDER_PROTOCOL, id: task.id, token, api: api.replace(/\/$/, ""), renderId: task.renderId, kind: task.kind, label: task.label, inputs, fonts, commands: task.commands, outputs, stallSec: task.stallSec ?? 120 };
}
