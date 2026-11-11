import { driveSaveOf, finalType, MAC_RENDER_PROTOCOL, macExportsKey, redis, signGet, type MacRenderInfo, type RenderProgress } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { CLOUD_REGION, deviceName, platformOf, type Delivery, type DesktopPlatform, type MacStatus, type RenderWhere } from "@rendrr/shared";

// The user's Mac: while the Rendrr Mac app is open it says so every few seconds (macPing), with what it can render.
// Renders are then made on that Mac (core/macRender.ts: the worker hands it the encode; routes/macRender.ts); a final
// it makes is kept in its Downloads. A final the AI exports is also queued for it (queueMacExport): one made on the
// cloud (the Mac could not take it) is collected as soon as it is done (macExports) and saved to Downloads; a claim
// makes sure only one window saves it. With the app closed, renders run on Rendrr's cloud server and the AI's finals
// go to Google Drive. renderWhere says where each render was made, wherever a render is shown.

const ONLINE_S = 75; // the app pings every 20 s: three missed pings and it counts as closed
const KEEP_S = 7 * 86400;
const onKey = (userId: string) => `mac:on:${userId}`;
const queueKey = macExportsKey;

/** What a ping says the Mac can render, kept only in a known shape (an older app sends none). */
export function cleanRenderInfo(x: unknown): MacRenderInfo | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (Number(r.protocol) !== MAC_RENDER_PROTOCOL) return null;
  const have = Array.isArray(r.have) ? r.have.filter((h): h is string => typeof h === "string" && /^[\w.-]{1,32}$/.test(h)).slice(0, 64) : [];
  return { protocol: MAC_RENDER_PROTOCOL, ready: r.ready === true, enabled: r.enabled !== false, busy: r.busy === true, cpus: Math.max(1, Math.min(64, Math.round(Number(r.cpus) || 4))), have, ffmpeg: typeof r.ffmpeg === "string" ? r.ffmpeg.slice(0, 40) : null, why: typeof r.why === "string" ? r.why.slice(0, 200) : null };
}

/** The desktop app is open (and signed in as this user); device: the computer's name, when the app sends it; render:
 *  what it can render; platform: "windows" from the Windows app (a Mac app says "mac" or nothing). */
export async function macPing(userId: string, version?: string, device?: string, render?: unknown, platform?: string) {
  const info = cleanRenderInfo(render);
  await redis().set(onKey(userId), JSON.stringify({ at: Date.now(), version: (version || "").slice(0, 20), device: deviceName(device), platform: platformOf(platform), ...(info ? { render: info } : {}) }), "EX", ONLINE_S);
}
export async function macOnline(userId: string): Promise<boolean> {
  return !!(await redis().get(onKey(userId)).catch(() => null));
}
/** Whether the Mac app is open, on which Mac, when it last said so, and whether renders are made on it. */
export async function macStatus(userId: string): Promise<MacStatus> {
  const raw = await redis().get(onKey(userId)).catch(() => null);
  if (!raw) return { online: false, device: null, version: null, seenAt: null, renders: false, why: null };
  try {
    const j = JSON.parse(raw) as { at?: number; version?: string; device?: string | null; platform?: string; render?: MacRenderInfo };
    const r = j.render, platform = platformOf(j.platform);
    const m = platform === "windows" ? "PC" : "Mac", appName = platform === "windows" ? "Windows app" : "Mac app";
    const renders = !!r && r.ready && r.enabled;
    const why = renders ? null : !r ? `this ${appName} cannot render yet: update it` : !r.enabled ? `rendering on the ${m} is turned off in the ${appName}` : r.why || `the ${appName} is not ready to render`;
    return { online: true, device: j.device || null, version: j.version || null, seenAt: j.at ?? null, renders, why, platform };
  } catch { return { online: true, device: null, version: null, seenAt: null, renders: false, why: null }; }
}

/**
 * Where a render is (or was) made, the user's Mac or Rendrr's cloud server, and where its file goes: the Mac app,
 * Google Drive or a download. live: its progress now (the Mac's name while the Mac app makes it).
 */
export function renderWhere(r: Pick<Render, "delivery" | "driveSave" | "made">, live?: Pick<RenderProgress, "on" | "device" | "platform"> | null): RenderWhere {
  const made = r.made && typeof r.made === "object" ? (r.made as { on?: string; device?: string | null; platform?: string }) : null;
  const on: "mac" | "cloud" = made ? (made.on === "mac" ? "mac" : "cloud") : live?.on === "mac" ? "mac" : "cloud";
  const madeOn = on === "mac" ? (made?.device ?? live?.device ?? null) : null;
  const platform: DesktopPlatform | undefined = on === "mac" ? platformOf(made ? made.platform : live?.platform) : undefined;
  const mac = r.delivery && typeof r.delivery === "object" ? (r.delivery as { to?: string; device?: string | null; state?: string; at?: number; platform?: string }) : null;
  const drive = driveSaveOf(r);
  const delivery: Delivery = mac?.to === "mac"
    ? { to: "mac", device: mac.device || null, state: mac.state === "sent" ? "sent" : "waiting", folder: null, at: mac.at ?? null, platform: platformOf(mac.platform) }
    : drive ? { to: "drive", device: null, state: null, folder: drive.path || null, at: null }
    : { to: "download", device: null, state: null, folder: null, at: null };
  return { renders: on, region: CLOUD_REGION, device: madeOn, delivery, ...(platform ? { platform } : {}) };
}

/** A final for the desktop app to save when it is done; the render remembers it goes to that computer (a Mac or a PC). */
export async function queueMacExport(userId: string, renderId: string, fileName: string, device?: string | null, platform?: DesktopPlatform) {
  await redis().hset(queueKey(userId), renderId, JSON.stringify({ fileName, at: Date.now() }));
  await redis().expire(queueKey(userId), KEEP_S);
  await prisma.render.update({ where: { id: renderId }, data: { delivery: { to: "mac", device: device ?? null, state: "waiting", at: Date.now(), platform: platform ?? "mac" } } }).catch(() => {});
}

export type MacExport = { renderId: string; fileName: string; url?: string; failed?: string; percent?: number };

/** The finals queued for the Mac: done ones with a link that saves the file, failed ones with why, others still going. */
export async function macExports(userId: string): Promise<MacExport[]> {
  const all = await redis().hgetall(queueKey(userId));
  const out: MacExport[] = [];
  for (const [renderId, raw] of Object.entries(all)) {
    let fileName = "Rendrr final.mp4"; try { fileName = (JSON.parse(raw) as { fileName?: string }).fileName || fileName; } catch { /* kept */ }
    const r = await prisma.render.findUnique({ where: { id: renderId } });
    if (!r || r.userId !== userId) { await redis().hdel(queueKey(userId), renderId); continue; }
    if (r.status === "failed") out.push({ renderId, fileName, failed: r.error || "The render did not finish." });
    else if (r.status === "done" && r.outputKey) out.push({ renderId, fileName, url: await signGet(r.outputKey, 3600, { download: fileName, contentType: finalType(r.outputKey).type }) });
    else out.push({ renderId, fileName });
  }
  return out;
}

/** One window takes a final to save (true only for the first): it leaves the queue. */
export async function claimMacExport(userId: string, renderId: string): Promise<boolean> {
  const claimed = (await redis().hdel(queueKey(userId), renderId)) === 1;
  if (claimed) {
    const r = await prisma.render.findUnique({ where: { id: renderId }, select: { userId: true, delivery: true } });
    const d = r && r.userId === userId && r.delivery && typeof r.delivery === "object" ? (r.delivery as Record<string, unknown>) : null;
    if (d) await prisma.render.update({ where: { id: renderId }, data: { delivery: { ...d, state: "sent", sentAt: Date.now() } } });
  }
  return claimed;
}
