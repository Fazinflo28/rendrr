import { driveSaveOf, finalType, redis, signGet } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { CLOUD_REGION, deviceName, type Delivery, type MacStatus, type RenderWhere } from "@rendrr/shared";

// Finals on the user's Mac: while the Rendrr Mac app is open it says so every few seconds (macPing), and a final the
// AI exports then is queued for it (queueMacExport). The app collects each one as soon as it is done (macExports) and
// saves it to the Mac's Downloads folder; a claim makes sure only one window saves it. The render itself runs on
// Rendrr's cloud server either way (renderWhere says so wherever a render is shown). With the app closed, the AI renders on Rendrr's cloud server and saves to Google Drive.

const ONLINE_S = 75; // the app pings every 20 s: three missed pings and it counts as closed
const KEEP_S = 7 * 86400;
const onKey = (userId: string) => `mac:on:${userId}`;
const queueKey = (userId: string) => `mac:exports:${userId}`;

/** The Mac app is open (and signed in as this user); device: the Mac's name, when the app sends it. */
export async function macPing(userId: string, version?: string, device?: string) {
  await redis().set(onKey(userId), JSON.stringify({ at: Date.now(), version: (version || "").slice(0, 20), device: deviceName(device) }), "EX", ONLINE_S);
}
export async function macOnline(userId: string): Promise<boolean> {
  return !!(await redis().get(onKey(userId)).catch(() => null));
}
/** Whether the Mac app is open, on which Mac, and when it last said so. */
export async function macStatus(userId: string): Promise<MacStatus> {
  const raw = await redis().get(onKey(userId)).catch(() => null);
  if (!raw) return { online: false, device: null, version: null, seenAt: null };
  try { const j = JSON.parse(raw) as { at?: number; version?: string; device?: string | null }; return { online: true, device: j.device || null, version: j.version || null, seenAt: j.at ?? null }; }
  catch { return { online: true, device: null, version: null, seenAt: null }; }
}

/** Where a render is made (always Rendrr's cloud server) and where its file goes: the Mac app, Google Drive or a download. */
export function renderWhere(r: Pick<Render, "delivery" | "driveSave">): RenderWhere {
  const mac = r.delivery && typeof r.delivery === "object" ? (r.delivery as { to?: string; device?: string | null; state?: string; at?: number }) : null;
  const drive = driveSaveOf(r);
  const delivery: Delivery = mac?.to === "mac"
    ? { to: "mac", device: mac.device || null, state: mac.state === "sent" ? "sent" : "waiting", folder: null, at: mac.at ?? null }
    : drive ? { to: "drive", device: null, state: null, folder: drive.path || null, at: null }
    : { to: "download", device: null, state: null, folder: null, at: null };
  return { renders: "cloud", region: CLOUD_REGION, delivery };
}

/** A final for the Mac app to save when it is done; the render remembers it goes to that Mac. */
export async function queueMacExport(userId: string, renderId: string, fileName: string, device?: string | null) {
  await redis().hset(queueKey(userId), renderId, JSON.stringify({ fileName, at: Date.now() }));
  await redis().expire(queueKey(userId), KEEP_S);
  await prisma.render.update({ where: { id: renderId }, data: { delivery: { to: "mac", device: device ?? null, state: "waiting", at: Date.now() } } }).catch(() => {});
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
