import { AppError, deleteObject, putObject } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { GRAPHIC_FONTS, PREFIX } from "@rendrr/shared";
import { fetchPublic } from "./fetchPublic";

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

export { privateAddress } from "./fetchPublic";

/** A font from a public https url (fetchPublic: every hop checked), 2 MB at most. */
export const fetchFont = async (url: string): Promise<Buffer> => (await fetchPublic(url, { max: FONT_MAX, what: "font", code: "bad-font" })).buf;

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
