/* ===================== /editor/:id ===================== */
// Ported from ui/rendrr-ui.html (editor script). Changes: real footage in the player, live reload when an AI
// edits, autosave conflicts, real undo/restore, the rendered preview plays in the player, real downloads.
// Phase 2: the edit is a sequence (clips of any video, in any order, J/L cuts) with Premiere's tools.
import { useState, useEffect, useRef, useMemo, useCallback, html, fmtTime, fmtAgo, initials, Icon, Btn, Toggle, Chip, useToast, Modal, useAsync, Async, usePlayback, Player, turnedVideoStyle, fitVideoStyle, Art, useNav, useApp } from "./ui";

// Web addresses in a comment as links (they open in a new tab); the rest stays text.
function linkified(text) {
  const out = [], re = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
  let last = 0, m;
  while ((m = re.exec(text || ""))) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""), href = /^https?:/i.test(url) ? url : "https://" + url;
    out.push(text.slice(last, m.index), html`<a href=${href} target="_blank" rel="noopener noreferrer">${url}</a>`);
    last = m.index + url.length; re.lastIndex = last;
  }
  out.push((text || "").slice(last));
  return out;
}
import { StyleArt, CreateLinkModal, ReferencePicker, VideoOrderPicker } from "./screens";
import { api } from "./api";
import { OpColor, OpSlider } from "./controls";
import { ColorTab, LookCanvas, MaskOverlay, pickColor, useLutData } from "./color";
import { ExportModal, timeLeft } from "./export";
// The timeline logic and the render plan are shared with the server: the editor edits with the connector's own ops,
// draws and plays the edit exactly as the connector changes it and the renderer renders it.
import { SourceMonitor, MediaBin, useLibrary } from "./media";
import { Filmstrip } from "./filmstrip";
import { ASPECT_RATIO, fitCrop, VOICE_PRESETS, applyOp, asSequence, audioFrames, patternPicture, peaksFromSamples, waveColumns, audioAt, cardBorderPicture, cardShadowPicture, audioSettings, CAPTION_FONTS, DIRS, EASES, KEY_PROPS, keyTracks, motionAt, showAt, speedText, TRANSITIONS, captionStyleOf, CLEANUP_KNOBS, CLEANUP_TEXT, CLEANUPS, cleanupParams, cssSize, dbToLin, drawnOf, FONT_WEIGHTS, fontFaceCss, fontFilesOf, TEXT_ANIMS, TEXT_PRESETS, textPreset, findTemplate, isCaptionMarker, layoutTimeline, liveFrame, playerGraphicHtml, sequenceClock, sequenceView, StyleRulesSchema, templateSize } from "@rendrr/shared";
import { outputSize, planRender } from "@rendrr/shared/renderPlan";
// Undo and redo over the whole edit state. `replace` changes without a history entry (typing), `commit` adds one.
function useHistory(initial) {
  const [h, setH] = useState({ past: [], present: initial, future: [] });
  const commit = useCallback((next) => setH((x) => { const p = typeof next === "function" ? next(x.present) : next; if (p === x.present) return x; return { past: [...x.past.slice(-60), x.present], present: p, future: [] }; }), []);
  const replace = useCallback((next) => setH((x) => ({ ...x, present: typeof next === "function" ? next(x.present) : next })), []);
  const commitFrom = useCallback((base) => setH((x) => (base === x.present ? x : { past: [...x.past.slice(-60), base], present: x.present, future: [] })), []);
  const undo = useCallback(() => setH((x) => (x.past.length ? { past: x.past.slice(0, -1), present: x.past[x.past.length - 1], future: [x.present, ...x.future] } : x)), []);
  const redo = useCallback(() => setH((x) => (x.future.length ? { past: [...x.past, x.present], present: x.future[0], future: x.future.slice(1) } : x)), []);
  return { state: h.present, commit, replace, commitFrom, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
const TRACKS = [["v3", "V3"], ["v2", "V2"], ["v1", "V1"], ["a1", "A1"], ["a2", "A2"], ["a3", "A3"]];
/** Timeline zoom in pixels a second: down to the whole edit, up to the 10 ms frames of the waveform (6 px each). */
const ZMIN = 4, ZMAX = 600;
/** Each track's height in pixels (the dialogue is taller: its waveform). */
const TRACK_H = { a1: 56, a2: 40, a3: 34 };
const TRACK_HINT = { v1: "Main cut", v2: "B-roll, effects", v3: "Titles", a1: "Dialogue", a2: "Music", a3: "Sound FX" };
// The style, broken down like a recipe. Keys muted, values plain, nested with two spaces.
const styleCode = (st, S) => [
  "style: " + st.name,
  "type: " + st.type,
  "shape: " + (S?.aspect || st.ori[0]),
  "cuts:",
  "  pace: " + st.cutPace,
  "zooms: " + st.zoomRules,
  "captions:",
  "  look: " + (S?.captionLook || st.captionLook),
  "  rule: " + st.captionRule,
  "  on: " + (S?.captionsOn === false ? "false" : "true"),
  "music: " + st.musicVibe,
  "export:",
  "  shapes: " + st.ori.join(", "),
  "  best_on: " + st.platforms.join(", "),
].join("\n");
// Premiere's tools and keys.
const TOOL_ICON = { select: "select", razor: "razor", ripple: "ripple", roll: "roll", slip: "slip", slide: "slide" };
const TOOLS = [["select", "V", "Select", "Click to select, drag a clip to reorder it, drag an edge to trim"], ["razor", "C", "Razor", "Click a clip to split it there"], ["ripple", "B", "Ripple", "Drag an edge: the clip gets longer or shorter and the edit closes up"], ["roll", "N", "Rolling", "Drag a cut: one clip gets longer, the next shorter"], ["slip", "Y", "Slip", "Drag a clip: same place and length, other footage"], ["slide", "U", "Slide", "Drag a clip between its neighbours"]];
const SHORTCUTS = [["Space", "Play or pause"], ["J", "Back 5 seconds"], ["K", "Pause"], ["L", "Forward 5 seconds"], ...TOOLS.map(([, k, l, d]) => [k, `${l}: ${d.charAt(0).toLowerCase() + d.slice(1)}`]), ["S", "Snapping on or off"], ["Shift Z", "Zoom the timeline to fit"], ["Cmd K", "Split at the playhead"], ["Alt drag", "Drag a dialogue edge: J or L cut"], ["Delete", "Cut selected words or clip"], ["Cmd Z", "Undo"], ["Cmd Shift Z", "Redo"], ["?", "Show shortcuts"]];
// The right panel, like Higgsfield's: Edit and Comments. Edit lists the tools in two groups, each opens on its own page
// with a back arrow. Tool key: label, icon.
const PANEL_TOOLS = { transcript: ["Transcript", "lines"], clip: ["Speed & motion", "gauge"], text: ["Text & captions", "type"], audio: ["Audio", "wave"], color: ["Color", "drop"], style: ["Reference", "image"], ai: ["What your AI did", "spark"] };
const PANEL_GROUPS = [["Edit video", "edit", ["transcript", "clip", "text", "audio", "color"]], ["Your AI", "spark", ["style", "ai"]]];
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// A video laid over the player (b-roll, a custom graphic), kept on the time it should show. Phase 6: a b-roll clip
// with a look is drawn through it (the video stays as the clock); CORS lets WebGL read its frames.
// A card's shadow or border: the shared picture (the one the render reads as a file) at the plan's size, in its
// colour, stretched over the frame.
function CardLayer({ spec, color, W, H }) {
  const ref = useRef(null);
  const key = useMemo(() => JSON.stringify([spec, color, W, H]), [spec, color, W, H]);
  useEffect(() => {
    const cv = ref.current; if (!cv || !spec) return;
    const px = spec.kind === "border" ? cardBorderPicture(spec.card, spec.framing, W, H) : cardShadowPicture(spec.card, spec.framing, W, H);
    const im = new ImageData(W, H), r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    for (let i = 0; i < px.length; i++) { im.data[i * 4] = r; im.data[i * 4 + 1] = g; im.data[i * 4 + 2] = b; im.data[i * 4 + 3] = px[i]; }
    cv.getContext("2d").putImageData(im, 0, 0);
  }, [key]);
  return html`<canvas ref=${ref} width=${W} height=${H} data-card=${spec?.kind} style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" />`;
}
// A pattern behind V1 (grid, dots, paper): the shared picture the render reads as a file, at the plan's size.
function PatternLayer({ pattern, W, H }) {
  const ref = useRef(null);
  const key = JSON.stringify([pattern, W, H]);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const px = patternPicture(pattern, W, H), im = new ImageData(W, H);
    for (let i = 0, n = W * H; i < n; i++) { im.data[i * 4] = px[i * 3]; im.data[i * 4 + 1] = px[i * 3 + 1]; im.data[i * 4 + 2] = px[i * 3 + 2]; im.data[i * 4 + 3] = 255; }
    cv.getContext("2d").putImageData(im, 0, 0);
  }, [key]);
  return html`<canvas ref=${ref} width=${W} height=${H} data-back="pattern" style="position:absolute;inset:0;width:100%;height:100%" />`;
}
// What is behind V1 (plan.background): the gradient by the CSS rule the render's picture follows, a library video looped,
// or the clip's own picture blurred (sigma at the stage's scale) and scaled up as the render does.
function BackLayer({ plan, time, playing, broll, part, partUrl, aspect, k }) {
  const bg = plan.background; if (!bg) return null;
  const spec = bg.file ? plan.lookFiles?.[bg.file] : null;
  if (spec?.kind === "pattern") return html`<${PatternLayer} pattern=${spec.pattern} W=${plan.width} H=${plan.height} />`;
  if (spec?.kind === "gradient") return html`<div data-back="gradient" style=${{ position: "absolute", inset: 0, background: `linear-gradient(${spec.gradient.angle ?? 180}deg, ${spec.gradient.from}, ${spec.gradient.to})` }} />`;
  if (bg.videoId && broll[bg.videoId]) return html`<div data-back="video" style="position:absolute;inset:0"><${SyncedVideo} src=${broll[bg.videoId].url} time=${bg.seconds ? time % bg.seconds : time} playing=${playing} /></div>`;
  if (bg.blur && part && partUrl) {
    const turn = turnedVideoStyle(part.rotate || 0, aspect);
    return html`<div data-back="blur" style="position:absolute;inset:0;overflow:hidden"><div style=${{ position: "absolute", inset: 0, filter: `blur(${bg.blur * k}px)`, transform: `scale(${bg.scale ?? 1.1})` }}><${SyncedVideo} src=${partUrl} time=${part.srcIn + (time - part.start) * (part.rate ?? 1)} playing=${playing} style=${turn || { objectPosition: "50% 40%" }} /></div></div>`;
  }
  return null;
}
function SyncedVideo({ src, time, playing, fit = "cover", look = null, plan = null, luts, style = null }) {
  const ref = useRef(null); const [noGl, setNoGl] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (playing) { if (Math.abs(el.currentTime - time) > 0.25) { try { el.currentTime = time; } catch {} } el.play().catch(() => {}); }
    else { el.pause(); if (Math.abs(el.currentTime - time) > 0.04) { try { el.currentTime = time; } catch {} } }
  }, [time, playing]);
  const gl = !!look && !!plan && !noGl;
  return html`<video ref=${ref} src=${src} crossOrigin="anonymous" muted playsInline preload="auto" style=${{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: fit, pointerEvents: "none", ...(style || {}), ...(gl ? { opacity: 0 } : {}) }} />
    ${gl && html`<${LookCanvas} videoRef=${ref} look=${look} W=${plan.width} H=${plan.height} fitY=${0.5} luts=${luts} onFail=${() => setNoGl(true)} />`}`;
}

// Engine Part 6: the sound's 10 ms peaks for the waveform: each video's measured peaks (4 bytes per 10 ms), a music or
// effect file decoded here. Kept for the session.
const peakCache = new Map();
function loadPeaks(key, url, decode) {
  if (!peakCache.has(key)) peakCache.set(key, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then(async (b) => {
    if (!b) return null;
    if (!decode) { const f = audioFrames(new Uint8Array(b)); return { n: f.n, min: f.min, max: f.max }; }
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!Ctx) return null;
    const buf = await new Ctx(1, 1, 44100).decodeAudioData(b);
    return peaksFromSamples(buf.getChannelData(0), buf.sampleRate);
  }).catch(() => null));
  return peakCache.get(key);
}
// A track's waveform: only the part of the timeline on screen is drawn (any zoom, any length), one column a pixel.
function WaveLayer({ parts, peaks, zoom, pad, canvasRef, height }) {
  const ref = useRef(null); const [vp, setVp] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const sc = canvasRef.current?.parentElement; if (!sc) return;
    const on = () => setVp({ left: sc.scrollLeft, width: sc.clientWidth });
    on(); sc.addEventListener("scroll", on, { passive: true }); const ro = new ResizeObserver(on); ro.observe(sc);
    return () => { sc.removeEventListener("scroll", on); ro.disconnect(); };
  }, []);
  useEffect(() => {
    const cv = ref.current; if (!cv || !vp.width) return;
    const dpr = window.devicePixelRatio || 1, W = Math.ceil(vp.width);
    cv.width = W * dpr; cv.height = height * dpr;
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, height);
    const cols = waveColumns(parts, (k) => peaks[k], (vp.left - pad) / zoom, 1 / zoom, W);
    const css = getComputedStyle(cv), on = css.getPropertyValue("--wave").trim() || "#4f9fe0", off = css.getPropertyValue("--wave-off").trim() || "#8888";
    const mid = height / 2, amp = height / 2 - 3;
    for (let x = 0; x < W; x++) {
      const lo = cols.lo[x]; if (Number.isNaN(lo)) continue;
      g.fillStyle = cols.muted[x] ? off : on;
      const y0 = mid - cols.hi[x] * amp, y1 = mid - lo * amp;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [vp, parts, peaks, zoom, height]);
  return html`<canvas ref=${ref} class="wave" data-wave="1" style=${{ left: vp.left + "px", width: vp.width + "px", height: height + "px" }} />`;
}
// Marks (Rendrr's measurements and the AI's notes) as thin coloured lines with a note.
const MARK_WORDS = { silence: "Silence", filler: "Filler word", retake: "Retake", stumble: "Stumble", false_start: "False start", off_camera: "Off camera", director_note: "Note to the crew", breath: "Breath", click_pop: "Click", loud_peak: "Loud peak", clipped_audio: "Clipped sound", low_light: "Dark", out_of_focus: "Soft focus", scene_change: "Scene change", face_lost: "Face lost", music_beat: "Beat", custom: "Note" };
const MARK_COLORS = { silence: "#8a8f98", filler: "#f5a524", retake: "#e5484d", stumble: "#f76b15", false_start: "#d6409f", off_camera: "#8e4ec6", director_note: "#0090ff", breath: "#68c6e8", click_pop: "#e2c400", loud_peak: "#ff977d", clipped_audio: "#ce2c31", low_light: "#6e56cf", out_of_focus: "#ab4aba", scene_change: "#12a594", face_lost: "#a18072", music_beat: "#46a758", custom: "#30a46c" };
const mss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const markNote = (m) => `${MARK_WORDS[m.kind] || m.kind}${m.label ? ": " + m.label : ""}${m.note ? " · " + m.note : ""} (${mss(m.start)}${m.end > m.start + 0.05 ? "–" + mss(m.end) : ""})${m.source === "ai" ? " · from your AI" : ""}`;
const readFlag = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } };
const writeFlag = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch {} };

// The font a built-in graphic draws with, as @font-face rules with the files inside (its frame has no network): the
// bundled files of the family, at the weights it uses. Kept for the session.
const fontData = {};
const b64 = (buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
function graphicFontCss(family, weights) {
  const files = fontFilesOf(family); if (!files.length) return Promise.resolve("");
  const pick = Array.from(new Set(weights.map((w) => files.reduce((b, x) => (Math.abs(x.weight - w) < Math.abs(b.weight - w) ? x : b), files[0]))));
  return Promise.all(pick.map((f) => (fontData[f.file] ??= fetch("/fonts/" + f.file).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => (buf ? `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${b64(buf)}) format("truetype");font-weight:${f.weight};font-display:block}` : "")).catch(() => "")))).then((r) => r.join(""));
}
// A built-in graphic (a template, or one from the library) drawn live with the recorder's own HTML and clock, at the
// size the render draws it, with the font files the recorder's browser has.
function TemplateFrame({ graphicId, params, start, end, t, aspect }) {
  const out = outputSize(aspect, "preview"); const { width: w, height: h } = templateSize(out.width, out.height);
  // Phase 7: drawn over the clip's whole length, as the render records it (no longer stopped at 15 s).
  const dur = Math.max(0.5, end - start);
  const family = typeof params?.font === "string" ? params.font : "Inter", weight = Number(params?.weight) || 800;
  const [fontCss, setFontCss] = useState("");
  useEffect(() => { let live = true; graphicFontCss(family, [weight, 400, 500, 600, 700]).then((c) => live && setFontCss(c)); return () => { live = false; }; }, [family, weight]);
  const doc = useMemo(() => playerGraphicHtml(graphicId, params || {}, w, h, dur, fontCss), [graphicId, JSON.stringify(params || {}), w, h, dur, fontCss]);
  const box = useRef(null); const fr = useRef(null); const [k, setK] = useState(0);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setK(el.clientWidth / w)); ro.observe(el); setK(el.clientWidth / w); return () => ro.disconnect(); }, [w]);
  const post = () => fr.current?.contentWindow?.postMessage({ rendrrT: t }, "*");
  useEffect(post, [t, doc]);
  return html`<div ref=${box} style="position:absolute;inset:0;overflow:hidden;pointer-events:none"><iframe ref=${fr} title="graphic" sandbox="allow-scripts" srcDoc=${doc} onLoad=${post} style=${{ width: w, height: h, border: 0, background: "transparent", colorScheme: "light", transform: `scale(${k})`, transformOrigin: "0 0" }} /></div>`;
}

// What the render lays over the footage at this moment: b-roll, then graphics, then text layers and captions.
function LiveOverlays({ frame, clips, media, aspect, playing, plan, luts }) {
  if (!frame) return null;
  const b = frame.broll && media.broll[frame.broll.videoId];
  // Keyframed overlays move as the render's perspective filter moves them (Phase 5).
  const moved = (m, child) => (m ? html`<div style=${{ position: "absolute", inset: 0, pointerEvents: "none", ...motionCss(m) }}>${child}</div>` : child);
  return html`${b && moved(frame.broll.motion, html`<${SyncedVideo} key=${frame.broll.clipId} src=${b.url} time=${frame.broll.src} playing=${playing} look=${plan?.looks?.[frame.broll.clipId]} plan=${plan} luts=${luts} />`)}
    ${frame.graphics.map((g) => { const m = media.graphicClips[g.clipId]; const c = clips.find((x) => x.id === g.clipId);
      return moved(g.motion, m ? html`<${SyncedVideo} key=${g.clipId} src=${m.url} time=${g.t} playing=${playing} fit="contain" />` : html`<${TemplateFrame} key=${g.clipId} graphicId=${g.graphicId} params=${c?.params} start=${g.start} end=${g.end} t=${g.t} aspect=${aspect} />`); })}
    ${plan && html`<${TextLayers} plan=${plan} frame=${frame} />`}`;
}

// Text layers and captions (Phase 4), drawn from the same layout the render draws with libass: a stage the size of the
// output (plan.width x plan.height pixels) scaled to the player, the same font files, the lines the plan broke.
let fontsLoaded = false;
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
function fontCss(d) {
  return { fontFamily: `"${d.face.family}", sans-serif`, fontSize: cssSize(d.face, d.size) + "px", lineHeight: d.size + "px", fontWeight: 400, color: d.color, whiteSpace: "pre",
    ...(d.stroke ? { WebkitTextStroke: `${2 * d.stroke.px}px ${d.stroke.color}`, paintOrder: "stroke fill" } : {}),
    ...(d.shadow && !d.box ? { textShadow: `${d.shadow.x}px ${d.shadow.y}px 0 ${rgba(d.shadow.color, d.shadow.opacity)}` } : {}) };
}
const boxCss = (d) => (d.box ? { background: rgba(d.box.color, d.box.opacity), padding: `0 ${d.box.pad}px`, boxShadow: `0 ${-d.box.pad}px 0 ${rgba(d.box.color, d.box.opacity)}, 0 ${d.box.pad}px 0 ${rgba(d.box.color, d.box.opacity)}${d.shadow ? `, ${d.shadow.x}px ${d.shadow.y + d.box.pad}px 0 ${rgba(d.shadow.color, d.shadow.opacity)}` : ""}`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } : {});
function TextLayers({ plan, frame }) {
  const ref = useRef(); const [k, setK] = useState(0);
  useEffect(() => { if (fontsLoaded) return; fontsLoaded = true; const st = document.createElement("style"); st.id = "rc-fonts"; st.textContent = fontFaceCss("/fonts/"); document.head.appendChild(st); }, []);
  useEffect(() => { const el = ref.current; if (!el) return; const f = () => setK(el.clientWidth / plan.width); f(); const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect(); }, [plan.width]);
  const W = plan.width, H = plan.height;
  const cs = plan.captionStyle, cd = cs && drawnOf(cs, W, H);
  return html`<div ref=${ref} class="tlayers" data-k=${k} data-captions=${plan.styledCaptions?.length ?? 0} data-texts=${plan.texts?.length ?? 0}><div class="stage" style=${{ width: W + "px", height: H + "px", transform: `scale(${k})` }}>
    ${frame.texts.map(({ layer: l, opacity, scale, dy, look }) => { const d = drawnOf(l.style, W, H); const ax = l.style.align === "left" ? 0 : l.style.align === "right" ? 100 : 50;
      // A keyframed layer (Phase 5): its anchor, scale, turn and opacity from textLookAt, as the ASS pieces draw it.
      const pos = look ? { left: look.x + "px", top: look.y + "px", transform: `translate(${-ax}%, -50%) rotate(${look.rotation}deg) scale(${look.scale})`, opacity: look.opacity } : { left: l.style.x * W + "px", top: l.style.y * H + dy + "px", transform: `translate(${-ax}%, -50%) scale(${scale})`, opacity };
      return html`<div key=${l.clipId} data-text=${l.clipId}>
        ${l.card && html`<div class="tcard" style=${{ background: rgba(l.card.color, l.card.opacity), opacity }} />`}
        <div class="tblock" style=${{ ...pos, transformOrigin: `${ax}% 50%`, textAlign: l.style.align }}>
          ${l.lines.map((line, i) => html`<div key=${i}><span style=${{ ...fontCss(d), ...boxCss(d) }}>${l.style.case === "upper" ? line.toUpperCase() : l.style.case === "lower" ? line.toLowerCase() : line}</span></div>`)}
        </div></div>`; })}
    ${frame.captionLines && cd && html`<div class="tblock cap-layer" id="caption-layer" style=${{ left: cs.x * W + "px", top: cs.y * H + "px", transform: "translate(-50%, -100%)", textAlign: "center" }}>
      ${frame.captionLines.map((line, i) => html`<div key=${i}><span style=${{ ...fontCss(cd), ...boxCss(cd) }}>${line.map((w, j) => html`${j ? " " : ""}<span key=${j} data-active=${w.active ? "1" : null} style=${w.active ? { color: cs.highlight } : null}>${w.text}</span>`)}</span></div>`)}
    </div>`}
  </div></div>`;
}

// Style controls shared by the caption style and a text layer: font, weight, size, colour, box, stroke, shadow,
// position, case (and for captions the active word and the word counts; for text the alignment, animation, card).
function StyleControls({ kind, style, card, anim, opFor, doOp, H, liveOp, idp }) {
  const sl = { H, liveOp };
  const set = (patch) => doOp(opFor(patch), false);
  const ws = FONT_WEIGHTS[style.font] || [400];
  const toggle = (on, def, key) => html`<input type="checkbox" checked=${on} id=${idp + "-" + key} onChange=${(e) => set({ [key]: e.target.checked ? def : null })} />`;
  return html`<div class="col" style="gap:8px">
    <div class="row" style="gap:8px">
      <label class="t-small grow" style="display:grid;gap:4px">Font<select class="input sm" id=${idp + "-font"} value=${style.font} onChange=${(e) => { const f = e.target.value; const fw = FONT_WEIGHTS[f] || [400]; set({ font: f, weight: fw.reduce((b, x) => (Math.abs(x - style.weight) < Math.abs(b - style.weight) ? x : b), fw[0]) }); }}>${CAPTION_FONTS.map((f) => html`<option key=${f} value=${f}>${f}</option>`)}</select></label>
      <label class="t-small" style="display:grid;gap:4px">Weight<select class="input sm" id=${idp + "-weight"} value=${String(style.weight)} onChange=${(e) => set({ weight: +e.target.value })}>${ws.map((w) => html`<option key=${w} value=${String(w)}>${w}</option>`)}</select></label>
      <label class="t-small" style="display:grid;gap:4px">Colour<${OpColor} id=${idp + "-color"} value=${style.color} opFor=${(c) => opFor({ color: c })} ...${sl} /></label>
    </div>
    <${OpSlider} id=${idp + "-size"} label="Size" value=${style.size} min=${2} max=${kind === "text" ? 20 : 14} step=${0.1} show=${(x) => x + "% of the frame"} opFor=${(x) => opFor({ size: x })} ...${sl} />
    <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id=${idp + "-x"} label="Across" value=${style.x} min=${0} max=${1} step=${0.01} show=${(x) => Math.round(x * 100) + "%"} opFor=${(x) => opFor({ x })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-y"} label="Down" value=${style.y} min=${0} max=${1} step=${0.01} show=${(x) => Math.round(x * 100) + "%"} opFor=${(y) => opFor({ y })} ...${sl} /></div></div>
    <div class="row wrap" style="gap:12px">
      <label class="t-small row" style="gap:6px">${toggle(!!style.box, { color: "#000000", opacity: 0.6, padding: 25 }, "box")}Box</label>
      ${!style.box && html`<label class="t-small row" style="gap:6px">${toggle(!!style.stroke, { color: "#000000", width: 8 }, "stroke")}Stroke</label>`}
      <label class="t-small row" style="gap:6px">${toggle(!!style.shadow, { color: "#000000", opacity: 0.6, x: 0, y: 6 }, "shadow")}Shadow</label>
      <label class="t-small row" style="gap:6px">Case<select class="input sm" id=${idp + "-case"} value=${style.case} onChange=${(e) => set({ case: e.target.value })}>${["none", "upper", "lower"].map((c) => html`<option key=${c} value=${c}>${c === "none" ? "As typed" : c === "upper" ? "UPPER" : "lower"}</option>`)}</select></label>
    </div>
    ${style.box && html`<div class="row" style="gap:12px;align-items:flex-end"><${OpColor} id=${idp + "-box-color"} value=${style.box.color} opFor=${(c) => opFor({ box: { ...style.box, color: c } })} ...${sl} />
      <div class="grow"><${OpSlider} id=${idp + "-box-opacity"} label="Box opacity" value=${style.box.opacity} min=${0} max=${1} step=${0.05} show=${(x) => Math.round(x * 100) + "%"} opFor=${(x) => opFor({ box: { ...style.box, opacity: x } })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-box-padding"} label="Padding" value=${style.box.padding} min=${0} max=${80} step=${1} show=${(x) => x + "%"} opFor=${(x) => opFor({ box: { ...style.box, padding: x } })} ...${sl} /></div></div>`}
    ${!style.box && style.stroke && html`<div class="row" style="gap:12px;align-items:flex-end"><${OpColor} id=${idp + "-stroke-color"} value=${style.stroke.color} opFor=${(c) => opFor({ stroke: { ...style.stroke, color: c } })} ...${sl} />
      <div class="grow"><${OpSlider} id=${idp + "-stroke-width"} label="Stroke" value=${style.stroke.width} min=${0} max=${30} step=${0.5} show=${(x) => x + "%"} opFor=${(x) => opFor({ stroke: { ...style.stroke, width: x } })} ...${sl} /></div></div>`}
    ${style.shadow && html`<div class="row" style="gap:12px;align-items:flex-end"><${OpColor} id=${idp + "-shadow-color"} value=${style.shadow.color} opFor=${(c) => opFor({ shadow: { ...style.shadow, color: c } })} ...${sl} />
      <div class="grow"><${OpSlider} id=${idp + "-shadow-y"} label="Shadow distance" value=${style.shadow.y} min=${-30} max=${30} step=${1} show=${(x) => x + "%"} opFor=${(x) => opFor({ shadow: { ...style.shadow, y: x } })} ...${sl} /></div></div>`}
    ${kind === "caption" && html`<div class="col" style="gap:8px">
      <div class="row" style="gap:8px;align-items:center"><label class="t-small row" style="gap:6px">${toggle(!!style.highlight, "#FFD400", "highlight")}Colour the spoken word</label>${style.highlight && html`<${OpColor} id=${idp + "-highlight-color"} value=${style.highlight} opFor=${(c) => opFor({ highlight: c })} ...${sl} />`}</div>
      <${OpSlider} id=${idp + "-words"} label="Words at once" value=${style.wordsAtOnce} min=${1} max=${12} step=${1} show=${(x) => String(x)} opFor=${(x) => opFor({ wordsAtOnce: x })} ...${sl} />
        <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id=${idp + "-perline"} label="Words a line" value=${style.wordsPerLine} min=${1} max=${12} step=${1} show=${(x) => String(x)} opFor=${(x) => opFor({ wordsPerLine: x })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id=${idp + "-lines"} label="Lines" value=${style.lines} min=${1} max=${3} step=${1} show=${(x) => String(x)} opFor=${(x) => opFor({ lines: x })} ...${sl} /></div></div></div>`}
    ${kind === "text" && html`<div class="row wrap" style="gap:12px;align-items:center">
      <label class="t-small row" style="gap:6px">Align<select class="input sm" id=${idp + "-align"} value=${style.align} onChange=${(e) => set({ align: e.target.value })}>${["left", "center", "right"].map((a) => html`<option key=${a} value=${a}>${a}</option>`)}</select></label>
      <label class="t-small row" style="gap:6px">Animation<select class="input sm" id=${idp + "-anim"} value=${anim} onChange=${(e) => set({ anim: e.target.value })}>${TEXT_ANIMS.map((a) => html`<option key=${a} value=${a}>${a}</option>`)}</select></label>
      <label class="t-small row" style="gap:6px"><input type="checkbox" id=${idp + "-card"} checked=${!!card} onChange=${(e) => set({ card: e.target.checked ? { color: "#0A0A0C", opacity: 1 } : null })} />Card behind</label>
      ${card && html`<${OpColor} id=${idp + "-card-color"} value=${card.color} opFor=${(c) => opFor({ card: { ...card, color: c } })} ...${sl} />`}</div>`}
  </div>`;
}

// The Text tab: the caption style and the text layers (title cards, callouts).
function TextTab({ timeline, aspect, captionRules, textClips, selText, onSelect, at, dur, doOp, H, liveOp }) {
  const style = captionStyleOf(timeline, aspect, captionRules);
  const cap = (patch) => ({ op: "set_caption_style", ...patch });
  const [draft, setDraft] = useState(selText?.text || "");
  useEffect(() => { setDraft(selText?.text || ""); }, [selText?.id]);
  const txt = (patch) => ({ op: "set_text", clipId: selText.id, ...patch });
  return html`<div class="pb" id="text-panel" style="padding-top:16px"><div class="col" style="gap:16px">
    <div class="col" style="gap:10px">
      <div class="row between"><b class="t-label">Captions</b><label class="t-small row" style="gap:6px"><input type="checkbox" id="captions-on" checked=${timeline.captionsOn} onChange=${(e) => doOp({ op: "set_captions", on: e.target.checked })} />On</label></div>
      <label class="t-small" style="display:grid;gap:4px">Start from<select class="input sm" id="caption-look" value=${timeline.captionStyle ? "own" : timeline.captionLook} onChange=${(e) => e.target.value !== "own" && doOp({ op: "set_captions", on: timeline.captionsOn, look: e.target.value })}>${timeline.captionStyle && html`<option value="own">Own style</option>`}${["clean", "bold", "outline"].map((l) => html`<option key=${l} value=${l}>${l[0].toUpperCase() + l.slice(1)} look</option>`)}</select></label>
      <${StyleControls} kind="caption" idp="cap" style=${style} opFor=${cap} doOp=${doOp} H=${H} liveOp=${liveOp} />
    </div>
    <div class="col" style="gap:10px" id="text-layers">
      <div class="row between" style="flex-wrap:wrap;gap:4px 8px"><b class="t-label">Text layers</b><span class="row" style="gap:4px;flex-wrap:wrap">${TEXT_PRESETS.map((p) => html`<${Btn} key=${p} kind="ghost" size="xs" id=${"add-text-" + p} onClick=${() => { const had = new Set(textClips.map((c) => c.id)); const r = doOp({ op: "add_text", text: p === "title" ? "Your title" : p === "callout" ? "Look here" : p === "lower-third" ? "Name, role" : "Text", start: Math.max(0, Math.min(at, dur - 0.5)), end: Math.min(dur, at + 3), edit: true, preset: p }); const made = r && r.state.tracks.v3.find((c) => c.kind === "text" && !had.has(c.id)); if (made) onSelect(made.id); }}>+ ${p}<//>`)}</span></div>
      ${textClips.length === 0 ? html`<p class="t-small muted">No text layers. Add one at the playhead, or select a text clip on V3.</p>`
        : html`<div class="col" style="gap:4px">${textClips.map((c) => html`<button key=${c.id} class=${"tlist" + (selText?.id === c.id ? " on" : "")} data-text-clip=${c.id} onClick=${() => onSelect(c.id)}><span class="mono t-small muted">${fmtTime(c.start)}</span> ${c.text.split("\n")[0]}</button>`)}</div>`}
      ${selText && html`<div class="col card flat" style="gap:8px;padding:12px" id="text-edit">
        <textarea class="input" id="text-content" rows="2" value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => draft.trim() && draft !== selText.text && doOp(txt({ text: draft }), false)} />
        <div class="row" style="gap:4px">${TEXT_PRESETS.map((p) => html`<${Btn} key=${p} kind="ghost" size="xs" onClick=${() => doOp(txt({ preset: p }), false)}>${p}<//>`)}</div>
        <${StyleControls} kind="text" idp="txt" style=${selText.style || textPreset("plain").style} card=${selText.card} anim=${selText.anim || "fade"} opFor=${txt} doOp=${doOp} H=${H} liveOp=${liveOp} />
        <${Btn} kind="ghost" size="xs" icon="trash" onClick=${() => doOp({ op: "delete_clip", track: "v3", clipId: selText.id })}>Remove this text<//>
      </div>`}
    </div>
    <p class="t-small muted" id="text-note">Captions and text are drawn here exactly as the render lays them out: same fonts, same lines, same sizes.</p>
  </div></div>`;
}

// The sequence's picture and sound, from the render plan: one <video> per video on V1 (the one playing shows, turned
// and framed like its clip) and one sound element per video for J/L cuts (when the sound is another clip's). They
// follow the edit time: a cut or a drift over 0.15 s seeks again. While the picture that should show is loading,
// the clock waits (at most 1.5 s), so picture and time stay together.
// Sound (Phase 3): the dialogue, music and sound effects play at the render's levels (audioAt: clip gains, fades,
// ducking, mix fades). An element can't go over full volume, so all of them play `head` lower when a clip is turned
// up: the balance stays exact. Cleanup and loudness are only in the rendered preview (no WebAudio: no CORS).
// Speed (Phase 5): an element plays at its part's rate (pitch kept: the browser's default). A reversed or frozen part
// cannot play in a <video>: the element stays paused on the frame the render shows (showAt), stepped frame by frame.
// Keyframes move the picture with the same table the render's perspective filter reads; transitions draw both sides
// with transitionAt, the curves the render's overlays use.
const motionCss = (m) => (m ? { transform: `translate(${m.x * 100}%, ${m.y * 100}%) rotate(${m.rotation}deg) scale(${m.scale})`, opacity: m.opacity } : {});
function follow(el, want, playing, rate = 1) {
  const drift = Math.abs(el.currentTime - want);
  if (playing && rate > 0) {
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
    if (drift > 0.15 * Math.max(1, rate)) { try { el.currentTime = want; } catch {} }
    if (el.paused) el.play().catch(() => {});
  } else { if (!el.paused) el.pause(); if (drift > (playing ? 0.02 : 0.004)) { try { el.currentTime = want; el.addEventListener("seeked", () => { repaint(el); setTimeout(() => repaint(el), 200); }, { once: true }); } catch {} } }
}
// Chromium can keep showing the old frame of a paused video after a seek (seen when the layer that covered it during a
// transition goes away in the same moment): seeks 0.1 ms on, inside the same frame, make it present the new one.
const repaint = (el) => { if (el.paused) { try { el.currentTime = el.currentTime + 0.0001; } catch {} } };
// One footage stretch as the render fits it: turned, fitted (cover, 40% down), framed, moved by its keyframes.
// Phase 6: with `gl` (the clip, or another part of this video, has a look) the picture is drawn through the look canvas
// with the render's numbers; the <video> stays as the clock, hidden. `look` null there draws it plain.
function Footage({ id, url, rotate, framing, motion, aspect, refFn, on = true, gl = false, look = null, plan = null, luts, card = null }) {
  const vEl = useRef(null); const [noGl, setNoGl] = useState(false);
  // Reframed (the framing's focus): the fit cuts around that point, which needs the video's own size.
  const [nat, setNat] = useState(null);
  const focus = framing?.focus || null, side = rotate === 90 || rotate === 270;
  const crop = focus && nat ? fitCrop(focus, side ? nat[1] : nat[0], side ? nat[0] : nat[1], ASPECT_RATIO[aspect] || 16 / 9, 1) : null;
  const sized = (el) => { if (el?.videoWidth && (!nat || nat[0] !== el.videoWidth || nat[1] !== el.videoHeight)) setNat([el.videoWidth, el.videoHeight]); };
  const drawn = gl && !!plan && !noGl;
  // A card: its shadow under it, its border over it (crop and corners are in its look's mask).
  const layer = (x) => x && plan?.lookFiles?.[x.file] && html`<${CardLayer} spec=${plan.lookFiles[x.file]} color=${x.color} W=${plan.width} H=${plan.height} />`;
  const moved = framing && (framing.scale !== 1 || framing.x || framing.y);
  return html`<div style=${{ position: "absolute", inset: 0, ...motionCss(motion) }}>${layer(card?.shadow)}<div style=${{ position: "absolute", inset: 0, transform: moved ? `translate(${framing.x * 100}%, ${framing.y * 100}%) scale(${framing.scale})` : "none" }}>
    <video ref=${(el) => { vEl.current = el; refFn?.(el); if (focus) sized(el); }} onLoadedMetadata=${(e) => focus && sized(e.currentTarget)} data-on=${on ? "1" : "0"} data-video=${id} src=${url} crossOrigin="anonymous" muted playsInline preload="auto" style=${{ objectFit: "cover", background: drawn ? "transparent" : "#000", ...fitVideoStyle(rotate || 0, aspect, crop), ...(drawn ? { opacity: 0 } : {}) }} />
    ${drawn && html`<${LookCanvas} videoRef=${vEl} look=${look} W=${plan.width} H=${plan.height} rotate=${rotate || 0} fitY=${0.4} focus=${focus} luts=${luts} onFail=${() => setNoGl(true)} />`}
  </div>${layer(card?.border)}</div>`;
}
function SeqMedia({ plan, clock, time, playing, urls, sounds = {}, aspect, pb, broll = {}, luts }) {
  const pic = clock.picture(time), snd = clock.soundAt(time);
  const part = pic ? plan.parts[pic.i] : null;
  const fr = useMemo(() => liveFrame(plan, time, clock), [plan, time, clock]);
  const tr = fr.transition;
  const vref = useRef({}), aref = useRef({}), mref = useRef({}), tref = useRef({}), hold = useRef(0), box = useRef(null);
  const [k, setK] = useState(1);
  useEffect(() => { const el = box.current; if (!el) return; const f = () => setK(el.clientWidth / plan.width); f(); const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect(); }, [plan.width]);
  const head = useMemo(() => Math.max(1, ...(plan.audioMix?.dialogue || []).map((d) => dbToLin(d.gainDb)), ...plan.audio.map((a) => dbToLin(a.gainDb))), [plan]);
  // Sound that is not its picture's own (J/L cuts): its elements load ahead.
  const jl = useMemo(() => plan.sound.some((s) => { const p = plan.parts.find((x) => s.start >= x.start - 1e-3 && s.start < x.end); return !p || p.videoId !== s.videoId || Math.abs((p.srcIn - p.start) - (s.srcIn - s.start)) > 0.02; }), [plan]);
  // Transitions with both sides drawn, near the playhead: their elements wait on their first frame.
  const near = useMemo(() => (plan.transitions || []).filter((x) => x.a.length && x.end > x.start && time > x.start - 3 && time < x.end + 0.5), [plan, Math.floor(time * 2)]);
  useEffect(() => {
    pb.attachGate?.(() => {
      const el = part && vref.current[part.videoId];
      if (!el || !urls[part.videoId]) return true;
      if (el.readyState >= 3 && !el.seeking) { hold.current = 0; return true; }
      hold.current ||= performance.now();
      return performance.now() - hold.current > 1500;
    });
  });
  useEffect(() => () => pb.attachGate?.(null), []);
  useEffect(() => {
    // The picture's own element plays the sound when the sound is its own footage, else a sound element does.
    const own = !!(snd && part && snd.videoId === part.videoId && Math.abs(snd.src - pic.src) < 0.08);
    const lv = audioAt(plan, time); const vol = (g) => Math.min(1, Math.max(0, g / head));
    for (const [id, el] of Object.entries(vref.current)) {
      const on = part?.videoId === id;
      el.muted = !(on && own && !snd.muted); el.volume = vol(lv.dialogue);
      // At normal speed it plays the sound's own moment (cut to the millisecond); its frame is the one the render shows.
      if (on) follow(el, own && pic.rate === 1 ? snd.src : pic.src, playing, pic.rate); else if (!el.paused) el.pause();
    }
    for (const [id, el] of Object.entries(aref.current)) {
      el.volume = vol(lv.dialogue);
      if (snd && !own && !snd.muted && snd.videoId === id) follow(el, snd.src, playing, snd.rate); else if (!el.paused) el.pause();
    }
    // Transition sides: on while the window plays, else parked on the frame they start with.
    for (const x of near) for (const s of ["a", "b"]) {
      const el = tref.current[x.clipId + s]; if (!el) continue;
      const segs = x[s], seg = tr && tr.op === x ? null : segs[0];
      if (tr && tr.op === x) { const now = tr[s]; follow(el, now.src, playing, now.rate); }
      else follow(el, showAt(seg, x.start), false);
    }
    // Music loops (as in the render); a sound effect plays once.
    const now = new Map([...lv.music, ...lv.sfx].map((x) => [x.clipId, x]));
    for (const [id, el] of Object.entries(mref.current)) {
      const x = now.get(id); const d = el.duration || 0;
      const want = x && (el.loop && d ? x.src % d : x.src);
      if (x && (el.loop || !d || want < d - 0.02)) { el.volume = vol(x.gain); follow(el, want, playing); } else if (!el.paused) el.pause();
    }
  }, [time, playing, part, plan, head, near]);
  const look = tr?.look;
  const blurId = "whip-" + (tr?.op.clipId || "x");
  // Phase 6: which videos have a look on any part (their element is drawn through the look canvas all along, so it
  // never switches mid-play), and the b-roll laid behind V1 at this moment.
  const looks = plan.looks || {};
  const glVideo = useMemo(() => new Set(plan.parts.filter((p) => looks[p.clipIds[0]]).map((p) => p.videoId)), [plan]);
  const under = (fr.under || []).filter((u) => broll[u.videoId]);
  const cards = plan.cards || {};
  return html`<div ref=${box} style="position:absolute;inset:0"><${BackLayer} plan=${plan} time=${time} playing=${playing} broll=${broll} part=${part} partUrl=${part ? urls[part.videoId] : null} aspect=${aspect} k=${k} />${under.map((u) => html`<div key=${"u" + u.clipId} data-under=${u.clipId} style=${{ position: "absolute", inset: 0, pointerEvents: "none", ...motionCss(u.motion) }}><${SyncedVideo} src=${broll[u.videoId].url} time=${u.src} playing=${playing} look=${looks[u.clipId]} plan=${plan} luts=${luts} /></div>`)}
    ${plan.sources.map((id) => {
    const on = part?.videoId === id; const p = on ? part : plan.parts.find((x) => x.videoId === id);
    return html`<div key=${id} style=${{ position: "absolute", inset: 0, visibility: on ? "visible" : "hidden" }}>
      ${urls[id] ? html`<${Footage} id=${id} url=${urls[id]} rotate=${p?.rotate} framing=${p?.framing} motion=${on ? fr.motion : null} aspect=${aspect} on=${on} gl=${glVideo.has(id)} look=${on && fr.lookId ? looks[fr.lookId] : null} plan=${plan} luts=${luts} card=${p ? cards[p.clipIds[0]] : null} refFn=${(el) => { if (el) vref.current[id] = el; else delete vref.current[id]; }} />`
        : on && html`<div style="position:absolute;inset:0;display:grid;place-items:center;background:#000;color:#999"><span class="t-small">No preview copy of this video</span></div>`}
      ${urls[id] && html`<audio ref=${(el) => { if (el) aref.current[id] = el; else delete aref.current[id]; }} data-sound=${id} src=${urls[id]} preload=${jl ? "auto" : "none"} />`}
    </div>`;
  })}
    ${near.map((x) => { const active = tr?.op === x;
      const side = (s) => { const now = active ? tr[s] : null; const seg = x[s][0]; const l = active ? look[s] : { x: 0, y: 0, opacity: 0 };
        return html`<div key=${s} data-side=${s} style=${{ position: "absolute", inset: 0, transform: `translate(${(l.x / plan.width) * 100}%, ${(l.y / plan.height) * 100}%)`, opacity: l.opacity }}>
          ${urls[seg.videoId] && html`<${Footage} id=${seg.videoId} url=${urls[seg.videoId]} rotate=${(now || seg).rotate} framing=${(now || seg).framing} motion=${now?.motion} aspect=${aspect} gl=${!!looks[(now || seg).clipId]} look=${looks[(now || seg).clipId] || null} plan=${plan} luts=${luts} card=${cards[(now || seg).clipId] || null} refFn=${(el) => { if (el) tref.current[x.clipId + s] = el; else delete tref.current[x.clipId + s]; }} />`}</div>`; };
      return html`<div key=${"tr" + x.clipId} class="tlayer" data-transition=${x.type} style=${{ position: "absolute", inset: 0, overflow: "hidden", background: under.length || plan.background ? "transparent" : "#000", visibility: active ? "visible" : "hidden", filter: active && (look.blur.x || look.blur.y) ? `url(#${blurId})` : "none" }}>${plan.background && !under.length && active ? html`<${BackLayer} plan=${plan} time=${time} playing=${playing} broll=${broll} part=${part} partUrl=${part ? urls[part.videoId] : null} aspect=${aspect} k=${k} />` : null}${side("a")}${side("b")}</div>`; })}
    ${look?.color && html`<div class="tdip" style=${{ position: "absolute", inset: 0, background: look.color.hex, opacity: look.color.opacity }} />`}
    ${look && (look.blur.x || look.blur.y) ? html`<svg width="0" height="0" style="position:absolute"><filter id=${blurId} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation=${`${look.blur.x * k} ${look.blur.y * k}`} /></filter></svg>` : null}
  </div>${plan.audio.map((a) => sounds[a.assetKey] && html`<audio key=${a.clipId} ref=${(el) => { if (el) mref.current[a.clipId] = el; else delete mref.current[a.clipId]; }} data-music=${a.clipId} data-kind=${a.kind} src=${sounds[a.assetKey]} loop=${a.kind === "music"} preload="auto" />`)}`;
}

// The Clip tab (Phase 5): the selected clip's speed, the transition on the cut before it (V1) and its keyframes at the
// playhead (V1, b-roll, text, graphics). Every control sends the connector's own op: set_speed, freeze_frame,
// set_transition, set_keyframes.
const KEY_UI = [["x", "Across", -1, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["y", "Down", -1, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["scale", "Scale", 0.1, 3, 0.01, (v) => Math.round(v * 100) + "%"], ["rotation", "Rotation", -180, 180, 1, (v) => Math.round(v) + "°"], ["opacity", "Opacity", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"]];
const EASE_NAME = { linear: "Linear", in: "Ease in", out: "Ease out", "in-out": "Ease in and out" };
function ClipTab({ clip, track, plan, first, at, srcAt, doOp, H, liveOp, onSeek }) {
  const [rampSpeed, setRampSpeed] = useState(2);
  const empty = html`<div class="pb" id="clip-panel" style="padding-top:16px"><p class="t-small muted">Select a clip: a V1 clip for its speed and the transition into it; any clip on V1, a b-roll clip, a text or a graphic for keyframes.</p></div>`;
  if (!clip) return empty;
  const v1 = track === "v1" || track === "a1";
  const keyable = v1 || (track === "v2" && clip.kind === "broll") || (track === "v3" && (clip.kind === "text" || clip.kind === "graphic"));
  if (!v1 && !keyable) return empty;
  const len = Math.max(0, clip.end - clip.start), local = r2(clamp(at - clip.start, 0, len));
  const keys = (v1 ? plan?.clipMotion?.[clip.id]?.keys : clip.keys) || [];
  const now = motionAt(keyTracks(keys), local);
  const here = keys.find((k) => Math.abs(k.t - local) < 0.02);
  const withKey = (patch) => [...keys.filter((k) => k !== here), { ...(here || { t: local }), ...patch }].sort((a, b) => a.t - b.t);
  const kop = (next) => ({ op: "set_keyframes", track: v1 ? "v1" : track, clipId: clip.id, keys: next });
  const sp = (patch) => ({ op: "set_speed", clipId: clip.id, ...patch });
  const tr = clip.transition, planned = plan?.transitions?.find((x) => x.clipId === clip.id);
  const trOp = (patch) => ({ op: "set_transition", clipId: clip.id, type: tr?.type || "dissolve", duration: tr?.duration, ...(tr?.dir ? { dir: tr.dir } : {}), ...patch });
  const sl = { H, liveOp };
  return html`<div class="pb" id="clip-panel" style="padding-top:16px"><div class="col" style="gap:16px">
    <div class="t-small muted" id="clip-name">${clip.label || clip.id} · ${len.toFixed(2)}s in the edit${v1 ? " · " + speedText(clip) : ""}</div>
    ${v1 && html`<div class="col" style="gap:10px" id="speed-panel">
      <b class="t-label">Speed</b>
      ${clip.freeze ? html`<${OpSlider} id="freeze-len" label="Freeze length" value=${clip.freeze} min=${0.1} max=${10} step=${0.1} show=${(v) => v + " s"} opFor=${(x) => sp({ freeze: x })} ...${sl} />`
        : html`<${OpSlider} id="clip-speed" label="Speed" value=${clip.speed || 1} min=${0.1} max=${4} step=${0.05} show=${(v) => v + "x"} opFor=${(x) => sp({ speed: x })} disabled=${!!clip.ramp?.length} ...${sl} />
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="t-small row" style="gap:6px"><input type="checkbox" id="clip-reverse" checked=${!!clip.reverse} onChange=${(e) => doOp(sp({ reverse: e.target.checked }))} />Reverse</label>
          ${(clip.speed && clip.speed !== 1) || clip.reverse || clip.ramp?.length ? html`<${Btn} kind="ghost" size="xs" id="speed-normal" onClick=${() => doOp(sp({ speed: 1, reverse: false, ramp: null }))}>Normal speed<//>` : null}
          <${Btn} kind="ghost" size="xs" id="freeze-here" icon="pause" onClick=${() => doOp({ op: "freeze_frame", clipId: clip.id, at: r2(at), edit: true, length: 1 })}>Freeze this frame (1 s)<//>
        </div>
        <div class="col" style="gap:6px" id="ramp">
          <span class="t-small">Speed ramp${clip.ramp?.length ? ": " + clip.ramp.map((p) => p.speed + "x").join(" → ") : ""}</span>
          <div class="row" style="gap:6px;align-items:center"><input class="input sm" id="ramp-speed" type="number" min="0.1" max="10" step="0.1" value=${rampSpeed} onInput=${(e) => setRampSpeed(+e.target.value || 1)} style="width:72px" />
            <${Btn} kind="ghost" size="xs" id="ramp-add" onClick=${() => { const src = r2(srcAt(clip.id, at)); const pts = clip.ramp?.length ? clip.ramp.filter((p) => Math.abs(p.at - src) > 0.01) : [{ at: clip.sourceIn, speed: clip.speed || 1 }]; doOp(sp({ ramp: [...pts, { at: src, speed: rampSpeed }].sort((a, b) => a.at - b.at) })); }}>Ramp to this speed here<//>
            ${clip.ramp?.length ? html`<${Btn} kind="ghost" size="xs" id="ramp-off" onClick=${() => doOp(sp({ ramp: null }))}>No ramp<//>` : null}</div>
        </div>`}
      <p class="t-small muted">Sound keeps its pitch from 0.5x to 4x. Reversed, frozen and outside that range the clip is silent, here and in the render.</p>
    </div>`}
    ${v1 && html`<div class="col" style="gap:10px" id="transition-panel">
      <b class="t-label">Transition into this clip</b>
      ${first ? html`<p class="t-small muted">The first clip: a dissolve or a dip fades it in from the colour.</p>` : null}
      <label class="t-small" style="display:grid;gap:4px">Type<select class="input sm" id="transition-type" value=${tr?.type || "cut"} onChange=${(e) => doOp(trOp({ type: e.target.value }))}>${TRANSITIONS.map((t) => html`<option key=${t} value=${t}>${t === "cut" ? "Cut" : t === "dip-black" ? "Dip to black" : t === "dip-white" ? "Dip to white" : t[0].toUpperCase() + t.slice(1)}</option>`)}</select></label>
      ${tr && html`<${OpSlider} id="transition-duration" label="Duration" value=${tr.duration} min=${0.1} max=${2} step=${0.05} show=${(v) => v + " s"} opFor=${(x) => trOp({ duration: x })} ...${sl} />`}
      ${tr && (tr.type === "whip" || tr.type === "slide") && html`<label class="t-small" style="display:grid;gap:4px">Direction<select class="input sm" id="transition-dir" value=${tr.dir || "left"} onChange=${(e) => doOp(trOp({ dir: e.target.value }), false)}>${DIRS.map((d) => html`<option key=${d} value=${d}>${d}</option>`)}</select></label>`}
      ${planned?.note && html`<p class="t-small" id="transition-note" style="color:var(--warn, #b45309)">${planned.end > planned.start ? `Plays ${(planned.end - planned.start).toFixed(2)} s: ` : ""}${planned.note}</p>`}
    </div>`}
    ${keyable && html`<div class="col" style="gap:10px" id="keys-panel">
      <div class="row between"><b class="t-label">Keyframes</b><span class="t-small muted mono">${here ? "key at " : "at "}${local.toFixed(2)}s</span></div>
      ${KEY_UI.map(([p, label, min, max, step, show]) => html`<${OpSlider} key=${p} id=${"key-" + p} label=${label} value=${Math.round(now[p] / step) * step} min=${min} max=${max} step=${step} show=${show} opFor=${(x) => kop(withKey({ [p]: x }))} ...${sl} />`)}
      ${here && html`<label class="t-small" style="display:grid;gap:4px">Easing to the next key<select class="input sm" id="key-ease" value=${Array.isArray(here.ease) ? "linear" : here.ease || "linear"} onChange=${(e) => doOp(kop(withKey({ ease: e.target.value })), false)}>${EASES.map((x) => html`<option key=${x} value=${x}>${EASE_NAME[x]}</option>`)}</select></label>`}
      ${keys.length ? html`<div class="col" style="gap:4px" id="key-list">${keys.map((k, i) => html`<div key=${i} class="row between tlist${here === k ? " on" : ""}"><button class="t-small" style="all:unset;cursor:pointer" data-key=${i} onClick=${() => onSeek(clip.start + k.t)}><span class="mono">${k.t.toFixed(2)}s</span> ${KEY_PROPS.filter((p) => k[p] != null).join(", ")}${k.ease && k.ease !== "linear" ? ` · ${Array.isArray(k.ease) ? "bezier" : k.ease}` : ""}</button><button class="btn icon sm quiet" aria-label="Remove this key" onClick=${() => doOp(kop(keys.filter((x) => x !== k)), false)}><${Icon} name="x" size="12" /></button></div>`)}
        <${Btn} kind="ghost" size="xs" id="keys-clear" onClick=${() => doOp(kop([]))}>Remove all keyframes<//></div>` : html`<p class="t-small muted">Move a slider to set a key at the playhead. Keys are seconds into the clip; between two keys the value moves with the first key's easing.</p>`}
    </div>`}
  </div></div>`;
}


// The cleanup values the Audio tab can set by hand: key, label, range, step, unit.
const FINE = [["highpass", "Rumble cut (high-pass)", 0, 300, 10, " Hz"], ["denoise", "Noise reduction", 0, 40, 1, " dB"], ["presence", "Presence", -8, 8, 0.5, " dB"], ["deess", "De-esser", 0, 1, 0.05, ""], ["compress", "Compression", 1, 10, 0.5, ":1"]];
const CLEANUP_NAME = Object.fromEntries(VOICE_PRESETS.map((v) => [v.id, v.name]));
const LOUDNESS = [[-14, "-14 LUFS (online)"], [-16, "-16 LUFS (podcast)"], [-23, "-23 LUFS (broadcast)"]];
const dB = (x) => (x > 0 ? "+" : "") + (Math.round(x * 10) / 10) + " dB";
// The Audio tab: the whole edit's sound (set_audio) and the selected clip's level and fades (set_clip_audio).
function AudioTab({ a, clip, track, len, planned, doOp, H, liveOp, voice }) {
  const loud = a.loudness == null ? "off" : String(a.loudness);
  const loudOpts = LOUDNESS.some(([v]) => v === a.loudness) || a.loudness == null ? LOUDNESS : [...LOUDNESS, [a.loudness, a.loudness + " LUFS"]];
  const v1 = track === "v1" || track === "a1";
  const gain = clip ? (v1 ? clip.audioGain ?? 0 : clip.gainDb ?? (track === "a2" ? -18 : -6)) : 0;
  // A music fade the clip does not set is automatic: show what renders (the plan's), marked "auto".
  const fi = clip ? (v1 ? clip.audioFadeIn : clip.fadeIn ?? planned?.fadeIn) ?? 0 : 0, fo = clip ? (v1 ? clip.audioFadeOut : clip.fadeOut ?? planned?.fadeOut) ?? 0 : 0;
  const autoIn = !!clip && !v1 && clip.fadeIn == null && !!planned?.fadeIn, autoOut = !!clip && !v1 && clip.fadeOut == null && !!planned?.fadeOut;
  const fadeMax = Math.max(0.1, Math.min(10, Math.floor(len * 10) / 10));
  const clipOp = (k) => (x) => ({ op: "set_clip_audio", track: v1 ? "v1" : track, clipId: clip.id, [k]: x });
  const sl = { H, liveOp };
  return html`<div class="pb" id="audio-panel" style="padding-top:16px"><div class="col" style="gap:16px">
    ${voice && html`<div class="card flat col" id="voice-file" style="gap:8px;padding:12px"><b class="t-label">Your voice file</b><p class="t-small muted">${voice.name ? `"${voice.name}"` : "Your audio file"} plays in place of every clip's own sound${voice.start ? ` from ${voice.start}s` : ""}. Cuts made after it was set are not in the file.</p><div class="row"><${Btn} kind="secondary" size="sm" id="voice-off" onClick=${() => doOp({ op: "set_voice", soundId: null })}>Use the clips' sound<//></div></div>`}
    <div class="col" style="gap:10px">
      <b class="t-label">Whole edit</b>
      <div class="col" style="gap:6px" id="voice-presets"><span class="t-small">Voice preset <span class="muted">(Essential Sound)</span></span>
        <div class="presets" role="radiogroup" aria-label="Voice preset">${VOICE_PRESETS.map((v) => html`<button key=${v.id} role="radio" aria-checked=${a.cleanup === v.id} class=${"preset" + (a.cleanup === v.id ? " on" : "")} data-preset=${v.id} title=${v.what} onClick=${() => doOp({ op: "set_audio", cleanup: v.id })}><b>${v.name}</b><span>${v.what}</span></button>`)}</div>
        <select class="input sm hide" id="audio-cleanup" aria-hidden="true" tabindex="-1" value=${a.cleanup} onChange=${(e) => doOp({ op: "set_audio", cleanup: e.target.value })}>${CLEANUPS.map((c) => html`<option key=${c} value=${c}>${CLEANUP_NAME[c]}</option>`)}</select></div>
      <div class="row" style="gap:8px">
        <label class="t-small grow" style="display:grid;gap:4px">Loudness<select class="input sm" id="audio-loudness" value=${loud} onChange=${(e) => doOp({ op: "set_audio", loudness: e.target.value === "off" ? null : +e.target.value })}>${loudOpts.map(([v, l]) => html`<option key=${v} value=${String(v)}>${l}</option>`)}<option value="off">Off (limiter only)</option></select></label>
        <label class="t-small grow" style="display:grid;gap:4px">True-peak ceiling<select class="input sm" id="audio-peak" value=${String(a.peak)} disabled=${a.loudness == null} onChange=${(e) => doOp({ op: "set_audio", peak: +e.target.value })}>${Array.from(new Set([-1, -1.5, -2, a.peak])).map((v) => html`<option key=${v} value=${String(v)}>${v} dBTP</option>`)}</select></label>
      </div>
      <details class="fine" id="audio-fine"><summary class="t-small">Fine-tune the cleanup${CLEANUP_KNOBS.some((k) => a[k] != null) ? " (hand-set)" : ""}</summary>
        <div class="col" style="gap:8px;padding-top:8px">
          ${FINE.map(([k, l, lo, hi, st, unit]) => html`<${OpSlider} key=${k} id=${"audio-" + k} label=${l} value=${cleanupParams(a)[k]} min=${lo} max=${hi} step=${st} show=${(x) => (x === lo && k !== "deess" ? "off" : x + unit) + (a[k] == null ? " (preset)" : "")} opFor=${(x) => ({ op: "set_audio", [k]: x })} ...${sl} />`)}
          <${OpSlider} id="audio-declick" label="Fade at every cut" value=${Math.round(a.declick * 1000)} min=${0} max=${30} step=${1} show=${(x) => (x ? x + " ms" : "off")} opFor=${(x) => ({ op: "set_audio", declick: x / 1000 })} ...${sl} />
          ${CLEANUP_KNOBS.some((k) => a[k] != null) && html`<${Btn} kind="ghost" size="xs" id="audio-fine-reset" onClick=${() => doOp({ op: "set_audio", ...Object.fromEntries(CLEANUP_KNOBS.map((k) => [k, null])) })}>Back to the preset's values<//>`}
        </div></details>
      <${OpSlider} id="audio-duck" label="Music under speech" value=${a.duck} min=${0} max=${24} step=${1} show=${(x) => (x ? x + " dB down" : "not ducked")} opFor=${(x) => ({ op: "set_audio", duck: x })} ...${sl} />
      <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id="audio-fade-in" label="Fade in" value=${a.fadeIn} min=${0} max=${5} step=${0.1} show=${(x) => x + " s"} opFor=${(x) => ({ op: "set_audio", fadeIn: x })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="audio-fade-out" label="Fade out" value=${a.fadeOut} min=${0} max=${5} step=${0.1} show=${(x) => x + " s"} opFor=${(x) => ({ op: "set_audio", fadeOut: x })} ...${sl} /></div></div>
    </div>
    <div class="col" style="gap:10px" id="audio-clip">
      <b class="t-label">${clip ? (v1 ? "Dialogue of " + (clip.label || "this clip") : clip.label || "This clip") : "Selected clip"}</b>
      ${clip ? html`<${OpSlider} id="clip-gain" label="Level" value=${gain} min=${v1 ? -24 : -40} max=${12} step=${0.5} show=${dB} opFor=${clipOp("gainDb")} ...${sl} />
        <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id="clip-fade-in" label="Fade in" value=${fi} min=${0} max=${fadeMax} step=${0.1} show=${(x) => x + " s" + (autoIn && x === fi ? " auto" : "")} opFor=${clipOp("fadeIn")} ...${sl} /></div>
          <div class="grow"><${OpSlider} id="clip-fade-out" label="Fade out" value=${fo} min=${0} max=${fadeMax} step=${0.1} show=${(x) => x + " s" + (autoOut && x === fo ? " auto" : "")} opFor=${clipOp("fadeOut")} ...${sl} /></div></div>`
        : html`<p class="t-small muted">Select a clip on V1, A1, A2 or A3 to set its level and fades.</p>`}
    </div>
    <p class="t-small muted" id="audio-note">The live player plays the balance: clip levels, fades, ducking, music and sound effects. Cleanup and loudness are heard in the rendered preview.</p>
  </div></div>`;
}

// Puts whole videos (the parts of a video filmed in parts, in order) or a part of one video into the sequence (the
// connector's add_clip).
function AddClipModal({ main, at, onAdd, onClose }) {
  const q = useAsync(() => api.listVideos(), []);
  const list = [main, ...(Array.isArray(q.data) ? q.data : []).filter((v) => v.id !== main.id && v.status === "ready" && v.kind !== "reference")];
  const [mode, setMode] = useState("whole"); const [ids, setIds] = useState([]);
  const [vid, setVid] = useState(main.id);
  const v = list.find((x) => x.id === vid) || main;
  const [from, setFrom] = useState(0); const [to, setTo] = useState(main.seconds || 5); const [where, setWhere] = useState("end");
  const ok = mode === "whole" ? ids.length > 0 : to - from >= 0.1 && from >= 0 && to <= (v.seconds || 0) + 0.05;
  const go_ = () => onAdd({ items: mode === "whole" ? ids.map((id) => { const x = list.find((y) => y.id === id); return { video: x, from: 0, to: r2(x.seconds || 0) }; }) : [{ video: v, from: r2(from), to: r2(to) }], at: where === "playhead" ? at : undefined });
  return html`<${Modal} title="Add videos" sub="Whole videos, in the order they play (a video filmed in parts), or a part of one. They go into the sequence and the edit makes room." onClose=${onClose}
    footer=${html`<${Btn} kind="ghost" onClick=${onClose}>Cancel<//><${Btn} id="add-clip-go" icon="plus" disabled=${!ok} onClick=${go_}>${mode === "whole" && ids.length > 1 ? "Add " + ids.length + " videos" : mode === "whole" ? "Add video" : "Add clip"}<//>`}>
    <div class="col" style="gap:12px" id="add-clip-form">
      <div class="row" style="gap:12px">${[["whole", "Whole videos"], ["part", "A part of a video"]].map(([k, l]) => html`<label key=${k} class="t-small row" style="gap:6px"><input type="radio" name="add-mode" data-mode=${k} checked=${mode === k} onChange=${() => setMode(k)} />${l}</label>`)}</div>
      ${mode === "whole" ? html`<${VideoOrderPicker} id="add-videos" videos=${list.map((x) => (x.id === main.id ? { ...x, name: x.name + " (this edit's footage)" } : x))} value=${ids} onChange=${setIds} />`
      : html`<label class="t-small" style="display:grid;gap:4px">Video<select class="input sm" id="add-clip-video" value=${vid} onChange=${(e) => { setVid(e.target.value); const nv = list.find((x) => x.id === e.target.value); if (nv) { setFrom(0); setTo(nv.seconds || 5); } }}>${list.map((x) => html`<option key=${x.id} value=${x.id}>${x.id === main.id ? x.name + " (this edit's footage)" : x.name} · ${fmtTime(x.seconds || 0)}</option>`)}</select></label>
      <div class="row" style="gap:8px"><label class="t-small grow" style="display:grid;gap:4px">From (s)<input class="input sm" id="add-clip-from" type="number" min="0" step="0.1" value=${from} onInput=${(e) => setFrom(+e.target.value)} /></label><label class="t-small grow" style="display:grid;gap:4px">To (s)<input class="input sm" id="add-clip-to" type="number" min="0" step="0.1" value=${to} onInput=${(e) => setTo(+e.target.value)} /></label></div>
      ${!ok && html`<p class="t-small muted" role="alert">Pick a part at least 0.1 s long inside the video (${fmtTime(v.seconds || 0)}).</p>`}`}
      <div class="row" style="gap:12px">${[["end", "At the end"], ["playhead", "At the playhead (" + fmtTime(at) + ")"]].map(([k, l]) => html`<label key=${k} class="t-small row" style="gap:6px"><input type="radio" name="add-where" data-where=${k} checked=${where === k} onChange=${() => setWhere(k)} />${l}</label>`)}</div>
    </div>
  <//>`;
}

function EditorPage({ id }) {
  const q = useAsync(() => api.getProject(id), [id]);
  const { go } = useNav();
  // When your AI changes this edit, load its new version (the editor remounts on the new version).
  useEffect(() => api.watchProject(id, (m) => { if (m && m.by !== "user") q.reload(); }), [id]);
  // The AI tab's messages live here, not in EditorInner: an AI's change remounts EditorInner on the new version.
  const [chat, setChat] = useState(null);
  const keep = useRef({ tab: "edit", time: 0 }); // the open tab and the playhead survive that remount too
  useEffect(() => { setChat(null); keep.current = { tab: "edit", time: 0 }; }, [id]);
  // A new version from the AI brings its new messages with it.
  useEffect(() => { if (q.data?.aiChat) setChat(null); }, [q.data?.version]);
  return html`<${Async} q=${q} skeleton=${html`<div style="padding:24px" class="col"><div class="skeleton sk-pill" style="width:40%" /><div class="skeleton" style="height:60vh;border-radius:20px" /></div>`}>${(p) => html`<${EditorInner} key=${p.id + ":" + p.version} project=${p} reload=${q.reload} keep=${keep} ai=${{ chat: chat || p.aiChat || [], setChat: (f) => setChat((c) => f(c || p.aiChat || [])) }} />`}<//>`;
}

function EditorInner({ project, reload, ai, keep }) {
  const { go } = useNav(); const toast = useToast(); const { refreshUsage } = useApp();
  const sq = useAsync(() => api.listStyles(), []);
  // Every word needs an end time for the plan (stored transcripts have them; the UI demo's do not).
  const transcript = useMemo(() => {
    const all = project.transcript.flatMap((l) => l.words); let i = 0;
    return project.transcript.map((l) => { const ws = l.words.map((w) => { const nx = all[++i]; return w.end != null ? w : { ...w, end: r2(Math.min(nx ? nx.t : w.t + 0.6, w.t + 0.6)) }; }); return { ...l, words: ws, end: l.end ?? (ws.length ? ws[ws.length - 1].end : l.start) }; });
  }, [project]);
  const words = useMemo(() => transcript.flatMap((l) => l.words), [transcript]);
  const footDur = project.timeline.duration;
  // The edit is a sequence. A project stored before Phase 2 is shown converted (the server stores it so at the next save).
  const tl = useMemo(() => asSequence(project.timeline, words, project.videoId, project.video?.seconds || footDur), [project, words]);
  const H = useHistory({ name: project.name, styleId: project.styleId, aspect: project.aspect, cut: tl.cut, tracks: tl.tracks, captionsOn: tl.captionsOn, captionLook: tl.captionLook, captionText: tl.captionText, captionStyle: tl.captionStyle, audio: tl.audio, export: tl.export, media: tl.media, voice: tl.voice ?? null });
  const S = H.state;
  // The edit as the server and the renderer see it, the place of every clip in it, and the render plan the live
  // player draws from. Times on the timeline and in the player are EDIT seconds.
  const initial = useRef(S).current;
  const tlOf = (s) => ({ ...tl, cut: s.cut, tracks: s.tracks, captionsOn: s.captionsOn, captionLook: s.captionLook, captionText: s.captionText, captionStyle: s.captionStyle, audio: s.audio, export: s.export, media: s.media, voice: s.voice ?? null });
  const timeline = useMemo(() => tlOf(S), [S]);
  const lay = useMemo(() => layoutTimeline(timeline, words), [timeline, words]);
  const view = useMemo(() => sequenceView(lay, words), [lay, words]);
  const main = view.mainVideoId;
  // The other videos on V1: sent with the project, plus any added here (their preview copy is fetched then).
  const [added, setAdded] = useState({});
  const others = useMemo(() => ({ ...(project.videos || {}), ...added }), [project, added]);
  // Custom graphics by clip: a placement with its own params plays its own recording (g.t includes add_graphic from).
  const media = useMemo(() => ({ broll: project.brollMedia || {}, graphicClips: project.graphicClipMedia || {}, audio: project.audioMedia || {} }), [project]);
  const urls = useMemo(() => ({ ...Object.fromEntries(Object.entries(others).map(([id, v]) => [id, v.url || null])), [main]: project.video?.proxyUrl || null }), [others, main, project]);
  const [sel, setSel] = useState(null); // {track,id}
  const [wsel, setWsel] = useState(null); // {a,b} word indexes
  const [rtab, setRtabNow] = useState(keep.current.tab); const setRtab = (t) => { keep.current.tab = t; setRtabNow(t); }; const [verMenu, setVerMenu] = useState(false);
  useEffect(() => { const k = () => setVerMenu(false); window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const [zoom, setZoom] = useState(36);
  // Engine Part 6: the waveform's peaks and the marks.
  const [peaks, setPeaks] = useState({});
  useEffect(() => {
    let live = true;
    const want = [...Object.entries(project.peaks || {}).map(([vid, url]) => ["v:" + vid, url, false]), ...Object.entries(project.audioMedia || {}).map(([k, url]) => ["a:" + k, url, true])];
    for (const [k, url, dec] of want) loadPeaks(k, url, dec).then((p) => { if (live && p) setPeaks((x) => (x[k] ? x : { ...x, [k]: p })); });
    return () => { live = false; };
  }, [project]);
  const [marks, setMarks] = useState([]); const [showMarks, setShowMarksNow] = useState(() => readFlag("rendrr.marks", true));
  const setShowMarks = (v) => { writeFlag("rendrr.marks", v); setShowMarksNow(v); };
  useEffect(() => { let live = true; api.getProjectMarks(project.id).then((m) => live && setMarks(Array.isArray(m) ? m : [])).catch(() => {}); return () => { live = false; }; }, [project.id, project.version]);
  const [tool, setTool] = useState("select"); const [snapOn, setSnapOn] = useState(true); const [addOpen, setAddOpen] = useState(false);
  const [render, setRender] = useState(null);
  const [share, setShare] = useState(false); const [help, setHelp] = useState(false); const [exportOpen, setExportOpen] = useState(false);
  const [viewVer, setViewVer] = useState(null);
  const [comments, setComments] = useState(project.comments);
  const [saved, setSaved] = useState("Saved");
  const [status, setStatus] = useState(project.status);
  const cutSet = useMemo(() => new Set(S.cut), [S.cut]);
  const style = (sq.data || []).find((s) => s.id === S.styleId) || project.style; // only a style the AI applied
  // The reference the user attached for their AI: stored with the edit, never applied to it.
  const [reference, setReference] = useState(project.reference || null);
  const attach = async (r) => {
    const before = reference; setReference(r);
    try { await api.updateProject(project.id, { reference: r ? { kind: r.kind, id: r.id } : null }); toast(r ? "Attached for your AI to read" : "Reference taken off", { icon: "check", tone: "brand" }); }
    catch (e) { setReference(before); toast(e.message); }
  };
  // The left column: the library (bin and reference picker), the bin video playing in the monitor.
  const lib = useLibrary([project.id]); const [source, setSource] = useState(null); const { openAdd } = useApp();
  const usedIds = useMemo(() => Array.from(new Set([...S.tracks.v1.map((c) => c.sourceVideoId).filter(Boolean), ...S.tracks.v2.filter((b) => b.kind === "broll" && b.videoId).map((b) => b.videoId)])).filter((x) => x !== project.videoId), [S.tracks]);
  const captionRules = useMemo(() => { const r = StyleRulesSchema.safeParse(style?.rules); return r.success ? r.data.captions : undefined; }, [style]);
  // Phase 6: the user's LUTs, and the numbers of the ones this edit's grades use (the plan needs them, as the render).
  const lutQ = useAsync(() => api.listLuts().catch(() => []), []);
  const lutIds = Array.from(new Set([...S.tracks.v1, ...S.tracks.v2].map((c) => c.grade?.lut?.id).filter(Boolean)));
  const luts = useLutData(lutIds);
  const [colorMode, setColorMode] = useState(null); const [pathDraft, setPathDraft] = useState([]);
  const plan = useMemo(() => {
    try {
      const v = project.video || {};
      return planRender({ kind: "preview", snapshot: { timeline, name: S.name, aspect: S.aspect, styleId: S.styleId }, transcript, videoId: project.videoId,
        source: { width: v.width || 1920, height: v.height || 1080, fps: v.fps || 30, seconds: v.seconds || footDur, hasAudio: true }, captionRules,
        sources: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, { width: o.width || 1920, height: o.height || 1080, fps: 30, seconds: o.seconds || 0, hasAudio: true }])),
        transcripts: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, o.transcript || []])),
        brollSeconds: Object.fromEntries(Object.entries(media.broll).map(([id, b]) => [id, b.seconds])),
        // Templates draw live; a custom graphic shows once its recorded file is there (as in the render).
        graphicsReady: Object.fromEntries(lay.tracks.v3.filter((c) => c.kind === "graphic").map((c) => [c.id, !!findTemplate(c.graphicId) || !!media.graphicClips[c.id]])), luts,
        // The user's own audio files (own music, the voice in place of the clips' sound), as the render reads them.
        sounds: project.sounds || {} });
    } catch { return null; } // everything is cut
  }, [timeline, S.aspect, captionRules, media, others, luts]);
  const clock = useMemo(() => sequenceClock(plan || { parts: [], sound: [], outputSeconds: 0 }), [plan]);
  const dur = plan ? plan.outputSeconds : 0;
  // The rendered preview plays instead when it is of this version and nothing changed since: exactly the file.
  const fresh = !!project.previewUrl && project.previewVersion === project.version && S === initial;
  const pb = usePlayback(dur, { seq: !fresh });
  useEffect(() => { if (keep.current.time > 0) pb.seek(Math.min(keep.current.time, dur)); }, []);
  useEffect(() => { keep.current.time = pb.time; }, [pb.time]);
  // "Watch preview": the rendered file plays in the same player, without the live overlays.
  const [watch, setWatch] = useState(null);
  const wpb = usePlayback(watch?.seconds || 1);

  // Autosave after each change.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setSaved("Saving…"); const t = setTimeout(() => api.updateProject(project.id, { name: S.name, styleId: S.styleId, aspect: S.aspect, timeline: tlOf(S) }).then(() => { setSaved("Saved"); }).catch((e) => { if (e.code === "stale") { toast(e.message, { icon: "spark" }); reload(); } else { setSaved("Not saved"); } }), 600); return () => clearTimeout(t); }, [S]);

  // Derived playback bits: what the render shows at this moment of the edit.
  const frame = plan && !fresh ? liveFrame(plan, pb.time, clock) : null;
  const picNow = fresh ? (clock.picture(pb.time)?.videoId === main ? clock.picture(pb.time).src : null) : frame && frame.videoId === main ? frame.src : null;
  const curWord = picNow == null ? null : words.filter((w) => w.t <= picNow).pop();
  const inEdit = (w) => !!plan && plan.parts.some((p) => p.videoId === main && w.t >= p.srcIn && w.t < p.srcOut);
  const wordAt = (w) => view.videoToEdit(main, w.t) ?? 0; // where a word first plays

  // ---- editing: every change is one of the connector's ops, run here on the editor's state ----
  const ectx = useMemo(() => ({ videoId: project.videoId, transcript, silences: project.silences || [], sceneCuts: [], duration: footDur, getStyle: () => undefined,
    getVideo: (id) => { if (others[id]) return { id, name: others[id].name, seconds: others[id].seconds || 0, ready: true }; const v = (lib.library || []).find((x) => x.id === id); return v ? { id, name: v.name, seconds: v.seconds || 0, ready: v.status === "ready" } : undefined; },
    getGraphic: (id) => { const g = findTemplate(id); return g ? { id, name: g.name, durationSec: g.durationSec } : undefined; },
    getSound: (id) => { const x = (project.sounds || {})[id]; return x ? { id, name: x.name, seconds: x.seconds, ready: true } : undefined; },
    sources: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, { transcript: o.transcript || [], silences: [] }])) }), [project, transcript, others, lib.library]);
  const snapOf = (s) => ({ timeline: tlOf(s), name: s.name, aspect: s.aspect, styleId: s.styleId });
  const opOn = (s, op) => { const r = applyOp(snapOf(s), op, ectx); const t = r.snap.timeline; return { state: { ...s, cut: t.cut, tracks: t.tracks, audio: t.audio, captionsOn: t.captionsOn, captionLook: t.captionLook, captionText: t.captionText, captionStyle: t.captionStyle, export: t.export, media: t.media, voice: t.voice ?? null, aspect: r.snap.aspect, name: r.snap.name }, summary: r.summary }; };
  const say = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const doOp = (op, tell = true) => { try { const r = opOn(H.state, op); H.commit(r.state); if (tell) toast(say(r.summary), { icon: "scissors" }); return r; } catch (e) { toast(e.message); return null; } };
  const liveOp = (base, op) => { try { H.replace(opOn(base, op).state); return true; } catch { return false; } };
  const cutWords = (ids) => { if (!ids.length) return; H.commit((s) => ({ ...s, cut: Array.from(new Set([...s.cut, ...ids])) })); toast(ids.length + (ids.length === 1 ? " word cut" : " words cut"), { icon: "scissors" }); };
  const restoreWord = (wid) => H.commit((s) => ({ ...s, cut: s.cut.filter((x) => x !== wid) }));
  const selWords = () => { if (!wsel) return []; const [a, b] = [Math.min(wsel.a, wsel.b), Math.max(wsel.a, wsel.b)]; return words.slice(a, b + 1).filter((w) => !cutSet.has(w.id)).map((w) => w.id); };
  const isV1 = (k) => k === "v1" || k === "a1"; // a V1 clip and its dialogue share an id and edit together
  // Split at the playhead: the selected clip if the playhead is in it, else the V1 clip playing.
  const split = () => {
    const t = pb.time; const inside = (c) => t > c.start + .05 && t < c.end - .05;
    let target = sel && lay.tracks[sel.track]?.find((c) => c.id === sel.id && inside(c)) ? sel : null;
    if (!target) { const c = lay.tracks.v1.find(inside); if (c) target = { track: "v1", id: c.id }; }
    if (!target) { toast("Move the playhead inside a clip to split it"); return; }
    doOp({ op: "split_clip", track: isV1(target.track) ? "v1" : target.track, clipId: target.id, at: r2(t), edit: true });
  };
  const removeSel = () => { if (!sel) return; if (doOp({ op: "delete_clip", track: sel.track, clipId: sel.id })) setSel(null); };
  const [frameOpen, setFrameOpen] = useState(false); const frameBase = useRef(null);
  const selClip = sel ? lay.tracks[sel.track]?.find((c) => c.id === sel.id) : null;
  const selV1 = sel && isV1(sel.track) ? lay.tracks.v1.find((c) => c.id === sel.id) : null;
  const isOn = (k, c) => !!sel && c.id === sel.id && (k === sel.track || (isV1(k) && isV1(sel.track)));
  // The Color tab's clip (V1 or b-roll), its shapes on the picture, and a click there: a path point or the key colour.
  const colorClip = selV1 || (sel?.track === "v2" && selClip?.kind === "broll" ? selClip : null);
  const colorShapes = colorClip ? [...(colorClip.masks || []).map((m) => ({ ...m, kind: "mask" })), ...(colorClip.effects || []).filter((e) => e.area).map((e) => ({ ...e.area, kind: "area" }))] : [];
  const onColorPoint = (pt) => {
    if (colorMode === "path") { setPathDraft((d) => [...d, pt]); return; }
    if (colorMode !== "pick" || !colorClip || !plan) return;
    const el = colorClip.sourceVideoId ? document.querySelector(`video[data-video="${colorClip.sourceVideoId}"][data-on="1"]`) : media.broll[colorClip.videoId] && document.querySelector(`video[src="${media.broll[colorClip.videoId].url}"]`);
    let c = null; try { c = el && pickColor(el, plan.width, plan.height, colorClip.rotate || 0, colorClip.sourceVideoId ? 0.4 : 0.5, pt[0], pt[1], colorClip.sourceVideoId ? colorClip.framing?.focus : null); } catch (e) { toast("Could not read the picture here: " + e.message); }
    if (c) { doOp({ op: "set_key", clipId: colorClip.id, color: c }); setColorMode(null); }
  };
  const toggleMute = () => selV1 && doOp({ op: "set_audio_offset", clipId: selV1.id, muted: !selV1.audioMuted });
  // Turn and framing: the selected V1 clip, else every clip of the footage (as the connector's ops do).
  const lookIds = selV1 ? [selV1.id] : undefined;
  // Footage Rendrr measured as filmed sideways (faces upright when turned) and not turned yet in this edit: offered,
  // never done by itself.
  const [sideDismissed, setSideDismissed] = useState(false);
  const sideways = Object.entries(project.sideways || {}).map(([vid, turn]) => ({ vid, turn, clips: S.tracks.v1.filter((c) => (c.sourceVideoId || main) === vid && (c.rotate || 0) !== turn) })).filter((x) => x.clips.length);
  const lookClip = selV1 || lay.tracks.v1.find((c) => c.sourceVideoId === main) || null;
  const rotNow = lookClip?.rotate || 0; const frNow = lookClip?.framing || { scale: 1, x: 0, y: 0 };
  // Auto reframe: the speaker's face in each clip (from the faces Rendrr measured), kept in the frame's shape.
  const [reframing, setReframing] = useState(false);
  const reframeFace = async (all = false) => {
    const ids = all ? S.tracks.v1.map((c) => c.id) : lookIds || S.tracks.v1.filter((c) => (c.sourceVideoId || main) === main).map((c) => c.id);
    const clips = S.tracks.v1.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, videoId: c.sourceVideoId || main, srcIn: c.sourceIn, srcOut: c.freeze ? c.sourceIn + 0.04 : c.sourceOut, rotate: c.rotate || 0 }));
    if (!clips.length) return;
    setReframing(true);
    try {
      const { centers } = await api.speakerCentres(project.id, clips);
      const found = Object.values(centers).filter(Boolean).length;
      if (!found) toast("No face found here yet. Rendrr measures faces when a video comes in; try again once it is ready.");
      else { doOp({ op: "set_framing", focus: "face", centers, clipIds: ids }); if (found < clips.length) toast(`Reframed ${found} of ${clips.length} clips: no face in the others.`); }
    } catch (e) { toast(e.message); } finally { setReframing(false); }
  };
  const onDelete = () => { const ids = selWords(); if (ids.length) { cutWords(ids); setWsel(null); } else if (sel) removeSel(); };
  const fit = () => setZoom(Math.max(ZMIN, Math.min(ZMAX, Math.floor(((canvasRef.current?.parentElement?.clientWidth || 900) - 40) / Math.max(1, dur)))));
  // Clips of other videos: their preview copies, so they play here at once. Several go in one after another, from the
  // playhead (or the end), as one change.
  const addClip = async ({ items, at }) => {
    setAddOpen(false);
    for (const { video } of items) {
      if (video.id === main || others[video.id]) continue;
      try { const v = await api.getVideo(video.id); setAdded((a) => ({ ...a, [video.id]: { name: v.name, seconds: v.seconds, width: v.width, height: v.height, url: v.proxyUrl || null, transcript: [] } })); }
      catch (e) { toast(e.message); return; }
    }
    // The ops need to know the videos: run them with these videos known.
    try {
      const known = Object.fromEntries(items.map(({ video }) => [video.id, video]));
      const ctx2 = { ...ectx, getVideo: (id) => (known[id] ? { id, name: known[id].name, seconds: known[id].seconds || 0, ready: true } : ectx.getVideo(id)) };
      let snap = snapOf(H.state), index; const said = [];
      for (const [k, { video, from, to }] of items.entries()) {
        const before = new Set(snap.timeline.tracks.v1.map((c) => c.id));
        const place = k > 0 ? { index } : at != null ? { at: r2(at) } : {};
        const r = applyOp(snap, { op: "add_clip", videoId: video.id === main ? undefined : video.id, from, to, ...place, label: video.id === main ? undefined : video.name }, ctx2);
        snap = r.snap; said.push(r.summary);
        index = snap.timeline.tracks.v1.findIndex((c) => !before.has(c.id)) + 1; // right after the clip just added
      }
      H.commit((s) => ({ ...s, cut: snap.timeline.cut, tracks: snap.timeline.tracks }));
      toast(items.length === 1 ? say(said[0]) : "Added " + items.length + " videos, one after another", { icon: "plus" });
    } catch (e) { toast(e.message); }
  };

  // ---- keyboard ----
  useEffect(() => {
    const k = (e) => {
      const tag = e.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
      if (render || share || addOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? H.redo() : H.undo(); return; }
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); split(); return; }
      if (mod) return;
      if (e.shiftKey && e.key.toLowerCase() === "z") { fit(); return; }
      const t = TOOLS.find(([, key]) => key.toLowerCase() === e.key.toLowerCase());
      if (t && !e.shiftKey) { setTool(t[0]); return; }
      switch (e.key) {
        case " ": e.preventDefault(); pb.toggle(); break;
        case "j": case "J": pb.seek(pb.time - 5); break; // edit time
        case "k": case "K": pb.setPlaying(false); break;
        case "l": case "L": pb.seek(pb.time + 5); break;
        case "s": case "S": setSnapOn((x) => { toast(x ? "Snapping off" : "Snapping on"); return !x; }); break;
        case "Delete": case "Backspace": e.preventDefault(); onDelete(); break;
        case "?": setHelp((h) => !h); break;
        case "Escape": setHelp(false); setWsel(null); setSel(null); break;
      }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  // ---- render flow ----
  const startRender = async (kind) => {
    pb.setPlaying(false);
    setRender({ kind, status: "running", progress: { step: 0, steps: [], percent: 0 } });
    try {
      const fn = kind === "preview" ? api.renderPreview : api.renderFinal;
      const result = await fn(project.id, (p) => setRender((r) => r && { ...r, progress: p }));
      setRender((r) => ({ ...r, status: "done", result })); setStatus(kind === "preview" ? "Preview ready" : "Final ready"); refreshUsage();
      // A new preview of this version: reload so the player plays the file itself.
      if (kind === "preview") { setRender(null); toast("Preview rendered. The player now plays the file.", { icon: "check", tone: "brand" }); reload(); return; }
      setChat((c) => [...c, { id: "r" + Date.now(), role: "ai", ai: "Rendrr", text: "Final rendered.", workflow: result.steps || ["Encoded 1080p", "Cleaned up raw file"], at: Date.now() }]);
    } catch (e) {
      // Local footage: full quality needs the original once. Ask for it, then run the final.
      if (e.code === "need-original") { setRender({ kind, status: "original", hasFile: api.hasLocalFile(project.videoId), error: null, progress: { step: 0, steps: [], percent: 0 } }); return; }
      setRender((r) => ({ ...r, status: "error", code: e.code, error: e.message }));
    }
  };
  const sendOriginal = async (file) => {
    setRender((r) => ({ ...r, status: "running", progress: { step: 0, steps: ["Uploading original"], percent: 0 } }));
    try { await api.uploadOriginalForExport(project.id, file, (p) => setRender((r) => r && { ...r, progress: p })); }
    catch (e) { setRender((r) => ({ ...r, status: "original", hasFile: api.hasLocalFile(project.videoId), error: e.message })); return; }
    startRender("final");
  };
  const reconnectDrive = async () => { try { await api.reconnectDriveFile(project.videoId, project.video?.driveFileId); toast("Drive file reconnected", { icon: "drive", tone: "brand" }); startRender("final"); } catch (e) { toast(e.message); } };

  // ---- transcript selection (drag over words) ----
  const dragRef = useRef(null);
  const onWordDown = (i) => (e) => { e.preventDefault(); dragRef.current = { a: i, moved: false }; setWsel({ a: i, b: i }); };
  const onWordEnter = (i) => () => { if (dragRef.current) { dragRef.current.moved = dragRef.current.moved || i !== dragRef.current.a; setWsel({ a: dragRef.current.a, b: i }); } };
  useEffect(() => { const up = () => { if (!dragRef.current) return; const d = dragRef.current; dragRef.current = null; if (!d.moved) { const w = words[d.a]; if (cutSet.has(w.id)) { restoreWord(w.id); setWsel(null); } else if (inEdit(w)) { pb.seek(wordAt(w)); } else toast("This word's clip is out of the edit. Undo, or trim the clip back, to bring it back."); } }; window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, [words, cutSet, view, plan]);
  const inWsel = (i) => wsel && i >= Math.min(wsel.a, wsel.b) && i <= Math.max(wsel.a, wsel.b);

  // ---- timeline pointer logic ----
  const canvasRef = useRef();
  const PAD = 12; const px = (t) => PAD + t * zoom;
  // The page is drawn at a CSS zoom (#root, 0.8 on desktop): pointer positions and rects are screen pixels, the
  // timeline's px are CSS pixels. uiScale converts (without it a click landed at 0.8x the time under the pointer).
  const uiScale = () => { const el = canvasRef.current; const w = el?.offsetWidth; return w ? el.getBoundingClientRect().width / w || 1 : 1; };
  const tAt = (clientX) => { const r = canvasRef.current.getBoundingClientRect(); return Math.min(dur, Math.max(0, ((clientX - r.left) / uiScale() - PAD) / zoom)); };
  const scrubTimeline = (e) => { pb.seek(tAt(e.clientX)); const mv = (ev) => pb.seek(tAt(ev.clientX)); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); };
  // Snapping: an edge or a cut dragged within 8 px of the playhead or another clip's edge lands on it.
  const snapT = (t, skip = []) => {
    if (!snapOn) return t;
    let best = t, bd = 8 / zoom;
    for (const p of [0, dur, pb.time, ...TRACKS.flatMap(([k]) => lay.tracks[k].flatMap((c) => [c.start, c.end]))]) {
      if (skip.some((x) => Math.abs(x - p) < 1e-6)) continue;
      const d = Math.abs(p - t); if (d < bd) { best = p; bd = d; }
    }
    return best;
  };
  // A drag: each move shows the result of the op on the state before the drag; letting go makes it one undo step.
  const drag = (e, onMove, onUp) => {
    const x0 = e.clientX; const base = H.state; const k = uiScale() * zoom;
    const mv = (ev) => onMove((ev.clientX - x0) / k, base, ev);
    const up = (ev) => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); if (onUp) onUp((ev.clientX - x0) / k, base); else H.commitFrom(base); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const [drop, setDrop] = useState(null); // reordering: the cut where the dragged clip would go
  const clipDown = (k, c) => (e) => {
    e.stopPropagation(); e.preventDefault();
    setSel({ track: k, id: c.id });
    const marker = isCaptionMarker(k, c);
    if (tool === "razor") { if (!marker) doOp({ op: "split_clip", track: isV1(k) ? "v1" : k, clipId: c.id, at: r2(snapT(tAt(e.clientX))), edit: true }); return; }
    if (isV1(k) && tool === "slip") return drag(e, (d, base) => liveOp(base, { op: "slip_clip", clipId: c.id, by: r2(-d) }));
    if (isV1(k) && tool === "slide") return drag(e, (d, base) => { const s = snapT(c.start + d, [c.start]); liveOp(base, { op: "slide_clip", clipId: c.id, by: r2(s - c.start) }); });
    if (k === "v1" && tool === "select") {
      // Drag to reorder: the clip goes to the cut nearest the pointer.
      const t0 = tAt(e.clientX); const cuts = [...lay.tracks.v1.map((x) => x.start), dur];
      let moved = false;
      return drag(e, (d) => { if (!moved && Math.abs(d * zoom) < 5) return; moved = true; const t = t0 + d; setDrop(cuts.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), cuts[0])); },
        (d) => { setDrop(null); if (moved) doOp({ op: "move_clip", clipId: c.id, at: r2(clamp(t0 + d, 0, dur)) }); });
    }
    if (!isV1(k) && !marker && (tool === "select" || tool === "ripple")) {
      // Move a clip on another track: it hangs on the V1 clip under its new start.
      const len = c.end - c.start;
      return drag(e, (d, base) => { const s = clamp(snapT(c.start + d, [c.start]), 0, Math.max(0, dur - 0.05)); liveOp(base, { op: "trim_clip", track: k, clipId: c.id, start: r2(s), end: r2(Math.min(dur, s + len)), edit: true }); });
    }
  };
  const edgeDown = (k, c, edge) => (e) => {
    e.stopPropagation(); e.preventDefault(); setSel({ track: k, id: c.id });
    if (isCaptionMarker(k, c)) return;
    const v = isV1(k) ? lay.tracks.v1.find((x) => x.id === c.id) : null;
    const at0 = edge === "l" ? c.start : c.end;
    if (k === "a1" && e.altKey && v) {
      // J/L cut: the dialogue's edge moves on its own (the neighbour's sound gives way).
      return drag(e, (d, base) => { const t = snapT(at0 + d, [at0]); liveOp(base, edge === "l" ? { op: "set_audio_offset", clipId: c.id, start: r2(t - v.start) } : { op: "set_audio_offset", clipId: c.id, end: r2(t - v.end) }); });
    }
    if (v && tool === "roll") {
      // Rolling edit: the cut between this clip and its neighbour moves; the edit keeps its length.
      const i = lay.tracks.v1.findIndex((x) => x.id === c.id); const left = edge === "l" ? lay.tracks.v1[i - 1] : v;
      if (!left) return;
      const cut = edge === "l" ? v.start : v.end;
      return drag(e, (d, base) => { const t = snapT(cut + d, [cut]); liveOp(base, { op: "roll_edit", clipId: left.id, by: r2(t - cut) }); });
    }
    if (v) {
      // Ripple trim: the clip's footage edge moves; the edit grows or closes up after it.
      const vEdge = edge === "l" ? v.start : v.end;
      return drag(e, (d, base) => { const dd = snapT(vEdge + d, [vEdge]) - vEdge; liveOp(base, { op: "trim_clip", track: "v1", clipId: c.id, start: r2(edge === "l" ? v.sourceIn + dd : v.sourceIn), end: r2(edge === "r" ? v.sourceOut + dd : v.sourceOut) }); });
    }
    // Another track: the edge moves in the edit.
    return drag(e, (d, base) => {
      const s = edge === "l" ? clamp(snapT(c.start + d, [c.start]), 0, c.end - 0.1) : c.start;
      const en = edge === "r" ? clamp(snapT(c.end + d, [c.end]), c.start + 0.1, dur) : c.end;
      liveOp(base, { op: "trim_clip", track: k, clipId: c.id, start: r2(s), end: r2(en), edit: true });
    });
  };
  const canvasW = Math.max(900, px(dur) + 40);
  const tickStep = zoom < 8 ? 30 : zoom < 14 ? 10 : zoom < 30 ? 5 : zoom < 60 ? 2 : zoom < 150 ? 1 : zoom < 400 ? 0.5 : 0.2;
  const ticks = []; for (let k = 0; k * tickStep <= dur; k++) ticks.push(r2(k * tickStep));
  const v1ById = useMemo(() => new Map(lay.tracks.v1.map((c) => [c.id, c])), [lay]);
  const clipText = (k, c) => {
    if (k === "v1") { const vn = c.sourceVideoId !== main ? others[c.sourceVideoId]?.name || "Other video" : ""; const sp = c.freeze ? " · freeze" : c.ramp?.length ? " · ramp" : (c.speed && c.speed !== 1 ? ` · ${c.speed}x` : "") + (c.reverse ? " · reversed" : ""); return (vn && vn !== c.label ? vn + " · " : "") + (c.label || vn) + (c.rotate ? ` ↻${c.rotate}°` : "") + sp; }
    if (k === "a1") { const v = v1ById.get(c.id); const j = v && c.start < v.start - 0.005, l = v && v.end < c.end - 0.005; return "Dialogue" + (j ? " · J" : "") + (l ? " · L" : "") + (c.audioMuted ? " · muted" : "") + (v?.audioGain ? " · " + dB(v.audioGain) : ""); }
    if (k === "a2" || k === "a3") { const a = planAudio.get(c.id); return c.label + (a ? " · " + dB(a.gainDb) : ""); }
    return c.label;
  };
  // Sound fades drawn on the clips, as they render (music without its own fades gets the automatic ones).
  const planAudio = useMemo(() => new Map((plan?.audio || []).map((a) => [a.clipId, a])), [plan]);
  // What each sound track plays, for its waveform: the dialogue parts (their videos' measured peaks), music and effects.
  const waveParts = useMemo(() => ({
    a1: (plan?.sound || []).filter((x) => !x.silent).map((x) => ({ ...x, key: "v:" + x.videoId })),
    a2: (plan?.audio || []).filter((a) => a.kind === "music").map((a) => ({ start: a.start, end: a.end, srcIn: 0, srcOut: a.end - a.start, key: "a:" + a.assetKey })),
    a3: (plan?.audio || []).filter((a) => a.kind === "sfx").map((a) => ({ start: a.start, end: a.end, srcIn: 0, srcOut: a.end - a.start, key: "a:" + a.assetKey })),
  }), [plan]);
  // Phase 5 marks: the transition on the cut before a V1 clip, and keyframes as diamonds where they sit in the clip.
  const marksOf = (k, c) => {
    if (k !== "v1" && k !== "v2" && k !== "v3") return null;
    const keys = k === "v1" ? plan?.clipMotion?.[c.id]?.keys : c.keys;
    const t = k === "v1" && c.transition ? plan?.transitions?.find((x) => x.clipId === c.id) : null;
    return html`${t && t.end > t.start && html`<span class="trm" data-transition=${t.type} title=${`${t.type} ${(t.end - t.start).toFixed(2)}s`} style=${{ left: -((t.at - t.start) * zoom) + "px", width: (t.end - t.start) * zoom + "px" }} />`}${(keys || []).map((x, i) => html`<i key=${i} class="kf" style=${{ left: x.t * zoom + "px" }} />`)}`;
  };
  const fadesOf = (k, c) => {
    const f = k === "a1" ? { i: v1ById.get(c.id)?.audioFadeIn, o: v1ById.get(c.id)?.audioFadeOut } : k === "a2" || k === "a3" ? { i: planAudio.get(c.id)?.fadeIn, o: planAudio.get(c.id)?.fadeOut } : null;
    return f && html`${f.i > 0 && html`<i class="fd in" data-fade="in" style=${{ width: f.i * zoom }} />`}${f.o > 0 && html`<i class="fd out" data-fade="out" style=${{ width: f.o * zoom }} />`}`;
  };
  const soundSel = sel && ["v1", "a1", "a2", "a3"].includes(sel.track) ? (isV1(sel.track) ? selV1 : selClip) : null;
  const soundLen = !soundSel ? 0 : isV1(sel.track) ? (() => { const a = lay.tracks.a1.find((x) => x.id === soundSel.id); return a ? a.end - a.start : 0; })() : soundSel.end - soundSel.start;

  const { chat, setChat } = ai;
  useEffect(() => { const el = document.getElementById("ai-thread"); if (el) el.scrollTop = el.scrollHeight; }, [chat, rtab]);
  useEffect(() => { const el = document.getElementById("comment-list"); if (el) el.scrollTop = el.scrollHeight; }, [comments.length, rtab]);
  // What each tool in the Edit list has going on, in a word or two.
  const toolHint = { transcript: S.cut.length ? `${S.cut.length} cut` : "", clip: sel ? sel.track.toUpperCase() + " clip" : "", text: S.captionsOn ? "Captions on" : "", audio: S.voice ? "Your voice file" : "", style: reference ? "Attached" : "", ai: chat.length ? String(chat.length) : "" };
  const [draft, setDraft] = useState(""); const [posting, setPosting] = useState(false);
  const postComment = async () => { if (!draft.trim()) return; setPosting(true); try { const c = await api.addProjectComment(project.id, { time: pb.time, text: draft }); setComments((x) => [...x, c].sort((a, b) => a.time - b.time)); setDraft(""); toast("Comment added at " + fmtTime(c.time), { icon: "comment" }); } catch (e) { toast(e.message); } finally { setPosting(false); } };
  const resolve = async (c) => { try { const u = await api.resolveComment(c.id, !c.resolved); setComments((x) => x.map((i) => (i.id === c.id ? { ...i, resolved: u.resolved } : i))); } catch (e) { toast(e.message); } };
  // Comments from the Rendrr app in Claude can carry a drawing and pictures; the user's own notes can be edited, any deleted.
  const [cEdit, setCEdit] = useState(null); // { id, text }
  const [cDel, setCDel] = useState(null);
  const [cFilter, setCFilter] = useState(() => (comments.some((c) => !c.resolved) || !comments.length ? "open" : "all"));
  const shownComments = cFilter === "open" ? comments.filter((c) => !c.resolved) : cFilter === "done" ? comments.filter((c) => c.resolved) : comments;
  const [ink, setInk] = useState(null); // { time, strokes }: a comment's drawing, shown on the picture at its moment
  const saveCEdit = async () => { try { const u = await api.editComment(cEdit.id, cEdit.text); setComments((x) => x.map((i) => (i.id === u.id ? { ...i, ...u } : i))); setCEdit(null); } catch (e) { toast(e.message); } };
  const delComment = async (c) => {
    if (cDel !== c.id) { setCDel(c.id); setTimeout(() => setCDel((v) => (v === c.id ? null : v)), 3000); return; }
    try { await api.deleteComment(c.id); setComments((x) => x.filter((i) => i.id !== c.id)); setCDel(null); toast("Comment deleted.", { icon: "trash" }); } catch (e) { toast(e.message); }
  };
  const showInk = (c) => { pb.setPlaying(false); pb.seek(c.time); setInk({ time: c.time, strokes: c.drawing.strokes }); };
  const inkOverlay = ink && !pb.playing && Math.abs(pb.time - ink.time) < 0.06 ? html`<svg class="cmt-ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Drawing from a comment">${ink.strokes.map((st, i) => html`<polyline key=${i} points=${st.p.reduce((a, v, k) => (k % 2 ? a + "," + v : a + (k ? " " : "") + v), "")} fill="none" stroke=${st.c} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`)}</svg>` : null;

  return html`<div class="editor">
    <div class="ed-top">
      <${Btn} kind="quiet" icon="back" aria-label="Back to projects" onClick=${() => go("/projects/" + project.folderId)} />
      <input id="project-name" class="name" value=${S.name} aria-label="Project name" onInput=${(e) => H.replace((s) => ({ ...s, name: e.target.value }))} onBlur=${(e) => { if (e.target.value !== project.name) H.commitFrom({ ...S, name: project.name }); }} />
      <div style="position:relative" onClick=${(e) => e.stopPropagation()}>
        <button class="btn secondary sm" id="version-btn" aria-haspopup="menu" aria-expanded=${verMenu} onClick=${() => setVerMenu((m) => !m)}>V${viewVer || project.versions.length}<${Icon} name="down" size="14" /></button>
        ${verMenu && html`<div class="menu" style="left:0;right:auto;top:40px;min-width:200px" role="menu">${[...project.versions].reverse().map((v) => { const latest = v.v === project.versions.length; const on = (viewVer || project.versions.length) === v.v; return html`<button key=${v.v} role="menuitemradio" aria-checked=${on} class=${"item" + (on ? " on" : "")} data-version=${v.v} onClick=${() => { setViewVer(latest ? null : v.v); setVerMenu(false); }}><${Icon} name=${on ? "check" : "film"} />V${v.v}<span class="muted t-small" style="margin-left:auto">${latest ? "Latest" : fmtAgo(v.at)}</span></button>`; })}</div>`}
      </div>
      <span class="t-small muted" id="saved" title=${saved} style="display:inline-flex;align-items:center;gap:4px;opacity:.7">${saved === "Saved" ? "" : saved}</span>
      <div class="grow" />
      <span class="t-small muted" id="auto-preview" title=${fresh ? "The player plays the rendered preview file of this version." : "The player plays the edit as it will render: every clip and video in order, J/L cuts, captions, zooms, b-roll, graphics, music and sound effects at their levels. Dialogue cleanup and loudness are heard in the rendered preview."}>${fresh ? `Playing the rendered preview (V${project.version})` : "Live edit"}</span>
      ${!fresh && html`<${Btn} kind="ghost" size="sm" id="render-preview" icon="play" disabled=${saved !== "Saved" || !plan} onClick=${() => startRender("preview")}>Export preview<//>`}
      <${Btn} kind="secondary" size="sm" id="render-final" icon="film" onClick=${() => setExportOpen(true)}>Export final<//>
      <${Btn} size="sm" id="share" icon="link" onClick=${() => setShare(true)}>Share for review<//>
    </div>

    <div class="ed-body">
      <aside class="ed-side" aria-label="Reference and project media">
        <${SourceMonitor} reference=${reference} refs=${lib.refs} styles=${sq.data || []} onReference=${attach} source=${source} onCloseSource=${() => setSource(null)}
          onInsert=${(v) => addClip({ items: [{ video: v, from: 0, to: v.seconds }], at: pb.time })} onAppend=${(v) => addClip({ items: [{ video: v, from: 0, to: v.seconds }] })} />
        <${MediaBin} library=${lib.library} used=${usedIds} bin=${S.media || []} mainId=${project.videoId} previewing=${source?.id} onPreview=${(v) => setSource(v)}
          onAppend=${(v) => addClip({ items: [{ video: v, from: 0, to: v.seconds }] })} onAddToBin=${(v) => doOp({ op: "add_media", videoIds: [v.id] })} onRemoveFromBin=${(v) => doOp({ op: "remove_media", videoIds: [v.id] })}
          onImport=${() => openAdd("footage")} />
      </aside>
      <div class="ed-left">
      <div class="center">
        ${viewVer && viewVer !== project.versions.length && html`<div class="ver-banner"><span>Viewing V${viewVer} of ${S.name} (read only)</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" onClick=${async () => { try { await api.restoreVersion(project.id, viewVer); toast("V" + viewVer + " restored as a new version"); setViewVer(null); reload(); } catch (e) { toast(e.message); } }}>Restore this version<//><${Btn} kind="ghost" size="xs" id="back-latest" onClick=${() => setViewVer(null)}>Back to latest<//></div></div>`}
        ${!viewVer && !watch && !sideDismissed && sideways.length > 0 && html`<div class="ver-banner" id="sideways"><span>${sideways.length === 1 && sideways[0].vid === main ? "This footage looks" : "Some footage looks"} filmed sideways: faces are upright when it is turned ${sideways[0].turn}° clockwise.</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" id="turn-upright" onClick=${() => { const ok = sideways.every((x) => doOp({ op: "set_rotation", degrees: x.turn, clipIds: x.clips.map((c) => c.id) }, false)); if (ok) toast("Turned upright", { icon: "refresh" }); }}>Turn it upright<//><${Btn} kind="ghost" size="xs" onClick=${() => setSideDismissed(true)}>Keep as is<//></div></div>`}
        ${watch && html`<div class="ver-banner"><span>Watching the rendered preview (V${watch.version || project.version})</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" id="back-editing" onClick=${() => { wpb.setPlaying(false); setWatch(null); }}>Back to editing<//></div></div>`}
        <div style="flex:1;min-height:0;display:flex;justify-content:center">${watch
          ? html`<${Player} key="watch" style=${{ height: "100%", maxWidth: "100%" }} pb=${wpb} duration=${watch.seconds || 1} aspect=${S.aspect} src=${watch.url} />`
          : !plan ? html`<div class="state" style="margin:auto"><div class="ico"><${Icon} name="scissors" /></div><b class="t-label">Everything is cut</b><p class="t-small">Undo, or restore some words or clips.</p></div>`
          : fresh ? html`<${Player} key="preview" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} src=${project.previewUrl} overlay=${inkOverlay} marks=${comments.filter((c) => c.time > 0 && !c.resolved)} onMark=${(c) => { pb.seek(c.time); setRtab("comments"); }} />`
          : html`<${Player} key="edit" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} media=${Object.values(urls).some(Boolean) && html`<${SeqMedia} plan=${plan} clock=${clock} time=${pb.time} playing=${pb.playing} urls=${urls} sounds=${media.audio} aspect=${S.aspect} pb=${pb} broll=${media.broll} luts=${luts} />`} caption=${frame?.caption} captionLook=${S.captionLook} zoom=${frame?.zoom || 1} zoomTransition=${false} captionDrawn=${!!plan?.styledCaptions} overlay=${html`<${LiveOverlays} frame=${frame} clips=${lay.tracks.v3} media=${media} aspect=${S.aspect} playing=${pb.playing} plan=${plan} luts=${luts} />${rtab === "color" && colorClip ? html`<${MaskOverlay} shapes=${colorShapes} mode=${colorMode} draft=${pathDraft} onPoint=${onColorPoint} />` : null}${inkOverlay}`} marks=${comments.filter((c) => c.time > 0 && !c.resolved)} onMark=${(c) => { pb.seek(c.time); setRtab("comments"); }} />`}</div>
      </div>
      <div class="tl">
      <div class="tl-bar">
        <div class="row" style="gap:6px"><${Btn} kind="quiet" size="xs" icon=${pb.playing ? "pause" : "play"} aria-label=${pb.playing ? "Pause" : "Play"} onClick=${pb.toggle} />
          <span class="mono t-small tc-ro"><b>${fmtTime(pb.time, true)}</b><span class="muted"> / ${fmtTime(dur, true)}</span></span></div>
        <div class="tl-acts">
          <button class="tool icon" id="split" data-tip="Split at the playhead (⌘K)" aria-label="Split at the playhead" onClick=${split}><${Icon} name="scissors" size="16" /></button>
          <button class="tool icon" id="add-clip" data-tip="Add videos to the sequence" aria-label="Add videos" onClick=${() => setAddOpen(true)}><${Icon} name="plus" size="16" /></button>
          <button class="tool icon" id="rotate" data-tip=${"Turn " + (selV1 ? "this clip" : "the footage") + " 90° clockwise" + (rotNow ? " (now " + rotNow + "°)" : "")} aria-label="Rotate" onClick=${() => doOp({ op: "set_rotation", degrees: (rotNow + 90) % 360, clipIds: lookIds })}><${Icon} name="refresh" size="16" /></button>
          <span style="position:relative"><button class="tool icon" id="frame-btn" data-tip=${"Position and scale of " + (selV1 ? "this clip" : "the footage")} aria-label="Frame" onClick=${() => setFrameOpen((o) => !o)}><${Icon} name="image" size="16" /></button>
            ${frameOpen && html`<div class="menu" id="frame-pop" style="left:0;right:auto;top:36px;min-width:240px;padding:12px;display:grid;gap:8px"><span class="t-small muted">${selV1 ? "This clip" : "Every clip of the footage"}</span>${[["scale", "Scale", 0.5, 2, 0.01], ["x", "Left / right", -0.5, 0.5, 0.01], ["y", "Up / down", -0.5, 0.5, 0.01]].map(([k, l, lo, hi, st]) => html`<label key=${k} class="t-small" style="display:grid;gap:2px">${l} <span class="muted">${frNow[k]}</span><input type="range" data-frame=${k} min=${lo} max=${hi} step=${st} value=${frNow[k]} onPointerDown=${() => { frameBase.current = H.state; }} onInput=${(e) => liveOp(H.state, { op: "set_framing", [k]: +e.target.value, clipIds: lookIds })} onChange=${() => frameBase.current && H.commitFrom(frameBase.current)} /></label>`)}<${Btn} kind="ghost" size="xs" onClick=${() => doOp({ op: "set_framing", scale: 1, x: 0, y: 0, focus: null, clipIds: lookIds }, false)}>Reset<//>
              <span class="t-small muted" style="margin-top:6px">Reframe: what the ${S.aspect} frame keeps of the footage</span>
              <${Btn} kind="secondary" size="xs" icon="spark" id="reframe-face" disabled=${reframing} onClick=${() => reframeFace()}>${reframing ? "Finding the speaker…" : "Follow the speaker"}<//>
              ${[["x", "Pan across", 0.5], ["y", "Pan up / down", 0.4]].map(([k, l, d]) => html`<label key=${"f" + k} class="t-small" style="display:grid;gap:2px">${l} <span class="muted">${frNow.focus ? frNow.focus[k] : "middle"}</span><input type="range" data-focus=${k} min="0" max="1" step="0.01" value=${frNow.focus ? frNow.focus[k] : d} onPointerDown=${() => { frameBase.current = H.state; }} onInput=${(e) => liveOp(H.state, { op: "set_framing", focus: { x: frNow.focus?.x ?? 0.5, y: frNow.focus?.y ?? 0.4, [k]: +e.target.value }, clipIds: lookIds })} onChange=${() => frameBase.current && H.commitFrom(frameBase.current)} /></label>`)}</div>`}</span>
          <button class="tool icon" id="delete-clip" data-tip="Delete the selected clip (⌫)" aria-label="Delete" disabled=${!sel} onClick=${removeSel}><${Icon} name="trash" size="16" /></button>
          ${selV1 && html`<button class="tool icon" id="mute-clip" data-tip=${selV1.audioMuted ? "Bring this clip's dialogue back" : "Silence this clip's dialogue"} aria-label=${selV1.audioMuted ? "Unmute" : "Mute"} onClick=${toggleMute}><${Icon} name="mic" size="16" /></button>`}
          ${selClip && html`<span class="t-small muted ell" style="margin-left:6px;max-width:220px">${selClip.label}</span>`}
        </div>
        <div class="zoom"><button class="tool icon" aria-label="Zoom out" onClick=${() => setZoom((z) => Math.max(ZMIN, Math.round(z / 1.4)))}><${Icon} name="more" size="14" /></button><input id="tl-zoom" type="range" min="0" max="1000" value=${Math.round((1000 * Math.log(zoom / ZMIN)) / Math.log(ZMAX / ZMIN))} onInput=${(e) => setZoom(Math.round(ZMIN * Math.pow(ZMAX / ZMIN, +e.target.value / 1000)))} aria-label="Timeline zoom" /><button class="tool icon" aria-label="Zoom in" onClick=${() => setZoom((z) => Math.min(ZMAX, Math.round(z * 1.4)))}><${Icon} name="plus" size="14" /></button><button class="tool" id="zoom-fit" title="Zoom to fit (Shift Z)" onClick=${fit}>Fit</button></div>
      </div>
      <div class="tl-body">
        <div class="tl-tbar" role="toolbar" aria-orientation="vertical" aria-label="Tools">
          <span class="tool-set" role="radiogroup" aria-label="Tool">${TOOLS.map(([k, key, label, hint]) => html`<button key=${k} class=${"tool icon" + (tool === k ? " on" : "")} id=${"tool-" + k} role="radio" aria-checked=${tool === k} aria-label=${label} data-tip=${label + " (" + key + "): " + hint} onClick=${() => setTool(k)}><${Icon} name=${TOOL_ICON[k]} size="16" /></button>`)}</span>
          <i class="tbar-sep" />
          <button class=${"tool icon" + (snapOn ? " on" : "")} id="snap" aria-pressed=${snapOn} aria-label=${snapOn ? "Snapping on" : "Snapping off"} data-tip=${"Snapping (S): " + (snapOn ? "on" : "off") + ". Edges land on the playhead and on other clips' edges"} onClick=${() => setSnapOn((x) => !x)}><${Icon} name="magnet" size="16" /></button>
          <button class=${"tool icon" + (showMarks ? " on" : "")} id="marks-toggle" aria-pressed=${showMarks} aria-label=${showMarks ? "Marks on" : "Marks off"} data-tip=${(showMarks ? "Hide" : "Show") + " the marks on the ruler (" + marks.length + "): silences, fillers, retakes, notes"} onClick=${() => setShowMarks(!showMarks)}><${Icon} name="flag" size="16" /></button>
        </div>
        <div class="tl-labels">${TRACKS.map(([k, l]) => html`<div key=${k} class=${k[0]} style=${TRACK_H[k] ? { height: TRACK_H[k] + "px" } : null} title=${TRACK_HINT[k]}><b>${l}</b><span>${TRACK_HINT[k]}</span></div>`)}</div>
        <div class="tl-scroll"><div class=${"tl-canvas tool-" + tool} ref=${canvasRef} style=${{ width: canvasW }} id="timeline">
          <div class="ruler" onPointerDown=${scrubTimeline}>${ticks.map((t) => html`<span key=${t} style=${{ left: px(t) }}>${tickStep < 1 ? fmtTime(t, true) : fmtTime(t)}</span>`)}${zoom >= 8 ? Array.from({ length: Math.floor(dur) + 1 }).map((_, t) => html`<i key=${"m" + t} class="mt" style=${{ left: px(t) }} />`) : null}
            ${showMarks && marks.filter((m) => m.end > m.start + 0.05).map((m) => html`<i key=${"r" + m.id} class="tl-mrange" style=${{ left: px(m.start), width: Math.max(2, (m.end - m.start) * zoom), background: MARK_COLORS[m.source === "ai" ? "custom" : m.kind] }} />`)}
            ${showMarks && marks.map((m) => html`<i key=${"p" + m.id} class="tl-mark" data-kind=${m.kind} title=${markNote(m)} style=${{ left: px(m.start) - 3, "--mk": MARK_COLORS[m.source === "ai" ? "custom" : m.kind] }} onPointerDown=${(e) => { e.stopPropagation(); pb.seek(m.start); }} />`)}
            ${comments.filter((c) => c.time > 0 && !c.resolved).map((c) => html`<div key=${c.id} class="cm" title=${c.text} onPointerDown=${(e) => { e.stopPropagation(); pb.seek(c.time); setRtab("comments"); }} style=${{ left: px(c.time) }} />`)}</div>
          ${TRACKS.map(([k]) => html`<div key=${k} class=${"track " + k[0] + " " + k + (k === "v1" ? " v1main" : "")} style=${TRACK_H[k] ? { height: TRACK_H[k] + "px" } : null} onPointerDown=${(e) => { setSel(null); scrubTimeline(e); }}>
            ${k[0] === "a" && waveParts[k].length > 0 && html`<${WaveLayer} parts=${waveParts[k]} peaks=${peaks} zoom=${zoom} pad=${PAD} canvasRef=${canvasRef} height=${(TRACK_H[k] || 34) - 1} />`}
            ${lay.tracks[k].map((c) => { const gone = c.end - c.start < 0.01; const other = k === "v1" && c.sourceVideoId !== main;
              return html`<div key=${c.id} class=${"clip " + (k === "v1" ? "video" : k[0] === "a" ? "audio" : c.kind === "zoom" ? "fx" : "title") + (isOn(k, c) ? " on" : "") + (gone ? " gone" : "") + (other ? " other" : "") + (c.audioMuted ? " muted" : "")} data-clip=${c.id} data-track=${k}
                title=${gone ? "Not in the edit: its footage is cut" : k === "a1" ? "Its V1 clip's dialogue. Alt-drag an edge for a J or L cut." : k === "v1" ? `${clipText(k, c)} · footage ${c.sourceIn.toFixed(2)}-${c.sourceOut.toFixed(2)}s` : c.label}
                style=${{ left: px(c.start), width: Math.max(gone ? 4 : 8, (c.end - c.start) * zoom) }}
                onPointerDown=${clipDown(k, c)}>${k === "v1" && !gone && html`<${Filmstrip} url=${urls[c.sourceVideoId || main]} from=${c.sourceIn} to=${c.sourceOut} width=${(c.end - c.start) * zoom} />`}${fadesOf(k, c)}${marksOf(k, c)}<span class="h l" onPointerDown=${edgeDown(k, c, "l")} /><span class="cl">${clipText(k, c)}</span><span class="h r" onPointerDown=${edgeDown(k, c, "r")} /></div>`; })}
            ${k === "v1" && drop != null && html`<div class="tl-drop" id="drop-marker" style=${{ left: px(drop) - 1 }} />`}
          </div>`)}
          <div class="playhead" id="playhead" style=${{ left: px(pb.time) - 1 }}><i /></div>
        </div></div>
      </div>
    </div>

      </div>

      <div class="panel">
        ${PANEL_TOOLS[rtab] ? html`<div class="rp-head" id="tool-head"><button class="rp-back" id="tool-back" aria-label="Back to the tools" title="Back" onClick=${() => setRtab("edit")}><${Icon} name="back" size="16" /></button><span class="rp-ico"><${Icon} name=${PANEL_TOOLS[rtab][1]} size="15" /></span><b>${PANEL_TOOLS[rtab][0]}</b></div>`
        : html`<div class="tabs" role="tablist">${[["edit", "Edit", "edit"], ["comments", "Comments", "bubble"]].map(([k, l, ic]) => html`<button key=${k} role="tab" id=${"tab-" + k} aria-selected=${rtab === k} class=${rtab === k ? "on" : ""} onClick=${() => setRtab(k)}><${Icon} name=${ic} size="15" />${l}${k === "comments" && comments.some((c) => !c.resolved) ? html`<span class="n">${comments.filter((c) => !c.resolved).length}</span>` : ""}</button>`)}</div>`}
        ${rtab === "edit" && html`<div class="pb" id="edit-tools">${PANEL_GROUPS.map(([g, gi, keys]) => html`<div key=${g} class="rp-card"><div class="rp-card-h"><${Icon} name=${gi} size="13" />${g}</div>
          ${keys.map((k) => html`<button key=${k} class="rp-row" id=${"tab-" + k} onClick=${() => setRtab(k)}><${Icon} name=${PANEL_TOOLS[k][1]} size="18" /><span class="grow">${PANEL_TOOLS[k][0]}</span>${toolHint[k] && html`<span class="hint">${toolHint[k]}</span>`}<${Icon} name="chev" size="14" /></button>`)}</div>`)}</div>`}
        ${rtab === "transcript" && html`<div class="pb words" id="transcript" style="padding-top:12px">
          <div class="row between" style="margin-bottom:8px"><span class="t-small muted">Drag over words and press <span class="kbd">Delete</span> to cut them.</span><span class="t-small muted" style="white-space:nowrap">${S.cut.length} cut</span></div>
          ${project.transcript.map((l) => html`<p key=${l.id}>${l.gapBefore ? html`<span class="gap">${l.gapBefore}s silence</span>` : null}<span class="ts">${fmtTime(l.start)}</span>${l.words.map((w) => { const i = words.indexOf(w); return html`<span key=${w.id} data-w=${w.id} class=${"w" + (cutSet.has(w.id) || !inEdit(w) ? " cut" : "") + (inWsel(i) ? " sel" : "") + (w === curWord ? " now" : "") + (w.filler ? " filler" : "")} onPointerDown=${onWordDown(i)} onPointerEnter=${onWordEnter(i)}>${w.text}</span>${" "}`; })}</p>`)}
          ${selWords().length > 0 && html`<div class="selpop" id="cut-pop"><span class="t-small">${selWords().length} ${selWords().length === 1 ? "word" : "words"}</span><${Btn} size="xs" icon="scissors" id="cut-selected" onClick=${() => { cutWords(selWords()); setWsel(null); }}>Remove from video<//><${Btn} kind="quiet" size="xs" icon="play" aria-label="Play selection" onClick=${() => { const ids = selWords(); const w = words.find((x) => x.id === ids[0]); if (w) { pb.seek(wordAt(w)); pb.setPlaying(true); } }} /><${Btn} kind="quiet" size="xs" icon="x" aria-label="Clear selection" onClick=${() => setWsel(null)} /></div>`}
        </div>`}
        ${rtab === "ai" && html`<div class="pb cmts" style="padding-top:12px">
          <div class="col" style="gap:10px;flex:1;min-height:0;overflow:auto" id="ai-thread">
            ${chat.length === 0 ? html`<div class="state" style="padding:28px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="spark" /></div><b class="t-label">What your AI did shows here</b><p class="t-small">When Claude or ChatGPT edits this video through the connector, every step and its notes to you appear here.</p></div>`
            : chat.map((m) => html`<div key=${m.id} class=${"msg " + m.role} data-msg=${m.id}>
                ${m.role === "ai" && html`<span class="who"><${Icon} name="spark" size="12" /> ${m.ai}</span>`}
                <p>${m.text}</p>
                ${m.workflow && html`<div class="wf"><span class="t-small muted">Workflow</span>${m.workflow.map((w, i) => html`<div key=${i} class="wf-step"><span class="n">${i + 1}</span>${w}</div>`)}</div>`}
                <span class="t-small muted when">${fmtAgo(m.at)}</span>
              </div>`)}
          </div>
          <p class="t-small muted" style="margin:0">Ask for changes in Claude or ChatGPT. This page only shows what they did.</p>
        </div>`}
        ${rtab === "comments" && html`<div class="pb cmts" id="comments-panel">
          <div class="cm-head"><div class="seg sm" role="tablist" aria-label="Which comments">${[["open", "Open", comments.filter((c) => !c.resolved).length], ["all", "All", comments.length], ["done", "Done", comments.filter((c) => c.resolved).length]].map(([k, l, n]) => html`<button key=${k} role="tab" aria-selected=${cFilter === k} class=${cFilter === k ? "on" : ""} id=${"cm-filter-" + k} onClick=${() => setCFilter(k)}>${l} <span class="muted">${n}</span></button>`)}</div></div>
          <div class="col cm-list" id="comment-list">
            ${comments.length === 0 ? html`<div class="state" style="padding:28px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="comment" /></div><b class="t-label">No comments yet</b><p class="t-small">Pause where something should change and write it below. Clients can comment too, from a review link.</p></div>`
            : shownComments.length === 0 ? html`<p class="t-small muted" style="padding:16px 4px">${cFilter === "open" ? "Every comment is resolved." : "No resolved comments yet."}</p>`
            : shownComments.map((c) => html`<div key=${c.id} class=${"cmt" + (c.resolved ? " done" : "") + (Math.abs(pb.time - c.time) < 0.05 && c.time > 0 ? " now" : "")} data-comment=${c.id} onClick=${(e) => { if (!e.target.closest("button, a, input, form") && c.time > 0) { pb.setPlaying(false); pb.seek(c.time); } }}>
                <span class=${"gava" + (c.mine ? "" : " client")}>${initials(c.author)}</span>
                <div class="grow" style="min-width:0">
                  <div class="cmt-top"><b>${c.author}${c.mine ? " (you)" : ""}</b><span class="muted">${fmtAgo(c.at)}${c.edited ? " · edited" : ""}</span><div class="grow" />
                    <span class="cmt-acts">${c.mine && html`<button class="cmt-act" onClick=${() => setCEdit({ id: c.id, text: c.text })}>Edit</button>`}
                    <button class=${"cmt-act" + (cDel === c.id ? " warn" : "")} aria-label="Delete comment" onClick=${() => delComment(c)}>${cDel === c.id ? "Delete?" : html`<${Icon} name="trash" />`}</button></span>
                    <button class=${"cmt-check" + (c.resolved ? " on" : "")} aria-label=${c.resolved ? "Reopen" : "Resolve"} title=${c.resolved ? "Reopen" : "Mark as done"} onClick=${() => resolve(c)}><${Icon} name="check" size="12" /></button></div>
                  ${cEdit?.id === c.id ? html`<form class="row" style="gap:6px;margin-top:6px" onSubmit=${(e) => { e.preventDefault(); saveCEdit(); }}><input class="input sm grow" aria-label="Edit comment" value=${cEdit.text} onInput=${(e) => setCEdit({ ...cEdit, text: e.target.value })} onKeyDown=${(e) => e.key === "Escape" && setCEdit(null)} autoFocus /><${Btn} size="sm" type="submit">Save<//><${Btn} size="sm" kind="quiet" type="button" onClick=${() => setCEdit(null)}>Cancel<//></form>`
                  : html`<p class="cmt-body">${c.time > 0 && html`<button class="tc" onClick=${() => pb.seek(c.time)}>${fmtTime(c.time)}</button>`}${linkified(c.text)}</p>`}
                  ${(c.drawing || c.images?.length) ? html`<div class="row cmt-media">${c.drawing && html`<button class="cmt-badge" onClick=${() => showInk(c)}>✎ Drawing</button>`}${(c.images || []).map((im) => html`<a key=${im.id} href=${im.url} target="_blank" rel="noopener noreferrer" title=${im.name || "Picture"}><img class="cmt-img" src=${im.url} alt=${im.name || "Picture"} /></a>`)}</div>` : null}</div>
              </div>`)}
          </div>
          <form class="cbox" onSubmit=${(e) => { e.preventDefault(); postComment(); }}>
            <textarea id="comment-input" class="cbox-text" rows="2" placeholder="Leave a comment at this moment…" value=${draft} onInput=${(e) => setDraft(e.target.value)} onFocus=${() => pb.setPlaying(false)} onKeyDown=${(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); } }} />
            <div class="row" style="gap:6px"><button type="button" class="tc big" title="The comment goes at this moment" onClick=${() => pb.setPlaying(false)}>${fmtTime(pb.time, true)}</button><div class="grow" />
              <${Btn} size="sm" type="submit" id="comment-post" disabled=${!draft.trim() || posting}>${posting ? "…" : "Comment"}<//></div>
          </form>
        </div>`}
        ${rtab === "clip" && html`<${ClipTab} clip=${sel && isV1(sel.track) ? selV1 : selClip} track=${sel?.track} plan=${plan} first=${!!selV1 && lay.tracks.v1.find((c) => c.end - c.start > 0.01)?.id === selV1.id} at=${pb.time} srcAt=${(id, t) => view.editToSource(id, t)} onSeek=${(t) => pb.seek(t)} doOp=${doOp} H=${H} liveOp=${liveOp} />`}
        ${rtab === "color" && html`<${ColorTab} clip=${colorClip} track=${sel?.track} projectId=${project.id} clips=${[...lay.tracks.v1, ...lay.tracks.v2.filter((b) => b.kind === "broll")]} lutList=${lutQ.data || []} reloadLuts=${() => lutQ.reload()} timeline=${timeline} doOp=${doOp} H=${H} liveOp=${liveOp} mode=${colorMode} setMode=${setColorMode} draft=${pathDraft} setDraft=${setPathDraft} toast=${toast} />`}
        ${rtab === "audio" && html`<${AudioTab} a=${audioSettings(timeline)} clip=${soundSel} track=${sel?.track} len=${soundLen} planned=${soundSel ? planAudio.get(soundSel.id) : null} doOp=${doOp} H=${H} liveOp=${liveOp} voice=${S.voice ? { ...S.voice, name: (project.sounds || {})[S.voice.soundId]?.name } : null} />`}
        ${rtab === "text" && html`<${TextTab} timeline=${timeline} aspect=${S.aspect} captionRules=${captionRules} textClips=${lay.tracks.v3.filter((c) => c.kind === "text")} selText=${sel?.track === "v3" ? lay.tracks.v3.find((c) => c.id === sel.id && c.kind === "text") : null} onSelect=${(id) => setSel({ track: "v3", id })} at=${pb.time} dur=${dur} doOp=${doOp} H=${H} liveOp=${liveOp} />`}
        ${rtab === "style" && html`<div class="pb" style="padding-top:16px"><div class="col" style="gap:16px">
          <div class="col" style="gap:8px"><b class="t-label">Reference</b><p class="t-small muted">Attached for your AI to read. Nothing from it is applied to the edit.</p>
            <${ReferencePicker} id="edit-reference" value=${reference} onChange=${attach} /></div>
          ${style ? html`<div class="col" style="gap:12px"><b class="t-label">Style your AI applied</b>
            <${StyleArt} s=${style} />
            <pre class="code" id="style-code">${styleCode(style, S).split("\n").map((ln, i) => { const m = ln.match(/^(\s*)([a-z_]+):(.*)$/); return html`<div key=${i}>${m ? html`${m[1]}<span class="k">${m[2]}:</span>${m[3]}` : ln}</div>`; })}</pre>
          </div>` : html`<p class="t-small muted" id="no-style">No style applied. The edit is your raw footage plus the changes you and your AI make.</p>`}
        </div></div>`}
      </div>
    </div>

    ${render && html`<${Modal} title=${render.kind === "preview" ? "Exporting preview" : "Exporting final"} sub=${render.status === "running" && render.kind === "preview" ? "540p, everything burned in." : render.status === "running" ? (project.video?.source === "drive" ? `Full quality${render.progress.quality ? ` (${render.progress.quality})` : ""}. We fetch the raw file from your Drive, then delete it.` : `Full quality${render.progress.quality ? ` (${render.progress.quality})` : ""}. This one takes a little longer.`) : null} onClose=${render.status !== "running" ? () => setRender(null) : undefined}>
      ${render.status === "running" && html`<div class="col" style="gap:16px"><div class="bar big"><i style=${{ width: render.progress.percent + "%" }} /></div><div class="row between"><span class="t-small muted" id="render-step">${render.progress.steps[render.progress.step] || "Starting…"}</span><span class="t-small mono muted"><span id="render-eta">${timeLeft(render.progress.etaSec)}</span> · ${render.progress.percent}%</span></div>
        <div class="steps">${render.progress.steps.map((s, i) => html`<div key=${s} class=${"step" + (i < render.progress.step ? " done" : i === render.progress.step ? " now" : "")}><span class="ck">${i < render.progress.step && html`<${Icon} name="check" />`}</span>${s}</div>`)}</div></div>`}
      ${render.status === "done" && html`<div class="state" style="padding:24px 0;box-shadow:none;background:none"><div class="ico"><${Icon} name="check" /></div><h3 class="t-heading" id="render-done">Final is ready</h3><p id="render-note">${render.result.note + " · " + (render.result.quality || "1080p") + " · " + render.result.size}</p>
        <div class="row"><${Btn} icon="laptop" id="download" onClick=${() => { if (render.result.downloadUrl) { window.open(render.result.downloadUrl, "_blank", "noopener"); toast("Saving " + (render.result.fileName || "the final") + " to this computer", { icon: "download", tone: "brand" }); } }}>Save to this computer<//><${Btn} kind="secondary" icon="drive" id="save-drive" onClick=${async () => { try { const r = await api.saveFinalToDrive(render.result.renderId); toast(r.message, { icon: "drive", tone: "brand" }); } catch (e) { toast(e.message); } }}>Save to Google Drive<//><${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
      ${render.status === "error" && html`<div class="state" role="alert" style="padding:24px 0;box-shadow:none;background:none"><div class="ico err"><${Icon} name="alert" /></div><h3 class="t-heading" id="render-error">${render.code === "drive" ? "Drive file out of reach" : "Render did not finish"}</h3><p>${render.error}</p><div class="row">${render.code === "drive" && html`<${Btn} id="render-reconnect" icon="drive" onClick=${reconnectDrive}>Reconnect<//>`}<${Btn} kind=${render.code === "drive" ? "secondary" : "primary"} id="render-retry" icon="refresh" onClick=${() => startRender(render.kind)}>Try again<//><${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
      ${render.status === "original" && html`<div class="col" style="gap:16px" id="need-original"><div class="card flat row" style="gap:12px;align-items:flex-start"><${Icon} name="laptop" size="18" /><div><b class="t-label">Full quality needs your original file once.</b><p class="t-small muted">We delete it within 24 hours of the export. Your preview copy stays.</p></div></div>
        ${project.video && html`<p class="t-small muted">Looking for <b style="color:var(--ink)">${project.video.originalName}</b> · ${project.video.size}</p>`}
        ${render.error && html`<p class="t-small" role="alert" id="original-error" style="color:var(--ink)"><${Icon} name="alert" size="13" /> ${render.error}</p>`}
        <input type="file" accept="video/*" class="hide" id="original-file" onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) sendOriginal(f); }} />
        <div class="row">${render.hasFile ? html`<${Btn} id="upload-original" icon="upload" onClick=${() => sendOriginal(null)}>Upload original and export<//>` : html`<${Btn} id="pick-original" icon="laptop" onClick=${() => document.getElementById("original-file").click()}>Pick the original file<//>`}<${Btn} kind="ghost" onClick=${() => setRender(null)}>Not now<//></div></div>`}
    <//>`}
    ${exportOpen && html`<${ExportModal} snap=${{ timeline, aspect: S.aspect }} video=${project.video} doOp=${doOp} onReframe=${() => reframeFace(true)} reframing=${reframing} onRender=${() => { setExportOpen(false); startRender("final"); }} onClose=${() => setExportOpen(false)} />`}
    ${share && html`<${CreateLinkModal} projectId=${project.id} onClose=${() => setShare(false)} onCreated=${() => setStatus("In review")} />`}
    ${addOpen && html`<${AddClipModal} main=${{ id: main, name: project.video?.name || "Footage", seconds: footDur }} at=${pb.time} onAdd=${addClip} onClose=${() => setAddOpen(false)} />`}
    ${help && html`<${Modal} title="Keyboard shortcuts" onClose=${() => setHelp(false)}><div class="list">${SHORTCUTS.map(([k, d]) => html`<div key=${k} class="row between" style="padding:6px 4px"><span>${d}</span><span class="kbd">${k}</span></div>`)}</div><//>`}
  </div>`;
}
export { EditorPage, TextLayers, SeqMedia, LiveOverlays };
