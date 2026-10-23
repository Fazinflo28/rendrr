// The check an AI reads after a render instead of looking at frames: what the edit now does, measured from the
// timeline and the transcript (and the rendered file's loudness). Facts and fixed thresholds only, no judgement.
import { fmtT } from "./breakdown";
import { keptRanges, makeTimeMap, type Range } from "./ops";
import type { Clip, Snapshot } from "./timeline";
import { allWords, type Transcript } from "./transcript";

export type FileLoudness = { lufs: number | null; peakDb: number | null };

const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const list = (xs: string[], max = 8) => xs.slice(0, max).join(", ") + (xs.length > max ? `, +${xs.length - max} more` : "");

/** pauseOver: pauses longer than this are listed (default 0.4 s). */
export function editCheck(snap: Snapshot, tr: Transcript, opts: { pauseOver?: number | null; loudness?: FileLoudness | null } = {}): string {
  const tl = snap.timeline;
  const words = allWords(tr);
  const kept = keptRanges(tl, words);
  const map = makeTimeMap(kept);
  const total = map.total;
  const cut = new Set(tl.cut);
  const inKept = (time: number) => kept.some((k) => time >= k.start && time < k.end);
  const spoken = words.filter((w) => !cut.has(w.id) && inKept(w.t));
  const at = (src: number) => fmtT(map.toOutput(src));
  const flags: string[] = [];

  // Pauses people will hear: between spoken words, and before the first and after the last word.
  const over = opts.pauseOver ?? 0.4;
  const pauses: { at: number; len: number }[] = [];
  if (spoken.length) {
    const lead = map.toOutput(spoken[0].t);
    if (lead > over) pauses.push({ at: 0, len: lead });
    for (let i = 0; i + 1 < spoken.length; i++) {
      const a = map.toOutput(spoken[i].end), b = map.toOutput(spoken[i + 1].t);
      if (b - a > over) pauses.push({ at: a, len: b - a });
    }
    const tail = total - map.toOutput(spoken[spoken.length - 1].end);
    if (tail > over) pauses.push({ at: total - tail, len: tail });
  }
  if (pauses.length) flags.push(`${pauses.length} pause${pauses.length === 1 ? "" : "s"} over ${over}s`);

  const fillers = spoken.filter((w) => w.filler);
  if (fillers.length) flags.push(`${fillers.length} filler word${fillers.length === 1 ? "" : "s"}`);

  // Captions follow transcript lines; a deleted caption clip leaves its words without captions.
  const lineOf = new Map(tr.flatMap((l) => l.words.map((w) => [w.id, l.id] as const)));
  const captioned = new Set((tl.tracks.v3 as Clip[]).filter((c) => (c as Record<string, unknown>).kind === "caption").map((c) => String((c as Record<string, unknown>).lineId)));
  const covered = spoken.filter((w) => captioned.has(lineOf.get(w.id) || "")).length;
  const coverPct = spoken.length ? Math.round((covered / spoken.length) * 100) : 100;
  if (tl.captionsOn && coverPct < 100) flags.push(`${spoken.length - covered} spoken words without captions`);

  const v2 = tl.tracks.v2 as (Clip & Record<string, unknown>)[];
  const shown = (c: Clip) => kept.some((k) => overlap(k, c) > 0.05);
  const zooms = v2.filter((c) => c.kind === "zoom" && shown(c));
  const broll = v2.filter((c) => c.kind === "broll" && shown(c));
  const graphics = (tl.tracks.v3 as (Clip & Record<string, unknown>)[]).filter((c) => c.kind === "graphic" && shown(c));
  const music = (tl.tracks.a2 as (Clip & Record<string, unknown>)[]).filter(shown);
  const musicCover = total ? kept.reduce((a, k) => a + Math.min(k.end - k.start, music.reduce((m, c) => m + overlap(k, c), 0)), 0) / total : 0;

  const segs = kept.map((k) => ({ at: map.toOutput(k.start), len: k.end - k.start }));
  const short = segs.filter((s) => s.len < 0.5);
  if (short.length) flags.push(`${short.length} clip${short.length === 1 ? "" : "s"} under 0.5s`);
  const ld = opts.loudness;
  if (ld?.peakDb != null && ld.peakDb > -1) flags.push(`peak ${ld.peakDb}dB (may clip)`);
  if (ld?.lufs != null && ld.lufs < -40) flags.push("sound is almost silent");

  const lines = [
    `CHECK ${total.toFixed(1)}s of ${tl.duration.toFixed(1)}s footage | ${snap.aspect} | ${spoken.length} words spoken${total ? `, ${Math.round((spoken.length / total) * 60)}/min` : ""}`,
    `Pauses over ${over}s: ${pauses.length ? list(pauses.map((p) => `${fmtT(p.at)} (${p.len.toFixed(1)}s)`)) : "none"}`,
    `Fillers left: ${fillers.length ? list(fillers.map((w) => `"${w.text.replace(/[^\w'-]/g, "")}" ${at(w.t)}`)) : "none"}`,
    `Captions: ${tl.captionsOn ? `on (${tl.captionLook}), ${coverPct}% of spoken words` : "off"}`,
    `Zooms ${zooms.length}${zooms.length ? ": " + list(zooms.map((z) => `${at(z.start)} ${Math.round(Number(z.zoom || 1) * 100)}%`)) : ""} | B-roll ${broll.length}${broll.length ? ": " + list(broll.map((b) => at(b.start))) : ""} | Graphics ${graphics.length}${graphics.length ? ": " + list(graphics.map((g) => `${at(g.start)} ${g.label}`)) : ""}`,
    `Music: ${music.length ? `${list(music.map((m) => `${m.label} ${m.gainDb ?? -18}dB`), 3)}, under ${Math.round(musicCover * 100)}% of the edit` : "none"}`,
    `Cuts ${Math.max(0, kept.length - 1)}${total ? ` (${(((kept.length - 1) / total) * 60).toFixed(1)}/min)` : ""}, shortest clip ${segs.length ? Math.min(...segs.map((s) => s.len)).toFixed(1) + "s" : "-"}${short.length ? ` at ${list(short.map((s) => fmtT(s.at)), 4)}` : ""}`,
    ...(ld ? [`Loudness of the file: ${ld.lufs != null ? ld.lufs + " LUFS" : "unknown"}, peak ${ld.peakDb != null ? ld.peakDb + "dB" : "unknown"}`] : []),
    `Flags: ${flags.length ? flags.join("; ") : "none"}`,
  ];
  return lines.join("\n");
}
