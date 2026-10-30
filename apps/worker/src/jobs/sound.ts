import { deleteObject, downloadFile, uploadFile, type SoundJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { PREFIX, SOUND_MAX_SECONDS } from "@rendrr/shared";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { JobError, probe, run } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

/**
 * The user's own audio file (add_audio: a voice made better outside Rendrr, their music) made into AAC 48 kHz stereo,
 * as the library's music is, so the render and the editor's player read it the same way. The file as sent is deleted.
 */
export async function soundJob(ctx: Ctx): Promise<{ key: string; seconds: number }> {
  const d = ctx.job.data as SoundJob;
  const s = await prisma.sound.findUnique({ where: { id: d.soundId } });
  if (!s) throw new JobError("That audio file is gone.", "gone", false);
  const src = join(ctx.dir, "src"), out = join(ctx.dir, "sound.m4a");
  try {
    await downloadFile(d.srcKey, src);
    const info = await probe(src, { signal: ctx.signal }).catch(() => null);
    if (!info?.hasAudio) throw new JobError("That file has no sound Rendrr can read. Send an mp3, wav, m4a, aac, flac or ogg file.", "bad-audio", false);
    if (info.seconds > SOUND_MAX_SECONDS) throw new JobError(`Audio files are ${SOUND_MAX_SECONDS / 3600} hours at most.`, "too-long", false);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", out], { signal: ctx.signal });
    const made = await probe(out, { signal: ctx.signal });
    const key = `${PREFIX.sounds}${s.userId}/${s.id}.m4a`;
    await uploadFile(key, out, "audio/mp4");
    await prisma.sound.update({ where: { id: s.id }, data: { status: "ready", key, seconds: Math.round(made.seconds * 1000) / 1000, sizeBytes: BigInt((await stat(out)).size), error: null } });
    return { key, seconds: made.seconds };
  } catch (e) {
    await prisma.sound.update({ where: { id: s.id }, data: { status: "failed", error: (e as JobError).friendly ? (e as Error).message : "Rendrr could not read that audio file." } }).catch(() => {});
    throw e;
  } finally {
    await deleteObject(d.srcKey).catch(() => {});
  }
}
