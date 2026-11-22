// Where a render is made and where its file goes, said the same way everywhere (the AI's tool answers, the Claude card,
// the web app). While the Rendrr app is open on the user's Mac or Windows PC (and able to render), renders are made on
// that computer: the cloud prepares them (graphics, the person's cut-out, the sound's loudness) and the computer makes
// the video; a final it makes is saved to its Downloads. With the app closed, or when the computer cannot take one, they
// are made on Rendrr's cloud server. Inside Rendrr that computer is "mac" whichever it is; `platform` says which, for
// the words ("your Mac", "your PC").

export const CLOUD = "Rendrr's cloud server";
export const CLOUD_REGION = "US East";

/** Which computer the Rendrr desktop app runs on (an app that does not say is a Mac app). */
export type DesktopPlatform = "mac" | "windows";
/** "windows" (or Node's "win32") is Windows; anything else is a Mac. */
export const platformOf = (raw?: string | null): DesktopPlatform => (raw === "windows" || raw === "win32" ? "windows" : "mac");
/** "Mac" or "PC". */
export const machineWord = (p?: string | null) => (platformOf(p) === "windows" ? "PC" : "Mac");
/** "Rendrr Mac app" or "Rendrr Windows app". */
export const desktopAppName = (p?: string | null) => (platformOf(p) === "windows" ? "Rendrr Windows app" : "Rendrr Mac app");

export type DeliveryTo = "mac" | "drive" | "download";
/** waiting: the Mac app takes it when it is done; sent: the Mac app took it and saves it to Downloads. */
export type MacState = "waiting" | "sent";
export type Delivery = { to: DeliveryTo; device: string | null; state: MacState | null; folder: string | null; at: number | null; platform?: DesktopPlatform };
/** renders: where it is (or was) made; device: the computer's name when on the user's computer; platform: which kind. */
export type RenderWhere = { renders: "cloud" | "mac"; region: string; device: string | null; delivery: Delivery; platform?: DesktopPlatform };
/** One of the user's computers with the Rendrr app open (one account can be open on several): id (the app's own),
 *  name, platform; renders: it can render (on, ready, not turned off); busy: rendering now; why: why it cannot. */
export type DeviceStatus = { id: string; name: string | null; platform: DesktopPlatform; version: string | null; seenAt: number; renders: boolean; busy: boolean; why: string | null };
/** renders: the desktop app is open and renders there (on, ready, not turned off); why: why not, when it is open but
 *  does not; platform: a Mac or a Windows PC. The top fields are the main computer (the one picked, else the first
 *  that renders); devices: every computer online; choice: the one the user picked ("cloud": Rendrr's cloud), if any. */
export type MacStatus = { online: boolean; device: string | null; version: string | null; seenAt: number | null; renders?: boolean; why?: string | null; platform?: DesktopPlatform; deviceId?: string | null; devices?: DeviceStatus[]; choice?: string | null;
  /** None open now: the computer Rendrr heard from last today (its name, platform and when). */
  lastSeen?: { name: string | null; platform: DesktopPlatform; at: number } | null };

/** "3 minutes ago", "5 hours ago". */
export function agoText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  return `${h} ${h === 1 ? "hour" : "hours"} ago`;
}

/**
 * No Rendrr app open now, but one was today: when Rendrr last heard from it and what the user can check, for the AI
 * to say instead of only "not open" (the user often sees the app in the Dock and thinks it is open).
 */
export function lastSeenText(seen: NonNullable<MacStatus["lastSeen"]>, now = Date.now()): string {
  const m = machineWord(seen.platform), appName = desktopAppName(seen.platform);
  const where = seen.platform === "windows" ? "the taskbar" : "the Dock";
  return `Rendrr last heard from the ${appName} on ${seen.name ? `"${seen.name}"` : `the user's ${m}`} ${agoText(now - seen.at)}; an open app checks in every 20 seconds. If the user says it is open: its window may have been closed (an older ${appName} stops checking in then, though it stays in ${where}), the ${m} may have slept, or it cannot reach Rendrr. Ask them to quit Rendrr and open it again (or update it from the Rendrr app's update bar), and check it is logged in to this same account. It shows as open here within 20 seconds; then render again.`;
}

/** "Studio Mac" (Mac), or "Gaming PC" (PC). */
export const deviceLabel = (d: Pick<DeviceStatus, "name" | "platform">) => `"${d.name || "this computer"}" (${machineWord(d.platform)})`;
/** The computers that can render, for a list: "Studio Mac" (Mac) and "Gaming PC" (PC). */
export function devicesText(list: Pick<DeviceStatus, "name" | "platform">[]): string {
  const parts = list.map(deviceLabel);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A Mac's name for people: "Ronniis-MacBook-Pro.local" -> "Ronniis MacBook Pro". Nothing usable gives null. */
export function deviceName(raw?: string | null): string | null {
  const s = String(raw ?? "").replace(/\.local$/i, "").replace(/[-_]+/g, " ").replace(/[^\p{L}\p{N} '’.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

const macOf = (d: Delivery) => (d.device ? `the ${desktopAppName(d.platform)} on "${d.device}"` : `the ${desktopAppName(d.platform)} on your ${machineWord(d.platform)}`);

const onMac = (device: string | null, p?: string | null) => (device ? `your ${machineWord(p)} ("${device}")` : `your ${machineWord(p)}`);

/** One sentence: where it is (or was) made, and where the file goes. done: the render has finished. */
export function whereText(w: RenderWhere, kind: "preview" | "final" | string, done: boolean): string {
  if (w.renders === "mac") {
    const made = `${done ? "Rendered" : "Rendering"} on ${onMac(w.device, w.platform)} by the ${desktopAppName(w.platform)} (graphics and checks on ${CLOUD}).`;
    if (kind !== "final") return `${made} It plays in Rendrr and in the chat's card.`;
    return `${made} ${done ? "Saved" : "It is saved"} in that ${machineWord(w.platform)}'s Downloads folder${done ? "" : " the moment it is done"}; it downloads from Rendrr too.`;
  }
  const made = `${done ? "Rendered" : "Rendering"} on ${CLOUD} (${w.region}), not on your computer.`;
  if (kind !== "final") return `${made} It plays in Rendrr and in the chat's card.`;
  const d = w.delivery;
  if (d.to === "mac") {
    if (d.state === "sent") return `${made} Sent to ${macOf(d)}: saved in its Downloads folder.`;
    return `${made} Goes to ${macOf(d)}: it saves the file to Downloads ${done ? "now" : "the moment it is done"}.`;
  }
  if (d.to === "drive") return `${made} Goes to Google Drive${d.folder ? ` › ${d.folder}` : ""}.`;
  return `${made} Download it from Rendrr or the card's download button.`;
}

/** A few words for a chip or a line under a player. */
export function whereShort(w: RenderWhere, kind: "preview" | "final" | string): string {
  const mac = w.device ? `"${w.device}"` : `your ${machineWord(w.platform)}`;
  if (w.renders === "mac") return kind === "final" ? `Made on ${mac} · Saved to Downloads` : `Made on ${mac}`;
  if (kind !== "final") return "Made on Rendrr's cloud server";
  const d = w.delivery;
  if (d.to === "mac") return `Made in the cloud · ${d.state === "sent" ? "Saved to" : "Going to"} ${d.device ? `"${d.device}"` : `your ${machineWord(d.platform)}`}`;
  if (d.to === "drive") return `Made in the cloud · Google Drive${d.folder ? ` › ${d.folder}` : ""}`;
  return "Made in the cloud · Download";
}

/** Where the AI's next render is made and where its export goes, for get_project and the Connect page. */
export function nextExportText(mac: MacStatus): string {
  const able = (mac.devices || []).filter((d) => d.renders);
  if (able.length > 1) {
    const picked = mac.choice === "cloud" ? `the user picked ${CLOUD}` : able.find((d) => d.id === mac.choice) ? `the user picked ${deviceLabel(able.find((d) => d.id === mac.choice)!)}` : "";
    return `${able.length} of the user's computers can render now: ${devicesText(able)}, or ${CLOUD}. ${picked ? `For now ${picked} (renders go there; pass device to switch).` : "The next render asks which one to use: ask the user, then pass device (its name, or \"cloud\")."} Finals made on a computer are saved to its Downloads.`;
  }
  const on = mac.device ? ` on "${mac.device}"` : "";
  const m = machineWord(mac.platform), appName = desktopAppName(mac.platform);
  if (mac.online && mac.renders) return `Renders run on the user's ${m}: the ${appName} is open${on}, so previews and finals are made there (graphics, the person's cut-out and checks on ${CLOUD}) and finals are saved to its Downloads. If the ${m} cannot take one, ${CLOUD} makes it.`;
  return mac.online
    ? `Renders run on ${CLOUD}${mac.why ? ` (${mac.why})` : ""}. The ${appName} is open${on}, so finals your AI exports go to that ${m}'s Downloads.`
    : `Renders run on ${CLOUD}. The Rendrr app (Mac or Windows) is not open, so finals your AI exports go to Google Drive (or a download link).${mac.lastSeen ? ` ${lastSeenText(mac.lastSeen)}` : ""}`;
}

/**
 * The original of footage added in the Rendrr desktop app stays on that computer (never uploaded): what Rendrr knows of
 * it, so a final made on that computer reads the file itself, at full quality, while the cloud keeps only the preview
 * copy. width x height: the picture as shown (turned upright); transfer: HDR (pq, hlg) or null; platform: Mac or PC.
 */
export type MacOriginal = { device: string | null; deviceId?: string | null; size: number; name: string; width: number; height: number; fps: number; seconds: number; hasAudio: boolean; transfer: "pq" | "hlg" | null; at: number; platform: DesktopPlatform };

/** A video's original on a Mac, when one is kept there and what was kept reads right (null otherwise). */
export function macOriginalOf(v: { macOriginal?: unknown } | null | undefined): MacOriginal | null {
  const m = v?.macOriginal as Partial<MacOriginal> | null | undefined;
  if (!m || typeof m !== "object") return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  if (!n(m.size) || !n(m.width) || !n(m.height)) return null;
  return { device: typeof m.device === "string" && m.device ? m.device : null, deviceId: typeof m.deviceId === "string" && /^[\w:. -]{1,80}$/.test(m.deviceId) ? m.deviceId : null, size: n(m.size), name: typeof m.name === "string" ? m.name.slice(0, 200) : "", width: Math.round(n(m.width)), height: Math.round(n(m.height)), fps: n(m.fps) || 30, seconds: n(m.seconds), hasAudio: m.hasAudio !== false, transfer: m.transfer === "pq" || m.transfer === "hlg" ? m.transfer : null, at: n(m.at), platform: platformOf(m.platform) };
}
