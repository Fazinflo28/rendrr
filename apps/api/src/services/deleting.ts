// Deleting the user's things, for the web app and for their AI (delete_items). Footage (videos and pictures), elements
// and audio go to the Trash first (Assets > Trash, TRASH_DAYS days; an edit using them keeps working; restore brings
// them back); edits are marked deleted (restore brings them back). For good (permanent) only when asked, and never
// silently past something that uses it: footage used by edits, an element or audio used by edits, or a project
// folder with edits in it is named and left alone unless force is given.
import { AppError, deleteObject, deleteObjects, deletePrefix, editsUsing, purgeElement, purgeSound, purgeTrash } from "@rendrr/core";
import { prisma, type Video } from "@rendrr/db";
import { PREFIX, trashDaysLeft } from "@rendrr/shared";
import { deleteFont } from "./fonts";
import { deleteLibraryFolder } from "./libraryFolders";
import { purgeProjectFiles } from "./projects";
import { rememberRemoved } from "./driveLibrary";

export const DELETE_KINDS = ["video", "edit", "folder", "library_folder", "element", "audio", "font", "lut", "style"] as const;
export type DeleteKind = (typeof DELETE_KINDS)[number];
export type DeleteItem = { kind: DeleteKind; id: string };

const framesPrefix = (v: { userId: string; id: string }) => `${PREFIX.frames}${v.userId}/${v.id}/`;
const names = (list: { name: string }[]) => list.slice(0, 5).map((p) => `"${p.name}"`).join(", ") + (list.length > 5 ? ` and ${list.length - 5} more` : "");
const editWord = (n: number) => (n === 1 ? "edit" : "edits");

/** Edits made from this footage, or playing it on V1 (one part of a several-video edit, an added clip). */
export async function editsOfVideo(v: Pick<Video, "id" | "userId">) {
  const onV1 = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Project" WHERE "userId" = ${v.userId} AND "deletedAt" IS NULL AND jsonb_path_exists(timeline, '$.tracks.v1[*] ? (@.sourceVideoId == $vid)', jsonb_build_object('vid', ${v.id}::text))`;
  return prisma.project.findMany({ where: { OR: [{ videoId: v.id }, { id: { in: onV1.map((r) => r.id) } }], deletedAt: null }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" } });
}

/** Footage gone for good, with its files. withEdits: the edits made from it go too (else an error names them). */
export async function deleteVideoForGood(v: Video, withEdits: boolean) {
  const edits = await editsOfVideo(v);
  if (edits.length && !withEdits) throw new AppError(`"${v.name}" is used by ${edits.length} ${editWord(edits.length)}: ${names(edits)}. Deleting it deletes ${edits.length === 1 ? "that edit" : "those edits"} too.`, 409, "in-use");
  if (edits.length) await prisma.project.updateMany({ where: { id: { in: edits.map((p) => p.id) } }, data: { deletedAt: new Date() } });
  const an = await prisma.footageAnalysis.findUnique({ where: { videoId: v.id } });
  // Footage brought in from the chat: Rendrr kept its raw, so that goes too.
  await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, v.source === "upload" ? v.sourceKey : null, ...(((an?.keyFrames as { key: string }[]) || []).map((k) => k.key))]);
  await deletePrefix(framesPrefix(v)); // key frames, contact sheets, frames taken for the AI
  await purgeProjectFiles({ videoId: v.id, deletedAt: { not: null } });
  await prisma.project.deleteMany({ where: { videoId: v.id, deletedAt: { not: null } } });
  await prisma.video.delete({ where: { id: v.id } });
  // From a Drive folder the Library syncs with: the sync must not link it again (it is still in the Drive folder).
  if (v.source === "drive") await rememberRemoved(v.userId, v.driveFileId);
  return { edits: edits.length };
}

/** One line per item: what happened, or why nothing did. */
export type DeleteResult = { kind: DeleteKind; id: string; name: string | null; done: boolean; text: string };

async function one(userId: string, it: DeleteItem, o: { permanent: boolean; force: boolean }): Promise<DeleteResult> {
  const r = (name: string | null, done: boolean, text: string): DeleteResult => ({ kind: it.kind, id: it.id, name, done, text });
  const gone = r(null, false, `${it.kind} ${it.id}: not found (not this user's, or already gone).`);
  switch (it.kind) {
    case "video": {
      const v = await prisma.video.findUnique({ where: { id: it.id } });
      if (!v || v.userId !== userId || v.kind === "canvas") return gone;
      const what = v.still ? "Picture" : "Video";
      if (!o.permanent) {
        if (v.deletedAt) return r(v.name, false, `${what} "${v.name}" is already in the Trash (${trashDaysLeft(v.deletedAt)} days left).`);
        const used = await editsOfVideo(v);
        await prisma.video.update({ where: { id: v.id }, data: { deletedAt: new Date() } });
        return r(v.name, true, `${what} "${v.name}" moved to the Trash (restorable for ${trashDaysLeft(new Date())} days).${used.length ? ` ${used.length} ${editWord(used.length)} using it keep working: ${names(used)}.` : ""}`);
      }
      try {
        const { edits } = await deleteVideoForGood(v, o.force);
        return r(v.name, true, `${what} "${v.name}" deleted for good${edits ? `, with the ${edits} ${editWord(edits)} made from it` : ""}.`);
      } catch (e) {
        if ((e as AppError).code === "in-use") return r(v.name, false, `${(e as Error).message} Nothing was deleted: send force: true to delete them too, or leave it in the Trash instead (no permanent).`);
        throw e;
      }
    }
    case "edit": {
      const p = await prisma.project.findUnique({ where: { id: it.id } });
      if (!p || p.userId !== userId) return gone;
      if (!o.permanent) {
        if (p.deletedAt) return r(p.name, false, `Edit "${p.name}" is already deleted (restore: true brings it back).`);
        await prisma.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
        return r(p.name, true, `Edit "${p.name}" deleted (restore: true brings it back).`);
      }
      await purgeProjectFiles({ id: p.id });
      await prisma.project.delete({ where: { id: p.id } });
      return r(p.name, true, `Edit "${p.name}" deleted for good, with its renders.`);
    }
    case "folder": {
      const f = await prisma.folder.findUnique({ where: { id: it.id } });
      if (!f || f.userId !== userId) return gone;
      const inside = await prisma.project.findMany({ where: { folderId: f.id, deletedAt: null }, select: { name: true }, orderBy: { updatedAt: "desc" } });
      if (inside.length && !o.force) return r(f.name, false, `Project folder "${f.name}" has ${inside.length} ${editWord(inside.length)} in it: ${names(inside)}. Deleting it deletes them for good. Nothing was deleted: send force: true to go ahead, or move or delete the edits first.`);
      await purgeProjectFiles({ folderId: f.id });
      await prisma.folder.delete({ where: { id: f.id } });
      return r(f.name, true, `Project folder "${f.name}" deleted${inside.length ? `, with its ${inside.length} ${editWord(inside.length)}` : ""}.`);
    }
    case "library_folder": {
      const f = await prisma.libraryFolder.findUnique({ where: { id: it.id } });
      if (!f || f.userId !== userId) return gone;
      const x = await deleteLibraryFolder(userId, f.id);
      return r(f.name, true, `Library folder "${f.name}" deleted; its ${x.moved} ${x.moved === 1 ? "video" : "videos"}${x.folders ? ` and ${x.folders} ${x.folders === 1 ? "folder" : "folders"}` : ""} moved up a level (nothing else deleted).`);
    }
    case "element":
    case "audio": {
      const row = it.kind === "element"
        ? await prisma.graphic.findFirst({ where: { id: it.id, ownerId: userId, kind: "element" } })
        : await prisma.sound.findFirst({ where: { id: it.id, userId } });
      if (!row) return gone;
      const what = it.kind === "element" ? "Element" : "Audio";
      if (!o.permanent) {
        if (row.deletedAt) return r(row.name, false, `${what} "${row.name}" is already in the Trash (${trashDaysLeft(row.deletedAt)} days left).`);
        if (it.kind === "element") await prisma.graphic.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
        else await prisma.sound.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
        return r(row.name, true, `${what} "${row.name}" moved to the Trash (restorable for ${trashDaysLeft(new Date())} days; edits using it keep working).`);
      }
      const used = await editsUsing(userId, row.id);
      if (used.length && !o.force) return r(row.name, false, `${what} "${row.name}" is used by ${used.length} ${editWord(used.length)}: ${names(used)}. Deleting it for good takes it out of their renders. Nothing was deleted: send force: true to go ahead, or leave it in the Trash.`);
      if (it.kind === "element") await purgeElement(row as Parameters<typeof purgeElement>[0]);
      else await purgeSound(row as Parameters<typeof purgeSound>[0]);
      return r(row.name, true, `${what} "${row.name}" deleted for good.`);
    }
    case "font": {
      const f = await prisma.font.findFirst({ where: { id: it.id, userId } });
      if (!f) return gone;
      await deleteFont(userId, f.id);
      return r(f.family, true, `Font "${f.family}" ${f.weight}${f.style === "italic" ? " italic" : ""} deleted (graphics that use it fall back to another font).`);
    }
    case "lut": {
      const l = await prisma.lut.findFirst({ where: { id: it.id, userId } });
      if (!l) return gone;
      await prisma.lut.delete({ where: { id: l.id } });
      await deleteObject(l.key).catch(() => {});
      return r(l.name, true, `LUT "${l.name}" deleted (edits already graded with it keep their look).`);
    }
    case "style": {
      const s = await prisma.style.findFirst({ where: { id: it.id, ownerId: userId } });
      if (!s) return gone;
      await prisma.style.delete({ where: { id: s.id } });
      return r(s.name, true, `Style "${s.name}" deleted (edits made with it keep their timeline).`);
    }
  }
}

/** Deletes each item (one failing does not stop the others). */
export async function deleteItems(userId: string, items: DeleteItem[], o: { permanent?: boolean; force?: boolean } = {}): Promise<DeleteResult[]> {
  const out: DeleteResult[] = [];
  for (const it of items) out.push(await one(userId, it, { permanent: !!o.permanent, force: !!o.force }));
  return out;
}

/** Brings items back from the Trash (footage, elements, audio) or back from deleted (edits). */
export async function restoreItems(userId: string, items: DeleteItem[]): Promise<DeleteResult[]> {
  const out: DeleteResult[] = [];
  for (const it of items) {
    const r = (name: string | null, done: boolean, text: string) => out.push({ kind: it.kind, id: it.id, name, done, text });
    if (it.kind === "video") {
      const v = await prisma.video.findFirst({ where: { id: it.id, userId } });
      if (!v) { r(null, false, `video ${it.id}: not found (deleted for good, or not this user's).`); continue; }
      if (!v.deletedAt) { r(v.name, false, `"${v.name}" is not in the Trash.`); continue; }
      await prisma.video.update({ where: { id: v.id }, data: { deletedAt: null } }); r(v.name, true, `"${v.name}" is back in Assets.`);
    } else if (it.kind === "element" || it.kind === "audio") {
      const row = it.kind === "element" ? await prisma.graphic.findFirst({ where: { id: it.id, ownerId: userId, kind: "element" } }) : await prisma.sound.findFirst({ where: { id: it.id, userId } });
      if (!row) { r(null, false, `${it.kind} ${it.id}: not found (deleted for good, or not this user's).`); continue; }
      if (!row.deletedAt) { r(row.name, false, `"${row.name}" is not in the Trash.`); continue; }
      if (it.kind === "element") await prisma.graphic.update({ where: { id: row.id }, data: { deletedAt: null } });
      else await prisma.sound.update({ where: { id: row.id }, data: { deletedAt: null } });
      r(row.name, true, `"${row.name}" is back in Assets.`);
    } else if (it.kind === "edit") {
      const p = await prisma.project.findFirst({ where: { id: it.id, userId } });
      if (!p) { r(null, false, `edit ${it.id}: not found (deleted for good, or not this user's).`); continue; }
      if (!p.deletedAt) { r(p.name, false, `Edit "${p.name}" is not deleted.`); continue; }
      await prisma.project.update({ where: { id: p.id }, data: { deletedAt: null } }); r(p.name, true, `Edit "${p.name}" is back.`);
    } else r(null, false, `A ${it.kind.replace("_", " ")} cannot be restored: it is deleted for good straight away.`);
  }
  return out;
}

/** What is in the Trash: footage, elements and audio (with days left), and edits deleted in the last TRASH_DAYS days. */
export async function trashList(userId: string) {
  const [vids, els, snds, edits] = await Promise.all([
    prisma.video.findMany({ where: { userId, deletedAt: { not: null }, kind: { not: "canvas" } }, orderBy: { deletedAt: "desc" }, take: 100, select: { id: true, name: true, still: true, deletedAt: true } }),
    prisma.graphic.findMany({ where: { ownerId: userId, kind: "element", deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, take: 100, select: { id: true, name: true, deletedAt: true } }),
    prisma.sound.findMany({ where: { userId, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, take: 100, select: { id: true, name: true, deletedAt: true } }),
    prisma.project.findMany({ where: { userId, deletedAt: { not: null, gt: new Date(Date.now() - 30 * 86400_000) } }, orderBy: { deletedAt: "desc" }, take: 100, select: { id: true, name: true, deletedAt: true } }),
  ]);
  return [
    ...vids.map((v) => ({ kind: "video" as const, id: v.id, name: v.name, what: v.still ? "picture" : "video", daysLeft: trashDaysLeft(v.deletedAt!) })),
    ...els.map((g) => ({ kind: "element" as const, id: g.id, name: g.name, what: "element", daysLeft: trashDaysLeft(g.deletedAt!) })),
    ...snds.map((s) => ({ kind: "audio" as const, id: s.id, name: s.name, what: "audio", daysLeft: trashDaysLeft(s.deletedAt!) })),
    ...edits.map((p) => ({ kind: "edit" as const, id: p.id, name: p.name, what: "edit", daysLeft: null as number | null })),
  ];
}

/** Empties the Trash for good (footage, elements, audio), except what an edit still uses. */
export async function emptyTrash(userId: string) {
  const r = await purgeTrash({ userId, before: new Date(Date.now() + 60_000) });
  return { deleted: r.videos + r.elements + r.sounds, kept: r.kept };
}
