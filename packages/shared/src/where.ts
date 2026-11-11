// Where a render is made and where its file goes, said the same way everywhere (the AI's tool answers, the Claude card,
// the web app). While the Rendrr Mac app is open (and able to render), renders are made on that Mac: the cloud prepares
// them (graphics, the person's cut-out, the sound's loudness) and the Mac makes the video; a final it makes is saved to
// its Downloads. With the app closed, or when the Mac cannot take one, they are made on Rendrr's cloud server.

export const CLOUD = "Rendrr's cloud server";
export const CLOUD_REGION = "US East";

export type DeliveryTo = "mac" | "drive" | "download";
/** waiting: the Mac app takes it when it is done; sent: the Mac app took it and saves it to Downloads. */
export type MacState = "waiting" | "sent";
export type Delivery = { to: DeliveryTo; device: string | null; state: MacState | null; folder: string | null; at: number | null };
/** renders: where it is (or was) made; device: the Mac's name when on a Mac. */
export type RenderWhere = { renders: "cloud" | "mac"; region: string; device: string | null; delivery: Delivery };
/** renders: the Mac app is open and renders there (on, ready, not turned off); why: why not, when it is open but does not. */
export type MacStatus = { online: boolean; device: string | null; version: string | null; seenAt: number | null; renders?: boolean; why?: string | null };

/** A Mac's name for people: "Ronniis-MacBook-Pro.local" -> "Ronniis MacBook Pro". Nothing usable gives null. */
export function deviceName(raw?: string | null): string | null {
  const s = String(raw ?? "").replace(/\.local$/i, "").replace(/[-_]+/g, " ").replace(/[^\p{L}\p{N} '’.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

const macOf = (d: Delivery) => (d.device ? `the Rendrr Mac app on "${d.device}"` : "the Rendrr Mac app on your Mac");

const onMac = (device: string | null) => (device ? `your Mac ("${device}")` : "your Mac");

/** One sentence: where it is (or was) made, and where the file goes. done: the render has finished. */
export function whereText(w: RenderWhere, kind: "preview" | "final" | string, done: boolean): string {
  if (w.renders === "mac") {
    const made = `${done ? "Rendered" : "Rendering"} on ${onMac(w.device)} by the Rendrr Mac app (graphics and checks on ${CLOUD}).`;
    if (kind !== "final") return `${made} It plays in Rendrr and in the chat's card.`;
    return `${made} ${done ? "Saved" : "It is saved"} in that Mac's Downloads folder${done ? "" : " the moment it is done"}; it downloads from Rendrr too.`;
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
  const mac = w.device ? `"${w.device}"` : "your Mac";
  if (w.renders === "mac") return kind === "final" ? `Made on ${mac} · Saved to Downloads` : `Made on ${mac}`;
  if (kind !== "final") return "Made on Rendrr's cloud server";
  const d = w.delivery;
  if (d.to === "mac") return `Made in the cloud · ${d.state === "sent" ? "Saved to" : "Going to"} ${d.device ? `"${d.device}"` : "your Mac"}`;
  if (d.to === "drive") return `Made in the cloud · Google Drive${d.folder ? ` › ${d.folder}` : ""}`;
  return "Made in the cloud · Download";
}

/** Where the AI's next render is made and where its export goes, for get_project and the Connect page. */
export function nextExportText(mac: MacStatus): string {
  const on = mac.device ? ` on "${mac.device}"` : "";
  if (mac.online && mac.renders) return `Renders run on the user's Mac: the Rendrr Mac app is open${on}, so previews and finals are made there (graphics, the person's cut-out and checks on ${CLOUD}) and finals are saved to its Downloads. If the Mac cannot take one, ${CLOUD} makes it.`;
  return mac.online
    ? `Renders run on ${CLOUD}${mac.why ? ` (${mac.why})` : ""}. The Rendrr Mac app is open${on}, so finals your AI exports go to that Mac's Downloads.`
    : `Renders run on ${CLOUD}. The Rendrr Mac app is not open, so finals your AI exports go to Google Drive (or a download link).`;
}
