// The @ footage picker in comment boxes (the editor, a pinned comment, the Rendrr app in the chat): typing @ shows the
// client's footage folder first, then every library folder; a folder opens as a list of its clips (a picture each, a
// short preview on hover); the clip picked goes into the comment with its real id (clipRefs.ts), and get_comments tells
// the AI exactly which library video that is.
import { enqueue, notFound, redis, signGet, type FramesJob } from "@rendrr/core";
import { prisma, type Video } from "@rendrr/db";
import { clipRefs, hoverKeyOf, hoverMarkKey, PREFIX } from "@rendrr/shared";
import { folderTree, listLibraryFolders, ownLibraryFolder } from "./libraryFolders";
import { getOwnedProject } from "./projects";

const LINK_SECONDS = 3 * 3600;
/** The most clips one folder (or a search) sends at once. */
export const PICKER_CLIPS_MAX = 200;
const SEARCH_MAX = 40;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

export type PickerFolder = { id: string; name: string; path: string; parentId: string | null; count: number; total: number; folders: number };
export type PickerFolders = {
  /** The edit's client (its project folder) and the library folder shown first for it. why: "set" (chosen for this
   *  client), "name" (a library folder with the client's name), "footage" (where the edit's own video is), or null. */
  client: { id: string; name: string; libraryFolderId: string | null; why: "set" | "name" | "footage" | null };
  folders: PickerFolder[];
  /** Videos not in any folder. */
  loose: number;
};
/** preview: the tiny hover clip; soon: it is being made now (ask again in a few seconds). */
export type PickerClip = { id: string; name: string; seconds: number; still: boolean; status: string; ready: boolean; orientation: string; w: number | null; h: number | null; folderId: string | null; path: string | null; thumb: string | null; preview: string | null; soon?: boolean };
/** Hover clips asked for at most per listing (the rest on the next one), behind the AI's own frames in the line. */
const HOVER_ASK_MAX = 40;
const framesDir = (v: { userId: string; id: string }) => `${PREFIX.frames}${v.userId}/${v.id}/`;

async function clientOf(userId: string, ref: { projectId?: string; folderId?: string }) {
  const folderId = ref.folderId ?? (ref.projectId ? (await getOwnedProject(userId, ref.projectId)).folderId : null);
  if (!folderId) throw notFound("Pick an edit first.");
  const f = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!f || f.userId !== userId) throw notFound("That project is gone, or is not yours.");
  return f;
}

/** The folders the picker lists, the client's first. */
export async function pickerFolders(userId: string, ref: { projectId?: string; folderId?: string }): Promise<PickerFolders> {
  const client = await clientOf(userId, ref);
  const [all, loose] = await Promise.all([
    listLibraryFolders(userId),
    prisma.video.count({ where: { userId, libraryFolderId: null, kind: { not: "canvas" }, deletedAt: null } }),
  ]);
  const folders: PickerFolder[] = all.map((f) => ({ id: f.id, name: f.name, path: f.path, parentId: f.parentId, count: f.count, total: f.total, folders: f.folders }));
  const has = (id: string | null | undefined) => !!id && folders.some((f) => f.id === id);
  let libraryFolderId: string | null = null, why: PickerFolders["client"]["why"] = null;
  if (has(client.libraryFolderId)) { libraryFolderId = client.libraryFolderId; why = "set"; }
  else {
    // A library folder named like the client (the top-most one), else the folder the edit's own footage is in.
    const n = norm(client.name);
    const named = n ? folders.filter((f) => norm(f.name) === n).sort((a, b) => a.path.split(" / ").length - b.path.split(" / ").length)[0] : undefined;
    if (named) { libraryFolderId = named.id; why = "name"; }
    else if (ref.projectId) {
      const p = await prisma.project.findUnique({ where: { id: ref.projectId }, select: { video: { select: { libraryFolderId: true } } } });
      if (has(p?.video?.libraryFolderId)) { libraryFolderId = p!.video!.libraryFolderId; why = "footage"; }
    }
  }
  return { client: { id: client.id, name: client.name, libraryFolderId, why }, folders, loose };
}

/** Sets (or clears, null) the library folder shown first for a client. */
export async function setClientFootage(userId: string, ref: { projectId?: string; folderId?: string }, libraryFolderId: string | null) {
  const client = await clientOf(userId, ref);
  if (libraryFolderId) await ownLibraryFolder(userId, libraryFolderId);
  await prisma.folder.update({ where: { id: client.id }, data: { libraryFolderId } });
  return pickerFolders(userId, { ...ref, folderId: client.id });
}

async function clipOut(v: Video, path: string | null, hover: "have" | "soon" | "none"): Promise<PickerClip> {
  const ready = v.status === "ready";
  return {
    id: v.id, name: v.name, seconds: Math.round(v.seconds * 100) / 100, still: v.still, status: v.status, ready, orientation: v.orientation, w: v.width ?? null, h: v.height ?? null,
    folderId: v.libraryFolderId ?? null, path,
    thumb: v.thumbKey ? await signGet(v.thumbKey, LINK_SECONDS) : null,
    // The tiny hover clip (never the full file); while it is being made the picture shows.
    preview: hover === "have" ? await signGet(hoverKeyOf(framesDir(v)), LINK_SECONDS) : null,
    ...(hover === "soon" ? { soon: true } : {}),
  };
}

/** Which clips already have their hover preview; the others (up to HOVER_ASK_MAX) are asked for now. */
async function hoverState(vs: Video[]): Promise<Map<string, "have" | "soon" | "none">> {
  const out = new Map<string, "have" | "soon" | "none">();
  const can = vs.filter((v) => v.proxyKey && !v.still && v.status !== "expired");
  for (const v of vs) out.set(v.id, "none");
  if (!can.length) return out;
  const marks = await redis().mget(...can.map((v) => hoverMarkKey(v.id))).catch(() => can.map(() => null));
  let asked = 0;
  for (const [i, v] of can.entries()) {
    if (marks[i]) { out.set(v.id, "have"); continue; }
    if (asked >= HOVER_ASK_MAX) continue;
    asked++;
    out.set(v.id, "soon");
    // One job per video (its id): asking again while it is waiting or after it is made adds nothing.
    void enqueue<FramesJob>("frames", { times: [], hover: v.id }, { jobId: `hover-${v.id}`, priority: 10, attempts: 1 }).catch(() => null);
  }
  return out;
}

/** The clips of one library folder (its own, in name order), the videos in no folder (loose), or a search by name. */
export async function pickerClips(userId: string, q: { folderId?: string | null; loose?: boolean; query?: string | null }): Promise<{ clips: PickerClip[]; more: number }> {
  const base = { userId, kind: { not: "canvas" }, deletedAt: null } as const;
  const tree = await folderTree(userId);
  const pathOf = (id: string | null) => { const f = id ? tree.byId.get(id) : null; return f ? tree.path(f) : null; };
  const query = (q.query || "").trim();
  let vs: Video[];
  if (query) {
    const words = norm(query).split(" ").filter(Boolean);
    const found = await prisma.video.findMany({ where: { ...base, AND: words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })), ...(q.folderId ? { libraryFolderId: q.folderId } : {}) }, orderBy: { createdAt: "desc" }, take: 400 });
    vs = found;
  } else if (q.folderId) {
    await ownLibraryFolder(userId, q.folderId);
    vs = await prisma.video.findMany({ where: { ...base, libraryFolderId: q.folderId } });
  } else if (q.loose) {
    vs = await prisma.video.findMany({ where: { ...base, libraryFolderId: null }, orderBy: { createdAt: "desc" }, take: 1000 });
  } else vs = [];
  if (!query) vs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.createdAt.getTime() - b.createdAt.getTime());
  const max = query ? SEARCH_MAX : PICKER_CLIPS_MAX;
  const shown = vs.slice(0, max);
  const hover = await hoverState(shown);
  return { clips: await Promise.all(shown.map((v) => clipOut(v, pathOf(v.libraryFolderId), hover.get(v.id) ?? "none"))), more: Math.max(0, vs.length - shown.length) };
}

const secs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s * 10) / 10} s`);

/** For get_comments: what each @clip a comment names is (its videoId, library folder, length, whether it is ready),
 *  so the AI uses exactly that video. Empty when the comment names none. */
export async function clipRefsText(userId: string, texts: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(texts.flatMap((t) => clipRefs(t).map((r) => r.id)))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const [vs, tree] = await Promise.all([prisma.video.findMany({ where: { id: { in: ids }, userId } }), folderTree(userId)]);
  const by = new Map(vs.map((v) => [v.id, v]));
  for (const id of ids) {
    const v = by.get(id);
    if (!v || v.deletedAt) { out.set(id, `videoId ${id}: not in the library any more (deleted or not theirs): ask the user which clip to use`); continue; }
    const f = v.libraryFolderId ? tree.byId.get(v.libraryFolderId) : null;
    out.set(id, `videoId ${v.id} = "${v.name}"${f ? ` in library folder "${tree.path(f)}"` : ""}, ${v.still ? "a picture" : secs(v.seconds)}${v.status === "ready" ? "" : `, ${v.status} (not ready yet: add_footage videoId with wait_seconds waits)`}`);
  }
  return out;
}
