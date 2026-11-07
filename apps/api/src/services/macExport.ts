import { finalType, redis, signGet } from "@rendrr/core";
import { prisma } from "@rendrr/db";

// Finals on the user's Mac: while the Rendrr Mac app is open it says so every few seconds (macPing), and a final the
// AI exports then is queued for it (queueMacExport). The app collects each one as soon as it is done (macExports) and
// saves it to the Mac's Downloads folder; a claim makes sure only one window saves it. The render itself runs on
// Rendrr's servers either way. With the app closed, the AI renders on Rendrr's cloud server and saves to Google Drive.

const ONLINE_S = 75; // the app pings every 20 s: three missed pings and it counts as closed
const KEEP_S = 7 * 86400;
const onKey = (userId: string) => `mac:on:${userId}`;
const queueKey = (userId: string) => `mac:exports:${userId}`;

/** The Mac app is open (and signed in as this user). */
export async function macPing(userId: string, version?: string) {
  await redis().set(onKey(userId), JSON.stringify({ at: Date.now(), version: (version || "").slice(0, 20) }), "EX", ONLINE_S);
}
export async function macOnline(userId: string): Promise<boolean> {
  return !!(await redis().get(onKey(userId)).catch(() => null));
}

/** A final for the Mac app to save when it is done. */
export async function queueMacExport(userId: string, renderId: string, fileName: string) {
  await redis().hset(queueKey(userId), renderId, JSON.stringify({ fileName, at: Date.now() }));
  await redis().expire(queueKey(userId), KEEP_S);
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
  return (await redis().hdel(queueKey(userId), renderId)) === 1;
}
