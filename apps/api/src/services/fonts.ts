import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError, deleteObject, putObject } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { GRAPHIC_FONTS, PREFIX } from "@rendrr/shared";

// Fonts the user adds once (add_font, Settings) and graphics use by family name. The worker loads the ones a
// graphic's code names as @font-face data URLs.
export const FONT_MAX = 2 * 1024 * 1024;
const TYPES = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" } as const;
type FontFormat = keyof typeof TYPES;

/** The format from the file's first bytes; null for anything that is not a font file Rendrr can use. */
export function fontFormat(b: Buffer): FontFormat | null {
  if (b.length < 12) return null;
  const tag = b.subarray(0, 4).toString("latin1");
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (b.readUInt32BE(0) === 0x00010000 || tag === "true") return "ttf";
  return null;
}

/** Loopback, private, link-local and other non-public addresses (a font url must not reach Rendrr's own network). */
export function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
}

/** A font from a public https url: every hop's address checked (redirects too), 2 MB at most, 20 s. */
export async function fetchFont(url: string): Promise<Buffer> {
  let u: URL;
  try { u = new URL(url); } catch { throw new AppError("That font url is not a url.", 400, "bad-font"); }
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "https:") throw new AppError("Font urls must start with https://.", 400, "bad-font");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw new AppError(`Could not find ${host}.`, 400, "bad-font");
    if (addrs.some(privateAddress)) throw new AppError("That font url is not on the public internet.", 400, "bad-font");
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch((e) => { throw new AppError(`Could not download the font: ${(e as Error).message}.`, 400, "bad-font"); });
    const to = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && to) { u = new URL(to, u); continue; }
    if (!r.ok || !r.body) throw new AppError(`The font url answered ${r.status}.`, 400, "bad-font");
    if (Number(r.headers.get("content-length") || 0) > FONT_MAX) throw new AppError("Font files are 2 MB at most.", 400, "bad-font");
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > FONT_MAX) throw new AppError("Font files are 2 MB at most.", 400, "bad-font");
      parts.push(Buffer.from(c));
    }
    return Buffer.concat(parts);
  }
  throw new AppError("The font url redirects too many times.", 400, "bad-font");
}

/** Keeps a font file under its family, weight and style (the same three again replace the file). */
export async function addFont(userId: string, f: { family: string; weight: number; style: string }, buf: Buffer) {
  if (buf.length > FONT_MAX) throw new AppError("Font files are 2 MB at most.", 400, "bad-font");
  const format = fontFormat(buf);
  if (!format) throw new AppError("That is not a TTF, OTF, WOFF or WOFF2 font file. Nothing was saved.", 400, "bad-font");
  const where = { userId_family_weight_style: { userId, family: f.family, weight: f.weight, style: f.style } };
  const old = await prisma.font.findUnique({ where });
  if (!old && (await prisma.font.count({ where: { userId } })) >= 100) throw new AppError("You have 100 fonts. Delete some in Settings first.", 409);
  const row = old ?? (await prisma.font.create({ data: { userId, family: f.family, weight: f.weight, style: f.style, format, key: "pending", size: buf.length } }));
  const key = `${PREFIX.fonts}${userId}/${row.id}-${Date.now().toString(36)}.${format}`;
  await putObject(key, buf, TYPES[format]);
  await prisma.font.update({ where: { id: row.id }, data: { key, format, size: buf.length } });
  if (old) await deleteObject(old.key).catch(() => {});
  // A family that is also installed: the user's file is what graphics naming it draw with.
  const installed = Object.values(GRAPHIC_FONTS).flat().some((x) => x.toLowerCase() === f.family.toLowerCase());
  return { id: row.id, family: f.family, weight: f.weight, style: f.style, format, size: buf.length, replaced: !!old, installed };
}

export async function listFonts(userId: string) {
  const fs = await prisma.font.findMany({ where: { userId }, orderBy: [{ family: "asc" }, { weight: "asc" }, { style: "asc" }] });
  return fs.map((x) => ({ id: x.id, family: x.family, weight: x.weight, style: x.style, format: x.format, size: x.size, createdAt: x.createdAt }));
}

export async function deleteFont(userId: string, id: string) {
  const f = await prisma.font.findUnique({ where: { id } });
  if (!f || f.userId !== userId) throw new AppError("That font is gone.", 404, "not-found");
  await prisma.font.delete({ where: { id } });
  await deleteObject(f.key).catch(() => {});
}

/** "Brand Sans 400, 700 italic; Other 400", for list_graphics. */
export function fontsText(fs: { family: string; weight: number; style: string }[]) {
  const by = new Map<string, string[]>();
  for (const f of fs) by.set(f.family, [...(by.get(f.family) ?? []), `${f.weight}${f.style === "italic" ? " italic" : ""}`]);
  return Array.from(by, ([fam, ws]) => `${fam} ${ws.join(", ")}`).join("; ");
}
