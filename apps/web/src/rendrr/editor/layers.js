// What the player draws over and under the footage: cards, patterns, text, overlays, the person cut-out, and the
// sequence's videos and sounds kept in step with the playhead.
// Moved out of editor.js unchanged (audit #30): the editor imports it from here.
import { fitVideoStyle, html, turnedVideoStyle, useEffect, useMemo, useRef, useState } from "../ui";
import { ASPECT_RATIO, adjustCss, areaAt, audioAt, audioFrames, blendCss, cardBorderPicture, cardShadowPicture, cssSize, dbToLin, drawnOf, fitCrop, fontFaceCss, fontFilesOf, hashOf, isMatted, liveFrame, maskPicture, patternPicture, peaksFromSamples, playerGraphicHtml, rateOf, showAt, templateSize, waveColumns } from "@rendrr/shared";
import { LookCanvas } from "../color";
import { outputSize } from "@rendrr/shared/renderPlan";
import { api } from "../api";
import { applyLiveFx, resumeLiveAudio } from "../liveAudio";
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
// Phase 18: remove_background on a clip's look: its matte's block links (useMattes) with its edge, softness and invert.
const matteFrom = (lk, mattes) => (lk?.subject && mattes?.[lk.subject.matte] ? { ...mattes[lk.subject.matte], edge: lk.subject.edge, soft: lk.subject.soft, invert: !!lk.subject.invert } : null);
function SyncedVideo({ src, time, playing, fit = "cover", look = null, plan = null, luts, style = null, matte = null, t0 = 0 }) {
  const ref = useRef(null); const [noGl, setNoGl] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (playing) { if (Math.abs(el.currentTime - time) > 0.25) { try { el.currentTime = time; } catch {} } el.play().catch(() => {}); }
    else { el.pause(); if (Math.abs(el.currentTime - time) > 0.04) { try { el.currentTime = time; } catch {} } }
  }, [time, playing]);
  const gl = !!look && !!plan && !noGl;
  return html`<video ref=${ref} src=${src} crossOrigin="anonymous" muted playsInline preload="auto" style=${{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: fit, pointerEvents: "none", ...(style || {}), ...(gl ? { opacity: 0 } : {}) }} />
    ${gl && html`<${LookCanvas} videoRef=${ref} look=${look} W=${plan.width} H=${plan.height} fitY=${0.5} luts=${luts} onFail=${() => setNoGl(true)} matte=${matte} t0=${t0} fps=${plan.fps || 30} />`}`;
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

// Phase 9: an adjustment layer's preview: a box over the footage, b-roll and graphics (text and captions go on above it)
// that filters what is under it. Near enough to judge; the render draws the layer exactly.
// Phase 16: its masks (where they are t seconds into it) as a CSS mask picture with the render's own shapes, and its
// strength (opacity with its fades) as the box's opacity: what is under it shows through outside the masks.
function AdjustLayer({ a, plan }) {
  const box = useRef(null);
  const [k, setK] = useState(1);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setK(el.clientWidth / plan.width || 1)); ro.observe(el); return () => ro.disconnect(); }, [plan.width]);
  const f = adjustCss(a, plan.width, plan.height, k);
  const m = a.masks?.length ? adjustMaskUrl(a.masks, a.t || 0, plan.width, plan.height) : null;
  const masked = m ? { maskImage: m, WebkitMaskImage: m, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" } : {};
  const op = a.strength ?? 1;
  return html`<div ref=${box} data-adjust=${a.clipId} data-strength=${op.toFixed(3)} data-masked=${m ? "1" : null} style=${{ position: "absolute", inset: 0, pointerEvents: "none", backdropFilter: f, WebkitBackdropFilter: f, ...(op < 1 ? { opacity: op } : {}), ...masked }} />`;
}
const adjMasks = new Map();
/** The masks at t as a small picture (alpha = the mask, at most 240 wide; CSS stretches it over the frame), kept. */
function adjustMaskUrl(masks, t, W, H) {
  const sw = Math.min(W, 240), sh = Math.max(2, Math.round((H * sw) / W));
  const now = masks.map((x) => areaAt(x, t)), key = hashOf([now, sw, sh]);
  if (adjMasks.has(key)) return adjMasks.get(key);
  const px = maskPicture(now, sw, sh), cv = document.createElement("canvas");
  cv.width = sw; cv.height = sh;
  const cx = cv.getContext("2d"), img = cx.createImageData(sw, sh);
  for (let i = 0; i < px.length; i++) img.data[i * 4 + 3] = px[i];
  cx.putImageData(img, 0, 0);
  const url = `url(${cv.toDataURL()})`;
  adjMasks.set(key, url);
  if (adjMasks.size > 16) adjMasks.delete(adjMasks.keys().next().value);
  return url;
}

// Phase 4: the blend modes by their names in Premiere.
const BLEND_NAME = { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", "soft-light": "Soft Light", "hard-light": "Hard Light", add: "Add (Linear Dodge)", lighten: "Lighten", darken: "Darken", difference: "Difference", exclusion: "Exclusion", "color-dodge": "Color Dodge", "color-burn": "Color Burn" };

// What the render lays over the footage at this moment: b-roll, then (Phase 2) the graphics and text layers behind the
// person and the person laid back over them, then the other graphics, text layers and captions.
function LiveOverlays({ frame, clips, media, aspect, playing, plan, luts, person = null, mattes = {} }) {
  if (!frame) return null;
  const b = frame.broll && media.broll[frame.broll.videoId];
  // Keyframed overlays move as the render's perspective filter moves them (Phase 5).
  const moved = (m, child, anchor) => (m ? html`<div style=${{ position: "absolute", inset: 0, pointerEvents: "none", ...motionCss(m, anchor) }}>${child}</div>` : child);
  // Phase 11: b-roll mirrored, and a b-roll card's drop shadow.
  const [k, setK] = useState(1); const box = useRef(null);
  useEffect(() => { const el = box.current?.parentElement; if (!el || !plan) return; const ro = new ResizeObserver(() => setK(el.clientWidth / plan.width || 1)); ro.observe(el); return () => ro.disconnect(); }, [plan?.width]);
  const shadowed = (br, child) => (br.shadow && plan ? html`<div data-shadow=${br.clipId} style=${{ position: "absolute", inset: 0, pointerEvents: "none", filter: shadowCss(br.shadow, plan.width, plan.height, k) }}>${child}</div>` : child);
  const flipped = (f, child) => (f ? html`<div data-flip=${f} style=${{ position: "absolute", inset: 0, pointerEvents: "none", transform: flipCss(f).trim() }}>${child}</div>` : child);
  // Phase 4: a layer's blend mode and opacity, as the render's blend: the outermost box, so it blends with the picture.
  const blended = (x, child) => (x.blend || x.opacity != null ? html`<div data-blend=${x.blend || "normal"} style=${{ position: "absolute", inset: 0, pointerEvents: "none", mixBlendMode: blendCss(x.blend), opacity: x.opacity ?? 1 }}>${child}</div>` : child);
  const gfx = (g) => { const m = media.graphicClips[g.clipId]; const c = clips.find((x) => x.id === g.clipId);
    return blended(g, moved(g.motion, m ? html`<${SyncedVideo} key=${g.clipId} src=${m.url} time=${g.t} playing=${playing} fit="contain" />` : html`<${TemplateFrame} key=${g.clipId} graphicId=${g.graphicId} params=${c?.params} start=${g.start} end=${g.end} t=${g.t} aspect=${aspect} />`, g.anchor)); };
  const backText = frame.texts.some((x) => x.layer.behind);
  // Phase 17: a b-roll card's border over its picture, moving with it.
  const bordered = (br, child) => (br.border && plan?.lookFiles?.[br.border.file] ? html`${child}<div data-border=${br.clipId} style="position:absolute;inset:0;pointer-events:none"><${CardLayer} spec=${plan.lookFiles[br.border.file]} color=${br.border.color} W=${plan.width} H=${plan.height} /></div>` : child);
  return html`<i ref=${box} style="display:none" />${b && blended(frame.broll, shadowed(frame.broll, moved(frame.broll.motion, bordered(frame.broll, flipped(frame.broll.flip, html`<${SyncedVideo} key=${frame.broll.clipId} src=${b.url} time=${frame.broll.src} playing=${playing} look=${plan?.looks?.[frame.broll.clipId]} plan=${plan} luts=${luts} matte=${matteFrom(plan?.looks?.[frame.broll.clipId], mattes)} t0=${frame.broll.t0} />`)), frame.broll.anchor)))}
    ${frame.graphics.filter((g) => g.behind).map(gfx)}
    ${plan && backText && html`<${TextLayers} key="behind" plan=${plan} frame=${frame} only="behind" media=${media} playing=${playing} />`}
    ${person}
    ${frame.graphics.filter((g) => !g.behind).map(gfx)}
    ${plan && (frame.adjust || []).map((a) => html`<${AdjustLayer} key=${a.clipId} a=${a} plan=${plan} />`)}
    ${plan && html`<${TextLayers} key="front" plan=${plan} frame=${frame} only="front" media=${media} playing=${playing} />`}`;
}

/**
 * Phase 2: the person laid back over the layers behind them, as the render does: the footage playing now (its own
 * <video>, not a second copy) drawn by the look canvas with its matte as the alpha, zoomed as the picture is. Only while
 * a layer behind the person is on screen and that block of the matte is made (else nothing: never the whole picture).
 */
function PersonLayer({ plan, frame, mattes, zoom = 1, luts }) {
  const i = frame?.part, part = i != null ? plan.parts[i] : null;
  const ref = useMemo(() => ({ get current() { return part ? document.querySelector(`video[data-video="${part.videoId}"][data-on="1"]`) : null; } }), [part?.videoId]);
  const t = frame?.t ?? 0;
  const name = part ? plan.person?.parts?.[i] : null, m = name ? mattes[name] : null;
  const on = !!m && (plan.person?.windows || []).some((w) => t >= w.start && t < w.end) && !!m.urls?.[Math.floor((frame?.src ?? 0) / (m.block || 10))];
  if (!on) return null;
  const lk = plan.looks?.[part.clipIds[0]] || null;
  return html`<div data-person=${name} style=${{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", transform: `scale(${zoom})`, transformOrigin: "50% 40%" }}><${LookCanvas} videoRef=${ref} look=${lk} W=${plan.width} H=${plan.height} rotate=${part.rotate || 0} fitY=${0.4} focus=${part.framing?.focus || null} luts=${luts} matte=${{ ...m, edge: 0, soft: 10, invert: false }} /></div>`;
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
/**
 * Phase 2b: a text layer drawn from a mask, as the render draws it: a library video inside its letters (the layer's
 * own block, laid out by the browser with its letters clear, draws the card, stroke, shadow and box), or its card with
 * the letters cut out. A canvas the size of the stage draws the letters where the block puts them (measured from it
 * every frame, so keyframes, animations and alignment carry over).
 */
function TextMatte({ l, block, W, H, alpha, cardAlpha, src, t, playing }) {
  const cv = useRef(null), vid = useRef(null), st = useRef({});
  st.current = { l, alpha, cardAlpha };
  const want = l.inside ? (((t - l.start + l.inside.from) % l.inside.seconds) + l.inside.seconds) % l.inside.seconds : 0;
  useEffect(() => {
    const el = vid.current; if (!el) return;
    if (playing) { if (Math.abs(el.currentTime - want) > 0.25) { try { el.currentTime = want; } catch {} } el.play().catch(() => {}); }
    else { el.pause(); if (Math.abs(el.currentTime - want) > 0.04) { try { el.currentTime = want; } catch {} } }
  }, [want, playing]);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = cv.current, b = block.current; if (!c || !b) return;
      const ctx = c.getContext("2d"), { l, alpha, cardAlpha } = st.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H);
      const v = vid.current;
      if (l.inside && !(v && v.readyState >= 2 && v.videoWidth)) return;
      // The block's place on the stage: its offset, then its transform about its origin (as CSS applies them).
      const cs = getComputedStyle(b), m = cs.transform && cs.transform !== "none" ? new DOMMatrix(cs.transform) : new DOMMatrix();
      const [ox, oy] = cs.transformOrigin.split(" ").map(parseFloat);
      const at = new DOMMatrix().translate(b.offsetLeft + ox, b.offsetTop + oy).multiply(m).translate(-ox, -oy);
      const d = drawnOf(l.style, W, H), asc = (d.size * d.face.winAscent) / (d.face.winAscent + d.face.winDescent), pad = d.box ? d.box.pad : 0;
      const letters = (op) => {
        ctx.save(); ctx.setTransform(at); ctx.globalCompositeOperation = op; ctx.fillStyle = "#ffffff";
        ctx.font = `400 ${cssSize(d.face, d.size)}px "${d.face.family}"`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        for (const sp of b.querySelectorAll("span[data-line]")) ctx.fillText(sp.textContent, sp.offsetLeft + pad, sp.offsetTop + asc);
        ctx.restore();
      };
      if (l.inside) {
        ctx.globalAlpha = alpha; letters("source-over"); ctx.globalAlpha = 1;
        // The video over the letters only, fitted to cover the frame.
        const k = Math.max(W / v.videoWidth, H / v.videoHeight), vw = v.videoWidth * k, vh = v.videoHeight * k;
        ctx.globalCompositeOperation = "source-in"; ctx.drawImage(v, (W - vw) / 2, (H - vh) / 2, vw, vh);
      } else {
        ctx.globalAlpha = cardAlpha * l.card.opacity; ctx.fillStyle = l.card.color; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
        letters("destination-out");
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [W, H]);
  return html`<canvas ref=${cv} width=${W} height=${H} data-matte=${l.clipId} style=${{ position: "absolute", left: 0, top: 0, width: W + "px", height: H + "px" }} />
    ${l.inside && html`<video ref=${vid} src=${src} crossOrigin="anonymous" muted playsInline preload="auto" loop style=${{ position: "absolute", width: "2px", height: "2px", opacity: 0 }} />`}`;
}

/** One text layer: its card and its block of lines (Phase 2b: drawn from a mask when it has a video inside its letters
 *  or is cut out of its card). */
function TextLayer({ l, opacity, scale, dy, look, W, H, media, t, playing }) {
  const block = useRef(null);
  const d = drawnOf(l.style, W, H); const ax = l.style.align === "left" ? 0 : l.style.align === "right" ? 100 : 50;
  // A keyframed layer (Phase 5): its anchor, scale, turn and opacity from textLookAt, as the ASS pieces draw it.
  const pos = look ? { left: look.x + "px", top: look.y + "px", transform: `translate(${-ax}%, -50%) rotate(${look.rotation}deg) scale(${look.scale})`, opacity: look.opacity } : { left: l.style.x * W + "px", top: l.style.y * H + dy + "px", transform: `translate(${-ax}%, -50%) scale(${scale})`, opacity };
  const matted = isMatted(l), cut = matted && !l.inside, src = l.inside ? media?.broll?.[l.inside.videoId]?.url : null;
  // A video inside: the letters clear (their stroke, shadow and box still drawn). Cut out: the block only measured.
  const font = matted ? { ...fontCss(cut ? { ...d, stroke: null, shadow: null } : d), color: "transparent" } : fontCss(d);
  return html`<div data-text=${l.clipId}>
    ${l.card && !cut && html`<div class="tcard" style=${{ background: rgba(l.card.color, l.card.opacity), opacity }} />`}
    <div class="tblock" ref=${block} style=${{ ...pos, transformOrigin: `${ax}% 50%`, textAlign: l.style.align, ...(cut ? { visibility: "hidden" } : {}) }}>
      ${l.lines.map((line, i) => html`<div key=${i}><span data-line=${i} style=${{ ...font, ...(cut ? {} : boxCss(d)) }}>${l.style.case === "upper" ? line.toUpperCase() : l.style.case === "lower" ? line.toLowerCase() : line}</span></div>`)}
    </div>
    ${matted && (cut || src) && html`<${TextMatte} l=${l} block=${block} W=${W} H=${H} alpha=${look ? look.opacity : opacity} cardAlpha=${opacity} src=${src} t=${t} playing=${playing} />`}
  </div>`;
}

function TextLayers({ plan, frame, only = "all", media = null, playing = false }) {
  const ref = useRef(); const [k, setK] = useState(0);
  useEffect(() => { if (fontsLoaded) return; fontsLoaded = true; const st = document.createElement("style"); st.id = "rc-fonts"; st.textContent = fontFaceCss("/fonts/"); document.head.appendChild(st); }, []);
  useEffect(() => { const el = ref.current; if (!el) return; const f = () => setK(el.clientWidth / plan.width); f(); const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect(); }, [plan.width]);
  const W = plan.width, H = plan.height;
  const cs = plan.captionStyle, cd = cs && drawnOf(cs, W, H);
  return html`<div ref=${ref} class="tlayers" data-k=${k} data-captions=${plan.styledCaptions?.length ?? 0} data-texts=${plan.texts?.length ?? 0}><div class="stage" style=${{ width: W + "px", height: H + "px", transform: `scale(${k})` }}>
    ${frame.texts.filter(({ layer: x }) => only === "all" || (only === "behind") === !!x.behind)
      // Phase 2b: as the render does, the layers drawn from a mask first on their side.
      .sort((a, b) => (isMatted(b.layer) ? 1 : 0) - (isMatted(a.layer) ? 1 : 0))
      .map(({ layer: l, opacity, scale, dy, look }) => html`<${TextLayer} key=${l.clipId} l=${l} opacity=${opacity} scale=${scale} dy=${dy} look=${look} W=${W} H=${H} media=${media} t=${frame.t ?? 0} playing=${playing} />`)}
    ${only !== "behind" && frame.captionLines && cd && html`<div class="tblock cap-layer" id="caption-layer" style=${{ left: cs.x * W + "px", top: cs.y * H + "px", transform: "translate(-50%, -100%)", textAlign: "center" }}>
      ${frame.captionLines.map((line, i) => html`<div key=${i}><span style=${{ ...fontCss(cd), ...boxCss(cd) }}>${line.map((w, j) => html`${j ? " " : ""}<span key=${j} data-active=${w.active ? "1" : null} style=${w.active ? { color: cs.highlight } : null}>${w.text}</span>`)}</span></div>`)}
    </div>`}
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
// Phase 11: anchor: the point keys turn and scale about (transform-origin, as the render's perspective maps it).
const motionCss = (m, anchor) => (m ? { transform: `translate(${m.x * 100}%, ${m.y * 100}%) rotate(${m.rotation}deg) scale(${m.scale})`, opacity: m.opacity, ...(anchor ? { transformOrigin: `${anchor.x * 100}% ${anchor.y * 100}%` } : {}) } : {});
// Phase 11: a mirror, as CSS (with the framing's own transform).
const flipCss = (f) => (f === "h" ? " scale(-1, 1)" : f === "v" ? " scale(1, -1)" : f === "both" ? " scale(-1, -1)" : "");
// Phase 11: a b-roll card's drop shadow, as CSS (blur and offsets are shares of the frame's short side).
const shadowCss = (sh, W, H, k) => { if (!sh) return null; const s = Math.min(W, H) * k, a = Math.round(sh.opacity * 255).toString(16).padStart(2, "0"); return `drop-shadow(${(sh.x * s).toFixed(1)}px ${(sh.y * s).toFixed(1)}px ${(sh.blur * s).toFixed(1)}px ${sh.color}${a})`; };
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
function Footage({ id, url, rotate, framing, motion, aspect, refFn, on = true, gl = false, look = null, plan = null, luts, card = null, matte = null, flip = null, anchor = null, t0 = 0, rate = 1 }) {
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
  const fx = (moved ? `translate(${framing.x * 100}%, ${framing.y * 100}%) scale(${framing.scale})` : "") + flipCss(flip);
  return html`<div style=${{ position: "absolute", inset: 0, ...motionCss(motion, anchor) }}>${layer(card?.shadow)}<div data-flip=${flip || null} style=${{ position: "absolute", inset: 0, transform: fx.trim() || "none" }}>
    <video ref=${(el) => { vEl.current = el; refFn?.(el); if (focus) sized(el); }} onLoadedMetadata=${(e) => focus && sized(e.currentTarget)} data-on=${on ? "1" : "0"} data-video=${id} src=${url} crossOrigin="anonymous" muted playsInline preload="auto" style=${{ objectFit: "cover", background: drawn ? "transparent" : "#000", ...fitVideoStyle(rotate || 0, aspect, crop), ...(drawn ? { opacity: 0 } : {}) }} />
    ${drawn && html`<${LookCanvas} videoRef=${vEl} look=${look} W=${plan.width} H=${plan.height} rotate=${rotate || 0} fitY=${0.4} focus=${focus} luts=${luts} onFail=${() => setNoGl(true)} matte=${matte} t0=${t0} rate=${rate} fps=${plan.fps || 30} />`}
  </div>${layer(card?.border)}</div>`;
}
/**
 * remove_background in the player: each matte of the plan (plan.mattes) as its blocks' links, asked again every 8 s
 * while some are still being made. Returns { [matte]: { urls, block, missing } }.
 */
function useMattes(projectId, plan) {
  const [got, setGot] = useState({});
  const want = useMemo(() => Object.entries(plan?.mattes || {}).map(([name, m]) => ({ name, videoId: m.videoId, from: m.blocks[0] * 10, to: m.blocks[m.blocks.length - 1] * 10 + 9.9, rotate: plan.parts.find((p) => p.videoId === m.videoId)?.rotate || 0 })), [plan?.mattes]);
  const key = JSON.stringify(want);
  useEffect(() => {
    if (!want.length || !projectId) return;
    let on = true, timer = 0;
    const ask = async () => {
      const out = {};
      for (const w of want) {
        try { const r = await api.matte(projectId, w.videoId, w.from, w.to, w.rotate); out[w.name] = { urls: r.blocks, block: r.block, missing: Object.values(r.blocks).filter((u) => !u).length }; } catch { /* asked again below */ }
      }
      if (!on) return;
      setGot(out);
      if (Object.values(out).some((m) => m.missing) || Object.keys(out).length < want.length) timer = setTimeout(ask, 8000);
    };
    ask();
    return () => { on = false; clearTimeout(timer); };
  }, [projectId, key]);
  return got;
}
function SeqMedia({ plan, clock, time, playing, urls, sounds = {}, aspect, pb, broll = {}, luts, mattes = {} }) {
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
    // Phase 15: the clip's own pan, EQ and reverb heard live (the sound part's clip, as the render applies them).
    if (playing) resumeLiveAudio();
    const sp = snd ? plan.sound[snd.i] : null, fx = sp ? plan.audioMix?.clipFx?.[sp.clipId] : null;
    for (const [id, el] of Object.entries(vref.current)) {
      const on = part?.videoId === id;
      el.muted = !(on && own && !snd.muted); el.volume = vol(lv.dialogue);
      applyLiveFx(el, on && own ? fx : null);
      // At normal speed it plays the sound's own moment (cut to the millisecond); its frame is the one the render shows.
      if (on) follow(el, own && pic.rate === 1 ? snd.src : pic.src, playing, pic.rate); else if (!el.paused) el.pause();
    }
    for (const [id, el] of Object.entries(aref.current)) {
      el.volume = vol(lv.dialogue);
      applyLiveFx(el, snd && !own && snd.videoId === id ? fx : null);
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
      const op = x && plan.audio.find((a) => a.clipId === id);
      applyLiveFx(el, op ? { pan: op.pan, eq: op.eq, reverb: op.reverb } : null);
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
  // remove_background: the clip's matte (its blocks' links) with its edge, softness and invert, for the look canvas.
  const matteOf = (lk) => matteFrom(lk, mattes);
  return html`<div ref=${box} style="position:absolute;inset:0"><${BackLayer} plan=${plan} time=${time} playing=${playing} broll=${broll} part=${part} partUrl=${part ? urls[part.videoId] : null} aspect=${aspect} k=${k} />${under.map((u) => html`<div key=${"u" + u.clipId} data-under=${u.clipId} style=${{ position: "absolute", inset: 0, pointerEvents: "none", ...motionCss(u.motion, u.anchor) }}><div style=${{ position: "absolute", inset: 0, transform: flipCss(u.flip).trim() || "none" }}><${SyncedVideo} src=${broll[u.videoId].url} time=${u.src} playing=${playing} look=${looks[u.clipId]} plan=${plan} luts=${luts} /></div>${u.border && plan?.lookFiles?.[u.border.file] && html`<${CardLayer} spec=${plan.lookFiles[u.border.file]} color=${u.border.color} W=${plan.width} H=${plan.height} />`}</div>`)}
    ${plan.sources.map((id) => {
    const on = part?.videoId === id; const p = on ? part : plan.parts.find((x) => x.videoId === id);
    return html`<div key=${id} style=${{ position: "absolute", inset: 0, visibility: on ? "visible" : "hidden" }}>
      ${urls[id] ? html`<${Footage} id=${id} url=${urls[id]} rotate=${p?.rotate} framing=${p?.framing} flip=${p?.flip} anchor=${on ? fr.motionAnchor : null} motion=${on ? fr.motion : null} aspect=${aspect} on=${on} gl=${glVideo.has(id)} look=${on && fr.lookId ? looks[fr.lookId] : null} matte=${on && fr.lookId ? matteOf(looks[fr.lookId]) : null} plan=${plan} luts=${luts} card=${p ? cards[p.clipIds[0]] : null} t0=${on && p ? p.srcIn : 0} rate=${on && p ? Math.abs(rateOf(p)) || 1 : 1} refFn=${(el) => { if (el) vref.current[id] = el; else delete vref.current[id]; }} />`
        : on && html`<div style="position:absolute;inset:0;display:grid;place-items:center;background:#000;color:#999"><span class="t-small">No preview copy of this video</span></div>`}
      ${urls[id] && html`<audio ref=${(el) => { if (el) aref.current[id] = el; else delete aref.current[id]; }} data-sound=${id} src=${urls[id]} crossOrigin="anonymous" preload=${jl ? "auto" : "none"} />`}
    </div>`;
  })}
    ${near.map((x) => { const active = tr?.op === x;
      const side = (s) => { const now = active ? tr[s] : null; const seg = x[s][0]; const l = active ? look[s] : { x: 0, y: 0, opacity: 0 };
        // Phase 12: B's clip-path or mask (wipes, iris, barn door, diamond, clock) and A's zoom (cross zoom).
        const cut = active && s === "b" ? { ...(look.clip ? { clipPath: look.clip, WebkitClipPath: look.clip } : {}), ...(look.mask ? { maskImage: look.mask, WebkitMaskImage: look.mask, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" } : {}) } : {};
        const zoomA = active && s === "a" && look.aScale ? ` scale(${look.aScale})` : "";
        return html`<div key=${s} data-side=${s} style=${{ position: "absolute", inset: 0, transform: `translate(${(l.x / plan.width) * 100}%, ${(l.y / plan.height) * 100}%)${zoomA}`, opacity: l.opacity, ...cut }}>
          ${urls[seg.videoId] && html`<${Footage} id=${seg.videoId} url=${urls[seg.videoId]} rotate=${(now || seg).rotate} framing=${(now || seg).framing} motion=${now?.motion} aspect=${aspect} gl=${!!looks[(now || seg).clipId]} look=${looks[(now || seg).clipId] || null} matte=${matteOf(looks[(now || seg).clipId])} plan=${plan} luts=${luts} card=${cards[(now || seg).clipId] || null} refFn=${(el) => { if (el) tref.current[x.clipId + s] = el; else delete tref.current[x.clipId + s]; }} />`}</div>`; };
      return html`<div key=${"tr" + x.clipId} class="tlayer" data-transition=${x.type} style=${{ position: "absolute", inset: 0, overflow: "hidden", background: under.length || plan.background ? "transparent" : "#000", visibility: active ? "visible" : "hidden", filter: active && (look.blur.x || look.blur.y) ? `url(#${blurId})` : "none" }}>${plan.background && !under.length && active ? html`<${BackLayer} plan=${plan} time=${time} playing=${playing} broll=${broll} part=${part} partUrl=${part ? urls[part.videoId] : null} aspect=${aspect} k=${k} />` : null}${side("a")}${side("b")}</div>`; })}
    ${look?.color && html`<div class="tdip" style=${{ position: "absolute", inset: 0, background: look.color.hex, opacity: look.color.opacity }} />`}
    ${look?.flash && look.flash.level > 0.002 ? html`<div class="tflash" data-level=${Math.round(look.flash.level * 1000) / 1000} style=${{ position: "absolute", inset: 0, pointerEvents: "none", backdropFilter: `brightness(${look.flash.bright.toFixed(3)})`, WebkitBackdropFilter: `brightness(${look.flash.bright.toFixed(3)})`, background: `rgba(255,255,255,${look.flash.lift.toFixed(3)})` }} />` : null}
    ${look && (look.blur.x || look.blur.y) ? html`<svg width="0" height="0" style="position:absolute"><filter id=${blurId} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation=${`${look.blur.x * k} ${look.blur.y * k}`} /></filter></svg>` : null}
  </div>${plan.audio.map((a) => sounds[a.assetKey] && html`<audio key=${a.clipId} ref=${(el) => { if (el) mref.current[a.clipId] = el; else delete mref.current[a.clipId]; }} data-music=${a.clipId} data-kind=${a.kind} src=${sounds[a.assetKey]} crossOrigin="anonymous" loop=${a.kind === "music"} preload="auto" />`)}`;
}

export { BLEND_NAME, LiveOverlays, MARK_COLORS, PersonLayer, SeqMedia, TextLayers, WaveLayer, loadPeaks, markNote, readFlag, useMattes, writeFlag };
