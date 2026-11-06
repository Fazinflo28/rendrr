// The Rendrr mark for AI chats: Claude, ChatGPT and other clients show a connector's icon next to "Using Rendrr" from
// the server's own info (MCP `icons`) or from the favicon of the connector's address. Both are served here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");

/** Served path → file and type. */
export const ICON_FILES: Record<string, { file: string; type: string }> = {
  "/favicon.ico": { file: "favicon.ico", type: "image/x-icon" },
  "/favicon.png": { file: "icon-192.png", type: "image/png" },
  "/favicon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/icon.png": { file: "icon.png", type: "image/png" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/icon-64.png": { file: "icon-64.png", type: "image/png" },
  "/logo.png": { file: "icon.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
  "/apple-touch-icon-precomposed.png": { file: "apple-touch-icon.png", type: "image/png" },
};

const cache = new Map<string, Buffer>();
export function iconBytes(file: string): Buffer {
  let b = cache.get(file);
  if (!b) { b = readFileSync(join(DIR, file)); cache.set(file, b); }
  return b;
}

/** The small mark inline, so a client that does not fetch links still has it. */
const inline = () => `data:image/png;base64,${iconBytes("icon-64.png").toString("base64")}`;

/** MCP `icons` for the server's info: links on this server's address, and the small one inline. */
export function serverIcons(base: string) {
  const b = base.replace(/\/$/, "");
  return [
    { src: `${b}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
    { src: `${b}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
    { src: `${b}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    { src: inline(), mimeType: "image/png", sizes: ["64x64"] },
  ];
}

/** The <head> lines that point browsers and favicon fetchers at the mark. */
export const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#0b0c0e">`;
