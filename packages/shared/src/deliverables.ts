// Phase 12: the files an edit can be delivered as besides its video. Captions as SRT and WebVTT (the render's own
// word-timed events, in edit time), YouTube chapters from chapter marks, and what each export format is.
import type { ExportFormat, Snapshot } from "./timeline";

export type CaptionCue = { start: number; end: number; text: string };
export type Chapter = { at: number; title: string };

const clock = (t: number, sep: string) => {
  const ms = Math.max(0, Math.round(t * 1000)), h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};
/** Cues in order, joined where one runs into the next with the same text (word-timed events come one per word). */
function cues(events: CaptionCue[]): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    const text = e.text.replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").trim();
    if (!text || e.end - e.start <= 0.001) continue;
    const last = out[out.length - 1];
    if (last && last.text === text && e.start - last.end < 0.05) last.end = Math.max(last.end, e.end);
    else out.push({ start: e.start, end: e.end, text });
  }
  return out;
}
/** SubRip: numbered cues, hh:mm:ss,mmm. */
export function srtText(events: CaptionCue[]): string {
  return cues(events).map((c, i) => `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${c.text}\n`).join("\n");
}
/** WebVTT: hh:mm:ss.mmm. */
export function vttText(events: CaptionCue[]): string {
  return `WEBVTT\n\n${cues(events).map((c) => `${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${c.text}\n`).join("\n")}`;
}
/** YouTube chapters: "0:00 Title" lines; the first at 0:00. */
export function chaptersText(chapters: Chapter[]): string {
  const ts = (t: number) => { const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const list = [...chapters].sort((a, b) => a.at - b.at);
  if (list.length && list[0].at > 0.5) list.unshift({ at: 0, title: "Intro" });
  return list.map((c, i) => `${ts(i === 0 ? 0 : c.at)} ${c.title}`).join("\n");
}
/** What YouTube needs of chapters that these do not have (it shows none otherwise): empty when they are fine. */
export function chapterProblems(chapters: Chapter[], total: number): string[] {
  const list = [...chapters].sort((a, b) => a.at - b.at);
  if (list.length && list[0].at > 0.5) list.unshift({ at: 0, title: "Intro" });
  const out: string[] = [];
  if (list.length < 3) out.push(`YouTube needs at least 3 chapters (${list.length} here)`);
  const short = list.filter((c, i) => (list[i + 1]?.at ?? total) - c.at < 10);
  if (short.length) out.push(`each chapter at least 10 s long (${short.map((c) => c.title).slice(0, 3).join(", ")} ${short.length === 1 ? "is" : "are"} shorter)`);
  return out;
}
/** Sound only: a final with no picture (AAC .m4a or WAV). */
export const isSoundFormat = (f: string | null | undefined): f is "audio" | "wav" => f === "audio" || f === "wav";
/** What a sound-only final is called where a video's size would be (its quality label). */
export const SOUND_QUALITY = { audio: "Sound only (.m4a)", wav: "Sound only (WAV)" } as const;
/** The edit as a final of another file type, for one export (render_final format: sound only without changing the
 *  edit's own export settings). The snapshot is not changed; null or undefined keeps its own format. */
export function withExportFormat(s: Snapshot, format: ExportFormat | null | undefined): Snapshot {
  if (!format || s.timeline.export?.format === format) return s;
  return { ...s, timeline: { ...s.timeline, export: { ...(s.timeline.export ?? {}), format } } };
}
/** A format's file extension and media type. */
export const formatFile = (f: ExportFormat | undefined): { ext: string; type: string } =>
  f === "gif" ? { ext: "gif", type: "image/gif" } : f === "audio" ? { ext: "m4a", type: "audio/mp4" } : f === "wav" ? { ext: "wav", type: "audio/wav" } : f === "overlay" ? { ext: "mov", type: "video/quicktime" } : { ext: "mp4", type: "video/mp4" };
/** The longest GIF Rendrr makes, in seconds (a GIF is a stack of pictures: longer ones get huge). Phase 20: up to ten
 *  minutes, at fewer frames and a smaller size as it gets longer (gifSpec). */
export const GIF_MAX_SECONDS = 600;
/** A GIF's frame rate and width for its length: 15 fps and 640 across (480 portrait) up to a minute, 10 fps and 480
 *  (360) up to three, 6 fps and 360 (270) beyond: about 900 to 3600 frames, each smaller as there are more. */
export function gifSpec(seconds: number, w: number, h: number): { fps: number; width: number } {
  const tall = h > w;
  if (seconds <= 60.5) return { fps: 15, width: tall ? 480 : 640 };
  if (seconds <= 180.5) return { fps: 10, width: tall ? 360 : 480 };
  return { fps: 6, width: tall ? 270 : 360 };
}
/** A GIF's width at a minute or less (gifSpec has it for any length). */
export const gifWidth = (w: number, h: number) => gifSpec(0, w, h).width;
