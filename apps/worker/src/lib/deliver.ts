// Phase 12: the final made into what the export asks for, after the one render pass: a GIF (palette made from the
// file itself), or the overlay export's two passes (over black and over white) merged into ProRes 4444 with alpha
// (alpha from their difference, colour un-premultiplied from the black one). Captions and chapters as text files.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chaptersText, gifSpec, srtText, vttText, type Chapter } from "@rendrr/shared";
import { run } from "./ffmpeg";

/** A GIF of the rendered file: its frame rate and width for its length (gifSpec: 15 fps and 640 px wide up to a minute,
 *  fewer and smaller beyond), its own 256-colour palette, looping. */
export async function makeGif(src: string, out: string, w: number, h: number, signal?: AbortSignal, seconds = 0): Promise<void> {
  const g = gifSpec(seconds, w, h);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-filter_complex", `[0:v]fps=${g.fps},scale=${g.width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", out], { signal });
}

/**
 * The overlay export: the same edit over black and over white. Where a layer covers the picture fully both passes
 * agree; where it is see-through they differ by how much: alpha = 1 - (white - black). The colour is the black pass
 * divided by alpha (it was laid over black: colour x alpha). The sound comes from the black pass.
 */
export async function mergeOverlay(black: string, white: string, out: string, signal?: AbortSignal): Promise<void> {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", black, "-i", white, "-filter_complex",
    "[0:v]format=gbrp,split[bk][bc];[1:v]format=gbrp[wh];[wh][bk]blend=all_expr='255-(A-B)',extractplanes=g,split[a1][a2];[bc][a1]unpremultiply=inplace=0[col];[col][a2]alphamerge,format=yuva444p10le[v]",
    "-map", "[v]", "-map", "0:a?", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", "-c:a", "pcm_s16le", out], { signal });
}

/** SRT, WebVTT and YouTube chapters of a plan, written next to the render (only those it has). */
export async function writeSideFiles(dir: string, plan: { subtitles?: { start: number; end: number; text: string }[]; chapters?: Chapter[] }): Promise<{ srt?: string; vtt?: string; chapters?: string }> {
  const out: { srt?: string; vtt?: string; chapters?: string } = {};
  if (plan.subtitles?.length) {
    out.srt = `${dir}/captions.srt`; await writeFile(out.srt, srtText(plan.subtitles));
    out.vtt = `${dir}/captions.vtt`; await writeFile(out.vtt, vttText(plan.subtitles));
  }
  if (plan.chapters?.length) { out.chapters = `${dir}/chapters.txt`; await writeFile(out.chapters, chaptersText(plan.chapters) + "\n"); }
  return out;
}

/**
 * Joins the pieces of a final rendered in pieces (each a MOV of the same encode with its sound as PCM) into one MP4:
 * the picture copied as it is, the sound encoded once (no gap or click where pieces meet), ready to play from the start.
 */
export async function joinPieces(dir: string, pieces: string[], output: string, audioBitrate: string, signal?: AbortSignal) {
  const list = join(dir, "pieces.txt");
  await writeFile(list, pieces.map((m) => `file '${m.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v", "-map", "0:a?", "-c:v", "copy", "-c:a", "aac", "-b:a", audioBitrate, "-ar", "48000", "-movflags", "+faststart", output], { signal });
}

