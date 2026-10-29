import { headObject, signGet, uploadFile, type ColorSampleJob, type ColorSamples, type FaceJob, type FaceSamples, type FramesJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { frameAt, JobError, overlayPng, rgbFrames } from "../lib/ffmpeg";
import { detectFaces, faceOf } from "../lib/faces";
import type { Ctx } from "../lib/job";
import { framesPrefix } from "./breakdown";

// Frames for the AI to look at: from a preview render (get_preview_frames, output times) or from footage and
// references (get_frames, original times). Render frames are kept next to the render and expire with it; footage
// frames sit with the video's other frames and go when its preview copy goes.
export async function framesJob(ctx: Ctx): Promise<string[] | ColorSamples | FaceSamples> {
  const { renderId, videoId, times, overlays, colorSamples: cs, faces } = ctx.job.data as FramesJob;
  if (cs) return colorSamples(ctx, cs);
  if (faces) return faceSamples(ctx, faces);
  if (videoId) return videoFrames(ctx, videoId, times);
  const r = renderId ? await prisma.render.findUnique({ where: { id: renderId } }) : null;
  if (!r?.outputKey) return [];
  const url = await signGet(r.outputKey, 600);
  const out: string[] = [];
  for (const [i, t] of times.slice(0, 5).entries()) {
    const over = overlays?.[i];
    // A comment's drawing goes on a bigger frame, so the AI sees what was drawn on what.
    const key = over ? r.outputKey.replace(/\.mp4$/, `-at${Math.round(t * 1000)}ms-${over.slice(over.lastIndexOf("/") + 1).replace(/\.png$/, "")}.jpg`) : r.outputKey.replace(/\.mp4$/, `-at${Math.round(t * 100)}.jpg`);
    if (over && (await headObject(key))) { out.push(key); continue; } // asked before
    const p = join(ctx.dir, `t${i}.jpg`);
    await frameAt(url, t, p, over ? 960 : 540, ctx.signal).catch(() => {});
    if (!(await stat(p).then(() => true).catch(() => false))) continue;
    let file = p;
    if (over) {
      const png = join(ctx.dir, `o${i}.png`), q = join(ctx.dir, `t${i}-drawn.jpg`);
      const res = await fetch(await signGet(over, 600)).catch(() => null);
      if (res?.ok) {
        await writeFile(png, Buffer.from(await res.arrayBuffer()));
        await overlayPng(p, png, q, ctx.signal).then(() => { file = q; }).catch((e) => console.warn(`[frames] the drawing ${over} could not go on the frame: ${(e as Error).message}`));
      } else console.warn(`[frames] the drawing ${over} could not be read (${res?.status ?? "no answer"})`);
    }
    await uploadFile(key, file, "image/jpeg");
    out.push(key);
  }
  // Recorded with the render's other frames (after the first five check frames), so cleanup and deletes remove them.
  if (out.length) {
    const fresh = await prisma.render.findUnique({ where: { id: r.id }, select: { framesKeys: true } });
    const have = (fresh?.framesKeys as string[]) || [];
    await prisma.render.update({ where: { id: r.id }, data: { framesKeys: Array.from(new Set([...have, ...out])) } });
  }
  return out;
}

/** The time and frame number burned into a footage frame: "754.567s (12m 34.567s) · frame 22637 at 30 fps" (no
 *  colons or quotes, which FFmpeg's text filter would read as its own syntax). */
export function stampOf(t: number, fps: number | null): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${t.toFixed(3)}s${m ? ` (${m}m ${s.toFixed(3)}s)` : ""}${fps ? ` · frame ${Math.round(t * fps)} at ${+fps.toFixed(3)} fps` : ""}`;
}

async function videoFrames(ctx: Ctx, videoId: string, times: number[]): Promise<string[]> {
  const v = await prisma.video.findUnique({ where: { id: videoId } });
  if (!v?.proxyKey) return [];
  const url = await signGet(v.proxyKey, 600);
  const out: string[] = [];
  for (const [i, t0] of times.slice(0, 8).entries()) {
    const t = Math.min(Math.max(0, t0), Math.max(0, v.seconds - 0.05));
    // To the millisecond, with the time and frame number on the picture.
    const key = `${framesPrefix(v)}at-${Math.round(t * 1000)}ms-tc.jpg`;
    if (await headObject(key)) { out.push(key); continue; } // asked before
    const p = join(ctx.dir, `v${i}.jpg`);
    await frameAt(url, t, p, 960, ctx.signal, false, stampOf(t, v.fps)).catch(() => {});
    if (!(await stat(p).then((s) => s.size > 0).catch(() => false))) continue;
    await uploadFile(key, p, "image/jpeg");
    out.push(key);
  }
  return out;
}

/** Phase 6: frames of clips for shot matching (4 per clip, small), from each video's preview copy: what the editor shows. */
async function colorSamples(ctx: Ctx, cs: ColorSampleJob): Promise<ColorSamples> {
  const ids = Array.from(new Set(cs.clips.map((c) => c.videoId)));
  const videos = await prisma.video.findMany({ where: { id: { in: ids } }, select: { id: true, proxyKey: true, name: true } });
  const out: ColorSamples = {};
  const w = Math.min(96, cs.w), h = Math.min(96, cs.h);
  for (const c of cs.clips.slice(0, 40)) {
    const v = videos.find((x) => x.id === c.videoId);
    if (!v?.proxyKey) throw new JobError(`The preview copy of a video in this edit is gone${v ? ` ("${v.name}")` : ""}. Rebuild it from your Library, then match again.`, "expired", false);
    const url = await signGet(v.proxyKey, 600);
    const rgb = await rgbFrames(url, c.srcIn, c.srcOut, { w, h, rotate: c.rotate, fitY: c.fitY, focus: c.focus, n: 4, dir: ctx.dir, signal: ctx.signal });
    if (!rgb.length) throw new JobError(`Could not read frames of clip ${c.id}.`, "frames", false);
    out[c.id] = { w, h, rgb: rgb.toString("base64") };
  }
  return out;
}

/** Item 6: where the face is in each clip (set_framing fitFaceTo): 3 frames per clip, turned and fitted as the render
 *  draws them, all read by one YuNet run. A clip with no face on any frame is null. */
async function faceSamples(ctx: Ctx, fj: FaceJob): Promise<FaceSamples> {
  const clips = fj.clips.slice(0, 40);
  const videos = await prisma.video.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.videoId))) } }, select: { id: true, proxyKey: true, name: true } });
  const frames: Buffer[] = [], counts: number[] = [];
  const size = fj.w * fj.h * 3;
  for (const c of clips) {
    const v = videos.find((x) => x.id === c.videoId);
    if (!v?.proxyKey) throw new JobError(`The preview copy of a video in this edit is gone${v ? ` ("${v.name}")` : ""}. Rebuild it from your Library, then try again.`, "expired", false);
    const rgb = await rgbFrames(await signGet(v.proxyKey, 600), c.srcIn, c.srcOut, { w: fj.w, h: fj.h, rotate: c.rotate, fitY: c.fitY, focus: c.focus, n: 3, dir: ctx.dir, signal: ctx.signal });
    frames.push(rgb); counts.push(rgb.length / size);
  }
  const boxes = await detectFaces(Buffer.concat(frames), fj.w, fj.h, ctx.dir, ctx.signal);
  const out: FaceSamples = {};
  let at = 0;
  clips.forEach((c, i) => { out[c.id] = faceOf(boxes.slice(at, at + counts[i]), fj.w, fj.h); at += counts[i]; });
  return out;
}
