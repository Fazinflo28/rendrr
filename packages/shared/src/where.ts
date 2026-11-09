// Where a render is made and where its file goes, said the same way everywhere (the AI's tool answers, the Claude card,
// the web app). Every render, preview or final, is made on Rendrr's cloud server: the Mac app never renders. When the
// Rendrr Mac app is open, an export from the AI goes to that Mac: the app saves the finished file to Downloads.

export const CLOUD = "Rendrr's cloud server";
export const CLOUD_REGION = "US East";

export type DeliveryTo = "mac" | "drive" | "download";
/** waiting: the Mac app takes it when it is done; sent: the Mac app took it and saves it to Downloads. */
export type MacState = "waiting" | "sent";
export type Delivery = { to: DeliveryTo; device: string | null; state: MacState | null; folder: string | null; at: number | null };
export type RenderWhere = { renders: "cloud"; region: string; delivery: Delivery };
export type MacStatus = { online: boolean; device: string | null; version: string | null; seenAt: number | null };

/** A Mac's name for people: "Ronniis-MacBook-Pro.local" -> "Ronniis MacBook Pro". Nothing usable gives null. */
export function deviceName(raw?: string | null): string | null {
  const s = String(raw ?? "").replace(/\.local$/i, "").replace(/[-_]+/g, " ").replace(/[^\p{L}\p{N} '’.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

const macOf = (d: Delivery) => (d.device ? `the Rendrr Mac app on "${d.device}"` : "the Rendrr Mac app on your Mac");

/** One sentence: where it is (or was) made, and where the file goes. done: the render has finished. */
export function whereText(w: RenderWhere, kind: "preview" | "final" | string, done: boolean): string {
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
  if (kind !== "final") return "Made on Rendrr's cloud server";
  const d = w.delivery;
  if (d.to === "mac") return `Made in the cloud · ${d.state === "sent" ? "Saved to" : "Going to"} ${d.device ? `"${d.device}"` : "your Mac"}`;
  if (d.to === "drive") return `Made in the cloud · Google Drive${d.folder ? ` › ${d.folder}` : ""}`;
  return "Made in the cloud · Download";
}

/** Where the AI's next export goes, for get_project and the Connect page. */
export function nextExportText(mac: MacStatus): string {
  return mac.online
    ? `Renders run on ${CLOUD}. The Rendrr Mac app is open${mac.device ? ` on "${mac.device}"` : ""}, so finals your AI exports go to that Mac's Downloads.`
    : `Renders run on ${CLOUD}. The Rendrr Mac app is not open, so finals your AI exports go to Google Drive (or a download link).`;
}
