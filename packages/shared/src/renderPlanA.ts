// The model A planner, as it was before Phase 2 (the sequence model). Kept unchanged to render timelines stored in
// model A (old versions, and any project the migration left on A) exactly as before, and to verify the migration:
// toModelB() must give the same plan. New work goes into renderPlan.ts.
import { catalogMusic, catalogSfx } from "./catalog";
import { cutRegions, keptRanges, makeTimeMap, mergeRanges, subtractRanges, type Range } from "./sequence";
import type { A2Clip, A3Clip, V2Clip, V3Clip } from "./timeline";
import { allWords, type Word } from "./transcript";
import {
  buildAss, DEFAULT_CAPTION_RULES, outputSize, RenderPlanError, zoomExpr,
  type AudioOp, type CaptionEvent, type CaptionRules, type OverlayOp, type PlanFiles, type PlanInput, type RenderPlan, type SourceInfo, type ZoomOp,
} from "./renderPlan";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const FPS = 30;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
const n3 = (x: number) => x.toFixed(3);
const n6 = (x: number) => x.toFixed(6);

type TimedToken = { text: string; t: number; end: number };

function captionTokens(lineWords: Word[], text: string, cut: Set<string>, inKept: (t: number) => boolean): TimedToken[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !lineWords.length) return [];
  if (tokens.length === lineWords.length) {
    // Same number of words: keep each word's own timing (typo fixes, punctuation, casing).
    return lineWords.map((w, i) => ({ text: tokens[i], t: w.t, end: w.end })).filter((_, i) => !cut.has(lineWords[i].id) && inKept(lineWords[i].t));
  }
  // Rewritten line: spread the new words evenly over the words that are still in the video. A position p in
  // "kept word" units maps to a time inside that word, so more new words than old ones still get distinct times.
  const kept = lineWords.filter((w) => !cut.has(w.id) && inKept(w.t));
  if (!kept.length) return [];
  const n = kept.length, m = tokens.length;
  const at = (p: number) => {
    if (p >= n) return kept[n - 1].end;
    const k = kept[Math.floor(p)], f = p - Math.floor(p);
    return k.t + f * Math.max(0, k.end - k.t);
  };
  return tokens.map((tok, i) => {
    const t = at((i * n) / m);
    const p2 = ((i + 1) * n) / m;
    const end = Number.isInteger(p2) ? kept[Math.min(n, p2) - 1].end : at(p2);
    return { text: tok, t, end: Math.max(end, t + 0.05) };
  });
}

function captionEvents(input: PlanInput, kept: Range[], toOutput: (s: number) => number, total: number, rules: CaptionRules): CaptionEvent[] {
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
    if (!toks.length) continue;
    // A rewritten line with many more words than time shows them in bigger groups (each group on screen for at
    // least 0.3 s) instead of flashing some and dropping others.
    const perWord = Math.max(0.001, toOutput(toks[toks.length - 1].end) - toOutput(toks[0].t)) / toks.length;
    const step = Math.max(rules.wordsAtOnce, Math.ceil(0.3 / perWord));
    for (let i = 0; i < toks.length; i += step) {
      const chunk = toks.slice(i, i + step);
      const next = toks[i + step];
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

// ---------------------------------------------------------------------------------------------
// planRender
// ---------------------------------------------------------------------------------------------
export function planRenderA(input: PlanInput): RenderPlan {
  const { snapshot, transcript, kind } = input;
  const tl = snapshot.timeline;
  const words = allWords(transcript);
  // Footage beyond the real file length cannot be rendered. Every kept part starts and ends on a frame of the
  // 30 fps output, so the picture and the sound of each part are exactly as long as the plan says (no drift
  // at each cut, and captions, zooms and music stay on the footage).
  const f30 = (x: number) => Math.round(x * FPS) / FPS;
  const kept = mergeRanges(subtractRanges(keptRanges(tl, words), [{ start: input.source.seconds, end: 1e9 }])
    .map((k) => ({ start: f30(k.start), end: Math.min(f30(k.end), Math.floor(input.source.seconds * FPS) / FPS) }))
    .filter((k) => k.end - k.start >= 1 / FPS - 1e-9));
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
    `${tl.rotate ? `Turn the footage ${tl.rotate}° clockwise, then fit` : "Fit"} to ${snapshot.aspect} at ${width}x${height}, 30 fps${tl.framing ? `; frame it: scale ${tl.framing.scale}, offset ${tl.framing.x}, ${tl.framing.y}` : ""}`,
    zooms.length ? `Zoom: ${zooms.length} (${zooms.filter((z) => z.mode === "punch").length} punch, ${zooms.filter((z) => z.mode === "push").length} slow push)` : "Zoom: none",
    broll.length ? `B-roll overlays: ${broll.length}` : "B-roll overlays: none",
    graphics.length ? `Graphics overlays: ${graphics.length}` : "Graphics overlays: none",
    captions.length ? `Captions: ${captions.length} word-timed events, look ${look}` : "Captions: off",
    `Audio: dialogue${dialogueMutes.length ? ` (${dialogueMutes.length} muted gaps)` : ""}${audio.some((a) => a.kind === "music") ? " + music ducked under speech" : ""}${audio.some((a) => a.kind === "sfx") ? ` + ${audio.filter((a) => a.kind === "sfx").length} sound effects` : ""}`,
    kind === "preview" ? `Encode preview: H.264 ultrafast, ${width}x${height}` : `Encode final: H.264, ${width}x${height}`,
  ];
  // The same picture and sound in the sequence plan's terms (one video), for the player and the worker.
  const vid = input.videoId || "main";
  let acc = 0;
  const parts = kept.map((k) => { const start = acc; acc += k.end - k.start; return { videoId: vid, srcIn: k.start, srcOut: k.end, start, end: acc, rotate: (tl.rotate ?? 0) as 0 | 90 | 180 | 270, framing: tl.framing ?? null, clipIds: [] }; });
  const sound = parts.map((p) => ({ videoId: vid, srcIn: p.srcIn, srcOut: p.srcOut, start: p.start, end: p.end, muted: false, clipId: "" }));
  return { model: "A", kind, width, height, fps: 30, aspect: snapshot.aspect, kept, parts, sound, sources: [vid], outputSeconds: total, rotate: tl.rotate ?? 0, framing: tl.framing ?? null, zooms, broll, graphics, audio, dialogueMutes, captions, captionLook: look, ass, operations };
}

// ---------------------------------------------------------------------------------------------
// ffmpegArgs (model A): plan + local files -> one command.
// ---------------------------------------------------------------------------------------------
export function ffmpegArgsA(plan: RenderPlan, files: PlanFiles, source: SourceInfo, opts: { threads?: number } = {}): { args: string[]; filterGraph: string } {
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

  // 1. Cut: put the source on a 30 fps grid, split it, keep each part, then join them back together.
  // Kept parts start and end on frames (planRender), so each part is a whole number of frames in both streams.
  // After fps=30 the video time base is 1/30 s and trim rounds its times to the nearest frame, so small float
  // errors can never take or drop a boundary frame. Audio trims are sample-exact.
  const N = plan.kept.length;
  const vt = (k: Range) => `trim=start=${n6(k.start)}:end=${n6(k.end)},setpts=PTS-STARTPTS`;
  const at = (k: Range) => `atrim=start=${n6(k.start)}:end=${n6(k.end)},asetpts=PTS-STARTPTS`;
  if (N === 1) {
    g.push(`[${srcIdx}:v]fps=${FPS},${vt(plan.kept[0])}[v0]`);
    g.push(`[${srcAudio}]aresample=48000,${at(plan.kept[0])}[a0]`);
  } else {
    g.push(`[${srcIdx}:v]fps=${FPS},split=${N}${plan.kept.map((_, i) => `[sv${i}]`).join("")}`);
    g.push(`[${srcAudio}]aresample=48000,asplit=${N}${plan.kept.map((_, i) => `[sa${i}]`).join("")}`);
    plan.kept.forEach((k, i) => {
      g.push(`[sv${i}]${vt(k)}[v${i}]`);
      g.push(`[sa${i}]${at(k)}[a${i}]`);
    });
  }
  g.push(`${plan.kept.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${N}:v=1:a=1[vcat][acat]`);

  // 2. Fit to the output shape (fill and centre-crop), constant 30 fps. HDR originals are tone-mapped to SDR
  // BT.709 exactly like the preview copy, so the final looks like the preview that was approved.
  const tone = source.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "";
  // Footage filmed sideways is turned first (transpose=1 is 90° clockwise, 2 is 90° anticlockwise).
  const turn = plan.rotate === 90 ? "transpose=1," : plan.rotate === 270 ? "transpose=2," : plan.rotate === 180 ? "hflip,vflip," : "";
  g.push(`[vcat]${turn}${tone}fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4,setsar=1[vfit]`);
  let v = "vfit";

  // 2b. Framing (position and scale): the fitted picture is scaled about its centre and moved over a black frame.
  if (plan.framing) {
    const f = plan.framing;
    const sw = even(W * f.scale), sh = even(H * f.scale);
    const ox = Math.round((W - sw) / 2 + f.x * W), oy = Math.round((H - sh) / 2 + f.y * H);
    g.push(`color=c=black:s=${W}x${H}:r=${FPS}[fcanvas]`);
    g.push(`[${v}]scale=${sw}:${sh},setsar=1[fscaled]`);
    g.push(`[fcanvas][fscaled]overlay=x=${ox}:y=${oy}:shortest=1,format=yuv420p[vframed]`);
    v = "vframed";
  }

  // 3. Zooms: scale per frame, crop back to size.
  if (plan.zooms.length) {
    const z = zoomExpr(plan.zooms);
    // crop's iw/ih are fixed when the filter starts, so the offsets are computed from the zoom itself
    // (centred across, 40% down, the same framing as the fit step).
    g.push(`[${v}]scale=w='2*trunc(${W}*(${z})/2)':h='2*trunc(${H}*(${z})/2)':eval=frame,crop=${W}:${H}:x='(2*trunc(${W}*(${z})/2)-${W})/2':y='(2*trunc(${H}*(${z})/2)-${H})*0.4'[vzoom]`);
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
      g.push(`[${mi}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=${n3(Math.min(0.6, d / 4))},afade=t=out:st=${n3(Math.max(0, d - Math.min(1.2, d / 4)))}:d=${n3(Math.min(1.2, d / 4))},volume=${m.gainDb}dB,adelay=delays=${Math.round(m.start * 1000)}:all=1[mu${i}]`);
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
    g.push(`[${si}:a]atrim=0:${n3(Math.max(0.1, s.end - s.start))},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.gainDb}dB,adelay=delays=${Math.round(s.start * 1000)}:all=1[fx${i}]`);
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
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", preview ? "96k" : "192k", "-ar", "48000",
    "-t", n3(plan.outputSeconds),
    "-movflags", "+faststart",
    ...(opts.threads ? ["-threads", String(opts.threads)] : []),
    "-progress", "pipe:1", "-nostats",
    files.output,
  ];
  return { args, filterGraph: g.join(";\n") };
}
