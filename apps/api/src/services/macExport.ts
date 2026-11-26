import { deviceWhy, driveSaveOf, finalType, MAC_RENDER_PROTOCOL, macDevices, macExportsKey, macLastSeen, noteMacDevice, redis, renderChoice, setRenderChoice, signGet, type MacRenderInfo, type RenderProgress } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { CLOUD, CLOUD_REGION, deviceLabel, deviceName, devicesText, lastSeenText, platformOf, type Delivery, type DesktopPlatform, type DeviceStatus, type MacStatus, type RenderWhere } from "@rendrr/shared";

// The user's Mac: while the Rendrr Mac app is open it says so every few seconds (macPing), with what it can render.
// Renders are then made on that Mac (core/macRender.ts: the worker hands it the encode; routes/macRender.ts); a final
// it makes is kept in its Downloads. A final the AI exports is also queued for it (queueMacExport): one made on the
// cloud (the Mac could not take it) is collected as soon as it is done (macExports) and saved to Downloads; a claim
// makes sure only one window saves it. With the app closed, renders run on Rendrr's cloud server and the AI's finals
// go to Google Drive. renderWhere says where each render was made, wherever a render is shown.
// One account can be open on several computers (Macs and Windows PCs) at once: each pings with its own id, and
// pickTarget decides which renders (the one the user picked, the only one, or Claude asks), or Rendrr's cloud.

const KEEP_S = 7 * 86400;
const queueKey = macExportsKey;
/** The app's own id for its computer (desktop/main.js); an app too old to send one is known by its name. */
export const deviceIdOf = (id: unknown, name?: string | null) => (typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : `name:${name || "this computer"}`);

/** What a ping says the Mac can render, kept only in a known shape (an older app sends none). */
export function cleanRenderInfo(x: unknown): MacRenderInfo | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (Number(r.protocol) !== MAC_RENDER_PROTOCOL) return null;
  const have = Array.isArray(r.have) ? r.have.filter((h): h is string => typeof h === "string" && /^[\w.-]{1,32}$/.test(h)).slice(0, 64) : [];
  return { protocol: MAC_RENDER_PROTOCOL, ready: r.ready === true, enabled: r.enabled !== false, busy: r.busy === true, cpus: Math.max(1, Math.min(64, Math.round(Number(r.cpus) || 4))), have, ffmpeg: typeof r.ffmpeg === "string" ? r.ffmpeg.slice(0, 40) : null, why: typeof r.why === "string" ? r.why.slice(0, 200) : null };
}

/** The desktop app is open on a computer (and signed in as this user); device: the computer's name; render: what it can
 *  render; platform: "windows" from the Windows app (a Mac app says "mac" or nothing); deviceId: the app's own id. */
export async function macPing(userId: string, version?: string, device?: string, render?: unknown, platform?: string, deviceId?: string) {
  const name = deviceName(device);
  await noteMacDevice(userId, { id: deviceIdOf(deviceId, name), name, platform: platformOf(platform), version: (version || "").slice(0, 20) || null, render: cleanRenderInfo(render) });
}
/** Every computer with the Rendrr app open now, and the main one: the one the user picked to render on, else the first
 *  that can render, else the latest to ping. choice: the pick ("cloud", a computer's id) while it lasts. */
export async function macStatus(userId: string): Promise<MacStatus> {
  const [list, choice] = await Promise.all([macDevices(userId).catch(() => []), renderChoice(userId)]);
  const devices: DeviceStatus[] = list.map((d) => {
    const renders = !!d.render && d.render.ready && d.render.enabled;
    return { id: d.id, name: d.name, platform: d.platform, version: d.version, seenAt: d.at, renders, busy: !!d.render?.busy, why: renders ? null : deviceWhy(d) };
  });
  if (!devices.length) {
    const seen = await macLastSeen(userId).catch(() => null);
    return { online: false, device: null, version: null, seenAt: null, renders: false, why: null, devices: [], choice, lastSeen: seen ? { name: seen.name, platform: seen.platform, at: seen.at } : null };
  }
  const main = devices.find((d) => d.id === choice) ?? devices.find((d) => d.renders) ?? devices[0];
  return { online: true, device: main.name, version: main.version, seenAt: main.seenAt, renders: main.renders, why: main.why, platform: main.platform, deviceId: main.id, devices, choice };
}

/** Which computer a render goes to. target: a computer's id, "cloud", or null (none online: the cloud); device: that
 *  computer; ask: Rendrr cannot tell (several can render and none was picked, or the one named is not there): say this
 *  to the AI instead of rendering; note: a line for the answer. */
export type TargetPick = { target: string | null; device: DeviceStatus | null; ask: string | null; note: string | null };
const CLOUD_WORDS = /^(the )?(rendrr('s)? )?cloud( server)?$|^server$|^rendrr$/i;

/**
 * Picks where a render is made. asked: what the user said (a computer's name or id, or "cloud"), remembered for the
 * next few hours; prefer: the computer that must make it (it keeps the original). With nothing asked: the computer
 * picked earlier, the only one that can render, or (several) a question for the AI to put to the user.
 */
export async function pickTarget(userId: string, asked: string | null | undefined, o: { tool: string; prefer?: string | null }): Promise<TargetPick> {
  const st = await macStatus(userId);
  const all = st.devices || [], able = all.filter((d) => d.renders);
  const choices = () => (able.length ? `Computers that can render now: ${devicesText(able)}, or ${CLOUD}.` : `No computer can render now: only ${CLOUD}.`);
  const several = able.length > 1;
  const say = (d: DeviceStatus) => (several ? `Rendering on ${deviceLabel(d)} (the user's pick: pass device to switch, or "cloud").` : null);
  if (asked && asked.trim()) {
    const a = asked.trim().replace(/^"|"$/g, "");
    // "cloud" is kept for the next renders only while several computers can render (the same pick the app offers then).
    // With one computer it is for this render alone: a preview sent to the cloud while the Mac was off must not keep
    // the Mac out of every render after it for hours.
    if (CLOUD_WORDS.test(a)) { if (several) await setRenderChoice(userId, "cloud"); return { target: "cloud", device: null, ask: null, note: several ? `Rendering on ${CLOUD} (the user's pick).` : null }; }
    const low = a.toLowerCase();
    const d = all.find((x) => x.id === a) ?? all.find((x) => (x.name || "").toLowerCase() === low) ?? all.find((x) => (x.name || "").toLowerCase().includes(low));
    if (!d) return { target: null, device: null, ask: `"${a}" is not one of the user's computers connected to Rendrr now (the Rendrr app open and online). ${choices()} Nothing was rendered: ask the user, then call ${o.tool} again with device.`, note: null };
    if (!d.renders) return { target: null, device: null, ask: `${deviceLabel(d)} is connected but cannot render (${d.why}). ${choices()} Nothing was rendered: ask the user, then call ${o.tool} again with device.`, note: null };
    await setRenderChoice(userId, d.id);
    return { target: d.id, device: d, ask: null, note: say(d) };
  }
  // None can render: Rendrr's cloud. None open at all, though one was today: when Rendrr last heard from it, so the AI
  // can tell a user who expected their computer to render what to check.
  if (!able.length) return { target: null, device: null, ask: null, note: !all.length && st.lastSeen ? `Rendering on ${CLOUD}: no Rendrr app is open now. ${lastSeenText(st.lastSeen)}` : null };
  const must = o.prefer ? able.find((d) => d.id === o.prefer) : undefined;
  if (must) return { target: must.id, device: must, ask: null, note: several ? `Rendering on ${deviceLabel(must)}: it keeps this footage's original.` : null };
  // A cloud pick counts only while several computers can render (see above): the one computer open renders.
  if (st.choice === "cloud" && several) return { target: "cloud", device: null, ask: null, note: `Rendering on ${CLOUD} (the user's pick: pass device to switch).` };
  const picked = able.find((d) => d.id === st.choice);
  if (picked) return { target: picked.id, device: picked, ask: null, note: say(picked) };
  if (!several) return { target: able[0].id, device: able[0], ask: null, note: null };
  return { target: null, device: null, ask: `${able.length} of the user's computers can render this now: ${devicesText(able)}, or ${CLOUD}. Nothing was rendered yet: ask the user which one to use, then call ${o.tool} again with device set to its name (or "cloud"). Rendrr remembers the choice for the next few hours.`, note: null };
}

/**
 * Where a render is (or was) made, the user's Mac or Rendrr's cloud server, and where its file goes: the Mac app,
 * Google Drive or a download. live: its progress now (the Mac's name while the Mac app makes it).
 */
export function renderWhere(r: Pick<Render, "delivery" | "driveSave" | "made">, live?: Pick<RenderProgress, "on" | "device" | "platform" | "next"> | null): RenderWhere {
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
  const next = !made && on === "cloud" && live?.next ? { device: live.next.device ?? null, platform: platformOf(live.next.platform) } : null;
  return { renders: on, region: CLOUD_REGION, device: madeOn, delivery, ...(platform ? { platform } : {}), ...(next ? { next } : {}) };
}

/** A final for the desktop app to save when it is done; the render remembers it goes to that computer (a Mac or a PC).
 *  deviceId: only that computer saves it (none: the first window to ask). */
export async function queueMacExport(userId: string, renderId: string, fileName: string, device?: string | null, platform?: DesktopPlatform, deviceId?: string | null) {
  await redis().hset(queueKey(userId), renderId, JSON.stringify({ fileName, at: Date.now(), ...(deviceId ? { deviceId } : {}) }));
  await redis().expire(queueKey(userId), KEEP_S);
  await prisma.render.update({ where: { id: renderId }, data: { delivery: { to: "mac", device: device ?? null, state: "waiting", at: Date.now(), platform: platform ?? "mac" } } }).catch(() => {});
}

export type MacExport = { renderId: string; fileName: string; url?: string; failed?: string; percent?: number };

/** The finals queued for this computer (deviceId; one queued for another computer is left for it): done ones with a
 *  link that saves the file, failed ones with why, others still going. */
export async function macExports(userId: string, deviceId?: string | null): Promise<MacExport[]> {
  const all = await redis().hgetall(queueKey(userId));
  const out: MacExport[] = [];
  for (const [renderId, raw] of Object.entries(all)) {
    let fileName = "Rendrr final.mp4", forDevice: string | null = null;
    try { const j = JSON.parse(raw) as { fileName?: string; deviceId?: string }; fileName = j.fileName || fileName; forDevice = j.deviceId || null; } catch { /* kept */ }
    if (forDevice && deviceId && forDevice !== deviceId) continue;
    const r = await prisma.render.findUnique({ where: { id: renderId } });
    if (!r || r.userId !== userId) { await redis().hdel(queueKey(userId), renderId); continue; }
    if (r.status === "failed") out.push({ renderId, fileName, failed: r.error || "The render did not finish." });
    else if (r.status === "done" && r.outputKey) out.push({ renderId, fileName, url: await signGet(r.outputKey, 3600, { download: fileName, contentType: finalType(r.outputKey).type }) });
    else out.push({ renderId, fileName });
  }
  return out;
}

/** One window takes a final to save (true only for the first, and only on the computer it was queued for): it leaves the queue. */
export async function claimMacExport(userId: string, renderId: string, deviceId?: string | null): Promise<boolean> {
  const raw = await redis().hget(queueKey(userId), renderId);
  if (!raw) return false;
  try { const j = JSON.parse(raw) as { deviceId?: string }; if (j.deviceId && deviceId && j.deviceId !== deviceId) return false; } catch { /* anyone */ }
  const claimed = (await redis().hdel(queueKey(userId), renderId)) === 1;
  if (claimed) {
    const r = await prisma.render.findUnique({ where: { id: renderId }, select: { userId: true, delivery: true } });
    const d = r && r.userId === userId && r.delivery && typeof r.delivery === "object" ? (r.delivery as Record<string, unknown>) : null;
    if (d) await prisma.render.update({ where: { id: renderId }, data: { delivery: { ...d, state: "sent", sentAt: Date.now() } } });
  }
  return claimed;
}
