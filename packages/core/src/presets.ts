// Client presets (audit #24): each folder (one per client or series) remembers the style, the shape and the Google
// Drive folder its edits last used, and a new edit in it starts with them: the shape is the new edit's, the style is
// attached for the user's AI to read (Rendrr never applies a style itself), and a final made on Rendrr's cloud is
// saved to that Drive folder when no other is given.
import { prisma, type Prisma } from "@rendrr/db";

export type FolderPreset = { styleId?: string | null; aspect?: string | null; drive?: { folderId: string; path: string | null } | null };

/** A preset as stored, kept only in its known shape (anything else is left out). */
export function presetOf(x: unknown): FolderPreset {
  if (!x || typeof x !== "object") return {};
  const r = x as Record<string, unknown>, out: FolderPreset = {};
  if (typeof r.styleId === "string" && r.styleId.length <= 80) out.styleId = r.styleId;
  if (typeof r.aspect === "string" && /^\d{1,2}:\d{1,2}$/.test(r.aspect)) out.aspect = r.aspect;
  const d = r.drive as Record<string, unknown> | null | undefined;
  if (d && typeof d === "object" && typeof d.folderId === "string" && /^[\w-]{1,128}$/.test(d.folderId)) out.drive = { folderId: d.folderId, path: typeof d.path === "string" ? d.path.slice(0, 300) : null };
  return out;
}

/** The preset's Drive folder as a folder reference the Drive lookup takes. */
export const presetDriveRef = (p: FolderPreset) => (p.drive ? `https://drive.google.com/drive/folders/${p.drive.folderId}` : null);

/** A few words for the AI: what the folder's new edits start with ("" when nothing). */
export function presetText(p: FolderPreset): string {
  return [p.aspect, p.styleId ? `style ${p.styleId}` : null, p.drive ? `Drive ${p.drive.path || p.drive.folderId}` : null].filter(Boolean).join(", ");
}

/**
 * Remembers what an edit in the folder just used (best effort: a preset that cannot be saved changes nothing else).
 * The folder keeps its place in the list (remembering is not working in it).
 */
export async function rememberPreset(folderId: string, change: FolderPreset): Promise<void> {
  try {
    const f = await prisma.folder.findUnique({ where: { id: folderId }, select: { preset: true, updatedAt: true } });
    if (!f) return;
    const cur = presetOf(f.preset), next = presetOf({ ...cur, ...change });
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    await prisma.folder.update({ where: { id: folderId }, data: { preset: next as Prisma.InputJsonValue, updatedAt: f.updatedAt } });
  } catch (e) {
    console.error("[preset] not remembered:", (e as Error).message.slice(0, 200));
  }
}
