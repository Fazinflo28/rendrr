// Elements (Assets page): logos and overlay pictures the user keeps (PNG keeps its transparency). Each is a graphic of
// kind "element": the worker makes it a 1 s transparent clip that the graphics layer holds for as long as it is placed,
// so it moves, scales, fades and blends like any graphic (add_graphic, then set_keyframes to size and place it).
import { AppError, drive, enqueue, features, newRedis, signGet, uploadFile, type ElementJob } from "@rendrr/core";
import { prisma, type Graphic } from "@rendrr/db";
import { ELEMENT_MAX_BYTES, PREFIX, QUEUES, trashDaysLeft } from "@rendrr/shared";
import { QueueEvents } from "bullmq";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPublicTo } from "./fetchPublic";
import { sniff } from "./footage";
import { driveIdOf } from "./luts";

const err = (m: string) => new AppError(m, 400, "bad-element");
const MAX_ELEMENTS = 1000;
let events: QueueEvents | null = null;
const nameOf = (raw: string | null | undefined) => (raw || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Element";

/** A picture on disk kept as an element; waits (up to waitMs) for its transparent clip to be made. */
export async function keepElement(userId: string, path: string, name: string, waitMs = Number(process.env.ELEMENT_WAIT_MS ?? 30_000)): Promise<Graphic> {
  const size = (await stat(path)).size;
  if (!size) throw err("The file is empty.");
  if (size > ELEMENT_MAX_BYTES) throw err(`Elements are ${ELEMENT_MAX_BYTES / 1024 / 1024} MB at most.`);
  const fh = await open(path, "r"); const head = Buffer.alloc(16);
  try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
  const kind = sniff(head);
  if (!kind.image || kind.ext === "gif") throw err("An element is a picture: send a PNG (keeps its transparency), WebP or JPEG. An SVG is drawn to a PNG first.");
  if ((await prisma.graphic.count({ where: { ownerId: userId, kind: "element", deletedAt: null } })) >= MAX_ELEMENTS) throw new AppError(`You have ${MAX_ELEMENTS} elements. Delete some first.`, 409);
  const g = await prisma.graphic.create({ data: { ownerId: userId, kind: "element", name: nameOf(name), status: "rendering", durationSec: 1, width: 2, height: 2, transparent: true, sizeBytes: BigInt(size) } });
  const srcKey = `${PREFIX.graphics}${userId}/${g.id}-src.${kind.ext}`;
  try { await uploadFile(srcKey, path, kind.type); } catch (e) { await prisma.graphic.delete({ where: { id: g.id } }).catch(() => {}); throw e; }
  await prisma.graphic.update({ where: { id: g.id }, data: { sourceKey: srcKey } });
  const job = await enqueue<ElementJob>("test", { kind: "element", graphicId: g.id, srcKey }, { attempts: 2 });
  if (waitMs > 0) {
    events ||= new QueueEvents(QUEUES.test.name, { connection: newRedis() });
    await job.waitUntilFinished(events, waitMs).catch(() => {});
  }
  return prisma.graphic.findUniqueOrThrow({ where: { id: g.id } });
}

/** From a share link (Google Drive, Dropbox, a direct link) or a file in the user's connected Google Drive. */
export async function elementFromSource(userId: string, i: { url?: string; driveFileId?: string; name?: string | null }): Promise<Graphic> {
  const fileId = i.driveFileId ?? (i.url ? driveIdOf(i.url) : null);
  const conn = fileId && features().drive ? await prisma.driveConnection.findUnique({ where: { userId } }) : null;
  const dir = await mkdtemp(join(tmpdir(), "element-"));
  const path = join(dir, "src");
  try {
    if (fileId && conn && !conn.stub) {
      const f = await drive.getFile(userId, fileId, false).catch(() => null);
      if (!f) throw err("Rendrr cannot find that file in your Google Drive (it may be in another account's Drive, or trashed).");
      if (f.sizeBytes > ELEMENT_MAX_BYTES) throw err(`Elements are ${ELEMENT_MAX_BYTES / 1024 / 1024} MB at most.`);
      const m = await drive.mediaRequest(userId, fileId);
      const r = await fetch(m.url, { headers: m.headers, signal: AbortSignal.timeout(2 * 60_000) }).catch(() => null);
      if (!r?.ok || !r.body) throw err(`Google Drive did not give the file${r ? ` (${r.status})` : ""}. Try again in a moment.`);
      const out = createWriteStream(path);
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(c)) await new Promise<void>((ok) => out.once("drain", () => ok()));
      await new Promise<void>((ok) => out.end(() => ok()));
      return await keepElement(userId, path, i.name || f.name);
    }
    if (i.driveFileId) throw err("Connect Google Drive in Rendrr first (Settings › Google Drive), or send a share link of the file (Anyone with the link) as url, or upload: true.");
    const url = fileId ? `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t` : i.url!;
    const got = await fetchPublicTo(url, path, { max: ELEMENT_MAX_BYTES, what: "element", code: "bad-element", timeoutMs: 2 * 60_000 });
    if (/^text\/html/i.test(got.type)) throw err("That link gives a web page, not a picture. Send a direct link to the file.");
    return await keepElement(userId, path, i.name || got.name || decodeURIComponent(got.url.pathname.split("/").pop() || "") || "Element");
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** An element for the web (Assets page, the editor's bin). */
export async function elementOut(g: Graphic) {
  return {
    id: g.id, type: "element" as const, name: g.name, status: g.status, error: g.error ?? undefined, width: g.width, height: g.height,
    thumb: g.thumbKey ? await signGet(g.thumbKey, 3600) : null, url: g.renderedKey && g.status === "ready" ? await signGet(g.renderedKey, 3600) : null,
    favorite: g.favorite, at: g.createdAt.getTime(), sizeBytes: Number(g.sizeBytes), deletedAt: g.deletedAt ? g.deletedAt.getTime() : null,
    ...(g.deletedAt ? { daysLeft: trashDaysLeft(g.deletedAt) } : {}),
  };
}

/** What the AI is told about an element it brought in, or one of the user's. */
export function elementText(g: Pick<Graphic, "id" | "name" | "status" | "error" | "width" | "height">) {
  if (g.status === "failed") return `Rendrr could not use "${g.name}" as an element: ${g.error || "the picture could not be read"}.`;
  const how = `Place it with apply_edits add_graphic {graphicId: "${g.id}", start, end}; a graphic fills the frame as large as it fits, so size and place it with set_keyframes (track v3, keys [{t:0, scale, x, y}], x/y the centre's offset as a share of the frame): a corner logo is about scale 0.15-0.3 with x/y about ±0.38.`;
  return g.status === "ready" ? `Element ready: ${g.id} "${g.name}" (${g.width}x${g.height}, transparent). ${how}` : `Element ${g.id} "${g.name}" is being prepared (a few seconds). ${how}`;
}

/** The user's elements for the AI (list_graphics). */
export async function elementsText(userId: string) {
  const es = await prisma.graphic.findMany({ where: { ownerId: userId, kind: "element", deletedAt: null }, orderBy: { createdAt: "desc" }, take: 50 });
  return es.length ? es.map((g) => `${g.id} | ${g.name} | ${g.status === "ready" ? `${g.width}x${g.height}` : g.status}${g.favorite ? " | favourite" : ""}`).join("\n") : "";
}
