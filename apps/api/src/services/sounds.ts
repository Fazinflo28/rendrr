import { AppError, drive, enqueue, env, features, newRedis, redis, uploadFile, type SoundJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { PREFIX, QUEUES, SOUND_MAX_BYTES } from "@rendrr/shared";
import { QueueEvents } from "bullmq";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveIdOf } from "./luts";
import { fetchPublicTo } from "./fetchPublic";

// The user's own audio files (add_audio): a voice they made better outside Rendrr (Adobe Podcast Enhance, a mix), a
// voice-over, their own music. The file comes from the AI's code workspace (a one-time upload link), a share link or
// the user's Google Drive; the worker makes it AAC 48 kHz stereo and measures it. Then set_voice or add_music soundId.

const err = (m: string) => new AppError(m, 400, "bad-audio");
const UPLOAD_SECONDS = 30 * 60;
const uploadKey = (t: string) => `sound-upload:${t}`;
const WAIT_MS = 60_000;
let events: QueueEvents | null = null;

const fmtLen = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`);
export const soundLine = (s: { id: string; name: string; seconds: number; status: string; error?: string | null }) =>
  `${s.id} "${s.name}" ${s.status === "ready" ? `${fmtLen(s.seconds)} (${s.seconds.toFixed(3)}s)` : s.status === "failed" ? `failed: ${s.error || "unreadable"}` : "being prepared"}`;

export async function soundsText(userId: string) {
  const ss = await prisma.sound.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 });
  return ss.length ? ss.map(soundLine).join("; ") : "none yet";
}

const nameOf = (raw: string | null | undefined, fallback = "Audio") => (raw || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || fallback;

/** A file on disk kept as the user's audio: stored as sent, made into AAC by the worker; waits for it (a minute). */
export async function keepSound(userId: string, path: string, name: string) {
  const size = (await stat(path)).size;
  if (!size) throw err("The file is empty.");
  if (size > SOUND_MAX_BYTES) throw err(`Audio files are ${SOUND_MAX_BYTES / 1024 / 1024} MB at most.`);
  if ((await prisma.sound.count({ where: { userId } })) >= 500) throw new AppError("You have 500 audio files. Delete some first.", 409);
  const s = await prisma.sound.create({ data: { userId, name: nameOf(name) } });
  const srcKey = `${PREFIX.sounds}${userId}/${s.id}.src`;
  await uploadFile(srcKey, path, "application/octet-stream");
  events ||= new QueueEvents(QUEUES.test.name, { connection: newRedis() });
  const job = await enqueue<SoundJob>("test", { kind: "sound", soundId: s.id, srcKey }, { attempts: 1 });
  await job.waitUntilFinished(events, WAIT_MS).catch(() => {});
  return prisma.sound.findUniqueOrThrow({ where: { id: s.id } });
}

/** From a share link (Google Drive, Dropbox, a direct link) or a file in the user's connected Google Drive. */
export async function soundFromSource(userId: string, i: { url?: string; driveFileId?: string; name?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "sound-"));
  const path = join(dir, "src");
  try {
    const fileId = i.driveFileId ?? (i.url ? driveIdOf(i.url) : null);
    let name = i.name || null;
    const conn = fileId && features().drive ? await prisma.driveConnection.findUnique({ where: { userId } }) : null;
    if (fileId && conn && !conn.stub) {
      // The user's own Drive connection reads any file they can open.
      const f = await drive.getFile(userId, fileId, false).catch(() => null);
      if (!f) throw err("Rendrr cannot find that file in your Google Drive (it may be in another account's Drive, or trashed).");
      if (f.sizeBytes > SOUND_MAX_BYTES) throw err(`Audio files are ${SOUND_MAX_BYTES / 1024 / 1024} MB at most.`);
      const m = await drive.mediaRequest(userId, fileId);
      const r = await fetch(m.url, { headers: m.headers, signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
      if (!r?.ok || !r.body) throw err(`Google Drive did not give the file${r ? ` (${r.status})` : ""}. Try again in a moment.`);
      const out = createWriteStream(path);
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(c)) await new Promise<void>((ok) => out.once("drain", () => ok()));
      await new Promise<void>((ok) => out.end(() => ok()));
      name ||= f.name;
    } else {
      if (i.driveFileId) throw err("Connect Google Drive in Rendrr first (Settings › Google Drive), or send a share link of the file (Anyone with the link) as url.");
      let url = fileId ? `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t` : i.url!;
      // Dropbox share links show a page; dl=1 gives the file.
      try { const u = new URL(url); if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.set("dl", "1"); url = u.href; } } catch { /* fetchPublicTo says why */ }
      const got = await fetchPublicTo(url, path, { max: SOUND_MAX_BYTES, what: "audio", code: "bad-audio", timeoutMs: 10 * 60_000 });
      if (/^text\/html/i.test(got.type)) throw err(fileId ? "Google Drive did not give the file: it is not shared as Anyone with the link. Share it that way, or connect Google Drive in Rendrr and send its driveFileId." : "That link gives a web page, not an audio file. Send a direct link to the file.");
      name ||= got.name || decodeURIComponent(got.url.pathname.split("/").pop() || "");
    }
    return await keepSound(userId, path, name || "Audio");
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** A one-time link the AI's code workspace sends a file to (curl -T), for 30 minutes. */
export async function soundUploadLink(userId: string, name?: string) {
  const token = randomBytes(24).toString("base64url");
  await redis().set(uploadKey(token), JSON.stringify({ userId, name: name || null }), "EX", UPLOAD_SECONDS);
  const url = `${env().PUBLIC_API_URL.replace(/\/$/, "")}/audio/upload/${token}`;
  return { url, host: new URL(url).host };
}

/** Who a link is for (and the name asked), or why it does not work; used once a file came through it. */
export async function uploadFor(token: string) {
  const raw = await redis().get(uploadKey(token));
  if (!raw) throw new AppError("This upload link has expired or was used already. Call add_audio with upload: true for a new one.", 404, "sound-upload");
  return JSON.parse(raw) as { userId: string; name: string | null };
}
export const usedUpload = (token: string) => redis().del(uploadKey(token));

/** What the AI is told about a file it brought in: ready (with how to use it), still being prepared, or why not. */
export function soundOut(s: { id: string; name: string; seconds: number; status: string; error: string | null }) {
  if (s.status === "failed") return `Rendrr could not use "${s.name}": ${s.error || "the file could not be read"}.`;
  if (s.status !== "ready") return `"${s.name}" (${s.id}) is being prepared (a long file takes a minute). Call add_audio with no source to see when it is ready.`;
  return `Added audio "${s.name}" ${s.id}: ${fmtLen(s.seconds)} (${s.seconds.toFixed(3)}s). Use it with apply_edits: set_voice{soundId: "${s.id}"} plays it in place of the edit's own sound (a voice made from this edit's exported sound lines up from 0); add_music{soundId: "${s.id}"} puts it under the edit as music.`;
}

export async function closeSoundEvents() { await events?.close(); events = null; }

/**
 * set_voice and add_music with the file itself (url, driveFileId) are brought in first, as add_audio does, and get its
 * soundId; upload: true answers with a one-time link instead (nothing is changed). So a chat whose tool list is older
 * than add_audio still uses the user's own audio through apply_edits.
 */
export async function resolveSoundRefs<T extends { op: string }>(userId: string, edits: T[], ai?: string): Promise<T[]> {
  const out: T[] = [];
  for (const e of edits) {
    const x = e as T & { url?: string; driveFileId?: string; upload?: boolean; name?: string; soundId?: string | null };
    if ((e.op !== "set_voice" && e.op !== "add_music") || !(x.url || x.driveFileId || x.upload)) { out.push(e); continue; }
    if ([x.url, x.driveFileId, x.upload].filter(Boolean).length > 1 || x.soundId) throw err(`${e.op} takes one of soundId, url, driveFileId or upload.`);
    const { url, driveFileId, upload, name, ...rest } = x;
    if (upload) {
      const u = await soundUploadLink(userId, name);
      throw new AppError(`Nothing changed yet. Upload link for the audio file, for 30 minutes: ${u.url}\nSend the file from your code workspace (up to 500 MB):\n  curl -sS -T "<file>" "${u.url}"\nThe reply is JSON with its soundId once it is ready (a few seconds; a long file up to a minute). Then apply_edits ${e.op}{soundId: "<that id>"}. ${ai === "chatgpt" ? "ChatGPT's code sandbox has no internet, so it cannot send the file: send url (a share link) or driveFileId instead." : `If the workspace cannot reach ${u.host}, the user allows that host in their AI's settings (Claude: Settings > Capabilities, code execution, allowed domains), or send url (a share link) or driveFileId instead.`}`, 400, "sound-upload-link");
    }
    const s = await soundFromSource(userId, { url, driveFileId, name });
    if (s.status !== "ready") throw err(soundOut(s));
    out.push({ ...rest, soundId: s.id } as unknown as T);
  }
  return out;
}
