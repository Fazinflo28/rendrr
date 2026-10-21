// Timeline -> FFmpeg. The one place that decides what a render looks like.
// planRender() is pure: it turns a snapshot + transcript into an ordered plan in OUTPUT time.
// ffmpegArgs() turns a plan + local file paths into one FFmpeg command (a single pass: fast and lossless between steps).
import { catalogMusic, catalogSfx } from "./catalog";
import type { Aspect, CaptionLook } from "./constants";
import { cutRegions, keptRanges, makeTimeMap, mergeRanges, subtractRanges, type Range } from "./ops";
import type { Snapshot, V2Clip, V3Clip, A2Clip, A3Clip } from "./timeline";
import { allWords, type Transcript, type Word } from "./transcript";

export type RenderKind = "preview" | "final";
export type SourceInfo = { width: number; height: number; fps: number; seconds: number; hasAudio: boolean };
export type CaptionRules = { wordsAtOnce: number; upper: boolean; maxLines: number };

export type PlanInput = {
  kind: RenderKind;
  snapshot: Snapshot;
  transcript: Transcript;
  source: SourceInfo;
  captionRules?: Partial<CaptionRules>;
  /** Footage length of each b-roll video, by video id. Clips whose footage is unknown are skipped. */
  brollSeconds?: Record<string, number>;
  /** Which graphic clips have a rendered file ready, by v3 clip id. */
  graphicsReady?: Record<string, boolean>;
};

export type ZoomOp = { start: number; end: number; scale: number; mode: "punch" | "push" };
export type OverlayOp = { clipId: string; start: number; end: number; sourceStart: number; videoId?: string; graphicId?: string };
export type AudioOp = { clipId: string; start: number; end: number; gainDb: number; assetKey: string; kind: "music" | "sfx" };
export type CaptionEvent = { start: number; end: number; text: string };

export type RenderPlan = {
  kind: RenderKind;
  width: number; height: number; fps: number;
  aspect: Aspect;
  kept: Range[];
  outputSeconds: number;
  zooms: ZoomOp[];
  broll: OverlayOp[];
  graphics: OverlayOp[];
  audio: AudioOp[];
  dialogueMutes: Range[];
  captions: CaptionEvent[];
  captionLook: CaptionLook;
  ass: string | null;
  operations: string[];
};

export class RenderPlanError extends Error {
  friendly = true;
  constructor(message: string) { super(message); }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function outputSize(aspect: Aspect, kind: RenderKind) {
  const short = kind === "preview" ? 540 : 1080;
  if (aspect === "9:16") return { width: short, height: even((short * 16) / 9) };
  if (aspect === "1:1") return { width: short, height: short };
  return { width: even((short * 16) / 9), height: short };
}

const DEFAULT_CAPTION_RULES: Record<CaptionLook, CaptionRules> = {
  clean: { wordsAtOnce: 7, upper: false, maxLines: 2 },
  bold: { wordsAtOnce: 3, upper: true, maxLines: 1 },
  outline: { wordsAtOnce: 5, upper: false, maxLines: 1 },
};

// ---------------------------------------------------------------------------------------------
// Captions: timed by the server from transcript words, never by the AI.
// ---------------------------------------------------------------------------------------------
type TimedToken = { text: string; t: number; end: number };

function captionTokens(lineWords: Word[], text: string, cut: Set<string>, inKept: (t: number) => boolean): TimedToken[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !lineWords.length) return [];
  if (tokens.length === lineWords.length) {
    // Same number of words: keep each word's own timing (typo fixes, punctuation, casing).
    return lineWords.map((w, i) => ({ text: tokens[i], t: w.t, end: w.end })).filter((_, i) => !cut.has(lineWords[i].id) && inKept(lineWords[i].t));
  }
  // Rewritten line: spread the new words across the words that are still in the video.
  const kept = lineWords.filter((w) => !cut.has(w.id) && inKept(w.t));
  if (!kept.length) return [];
  return tokens.map((tok, i) => {
    const a = kept[Math.min(kept.length - 1, Math.floor((i * kept.length) / tokens.length))];
    const b = kept[Math.min(kept.length - 1, Math.floor(((i + 1) * kept.length) / tokens.length) - 1)] || a;
    return { text: tok, t: a.t, end: Math.max(b.end, a.t + 0.1) };
  });
}

export function captionEvents(input: PlanInput, kept: Range[], toOutput: (s: number) => number, total: number, rules: CaptionRules): CaptionEvent[] {
  const tl = input.snapshot.timeline;
  if (!tl.captionsOn) return [];
  const cut = new Set(tl.cut);
  const inKept = (t: number) => kept.some((k) => t >= k.start && t < k.end);
  const capClips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "caption" || (!c.kind && c.lineId));
  const visible = capClips.length ? new Set(capClips.map((c) => c.lineId).filter(Boolean)) : null;
  const events: CaptionEvent[] = [];
  for (const line of input.transcript) {
    if (visible && !visible.has(line.id)) continue;
    const text = tl.captionText[line.id] ?? line.words.map((w) => w.text).join(" ");
    const toks = captionTokens(line.words, text, cut, inKept);
    for (let i = 0; i < toks.length; i += rules.wordsAtOnce) {
      const chunk = toks.slice(i, i + rules.wordsAtOnce);
      const next = toks[i + rules.wordsAtOnce];
      const start = toOutput(chunk[0].t);
      let end = next ? toOutput(next.t) : toOutput(chunk[chunk.length - 1].end) + 0.25;
      end = Math.min(end, total);
      if (end - start < 0.08) continue;
      // Bold and outline looks drop trailing commas and full stops, like most social captions.
      const tidy = (w: string) => (input.snapshot.timeline.captionLook === "clean" ? w : w.replace(/[,.;:]+$/, ""));
      const words = chunk.map((x) => tidy(x.text)).join(" ");
      events.push({ start: r3(start), end: r3(end), text: rules.upper ? words.toUpperCase() : words });
    }
  }
  // No overlaps: a caption ends when the next one starts.
  events.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < events.length; i++) if (events[i].end > events[i + 1].start) events[i].end = events[i + 1].start;
  return events.filter((e) => e.end - e.start >= 0.05);
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};
const assEscape = (s: string) => s.replace(/\\/g, "\uFF3C").replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D").replace(/\r?\n/g, "\\N");

/** ASS subtitles with the UI's three caption looks: clean (dark box), bold (white pill, black caps), outline. */
export function buildAss(events: CaptionEvent[], look: CaptionLook, width: number, height: number): string {
  // Sized by shape: vertical video gets bigger captions relative to its width, like the UI's previews.
  const portrait = height > width * 1.2, square = !portrait && height > width * 0.8;
  const factor = { bold: portrait ? 0.085 : square ? 0.075 : 0.062, outline: portrait ? 0.074 : square ? 0.066 : 0.056, clean: portrait ? 0.058 : square ? 0.054 : 0.046 }[look];
  const size = Math.round(Math.min(width, height) * factor);
  const marginV = Math.round(height * 0.13);
  const marginLR = Math.round(width * 0.08);
  // ASS colours are &HAABBGGRR, alpha 00 = solid.
  const styles: Record<CaptionLook, string> = {
    clean: `Style: Cap,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H73000000,&H00000000,0,0,0,0,100,100,0,0,3,${Math.round(size * 0.28)},0,2,${marginLR},${marginLR},${marginV},1`,
    bold: `Style: Cap,Inter,${size},&H000C0A0A,&H000C0A0A,&H00FFFDFC,&H00000000,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.3)},0,2,${marginLR},${marginLR},${marginV},1`,
    outline: `Style: Cap,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},0,2,${marginLR},${marginLR},${marginV},1`,
  };
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styles[look], "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Cap,,0,0,0,,${assEscape(e.text)}`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// planRender
// ---------------------------------------------------------------------------------------------
export function planRender(input: PlanInput): RenderPlan {
  const { snapshot, transcript, kind } = input;
  const tl = snapshot.timeline;
  const words = allWords(transcript);
  // Footage beyond the real file length cannot be rendered.
  const kept = subtractRanges(keptRanges(tl, words), [{ start: input.source.seconds, end: 1e9 }]);
  if (!kept.length) throw new RenderPlanError("Nothing is left to render. Every part of the video is cut. Restore some words or clips, then try again.");
  const map = makeTimeMap(kept);
  const total = r3(map.total);
  const { width, height } = outputSize(snapshot.aspect, kind);
  const toOut = (s: number) => r3(map.toOutput(s));
  // A clip on another track keeps its place in the edit: both ends move with the cuts.
  const span = (a: number, b: number) => { const s = toOut(a), e = toOut(b); return e - s >= 0.05 ? { start: s, end: e } : null; };

  const zooms: ZoomOp[] = [];
  const broll: OverlayOp[] = [];
  for (const c of tl.tracks.v2 as V2Clip[]) {
    const sp = span(c.start, c.end);
    if (!sp) continue;
    const x = c as V2Clip & { mode?: string };
    if (c.kind === "zoom" || (c.zoom && !c.videoId)) {
      zooms.push({ ...sp, scale: Math.min(2, Math.max(1, c.zoom ?? 1.15)), mode: x.mode === "push" || sp.end - sp.start > 4 ? "push" : "punch" });
    } else if (c.videoId && input.brollSeconds?.[c.videoId] != null) {
      const len = input.brollSeconds[c.videoId];
      const ss = Math.min(c.sourceStart ?? 0, Math.max(0, len - 0.1));
      const end = Math.min(sp.end, sp.start + (len - ss));
      if (end - sp.start >= 0.05) broll.push({ clipId: c.id, start: sp.start, end: r3(end), sourceStart: ss, videoId: c.videoId });
    }
  }
  const graphics: OverlayOp[] = [];
  for (const c of tl.tracks.v3 as V3Clip[]) {
    if (c.kind !== "graphic" || !c.graphicId || (input.graphicsReady && !input.graphicsReady[c.id])) continue;
    const sp = span(c.start, c.end);
    if (sp) graphics.push({ clipId: c.id, ...sp, sourceStart: 0, graphicId: c.graphicId });
  }
  const audio: AudioOp[] = [];
  // Keys come from the catalog only (see catalogMusic), whatever the stored clip says.
  for (const c of tl.tracks.a2 as A2Clip[]) {
    const track = catalogMusic(c);
    if (!track) continue;
    const sp = span(c.start, c.end);
    if (sp) audio.push({ clipId: c.id, ...sp, gainDb: c.gainDb ?? -18, assetKey: track.key, kind: "music" });
  }
  for (const c of tl.tracks.a3 as A3Clip[]) {
    const sfx = catalogSfx(c);
    if (!sfx) continue;
    const start = toOut(c.start);
    if (start >= total) continue;
    audio.push({ clipId: c.id, start, end: r3(Math.min(total, start + Math.max(0.1, c.end - c.start))), gainDb: c.gainDb ?? -6, assetKey: sfx.key, kind: "sfx" });
  }
  // Dialogue plays only where an A1 clip covers it.
  const a1 = mergeRanges(tl.tracks.a1.map((c) => ({ start: c.start, end: c.end })));
  const silentSrc = subtractRanges(kept, a1);
  const dialogueMutes = mergeRanges(silentSrc.map((g) => ({ start: toOut(g.start), end: toOut(g.end) })).filter((g) => g.end > g.start));

  const look = tl.captionLook;
  const rules: CaptionRules = { ...DEFAULT_CAPTION_RULES[look], ...(input.captionRules || {}) };
  const captions = captionEvents(input, kept, toOut, total, rules);
  const ass = captions.length ? buildAss(captions, look, width, height) : null;

  const cutCount = cutRegions(words, new Set(tl.cut)).length;
  const operations = [
    `Keep ${kept.length} ${kept.length === 1 ? "part" : "parts"} of the footage (${cutCount} word cuts, V1 gaps removed): ${total.toFixed(2)}s out of ${input.source.seconds.toFixed(2)}s`,
    `Fit to ${snapshot.aspect} at ${width}x${height}, 30 fps`,
    zooms.length ? `Zoom: ${zooms.length} (${zooms.filter((z) => z.mode === "punch").length} punch, ${zooms.filter((z) => z.mode === "push").length} slow push)` : "Zoom: none",
    broll.length ? `B-roll overlays: ${broll.length}` : "B-roll overlays: none",
    graphics.length ? `Graphics overlays: ${graphics.length}` : "Graphics overlays: none",
    captions.length ? `Captions: ${captions.length} word-timed events, look ${look}` : "Captions: off",
    `Audio: dialogue${dialogueMutes.length ? ` (${dialogueMutes.length} muted gaps)` : ""}${audio.some((a) => a.kind === "music") ? " + music ducked under speech" : ""}${audio.some((a) => a.kind === "sfx") ? ` + ${audio.filter((a) => a.kind === "sfx").length} sound effects` : ""}`,
    kind === "preview" ? `Encode preview: H.264 ultrafast, ${width}x${height}` : `Encode final: H.264, ${width}x${height}`,
  ];
  return { kind, width, height, fps: 30, aspect: snapshot.aspect, kept, outputSeconds: total, zooms, broll, graphics, audio, dialogueMutes, captions, captionLook: look, ass, operations };
}

// ---------------------------------------------------------------------------------------------
// ffmpegArgs: plan + local files -> one command. The filter graph goes in a script file.
// ---------------------------------------------------------------------------------------------
export type PlanFiles = {
  source: string;
  output: string;
  assPath?: string;
  fontsDir?: string;
  broll?: Record<string, string>; // by clip id
  graphics?: Record<string, string>; // by clip id
  audio?: Record<string, string>; // by clip id
};

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
const n3 = (x: number) => x.toFixed(3);

export function zoomExpr(zooms: ZoomOp[]): string {
  if (!zooms.length) return "1";
  const terms = zooms.map((z) => {
    const s = (z.scale - 1).toFixed(4);
    if (z.mode === "push") return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*(t-${n3(z.start)})/${n3(Math.max(0.1, z.end - z.start))},0)`;
    const ramp = Math.min(0.12, (z.end - z.start) / 3).toFixed(3);
    return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*min(1,(t-${n3(z.start)})/${ramp})*min(1,(${n3(z.end)}-t)/${ramp}),0)`;
  });
  return `min(2,1+${terms.join("+")})`;
}

export function ffmpegArgs(plan: RenderPlan, files: PlanFiles, source: SourceInfo, opts: { threads?: number } = {}): { args: string[]; filterGraph: string } {
  const inputs: string[] = [];
  const g: string[] = [];
  let idx = 0;
  const W = plan.width, H = plan.height;

  inputs.push("-i", files.source);
  const srcIdx = idx++;
  let srcAudio = `${srcIdx}:a`;
  if (!source.hasAudio) {
    inputs.push("-f", "lavfi", "-t", n3(source.seconds + 1), "-i", "anullsrc=r=48000:cl=stereo");
    srcAudio = `${idx++}:a`;
  }

  // 1. Cut: split the source and keep each part, then join them back together.
  const N = plan.kept.length;
  if (N === 1) {
    g.push(`[${srcIdx}:v]trim=start=${n3(plan.kept[0].start)}:end=${n3(plan.kept[0].end)},setpts=PTS-STARTPTS[v0]`);
    g.push(`[${srcAudio}]atrim=start=${n3(plan.kept[0].start)}:end=${n3(plan.kept[0].end)},asetpts=PTS-STARTPTS[a0]`);
  } else {
    g.push(`[${srcIdx}:v]split=${N}${plan.kept.map((_, i) => `[sv${i}]`).join("")}`);
    g.push(`[${srcAudio}]asplit=${N}${plan.kept.map((_, i) => `[sa${i}]`).join("")}`);
    plan.kept.forEach((k, i) => {
      g.push(`[sv${i}]trim=start=${n3(k.start)}:end=${n3(k.end)},setpts=PTS-STARTPTS[v${i}]`);
      g.push(`[sa${i}]atrim=start=${n3(k.start)}:end=${n3(k.end)},asetpts=PTS-STARTPTS[a${i}]`);
    });
  }
  g.push(`${plan.kept.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${N}:v=1:a=1[vcat][acat]`);

  // 2. Fit to the output shape (fill and centre-crop), constant 30 fps.
  g.push(`[vcat]fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4,setsar=1[vfit]`);
  let v = "vfit";

  // 3. Zooms: scale per frame, crop back to size.
  if (plan.zooms.length) {
    const z = zoomExpr(plan.zooms);
    g.push(`[${v}]scale=w='2*trunc(iw*(${z})/2)':h='2*trunc(ih*(${z})/2)':eval=frame,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4[vzoom]`);
    v = "vzoom";
  }

  // 4. B-roll overlays (video only; the dialogue keeps playing underneath).
  plan.broll.forEach((b, i) => {
    const path = files.broll?.[b.clipId];
    if (!path) return;
    inputs.push("-ss", n3(b.sourceStart), "-t", n3(b.end - b.start), "-i", path);
    const bi = idx++;
    g.push(`[${bi}:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,setpts=PTS-STARTPTS+${n3(b.start)}/TB[br${i}]`);
    g.push(`[${v}][br${i}]overlay=0:0:enable='between(t,${n3(b.start)},${n3(b.end)})':eof_action=pass[vb${i}]`);
    v = `vb${i}`;
  });

  // 5. Graphics: transparent WebM, decoded with libvpx to keep the alpha channel.
  plan.graphics.forEach((gr, i) => {
    const path = files.graphics?.[gr.clipId];
    if (!path) return;
    inputs.push("-c:v", "libvpx-vp9", "-i", path);
    const gi = idx++;
    g.push(`[${gi}:v]format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,setpts=PTS-STARTPTS+${n3(gr.start)}/TB[gr${i}]`);
    g.push(`[${v}][gr${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${n3(gr.start)},${n3(gr.end)})':eof_action=pass[vg${i}]`);
    v = `vg${i}`;
  });

  // 6. Captions on top of everything.
  if (plan.ass && files.assPath) {
    g.push(`[${v}]ass=filename=${q(files.assPath)}${files.fontsDir ? `:fontsdir=${q(files.fontsDir)}` : ""}[vcap]`);
    v = "vcap";
  }
  g.push(`[${v}]format=yuv420p[vout]`);

  // 7. Audio: dialogue (with muted gaps), music ducked under speech, sound effects.
  const mute = plan.dialogueMutes.length ? `,volume=volume=0:enable='${plan.dialogueMutes.map((m) => `between(t,${n3(m.start)},${n3(m.end)})`).join("+")}'` : "";
  g.push(`[acat]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${mute}[dlg]`);
  const music = plan.audio.filter((a) => a.kind === "music" && files.audio?.[a.clipId]);
  const sfx = plan.audio.filter((a) => a.kind === "sfx" && files.audio?.[a.clipId]);
  const mixIn: string[] = [];
  if (music.length) {
    g.push(`[dlg]asplit=2[dlgmix][dlgsc]`);
    mixIn.push("[dlgmix]");
    music.forEach((m, i) => {
      inputs.push("-stream_loop", "-1", "-i", files.audio![m.clipId]);
      const mi = idx++;
      const d = Math.max(0.1, m.end - m.start);
      g.push(`[${mi}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=${n3(Math.min(0.6, d / 4))},afade=t=out:st=${n3(Math.max(0, d - 1.2))}:d=${n3(Math.min(1.2, d / 4))},volume=${m.gainDb}dB,adelay=delays=${Math.round(m.start * 1000)}:all=1[mu${i}]`);
    });
    let bus = "[mu0]";
    if (music.length > 1) { g.push(`${music.map((_, i) => `[mu${i}]`).join("")}amix=inputs=${music.length}:normalize=0[mubus]`); bus = "[mubus]"; }
    g.push(`${bus}[dlgsc]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=350[muduck]`);
    mixIn.push("[muduck]");
  } else {
    mixIn.push("[dlg]");
  }
  sfx.forEach((s, i) => {
    inputs.push("-i", files.audio![s.clipId]);
    const si = idx++;
    g.push(`[${si}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.gainDb}dB,adelay=delays=${Math.round(s.start * 1000)}:all=1[fx${i}]`);
    mixIn.push(`[fx${i}]`);
  });
  if (mixIn.length > 1) g.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first,alimiter=limit=0.95[aout]`);
  else g.push(`${mixIn[0]}alimiter=limit=0.95[aout]`);

  const preview = plan.kind === "preview";
  const args = [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex_script", "__FILTER_SCRIPT__",
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", preview ? "ultrafast" : "veryfast", "-crf", preview ? "28" : "20",
    "-pix_fmt", "yuv420p", "-r", "30", "-g", "60",
    "-c:a", "aac", "-b:a", preview ? "96k" : "192k", "-ar", "48000",
    "-t", n3(plan.outputSeconds),
    "-movflags", "+faststart",
    ...(opts.threads ? ["-threads", String(opts.threads)] : []),
    "-progress", "pipe:1", "-nostats",
    files.output,
  ];
  return { args, filterGraph: g.join(";\n") };
}
