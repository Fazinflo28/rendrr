// The Assets page (once "Library"): the user's videos, pictures, elements (logos and overlays, transparent), audio,
// favourites and the Trash. Shared by the web, the API and the AI's tools.
import type { Key } from "./motion";

export const ASSET_TYPES = ["video", "image", "element", "audio"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const isAssetType = (x: unknown): x is AssetType => typeof x === "string" && (ASSET_TYPES as readonly string[]).includes(x);

/** The sections of the Assets page, in the order the side bar shows them. */
export const ASSET_SECTIONS = [
  { id: "all", label: "All assets", icon: "layers" },
  { id: "videos", label: "Videos", icon: "film", type: "video" },
  { id: "images", label: "Images", icon: "image", type: "image" },
  { id: "elements", label: "Elements", icon: "spark", type: "element" },
  { id: "audio", label: "Audio", icon: "wave", type: "audio" },
  { id: "favorites", label: "Favorites", icon: "heart" },
  { id: "trash", label: "Trash", icon: "trash" },
] as const;
export type AssetSection = (typeof ASSET_SECTIONS)[number]["id"];
export const isAssetSection = (x: unknown): x is AssetSection => ASSET_SECTIONS.some((s) => s.id === x);

/** Deleted assets wait in the Trash this long, then go for good (unless an edit still uses them). */
export const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;
/** Whole days left before a trashed asset goes for good (0 on its last day). */
export function trashDaysLeft(deletedAt: Date | number | string, now = Date.now()): number {
  const at = new Date(deletedAt).getTime();
  return Math.max(0, Math.ceil((at + TRASH_DAYS * DAY_MS - now) / DAY_MS));
}
/** Trashed before this moment: due to go for good. */
export const trashCutoff = (now = Date.now()) => new Date(now - TRASH_DAYS * DAY_MS);

/** Elements: logos and overlay pictures (PNG keeps its transparency; SVG is drawn to a PNG in the browser first). */
export const ELEMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ELEMENT_MAX_SIDE = 2048;
export const ELEMENT_ACCEPT = "image/png,image/webp,image/jpeg,image/svg+xml";
/** An element plays as a 1 s transparent clip held for as long as it is placed. */
export const ELEMENT_SECONDS = 1;

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
/**
 * Keyframes that put an element at a corner of the frame at about `size` of the frame's longer side (a graphic fills the
 * frame by itself, as large as it fits, so a logo needs scaling down). x, y: centre offset as a share of the frame.
 */
export function elementKeys(el: { width: number; height: number }, frame: { width: number; height: number }, corner: Corner = "top-right", size = 0.18): Key[] {
  const W = frame.width, H = frame.height, w = Math.max(1, el.width), h = Math.max(1, el.height);
  const fit = Math.min(W / w, H / h); // the picture drawn as large as it fits in the frame
  const fw = w * fit, fh = h * fit;
  const box = size * Math.max(W, H);
  const scale = Math.max(0.05, Math.min(1, Math.min(box / fw, box / fh)));
  const dw = fw * scale, dh = fh * scale, m = 0.045 * Math.min(W, H);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  if (corner === "center") return [{ t: 0, scale: r3(scale), x: 0, y: 0 }];
  const x = (W / 2 - m - dw / 2) / W, y = (H / 2 - m - dh / 2) / H;
  return [{ t: 0, scale: r3(scale), x: r3(corner.endsWith("left") ? -x : x), y: r3(corner.startsWith("top") ? -y : y) }];
}

/** Which section a library video belongs to: a picture (a still) is an image, anything else a video. */
export const videoSection = (v: { still?: boolean | null }): "images" | "videos" => (v.still ? "images" : "videos");

export const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
