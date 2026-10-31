// Colour and compositing in the editor (Phase 6): the look canvas the player draws a clip through (the render's
// numbers, see look-gl.js), the Color tab (grade, LUTs, copy, match, key, masks, blur/pixelate, under layer, HDR) and
// the overlay on the picture (mask outlines, drawing a path, picking the key colour). Every control sends the
// connector's own op.
import { useState, useEffect, useRef, useMemo, html, Btn, Icon } from "./ui";
import { api } from "./api";
import { OpColor, OpSlider, OpWheel } from "./controls";
import { createLookRenderer } from "./look-gl";
import { areaAt, areaPicture, buildLut, hueCurveFn, valueCurveFn, sampleLut, WHEELS, moving, CURVE_CHANNELS, curveFn, fitCrop, gradeText, hashOf, hexRgb, lutSizeFor, maskPicture, mergeGrade, parseCube, SKIN_DEFAULTS, spillType, SUBJECT_DEFAULTS } from "@rendrr/shared";

// ---------------------------------------------------------------------------------------------
// Imported LUTs: their numbers, loaded once per page.
// ---------------------------------------------------------------------------------------------
const lutData = {}; const lutLoading = {};
/** The imported LUTs these ids name, parsed; re-renders when one arrives. */
export function useLutData(ids) {
  const [n, bump] = useState(0);
  const key = ids.slice().sort().join(",");
  useEffect(() => {
    for (const id of ids) {
      if (lutData[id] || lutLoading[id]) continue;
      lutLoading[id] = api.lutText(id).then((t) => { lutData[id] = parseCube(t); bump((x) => x + 1); }).catch(() => { lutLoading[id] = null; });
    }
  }, [key]);
  return useMemo(() => Object.fromEntries(ids.filter((id) => lutData[id]).map((id) => [id, lutData[id]])), [key, n]);
}

// ---------------------------------------------------------------------------------------------
// The look as the renderer draws it: the grade's LUT, the key, the mask and area pictures at the plan's size.
// ---------------------------------------------------------------------------------------------
const specs = new Map();
export function lookSpec(look, W, H, luts = {}) {
  const lutReady = look?.grade?.lut ? !!luts[look.grade.lut.id] : true;
  const id = look ? hashOf([look.grade, look.key, look.masks, look.effects, look.skin?.skin, W, H, lutReady]) : `plain${W}x${H}`;
  if (specs.has(id)) return specs.get(id);
  const g = look?.grade;
  const spec = {
    id, W, H,
    lut: g ? { id: hashOf([g, lutReady]), n: lutSizeFor(g), data: buildLut(g, g.lut ? luts[g.lut.id] : null, lutSizeFor(g)) } : null,
    key: look?.key ? { rgb: hexRgb(look.key.color).map((v) => v / 255), sim: look.key.similarity, blend: look.key.blend, spill: look.key.spill, blue: spillType(look.key) === "blue" } : null,
    mask: look?.masks?.length ? { key: hashOf([look.masks, W, H]), px: maskPicture(look.masks, W, H) } : null,
    effects: (look?.effects || []).map((e) => ({ type: e.type, px: e.px, amount: e.amount, area: e.area ? { key: hashOf([e.area, W, H]), px: areaPicture(e.area, W, H) } : null })),
    skin: look?.skin ? { p: look.skin.p, area: look.skin.skin.area ? { key: hashOf([look.skin.skin.area, W, H]), px: areaPicture(look.skin.skin.area, W, H) } : null } : null,
  };
  // Phase 3: masks and areas with keys are drawn again at each footage moment (lookSpecAt).
  spec.moving = !!look && [...(look.masks || []), ...(look.effects || []).map((e) => e.area), look.skin?.skin.area].some((a) => moving(a));
  spec.look = look;
  specs.set(id, spec);
  if (specs.size > 40) specs.delete(specs.keys().next().value);
  return spec;
}

/**
 * Phase 3: the spec at footage second t: its moving masks and areas where their keys put them then, drawn small (at
 * most 320 wide; the shader stretches them over the frame, as the render scales its mask video). The last few are kept.
 */
const atCache = new Map();
export function lookSpecAt(spec, t) {
  if (!spec.moving) return spec;
  const look = spec.look, sw = Math.min(spec.W, 320), sh = Math.max(2, Math.round((spec.H * sw) / spec.W));
  const masks = (look.masks || []).map((m) => areaAt(m, t)), areas = (look.effects || []).map((e) => (e.area ? areaAt(e.area, t) : null)), sa = look.skin?.skin.area ? areaAt(look.skin.skin.area, t) : null;
  const key = hashOf([spec.id, masks, areas, sa]);
  if (atCache.has(key)) return atCache.get(key);
  const pic = (px, k) => ({ key: k, px, w: sw, h: sh });
  const out = {
    ...spec,
    mask: masks.length ? pic(maskPicture(masks, sw, sh), hashOf([key, "m"])) : spec.mask,
    effects: spec.effects.map((e, i) => (areas[i] ? { ...e, area: pic(areaPicture(areas[i], sw, sh), hashOf([key, "e", i])) } : e)),
    skin: spec.skin && sa ? { ...spec.skin, area: pic(areaPicture(sa, sw, sh), hashOf([key, "s"])) } : spec.skin,
  };
  atCache.set(key, out);
  if (atCache.size > 8) atCache.delete(atCache.keys().next().value);
  return out;
}

/**
 * The picture of one video element drawn through its look, the size of the plan. The video stays the clock (hidden);
 * the canvas redraws on every new frame, seek and look change. onFail: no WebGL2 here (the video then shows plain).
 * matte (remove_background): { urls (each block's link by number; null while it is made), block (seconds), edge, soft,
 * invert }: a hidden video of the person's matte follows the footage's time, block by block.
 */
export function LookCanvas({ videoRef, look, W, H, rotate = 0, fitY = 0.4, focus = null, luts, onFail, matte = null }) {
  const cv = useRef(null);
  const spec = lookSpec(look, W, H, luts);
  const cur = useRef(null);
  cur.current = { ...spec, rotate, fitY, focus, matte };
  useEffect(() => {
    let r = null;
    try { r = createLookRenderer(cv.current); } catch (e) { console.warn(e); }
    if (!r) { onFail?.(); return; }
    let raf = 0, last = "", dirty = true, el = null;
    const mark = () => { dirty = true; };
    const mv = document.createElement("video");
    mv.muted = true; mv.playsInline = true; mv.crossOrigin = "anonymous"; mv.preload = "auto";
    mv.addEventListener("seeked", mark); mv.addEventListener("loadeddata", mark);
    // The matte's block at the footage's time, seeked (paused) or playing along (corrected when it drifts).
    const matteAt = (s) => {
      const m = s.matte; if (!m || !el) return null;
      const t = el.currentTime, k = Math.floor(t / m.block), url = m.urls?.[k];
      if (!url) return null;
      if (mv.dataset.k !== String(k)) { mv.src = url; mv.dataset.k = String(k); }
      const want = t - k * m.block;
      if (!el.paused) { if (Math.abs(mv.playbackRate - el.playbackRate) > 1e-3) mv.playbackRate = el.playbackRate; if (mv.paused) mv.play().catch(() => {}); if (Math.abs(mv.currentTime - want) > 0.12) { try { mv.currentTime = want; } catch {} } }
      else { if (!mv.paused) mv.pause(); if (Math.abs(mv.currentTime - want) > 0.02) { try { mv.currentTime = want; } catch {} } }
      return { el: mv, edge: m.edge, soft: m.soft, invert: m.invert };
    };
    const onFrame = () => { dirty = true; if (el?.requestVideoFrameCallback) el.requestVideoFrameCallback(onFrame); };
    const tick = () => {
      const v = videoRef.current;
      if (v !== el) {
        el?.removeEventListener("seeked", mark); el?.removeEventListener("loadeddata", mark);
        el = v; dirty = true;
        if (el) { el.addEventListener("seeked", mark); el.addEventListener("loadeddata", mark); if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(onFrame); }
      }
      const s = cur.current;
      if (el && s && el.readyState >= 2 && el.videoWidth) {
        const mt = matteAt(s);
        const k = `${el.currentTime.toFixed(4)}|${s.id}|${s.rotate}|${s.fitY}|${s.focus ? s.focus.x + "," + s.focus.y : ""}|${mt ? `${mv.currentTime.toFixed(4)},${mt.edge},${mt.soft},${mt.invert}` : ""}`;
        if (dirty || k !== last || !el.paused) {
          try { r.draw(el, lookSpecAt(s, el.currentTime), mt); cv.current.dataset.drawn = String((+cv.current.dataset.drawn || 0) + 1); if (mt) cv.current.dataset.matte = mv.dataset.k; } catch (e) { console.warn(e); }
          last = k; dirty = false;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); el?.removeEventListener("seeked", mark); el?.removeEventListener("loadeddata", mark); mv.removeAttribute("src"); mv.load(); r.dispose(); };
  }, []);
  return html`<canvas ref=${cv} data-look=${look ? "1" : "plain"} style=${{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />`;
}

/** The colour at (fx, fy) (shares of the frame) of a video's current frame as the render fits it (for the key). */
export function pickColor(video, W, H, rotate, fitY, fx, fy, focus = null) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return null;
  const turned = rotate === 90 || rotate === 270;
  const tw = turned ? vh : vw, th = turned ? vw : vh;
  const s = Math.max(W / tw, H / th);
  const crop = focus ? fitCrop(focus, tw, th, W, H) : { cx: 0.5, cy: fitY };
  const u = [(fx * W + (tw * s - W) * crop.cx) / s, (fy * H + (th * s - H) * crop.cy) / s];
  const v = rotate === 90 ? [u[1], vh - u[0]] : rotate === 270 ? [vw - u[1], u[0]] : rotate === 180 ? [vw - u[0], vh - u[1]] : u;
  const c = document.createElement("canvas"); c.width = 3; c.height = 3;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(video, Math.max(0, v[0] - 1.5), Math.max(0, v[1] - 1.5), 3, 3, 0, 0, 3, 3);
  const d = g.getImageData(0, 0, 3, 3).data; let r = 0, gg = 0, b = 0;
  for (let i = 0; i < 9; i++) { r += d[i * 4]; gg += d[i * 4 + 1]; b += d[i * 4 + 2]; }
  return "#" + [r, gg, b].map((x) => Math.round(x / 9).toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// The overlay on the picture while the Color tab is open: outlines of the clip's masks and effect areas; a path being
// drawn; clicks that add a path point or pick the key colour.
// ---------------------------------------------------------------------------------------------
export function MaskOverlay({ shapes, mode, draft, onPoint }) {
  const box = useRef(null);
  const at = (e) => { const r = box.current.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000, Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000]; };
  const shapeEl = (s, i) => {
    const st = { fill: "none", stroke: s.kind === "mask" ? "#4ade80" : "#60a5fa", strokeWidth: 1.5, vectorEffect: "non-scaling-stroke", strokeDasharray: s.invert ? "4 3" : null };
    if (s.shape === "rect") return html`<rect key=${i} x=${s.x} y=${s.y} width=${s.w} height=${s.h} style=${st} />`;
    if (s.shape === "ellipse") return html`<ellipse key=${i} cx=${s.x + s.w / 2} cy=${s.y + s.h / 2} rx=${s.w / 2} ry=${s.h / 2} style=${st} />`;
    return html`<polygon key=${i} points=${s.points.map((p) => p.join(",")).join(" ")} style=${st} />`;
  };
  return html`<div ref=${box} id="mask-overlay" data-mode=${mode || ""} style=${{ position: "absolute", inset: 0, cursor: mode ? "crosshair" : "default", pointerEvents: mode ? "auto" : "none", zIndex: 5 }} onClick=${(e) => mode && onPoint(at(e))}>
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" width="100%" height="100%" style="position:absolute;inset:0;overflow:visible">
      ${shapes.map(shapeEl)}
      ${draft?.length ? html`<polyline points=${draft.map((p) => p.join(",")).join(" ")} style=${{ fill: "none", stroke: "#facc15", strokeWidth: 2, vectorEffect: "non-scaling-stroke" }} />` : null}
      ${(draft || []).map((p, i) => html`<circle key=${i} cx=${p[0]} cy=${p[1]} r="0.006" style=${{ fill: "#facc15" }} />`)}
    </svg>
    ${mode && html`<div class="t-small" style="position:absolute;left:8px;top:8px;background:rgba(0,0,0,.6);color:#fff;padding:4px 8px;border-radius:6px">${mode === "pick" ? "Click the colour to remove" : "Click to add points; Done in the Color tab when the shape is closed"}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// A curve editor: drag a point, click to add one, double-click a point to remove it. Live while dragging, one undo step.
// ---------------------------------------------------------------------------------------------
const CH_COLOR = { master: "#e5e7eb", r: "#f87171", g: "#4ade80", b: "#60a5fa" };
function CurveEditor({ id, points, color, opFor, H, liveOp, doOp }) {
  const box = useRef(null); const drag = useRef(null);
  const pts = points?.length ? points : [];
  const f = useMemo(() => curveFn(pts.length ? pts : [[0, 0], [1, 1]]), [JSON.stringify(pts)]);
  const path = Array.from({ length: 65 }, (_, i) => `${i ? "L" : "M"}${(i / 64) * 100},${100 - f(i / 64) * 100}`).join(" ");
  const at = (e) => { const r = box.current.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))].map((v) => Math.round(v * 1000) / 1000); };
  const down = (e, i) => {
    e.preventDefault(); e.stopPropagation();
    const base = H.state;
    let list = pts.slice();
    if (i == null) { const p = at(e); list = [...list, p].sort((a, b) => a[0] - b[0]); i = list.indexOf(p); }
    drag.current = { base, list, i };
    liveOp(base, opFor(list));
    const move = (ev) => { const d = drag.current; if (!d) return; const p = at(ev); d.list = d.list.map((q, j) => (j === d.i ? p : q)); liveOp(d.base, opFor(d.list.slice().sort((a, b) => a[0] - b[0]))); };
    const up = () => { const d = drag.current; drag.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (d) H.commitFrom(d.base); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return html`<svg ref=${box} id=${id} viewBox="0 0 100 100" style="width:100%;max-width:220px;aspect-ratio:1;background:var(--surface-2, #111);border-radius:8px;touch-action:none;cursor:crosshair" onPointerDown=${(e) => down(e, null)}>
    <path d="M0,100 L100,0" style="stroke:#555;stroke-width:0.5;fill:none" />
    <path d=${path} style=${{ stroke: color, strokeWidth: 1.5, fill: "none" }} />
    ${pts.map((p, i) => html`<circle key=${i} cx=${p[0] * 100} cy=${100 - p[1] * 100} r="3" style=${{ fill: color, cursor: "grab" }} onPointerDown=${(e) => down(e, i)} onDblClick=${(e) => { e.stopPropagation(); doOp(opFor(pts.filter((_, j) => j !== i)), false); }} />`)}
  </svg>`;
}

// ---------------------------------------------------------------------------------------------
// The Color tab
// ---------------------------------------------------------------------------------------------
const pct = (v) => Math.round(v * 100) + "%";
const sgn = (v, d = 0) => (v > 0 ? "+" : "") + (d ? v.toFixed(d) : Math.round(v));
const BOX = (shape) => ({ shape, x: 0.25, y: 0.2, w: 0.5, h: 0.6 });
const SHAPE_NAME = { rect: "Rectangle", ellipse: "Ellipse", path: "Path" };

/** A shape held still where it is now (its keys and any face it followed dropped). */
const stillArea = ({ keys: _k, follow: _f, ...a }) => a;

/** Sliders for a shape's box and feather, and its invert box (masks and effect areas). Phase 3: follow(a, on) makes a
 *  rect or ellipse follow the face (V1 clips; null elsewhere); a shape that moves says so and can be held still. */
function AreaControls({ idp, a, set, sl, follow, busy }) {
  const mv = moving(a), placed = a.shape !== "path" && !mv;
  return html`<div class="col" style="gap:6px">
    ${a.shape !== "path" && follow && html`<label class="t-small row" style="gap:6px"><input type="checkbox" id=${idp + "-follow"} disabled=${busy} checked=${a.follow === "face"} onChange=${(e) => follow(a, e.target.checked)} />Follow the face${busy ? " (measuring…)" : ""}</label>`}
    ${mv && html`<div class="row between" id=${idp + "-moving"}><span class="t-small muted">${a.follow === "face" ? `Follows the face (${a.keys.length} keys)` : `Moves (${a.keys.length} keys, ${a.keys[0].at.toFixed(1)}-${a.keys[a.keys.length - 1].at.toFixed(1)}s)`}</span>
      <${Btn} kind="ghost" size="xs" id=${idp + "-still"} onClick=${() => set(stillArea(a), true)}>Hold still<//></div>`}
    ${placed && html`<div class="row" style="gap:8px">
      <div class="grow"><${OpSlider} id=${idp + "-x"} label="Left" value=${a.x} min=${-0.5} max=${1} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, x: v })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-y"} label="Top" value=${a.y} min=${-0.5} max=${1} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, y: v })} ...${sl} /></div></div>
    <div class="row" style="gap:8px">
      <div class="grow"><${OpSlider} id=${idp + "-w"} label="Width" value=${a.w} min=${0.02} max=${1.5} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, w: v })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-h"} label="Height" value=${a.h} min=${0.02} max=${1.5} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, h: v })} ...${sl} /></div></div>`}
    <${OpSlider} id=${idp + "-feather"} label="Feather" value=${a.feather || 0} min=${0} max=${0.3} step=${0.005} show=${pct} opFor=${(v) => set({ ...a, feather: v })} ...${sl} />
    <label class="t-small row" style="gap:6px"><input type="checkbox" id=${idp + "-invert"} checked=${!!a.invert} onChange=${(e) => set({ ...a, invert: e.target.checked }, true)} />Outside instead (invert)</label>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Phase 5: Lumetri's tone, vibrance, colour wheels, Hue vs Sat and HSL secondaries (all in the grade's LUT, so the
// player and the render draw them with the same numbers), and scopes.
const WHEEL_NAME = { shadows: "Shadows", midtones: "Midtones", highlights: "Highlights" };
const HUE_BANDS = [["Red", 0], ["Yellow", 60], ["Green", 120], ["Cyan", 180], ["Blue", 240], ["Magenta", 300]];
// Phase 14: Luma vs Sat at five brightnesses.
const LUMA_BANDS = [["Blacks", 0], ["Shadows", 0.25], ["Midtones", 0.5], ["Highlights", 0.75], ["Whites", 1]];
const HSL_PRESETS = [["Skin", { hue: 25, range: 40, satMin: 0.15 }], ["Sky", { hue: 210, range: 50 }], ["Greens", { hue: 110, range: 60 }]];

/** The grade's Phase 5 controls; idp keeps the ids apart (a clip's page and the whole edit's). */
function GradeMore({ idp, g, gop, doOp, sl }) {
  const hsCurve = g.hueSat?.length ? hueCurveFn(g.hueSat) : null;
  const band = (i) => (hsCurve ? hsCurve(HUE_BANDS[i][1] / 360) : 0.5);
  const setBand = (i, v) => { const pts = HUE_BANDS.map((b, j) => [b[1] / 360, Math.round((j === i ? v : band(j)) * 1000) / 1000]); return gop({ hueSat: pts.every((q) => Math.abs(q[1] - 0.5) < 0.005) ? null : pts }); };
  // Phase 14: Hue vs Hue (a turn in degrees at six colours) and Luma vs Sat (saturation at five brightnesses).
  const hhCurve = g.hueHue?.length ? hueCurveFn(g.hueHue) : null;
  const hhDeg = (i) => (hhCurve ? Math.round((hhCurve(HUE_BANDS[i][1] / 360) - 0.5) * 360) : 0);
  const setHh = (i, deg) => { const pts = HUE_BANDS.map((b, j) => [b[1] / 360, Math.round((0.5 + (j === i ? deg : hhDeg(j)) / 360) * 1000) / 1000]); return gop({ hueHue: pts.every((q) => Math.abs(q[1] - 0.5) < 0.002) ? null : pts }); };
  const lsCurve = g.lumaSat?.length ? valueCurveFn(g.lumaSat) : null;
  const lsPct = (i) => (lsCurve ? Math.round(lsCurve(LUMA_BANDS[i][1]) * 200) : 100);
  const setLs = (i, pct) => { const pts = LUMA_BANDS.map((b, j) => [b[1], Math.round(((j === i ? pct : lsPct(j)) / 200) * 1000) / 1000]); return gop({ lumaSat: pts.every((q) => Math.abs(q[1] - 0.5) < 0.003) ? null : pts }); };
  const hsl = g.hsl || [];
  const setQ = (i, patch) => gop({ hsl: hsl.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const tone = (k, label) => html`<div class="grow"><${OpSlider} id=${`${idp}-${k}`} label=${label} value=${g[k] || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ [k]: v })} ...${sl} /></div>`;
  return html`<div class="col" style="gap:14px" id=${idp + "-more"}>
    <div class="col" style="gap:6px" id=${idp + "-light"}><span class="t-small muted">Light</span>
      <div class="row" style="gap:8px">${tone("highlights", "Highlights")}${tone("shadows", "Shadows")}</div>
      <div class="row" style="gap:8px">${tone("whites", "Whites")}${tone("blacks", "Blacks")}</div>
      <${OpSlider} id=${idp + "-vibrance"} label="Vibrance" value=${g.vibrance || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ vibrance: v })} ...${sl} /></div>
    <div class="col" style="gap:6px" id=${idp + "-wheels"}><div class="row between"><span class="t-small muted">Colour wheels</span>
      <span style=${{ visibility: g.wheels ? "visible" : "hidden" }}><${Btn} kind="ghost" size="xs" id=${idp + "-wheels-reset"} disabled=${!g.wheels} onClick=${() => doOp(gop({ wheels: null }), false)}>Reset<//></span></div>
      <div class="row" style="justify-content:space-between;gap:6px">${WHEELS.map((k) => html`<div key=${k} class="col wheel-col" style="gap:4px;width:31%;min-width:0;align-items:stretch">
        <${OpWheel} id=${`${idp}-wheel-${k}`} label=${WHEEL_NAME[k]} value=${g.wheels?.[k]} opFor=${(w) => gop({ wheels: { [k]: w } })} ...${sl} />
        <${OpSlider} id=${`${idp}-wheel-${k}-luma`} label="Luma" value=${g.wheels?.[k]?.luma || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ wheels: { [k]: { luma: v } } })} ...${sl} /></div>`)}</div></div>
    <div class="col" style="gap:4px" id=${idp + "-huesat"}><div class="row between"><span class="t-small muted">Hue vs Sat</span>
      <span style=${{ visibility: g.hueSat ? "visible" : "hidden" }}><${Btn} kind="ghost" size="xs" id=${idp + "-huesat-reset"} disabled=${!g.hueSat} onClick=${() => doOp(gop({ hueSat: null }), false)}>Reset<//></span></div>
      ${HUE_BANDS.map(([n, h], i) => html`<${OpSlider} key=${n} id=${`${idp}-huesat-${n.toLowerCase()}`} label=${html`<span style=${{ color: `hsl(${h},80%,60%)` }}>■</span> ${n}`} value=${band(i)} min=${0} max=${1} step=${0.01} show=${(v) => Math.round(v * 200) + "%"} opFor=${(v) => setBand(i, v)} ...${sl} />`)}</div>
    <div class="col" style="gap:4px" id=${idp + "-huehue"}><div class="row between"><span class="t-small muted">Hue vs Hue</span>
      <span style=${{ visibility: g.hueHue ? "visible" : "hidden" }}><${Btn} kind="ghost" size="xs" id=${idp + "-huehue-reset"} disabled=${!g.hueHue} onClick=${() => doOp(gop({ hueHue: null }), false)}>Reset<//></span></div>
      ${HUE_BANDS.map(([n, h], i) => html`<${OpSlider} key=${n} id=${`${idp}-huehue-${n.toLowerCase()}`} label=${html`<span style=${{ color: `hsl(${h},80%,60%)` }}>■</span> ${n}`} value=${hhDeg(i)} min=${-90} max=${90} step=${1} show=${(v) => sgn(v) + "°"} opFor=${(v) => setHh(i, v)} ...${sl} />`)}</div>
    <div class="col" style="gap:4px" id=${idp + "-lumasat"}><div class="row between"><span class="t-small muted">Luma vs Sat</span>
      <span style=${{ visibility: g.lumaSat ? "visible" : "hidden" }}><${Btn} kind="ghost" size="xs" id=${idp + "-lumasat-reset"} disabled=${!g.lumaSat} onClick=${() => doOp(gop({ lumaSat: null }), false)}>Reset<//></span></div>
      ${LUMA_BANDS.map(([n], i) => html`<${OpSlider} key=${n} id=${`${idp}-lumasat-${n.toLowerCase()}`} label=${n} value=${lsPct(i)} min=${0} max=${200} step=${1} show=${(v) => v + "%"} opFor=${(v) => setLs(i, v)} ...${sl} />`)}</div>
    <div class="col" style="gap:6px" id=${idp + "-hsl"}><div class="row between"><span class="t-small muted">HSL secondaries</span><span class="row" style="gap:4px">
      ${HSL_PRESETS.map(([n, q]) => html`<${Btn} key=${n} kind="ghost" size="xs" id=${`${idp}-hsl-add-${n.toLowerCase()}`} disabled=${hsl.length >= 4} onClick=${() => doOp(gop({ hsl: [...hsl, q] }))}>+ ${n}<//>`)}</span></div>
      ${hsl.length ? hsl.map((q, i) => html`<div key=${i} class="col card flat" style="gap:6px;padding:10px" data-hsl=${i}>
        <div class="row between"><span class="t-small"><span style=${{ color: `hsl(${q.hue},80%,55%)` }}>■</span> Colours near ${Math.round(q.hue)}°</span>
          <button class="btn icon sm quiet" aria-label="Remove" id=${`${idp}-hsl-del-${i}`} onClick=${() => doOp(gop({ hsl: hsl.filter((_, j) => j !== i) }), false)}><${Icon} name="x" size="12" /></button></div>
        <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id=${`${idp}-hsl-${i}-hue`} label="Hue" value=${q.hue} min=${0} max=${360} step=${1} show=${(v) => v + "°"} opFor=${(v) => setQ(i, { hue: v })} ...${sl} /></div>
          <div class="grow"><${OpSlider} id=${`${idp}-hsl-${i}-range`} label="Range" value=${q.range ?? 40} min=${4} max=${180} step=${1} show=${(v) => "±" + v / 2 + "°"} opFor=${(v) => setQ(i, { range: v })} ...${sl} /></div></div>
        <${OpSlider} id=${`${idp}-hsl-${i}-shift`} label="Hue shift" value=${q.hueShift || 0} min=${-180} max=${180} step=${1} show=${(v) => sgn(v) + "°"} opFor=${(v) => setQ(i, { hueShift: v })} ...${sl} />
        <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id=${`${idp}-hsl-${i}-sat`} label="Saturation" value=${q.saturation ?? 100} min=${0} max=${300} step=${1} show=${(v) => v + "%"} opFor=${(v) => setQ(i, { saturation: v })} ...${sl} /></div>
          <div class="grow"><${OpSlider} id=${`${idp}-hsl-${i}-light`} label="Lightness" value=${q.lightness || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => setQ(i, { lightness: v })} ...${sl} /></div></div>
      </div>`) : html`<p class="t-small muted">Change one colour only: the skin, the sky, the greens.</p>`}</div>
  </div>`;
}

/**
 * Phase 5: scopes of the picture showing now, through this grade (its LUT at 17 points, trilinear): a luma waveform and
 * a vectorscope (BT.709 Cb/Cr, the skin line at 123°). From a 160-wide copy of the frame, again a few times a second
 * while open.
 */
export function Scopes({ idp, grade, luts }) {
  const [on, setOn] = useState(false), [err, setErr] = useState(""), [mode, setMode] = useState("luma");
  const wave = useRef(null), vec = useRef(null);
  const key = JSON.stringify(grade || null);
  useEffect(() => {
    if (!on) return;
    const lut = grade && Object.keys(grade).length ? { kind: "3d", size: 17, data: buildLut(grade, grade.lut ? luts?.[grade.lut.id] : null, 17), min: [0, 0, 0], max: [1, 1, 1] } : null;
    const src = document.createElement("canvas"); let last = "";
    const draw = () => {
      const el = document.querySelector('video[data-on="1"]') || document.querySelector("#color-panel video, video");
      if (!wave.current || !vec.current) return;
      if (!el || el.readyState < 2) { setErr("No picture to measure here yet: play or seek the edit."); return; }
      const k = `${el.currentTime.toFixed(3)}|${el.src}`; if (k === last) return; last = k;
      const w = 160, h = Math.max(1, Math.round((160 * (el.videoHeight || 9)) / (el.videoWidth || 16)));
      src.width = w; src.height = h;
      const sx = src.getContext("2d", { willReadFrequently: true });
      let px;
      try { sx.drawImage(el, 0, 0, w, h); px = sx.getImageData(0, 0, w, h).data; setErr(""); } catch { setErr("The picture cannot be read here (its server does not allow it)."); return; }
      const W1 = 256, H1 = 128, wv = wave.current.getContext("2d"), vv = vec.current.getContext("2d");
      const wi = wv.createImageData(W1, H1), vi = vv.createImageData(H1, H1), add = (img, o, r, g, b) => { img.data[o] = Math.min(255, img.data[o] + r); img.data[o + 1] = Math.min(255, img.data[o + 1] + g); img.data[o + 2] = Math.min(255, img.data[o + 2] + b); img.data[o + 3] = 255; };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let r = px[o] / 255, g = px[o + 1] / 255, b = px[o + 2] / 255;
        if (lut) [r, g, b] = sampleLut(lut, r, g, b);
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, cb = (b - Y) / 1.8556, cr = (r - Y) / 1.5748;
        const wy = (v) => Math.min(H1 - 1, Math.max(0, Math.round((1 - v) * (H1 - 1))));
        if (mode === "rgb") {
          // Phase 14: RGB parade: red, green and blue side by side, each a waveform of its own channel.
          // Each column keeps its colour however many points land on it: its own channel builds up, the others stop at 90.
          const third = Math.floor(W1 / 3), px3 = Math.floor((x * (third - 2)) / w);
          const tint = (o, k) => { const d = wi.data; for (let c = 0; c < 3; c++) d[o + c] = c === k ? Math.min(255, d[o + c] + 90) : Math.min(90, d[o + c] + 12); d[o + 3] = 255; };
          tint((wy(r) * W1 + px3) * 4, 0);
          tint((wy(g) * W1 + third + px3) * 4, 1);
          tint((wy(b) * W1 + 2 * third + px3) * 4, 2);
        } else add(wi, (wy(Y) * W1 + Math.floor((x * W1) / w)) * 4, 40, 90, 40);
        const vx = Math.round(H1 / 2 + cb * H1 * 0.9), vy = Math.round(H1 / 2 - cr * H1 * 0.9);
        if (vx >= 0 && vx < H1 && vy >= 0 && vy < H1) add(vi, (vy * H1 + vx) * 4, 60, 110, 60);
      }
      wv.putImageData(wi, 0, 0); vv.putImageData(vi, 0, 0);
      wv.strokeStyle = "rgba(255,255,255,.25)"; for (const t of [0, 0.25, 0.5, 0.75, 1]) { const yy = Math.round((1 - t) * (H1 - 1)) + 0.5; wv.beginPath(); wv.moveTo(0, yy); wv.lineTo(W1, yy); wv.stroke(); }
      if (mode === "rgb") { wv.strokeStyle = "rgba(255,255,255,.35)"; for (const k of [1, 2]) { const xx = Math.floor(W1 / 3) * k - 1.5; wv.beginPath(); wv.moveTo(xx, 0); wv.lineTo(xx, H1); wv.stroke(); } }
      vv.strokeStyle = "rgba(255,255,255,.25)"; vv.beginPath(); vv.arc(H1 / 2, H1 / 2, H1 * 0.45, 0, Math.PI * 2); vv.stroke();
      vv.strokeStyle = "rgba(255,200,150,.5)"; vv.beginPath(); vv.moveTo(H1 / 2, H1 / 2); vv.lineTo(H1 / 2 + Math.cos((123 * Math.PI) / 180) * H1 * 0.45, H1 / 2 - Math.sin((123 * Math.PI) / 180) * H1 * 0.45); vv.stroke();
    };
    draw(); const t = setInterval(draw, 250);
    return () => clearInterval(t);
  }, [on, key, mode]);
  return html`<div class="col" style="gap:6px" id=${idp + "-scopes"}>
    <div class="row between" style="gap:6px"><label class="t-small row" style="gap:6px"><input type="checkbox" id=${idp + "-scopes-on"} checked=${on} onChange=${(e) => setOn(e.target.checked)} />Scopes (waveform and vectorscope)</label>
      ${on && html`<select class="input sm" id=${idp + "-scope-mode"} value=${mode} onChange=${(e) => setMode(e.target.value)} style="width:auto"><option value="luma">Luma waveform</option><option value="rgb">RGB parade</option></select>`}</div>
    ${on && html`<div class="row" style="gap:6px;align-items:flex-start"><canvas ref=${wave} id=${idp + "-waveform"} width="256" height="128" style="width:66%;background:#000;border-radius:4px" />
      <canvas ref=${vec} id=${idp + "-vectorscope"} width="128" height="128" style="width:33%;background:#000;border-radius:50%" /></div>
      ${err && html`<span class="t-small muted">${err}</span>`}`}</div>`;
}

export function ColorTab({ clip, track, projectId, mainVideo, aspect, clips, lutList, reloadLuts, timeline, doOp, H, liveOp, mode, setMode, draft, setDraft, toast, mattes = {}, adjust = { clips: [], sel: null, at: 0, dur: 0, select: () => {} } }) {
  const [ch, setCh] = useState("master");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const fileRef = useRef(null);
  if (adjust.sel) return html`<${AdjustPanel} c=${adjust.sel} doOp=${doOp} H=${H} liveOp=${liveOp} select=${adjust.select} />`;
  if (!clip || !(track === "v1" || track === "a1" || (track === "v2" && clip.kind === "broll"))) {
    return html`<${WholeEditColor} clips=${clips} projectId=${projectId} mainVideo=${mainVideo} aspect=${aspect} lutList=${lutList} reloadLuts=${reloadLuts} timeline=${timeline} doOp=${doOp} H=${H} liveOp=${liveOp} toast=${toast} mattes=${mattes} adjust=${adjust} />`;
  }
  const sl = { H, liveOp };
  const g = clip.grade || {};
  const gop = (patch) => ({ op: "set_grade", clipId: clip.id, ...patch });
  const k = clip.key;
  const kop = (patch) => ({ op: "set_key", clipId: clip.id, ...patch });
  const masks = clip.masks || [], effects = clip.effects || [];
  const mop = (ms) => ({ op: "set_masks", clipId: clip.id, masks: ms });
  const eop = (es) => ({ op: "set_effects", clipId: clip.id, effects: es });
  const setMask = (i) => (m, now) => { const op = mop(masks.map((x, j) => (j === i ? m : x))); if (now) doOp(op, false); return op; };
  const setEffect = (i) => (e, now) => { const op = eop(effects.map((x, j) => (j === i ? e : x))); if (now) doOp(op, false); return op; };
  // Phase 3: a shape that follows the face gets its keys from this clip's face, measured by the server first.
  const withFaces = async (op) => {
    setMeasuring(true);
    try {
      const { tracks } = await api.faceTracks(projectId, [{ id: clip.id, videoId: clip.sourceVideoId || mainVideo, srcIn: clip.sourceIn, srcOut: clip.freeze ? clip.sourceIn + 0.04 : clip.sourceOut, rotate: clip.rotate || 0, focus: clip.framing?.focus ?? null }], aspect);
      if (!tracks[clip.id]) toast("No face measured on this clip: the shape stays where it is.", { icon: "alert" });
      doOp({ ...op, faceTracks: tracks }, false);
    } catch (e) { toast(e.message); } finally { setMeasuring(false); }
  };
  const canFollow = track === "v1";
  const followMask = (i) => canFollow ? (m, on) => (on ? withFaces(mop(masks.map((x, j) => (j === i ? { ...stillArea(m), follow: "face" } : x)))) : doOp(setMask(i)(stillArea(m)), false)) : null;
  const followFx = (i) => canFollow ? (a, on) => (on ? withFaces(eop(effects.map((x, j) => (j === i ? { ...x, area: { ...stillArea(a), follow: "face" } } : x)))) : doOp(setEffect(i)({ ...effects[i], area: stillArea(a) }), false)) : null;
  const others = clips.filter((c) => c.id !== clip.id);
  const importLut = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      parseCube(text); // a broken file is refused here, with the reason
      const l = await api.uploadLut(file.name, text);
      delete lutData[l.id]; delete lutLoading[l.id]; // the same name replaces that LUT's file
      await reloadLuts();
      doOp(gop({ lut: { id: l.id, amount: 1 } }));
    } catch (e) { toast(e.message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const match = async () => {
    if (!ref) return;
    setBusy(true);
    try { const measured = await api.colorSamples(projectId, [ref, clip.id]); doOp({ op: "match_color", clipIds: [clip.id], to: ref, measured }); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const cur = g.curves?.[ch];
  return html`<div class="pb" id="color-panel" style="padding-top:16px"><div class="col" style="gap:18px">
    <div class="t-small muted" id="color-clip" title=${(clip.label || clip.id) + (g && Object.keys(g).length ? " · " + gradeText(g, (id) => lutList.find((l) => l.id === id)?.name) : "")} style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${clip.label || clip.id}${g && Object.keys(g).length ? " · " + gradeText(g, (id) => lutList.find((l) => l.id === id)?.name) : " · no grade"}</div>
    <${Scopes} idp="clip" grade=${clip.grade} luts=${lutData} />

    <div class="col" style="gap:8px" id="grade-panel">
      <div class="row between"><b class="t-label">Grade</b>${clip.grade && html`<${Btn} kind="ghost" size="xs" id="grade-reset" onClick=${() => doOp(gop({ reset: true }))}>Reset<//>`}</div>
      <${OpSlider} id="grade-exposure" label="Exposure" value=${g.exposure || 0} min=${-3} max=${3} step=${0.05} show=${(v) => sgn(v, 2) + " stops"} opFor=${(v) => gop({ exposure: v })} ...${sl} />
      <${OpSlider} id="grade-contrast" label="Contrast" value=${g.contrast || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ contrast: v })} ...${sl} />
      <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id="grade-temperature" label="Temperature" value=${g.temperature || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ temperature: v })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="grade-tint" label="Tint" value=${g.tint || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ tint: v })} ...${sl} /></div></div>
      <${OpSlider} id="grade-saturation" label="Saturation" value=${g.saturation ?? 100} min=${0} max=${200} step=${1} show=${(v) => v + "%"} opFor=${(v) => gop({ saturation: v })} ...${sl} />
      <${GradeMore} idp="grade" g=${g} gop=${gop} doOp=${doOp} sl=${sl} />
      <div class="col" style="gap:6px" id="curves">
        <div class="row" style="gap:4px">${CURVE_CHANNELS.map((c) => html`<button key=${c} class=${"chip" + (ch === c ? " on" : "")} id=${"curve-" + c} style=${{ color: CH_COLOR[c] }} onClick=${() => setCh(c)}>${c === "master" ? "Master" : c.toUpperCase()}${g.curves?.[c] ? " ·" : ""}</button>`)}
          ${cur && html`<${Btn} kind="ghost" size="xs" id="curve-reset" onClick=${() => doOp(gop({ curves: { [ch]: null } }), false)}>Straight<//>`}</div>
        <${CurveEditor} id="curve-editor" points=${cur} color=${CH_COLOR[ch]} opFor=${(pts) => gop({ curves: { [ch]: pts.length ? pts : null } })} H=${H} liveOp=${liveOp} doOp=${doOp} />
        <span class="t-small muted">Click to add a point, drag to move it, double-click to remove it.</span>
      </div>
      <div class="col" style="gap:6px" id="lut-panel">
        <div class="row" style="gap:8px;align-items:flex-end">
          <label class="t-small grow" style="display:grid;gap:4px">LUT<select class="input sm" id="lut-select" value=${g.lut?.id || ""} onChange=${(e) => doOp(gop({ lut: e.target.value ? { id: e.target.value, amount: g.lut?.amount ?? 1, ...(g.lut?.input ? { input: true } : {}) } : null }))}>
            <option value="">None</option>${lutList.map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}</select></label>
          <${Btn} kind="ghost" size="xs" id="lut-import" disabled=${busy} onClick=${() => fileRef.current?.click()}>Import .cube<//>
          <input ref=${fileRef} type="file" accept=".cube,text/plain" id="lut-file" style="display:none" onChange=${(e) => importLut(e.target.files?.[0])} />
        </div>
        ${g.lut && html`<${OpSlider} id="lut-amount" label="LUT amount" value=${g.lut.amount ?? 1} min=${0} max=${1} step=${0.01} show=${pct} opFor=${(v) => gop({ lut: { ...g.lut, amount: v } })} ...${sl} />
          <label class="t-small row" style="gap:6px"><input type="checkbox" id="lut-input" checked=${!!g.lut.input} onChange=${(e) => doOp(gop({ lut: { ...g.lut, input: e.target.checked } }), false)} />Apply first (an input LUT for log footage)</label>`}
      </div>
      <div class="row wrap" style="gap:6px" id="grade-copy">
        <${Btn} kind="ghost" size="xs" id="copy-all" disabled=${!clip.grade} onClick=${() => doOp({ op: "copy_grade", from: clip.id, all: true })}>Copy grade to every clip<//>
        ${clip.sourceVideoId && html`<${Btn} kind="ghost" size="xs" id="copy-video" disabled=${!clip.grade} onClick=${() => doOp({ op: "copy_grade", from: clip.id, video: clip.sourceVideoId })}>…to this video's clips<//>`}
      </div>
      <div class="row" style="gap:6px;align-items:flex-end" id="match-panel">
        <label class="t-small grow" style="display:grid;gap:4px">Match colour to<select class="input sm" id="match-ref" value=${ref} onChange=${(e) => setRef(e.target.value)}><option value="">Pick a clip…</option>${others.map((c) => html`<option key=${c.id} value=${c.id}>${c.label || c.id}</option>`)}</select></label>
        <${Btn} kind="ghost" size="xs" id="match-go" disabled=${!ref || busy} onClick=${match}>${busy ? "Measuring…" : "Match"}<//>
      </div>
    </div>

    <div class="col" style="gap:8px" id="key-panel">
      <div class="row between"><b class="t-label">Key (green screen)</b><label class="t-small row" style="gap:6px"><input type="checkbox" id="key-on" checked=${!!k} onChange=${(e) => doOp(e.target.checked ? kop({ color: k?.color || "#00B140" }) : kop({ off: true }))} />On</label></div>
      ${k && html`<div class="row" style="gap:8px;align-items:center"><${OpColor} id="key-color" value=${k.color.toLowerCase()} opFor=${(c) => kop({ color: c.toUpperCase() })} ...${sl} />
          <${Btn} kind="ghost" size="xs" id="key-pick" onClick=${() => setMode(mode === "pick" ? null : "pick")}>${mode === "pick" ? "Cancel" : "Pick from the picture"}<//></div>
        <${OpSlider} id="key-similarity" label="Similarity" value=${k.similarity} min=${0.01} max=${0.8} step=${0.01} show=${(v) => v.toFixed(2)} opFor=${(v) => kop({ similarity: v })} ...${sl} />
        <${OpSlider} id="key-blend" label="Softness" value=${k.blend} min=${0} max=${0.5} step=${0.01} show=${(v) => v.toFixed(2)} opFor=${(v) => kop({ blend: v })} ...${sl} />
        <${OpSlider} id="key-spill" label="Spill removal" value=${k.spill} min=${0} max=${1} step=${0.05} show=${pct} opFor=${(v) => kop({ spill: v })} ...${sl} />`}
    </div>

    <div class="col" style="gap:8px" id="masks-panel">
      <div class="row between"><b class="t-label">Masks</b><span class="row" style="gap:4px">
        <${Btn} kind="ghost" size="xs" id="mask-add-rect" onClick=${() => doOp(mop([...masks, BOX("rect")]))}>+ Rectangle<//>
        <${Btn} kind="ghost" size="xs" id="mask-add-ellipse" onClick=${() => doOp(mop([...masks, BOX("ellipse")]))}>+ Ellipse<//>
        <${Btn} kind="ghost" size="xs" id="mask-add-path" onClick=${() => { setDraft([]); setMode("path"); }}>+ Path<//></span></div>
      ${mode === "path" && html`<div class="row" style="gap:6px" id="path-draft"><span class="t-small muted grow">${draft.length} points</span>
        <${Btn} size="xs" id="path-done" disabled=${draft.length < 3} onClick=${() => { doOp(mop([...masks, { shape: "path", points: draft }])); setMode(null); setDraft([]); }}>Done<//>
        <${Btn} kind="ghost" size="xs" onClick=${() => { setMode(null); setDraft([]); }}>Cancel<//></div>`}
      ${masks.length ? masks.map((m, i) => html`<div key=${i} class="col card flat" style="gap:6px;padding:10px" data-mask=${i}>
          <div class="row between"><span class="t-small">${SHAPE_NAME[m.shape]}${m.shape === "path" ? ` (${m.points.length} points)` : ""}</span><span class="row" style="gap:6px">
            ${i > 0 && html`<select class="input sm" id=${"mask-mode-" + i} value=${m.mode || "add"} onChange=${(e) => setMask(i)({ ...m, mode: e.target.value }, true)}><option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option></select>`}
            <button class="btn icon sm quiet" aria-label="Remove this mask" id=${"mask-del-" + i} onClick=${() => doOp(mop(masks.filter((_, j) => j !== i)), false)}><${Icon} name="x" size="12" /></button></span></div>
          <${AreaControls} idp=${"mask-" + i} a=${m} set=${setMask(i)} sl=${sl} follow=${followMask(i)} busy=${measuring} />
        </div>`) : html`<p class="t-small muted">The clip shows only inside its masks. Shapes are on the clip's picture and move with it.</p>`}
    </div>

    ${track === "v1" || clip.sourceIn != null ? html`<${BackgroundSection} targets=${[clip]} timeline=${timeline} doOp=${doOp} H=${H} liveOp=${liveOp} mattes=${mattes} />` : null}
    ${track === "v1" || clip.sourceIn != null ? html`<${SkinSection} targets=${[clip]} projectId=${projectId} mainVideo=${mainVideo} aspect=${aspect} doOp=${doOp} H=${H} liveOp=${liveOp} toast=${toast} />` : null}
    <div class="col" style="gap:8px" id="effects-panel">
      <div class="row between"><b class="t-label">Blur, pixelate, sharpen, darken</b><span class="row wrap" style="gap:4px;justify-content:flex-end">
        <${Btn} kind="ghost" size="xs" id="fx-add-blur" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "blur", amount: 30 }]))}>+ Blur<//>
        <${Btn} kind="ghost" size="xs" id="fx-add-pixelate" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "pixelate", amount: 20 }]))}>+ Pixelate<//>
        <${Btn} kind="ghost" size="xs" id="fx-add-sharpen" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "sharpen", amount: 25 }]))}>+ Sharpen<//>
        <${Btn} kind="ghost" size="xs" id="fx-add-darken" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "darken", amount: 40 }]))}>+ Darken<//>
        <${Btn} kind="ghost" size="xs" id="fx-add-vignette" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "vignette", amount: 35 }]))}>+ Vignette<//>
        ${[["glow", "Glow", 40], ["grain", "Grain", 30], ["rgbsplit", "RGB split", 40], ["shake", "Camera shake", 30], ["mirror", "Mirror", 100], ["pin", "Corner pin", 100]].map(([t, l, a]) => html`<${Btn} key=${t} kind="ghost" size="xs" id=${"fx-add-" + t} disabled=${effects.length >= 4} title="Drawn in the render" onClick=${() => doOp(eop([...effects, { type: t, amount: a, ...(t === "pin" ? { corners: [[0.1, 0.1], [0.9, 0.05], [0.1, 0.9], [0.9, 0.95]] } : {}) }]))}>+ ${l}<//>`)}
        ${canFollow && html`<${Btn} kind="ghost" size="xs" id="fx-add-spotlight" disabled=${effects.length >= 4 || measuring} title="Darkens everything but the face, following it" onClick=${() => withFaces(eop([...effects, { type: "darken", amount: 55, area: { shape: "ellipse", invert: true, feather: 0.08, follow: "face" } }]))}>+ Spotlight<//>`}</span></div>
      ${effects.map((e, i) => html`<div key=${i} class="col card flat" style="gap:6px;padding:10px" data-effect=${i}>
        <div class="row between"><span class="t-small">${{ blur: "Blur", pixelate: "Pixelate", sharpen: "Sharpen", darken: "Darken", vignette: "Vignette", glow: "Glow", grain: "Grain", rgbsplit: "RGB split", shake: "Camera shake", mirror: "Mirror", pin: "Corner pin" }[e.type]}${["glow", "grain", "rgbsplit", "shake", "mirror", "pin"].includes(e.type) ? html` <span class="muted">(in the render)</span>` : ""}</span>
          <span class="row" style="gap:6px"><select class="input sm" id=${"fx-area-" + i} value=${e.area?.shape || "all"} onChange=${(ev) => setEffect(i)({ ...e, area: ev.target.value === "all" ? undefined : { ...BOX(ev.target.value), w: 0.3, h: 0.3, x: 0.35, y: 0.25 } }, true)}><option value="all">Whole picture</option><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select>
          <button class="btn icon sm quiet" aria-label="Remove" id=${"fx-del-" + i} onClick=${() => doOp(eop(effects.filter((_, j) => j !== i)), false)}><${Icon} name="x" size="12" /></button></span></div>
        ${e.type === "pin" ? html`<${PinCorners} i=${i} e=${e} set=${(c, now) => setEffect(i)({ ...e, corners: c }, now)} sl=${sl} />`
          : e.type !== "mirror" && html`<${OpSlider} id=${"fx-amount-" + i} label="Amount" value=${e.amount} min=${1} max=${100} step=${1} show=${(v) => String(v)} opFor=${(v) => setEffect(i)({ ...e, amount: v })} ...${sl} />`}
        ${e.area && html`<${AreaControls} idp=${"fx-" + i} a=${e.area} set=${(a, now) => setEffect(i)({ ...e, area: a }, now)} sl=${sl} follow=${followFx(i)} busy=${measuring} />`}
      </div>`)}
    </div>

    ${track === "v2" && html`<label class="t-small row" style="gap:6px" id="under-row"><input type="checkbox" id="under-v1" checked=${!!clip.under} onChange=${(e) => doOp({ op: "set_under", clipId: clip.id, under: e.target.checked })} />Behind the main picture (shows where V1 is keyed, masked or framed smaller)</label>`}
    ${hdrRow(timeline, doOp)}
    <p class="t-small muted" id="color-note">The picture here is drawn with the render's own numbers: the same LUT, key, masks (moving ones too), blur, sharpen and darken.</p>
  </div></div>`;
}

// Phase 12: a corner pin's four corners (shares of the frame), each across and down.
const PIN_NAMES = ["Top left", "Top right", "Bottom left", "Bottom right"];
function PinCorners({ i, e, set, sl }) {
  const c = e.corners || [[0, 0], [1, 0], [0, 1], [1, 1]];
  const at = (k, axis, v) => c.map((p, j) => (j === k ? (axis === 0 ? [v, p[1]] : [p[0], v]) : p));
  return html`<div class="col" style="gap:6px" id=${"fx-pin-" + i}>${PIN_NAMES.map((n, k) => html`<div key=${k} class="row" style="gap:8px">
    <div class="grow"><${OpSlider} id=${`fx-pin-${i}-${k}-x`} label=${n + " across"} value=${c[k][0]} min=${-0.5} max=${1.5} step=${0.01} show=${(v) => Math.round(v * 100) + "%"} opFor=${(v) => set(at(k, 0, v))} ...${sl} /></div>
    <div class="grow"><${OpSlider} id=${`fx-pin-${i}-${k}-y`} label="down" value=${c[k][1]} min=${-0.5} max=${1.5} step=${0.01} show=${(v) => Math.round(v * 100) + "%"} opFor=${(v) => set(at(k, 1, v))} ...${sl} /></div></div>`)}</div>`;
}

/**
 * Remove background (remove_background) on V1 clips: the person cut out by the AI matte, with its edge, softness and
 * invert; and what goes behind them (set_background: black, a colour, the room blurred, a gradient, a pattern). The
 * matte is made on the server the first time (the note says how far); the player shows it as soon as it is there.
 */
const BACKS = [["none", "Black"], ["color", "A colour"], ["blur", "The room, blurred"], ["gradient", "A gradient"], ["pattern", "A pattern"]];
function BackgroundSection({ targets, timeline, doOp, H, liveOp, mattes }) {
  const v1 = targets.filter((c) => c.sourceIn != null);
  const done = v1.filter((c) => c.subject), first = done[0]?.subject;
  const vals = first ?? SUBJECT_DEFAULTS, ids = (cs) => cs.map((c) => c.id);
  const bg = timeline.background || null;
  const kind = !bg ? "none" : bg.gradient ? "gradient" : bg.blur ? "blur" : bg.pattern ? "pattern" : bg.color ? "color" : bg.videoId ? "video" : "none";
  const missing = Object.values(mattes || {}).reduce((n, m) => n + (m.missing || 0), 0);
  const sl = { H, liveOp };
  const setBack = (k) => doOp(k === "none" ? { op: "set_background", none: true } : k === "color" ? { op: "set_background", color: "#1E1E24" } : k === "blur" ? { op: "set_background", blur: 40 }
    : k === "gradient" ? { op: "set_background", gradient: { from: "#2B2F77", to: "#0E0F1A", angle: 160 } } : { op: "set_background", pattern: { kind: "grid", color: "#F4F1EA", ink: "#D9D4C7" } });
  return html`<div class="col" style="gap:8px" id="bg-panel">
    <div class="row between"><b class="t-label">Remove background</b>
      <label class="t-small row" style="gap:6px"><input type="checkbox" id="bg-on" checked=${done.length > 0} disabled=${!v1.length} onChange=${(e) => doOp(e.target.checked ? { op: "remove_background", clipIds: ids(v1) } : { op: "remove_background", clipIds: ids(done), off: true })} />On</label></div>
    ${done.length ? html`
      <${OpSlider} id="bg-edge" label="Edge" value=${vals.edge} min=${-20} max=${20} step=${1} show=${(v) => (v > 0 ? "+" + v : String(v))} opFor=${(v) => ({ op: "remove_background", clipIds: ids(done), edge: v })} ...${sl} />
      <${OpSlider} id="bg-soft" label="Softness" value=${vals.soft} min=${0} max=${100} step=${1} show=${(v) => String(v)} opFor=${(v) => ({ op: "remove_background", clipIds: ids(done), soft: v })} ...${sl} />
      <label class="t-small row" style="gap:6px"><input type="checkbox" id="bg-invert" checked=${!!vals.invert} onChange=${(e) => doOp({ op: "remove_background", clipIds: ids(done), invert: e.target.checked })} />Remove the person instead (keep the room)</label>
      <label class="t-small" style="display:grid;gap:4px">Behind the person<select class="input sm" id="bg-behind" value=${kind} onChange=${(e) => setBack(e.target.value)}>
        ${kind === "video" && html`<option value="video">A video from your library</option>`}${BACKS.map(([v, t]) => html`<option key=${v} value=${v}>${t}</option>`)}</select></label>
      ${kind === "color" && html`<${OpColor} id="bg-color" value=${bg.color.toLowerCase()} opFor=${(c) => ({ op: "set_background", color: c.toUpperCase() })} ...${sl} />`}
      ${kind === "blur" && html`<${OpSlider} id="bg-blur" label="Blur" value=${bg.blur} min=${1} max=${100} step=${1} show=${(v) => String(v)} opFor=${(v) => ({ op: "set_background", blur: v })} ...${sl} />`}
      <p class="t-small muted" style="margin:0" id="bg-note">${missing ? `Cutting out the person on the server: ${missing} ${missing === 1 ? "part" : "parts"} of 10 s left. The player shows it when ready. ` : ""}${done.length < v1.length ? `On ${done.length} of ${v1.length} clips. ` : ""}People, not objects. B-roll set behind V1 shows there too.</p>`
    : html`<p class="t-small muted" style="margin:0">Cut the person out and put them on a colour, the room blurred, a gradient or another video. Your AI can do it too.</p>`}
  </div>`;
}

/**
 * Skin retouch (retouch_skin) on V1 clips: smooth, blemishes, even tone, brighten. On the face (the area Rendrr builds
 * from the faces it measured; fetched once when turned on) or the whole picture. Done before the grade.
 */
function SkinSection({ targets, projectId, mainVideo, aspect, doOp, H, liveOp, toast }) {
  const [busy, setBusy] = useState(false);
  const v1 = targets.filter((c) => c.sourceIn != null);
  const done = v1.filter((c) => c.skin), first = done[0]?.skin;
  const vals = first ?? SKIN_DEFAULTS, face = first ? !!first.face : true;
  const ids = (cs) => cs.map((c) => c.id);
  // Turned on (or onto the face): every clip gets it, with the faces measured for the face.
  const turnOn = async (onFace, values = {}) => {
    setBusy(true);
    try {
      let faceAreas;
      if (onFace) faceAreas = (await api.skinAreas(projectId, v1.map((c) => ({ id: c.id, videoId: c.sourceVideoId || mainVideo, srcIn: c.sourceIn, srcOut: c.sourceOut, rotate: c.rotate || 0, focus: c.framing?.focus ?? null })), aspect)).areas;
      doOp({ op: "retouch_skin", clipIds: ids(v1), ...(onFace ? { area: "face", faceAreas } : { area: "frame" }), smooth: vals.smooth, blemishes: vals.blemishes, even: vals.even, brighten: vals.brighten, ...values });
      if (onFace && Object.values(faceAreas).some((a) => !a)) toast("No face measured on some clips: the skin is found over the whole picture there.", { icon: "alert" });
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const sl = { H, liveOp };
  const slider = (key, label, idSuffix) => html`<${OpSlider} id=${"skin-" + idSuffix} label=${label} value=${vals[key]} min=${0} max=${100} step=${1} show=${(v) => (v ? String(v) : "off")} opFor=${(v) => ({ op: "retouch_skin", clipIds: ids(done), [key]: v })} ...${sl} />`;
  return html`<div class="col" style="gap:8px" id="skin-panel">
    <div class="row between"><b class="t-label">Skin retouch</b>
      <label class="t-small row" style="gap:6px"><input type="checkbox" id="skin-on" checked=${done.length > 0} disabled=${busy || !v1.length} onChange=${(e) => (e.target.checked ? turnOn(face) : doOp({ op: "retouch_skin", clipIds: ids(done), off: true }))} />${busy ? "Finding faces…" : "On"}</label></div>
    ${done.length ? html`
      ${slider("smooth", "Smooth", "smooth")}
      ${slider("blemishes", "Blemishes", "blemishes")}
      ${slider("even", "Even tone", "even")}
      ${slider("brighten", "Brighten", "brighten")}
      <label class="t-small row" style="gap:6px"><input type="checkbox" id="skin-face" checked=${face} disabled=${busy} onChange=${(e) => turnOn(e.target.checked)} />Face only (forehead to neck)</label>
      <p class="t-small muted" style="margin:0" id="skin-note">${done.length < v1.length ? `On ${done.length} of ${v1.length} clips. ` : ""}Done before the grade; the skin keeps its tone. The player shows it close to the render.</p>`
    : html`<p class="t-small muted" style="margin:0">Smoother skin, fewer spots, even tone. Natural by default; your AI can do it too.</p>`}
  </div>`;
}

/** The Color tab with no clip selected: the look of the whole edit, every V1 clip at once (set_grade all), like an
 *  adjustment layer: a LUT (pick or import), the basic grade and sharpening. A clip's own controls are one click away. */
// ---------------------------------------------------------------------------------------------
// Phase 9: adjustment layers (V3): a grade and effects on everything under them over their time (footage, b-roll,
// graphics; text and captions stay as they are). The list and "+ Adjustment layer" in the whole-edit panel; a selected
// layer's own grade and effects here.
// ---------------------------------------------------------------------------------------------
const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
function AdjustList({ adjust, doOp }) {
  const add = () => {
    const had = new Set(adjust.clips.map((c) => c.id));
    const s = Math.max(0, Math.min(adjust.at, adjust.dur - 0.5)), e = Math.min(adjust.dur, s + 5);
    const r = doOp({ op: "adjustment_layer", start: s, end: e, edit: true });
    const made = r && r.state.tracks.v3.find((c) => c.kind === "adjust" && !had.has(c.id));
    if (made) adjust.select(made.id);
  };
  return html`<div class="col" style="gap:8px" id="adjust-list">
    <div class="row between"><b class="t-label">Adjustment layers</b><${Btn} kind="ghost" size="xs" id="adjust-add" disabled=${adjust.dur < 0.6} onClick=${add}>+ Adjustment layer here<//></div>
    <span class="t-small muted">A layer on V3 from the playhead: its grade and effects go on everything under it (footage, b-roll, graphics). Text and captions stay as they are.</span>
    ${adjust.clips.map((c) => html`<button key=${c.id} class="btn ghost sm" style="justify-content:space-between" data-adjust-item=${c.id} onClick=${() => adjust.select(c.id)}>
      <span>${c.label || "Adjustment"}</span><span class="muted mono">${clock(c.start)}-${clock(c.end)}</span></button>`)}
  </div>`;
}
function AdjustPanel({ c, doOp, H, liveOp, select }) {
  const g = c.grade || {}, fx = c.effects || [];
  const amt = (type) => fx.find((e) => e.type === type && !e.area)?.amount ?? 0;
  const gop = (patch) => ({ op: "adjustment_layer", clipId: c.id, grade: mergeGrade(g, patch) });
  const fop = (type, v) => ({ op: "adjustment_layer", clipId: c.id, effects: [...fx.filter((e) => e.type !== type || e.area), ...(v ? [{ type, amount: v }] : [])] });
  const sl = { H, liveOp };
  return html`<div class="pb" id="color-panel" style="padding-top:16px"><div class="col" style="gap:18px" id="adjust-panel">
    <div class="row between"><b class="t-label">${c.label || "Adjustment layer"} <span class="muted mono">${clock(c.start)}-${clock(c.end)}</span></b>
      <${Btn} kind="ghost" size="xs" id="adjust-back" onClick=${() => select(null)}>Whole edit<//></div>
    <span class="t-small muted">On everything under it over its time (footage, b-roll, graphics); text and captions stay as they are. Drag its edges on V3 to change when.</span>
    <div class="col" style="gap:8px" id="adjust-grade">
      <b class="t-label">Grade</b>
      <${OpSlider} id="adjust-exposure" label="Exposure" value=${g.exposure || 0} min=${-3} max=${3} step=${0.05} show=${(v) => sgn(v, 2) + " stops"} opFor=${(v) => gop({ exposure: v })} ...${sl} />
      <${OpSlider} id="adjust-contrast" label="Contrast" value=${g.contrast || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ contrast: v })} ...${sl} />
      <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id="adjust-temperature" label="Temperature" value=${g.temperature || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ temperature: v })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="adjust-tint" label="Tint" value=${g.tint || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ tint: v })} ...${sl} /></div></div>
      <${OpSlider} id="adjust-saturation" label="Saturation" value=${g.saturation ?? 100} min=${0} max=${200} step=${1} show=${(v) => v + "%"} opFor=${(v) => gop({ saturation: v })} ...${sl} />
      <${GradeMore} idp="adjust" g=${g} gop=${gop} doOp=${doOp} sl=${sl} />
    </div>
    <div class="col" style="gap:8px" id="adjust-effects">
      <b class="t-label">Effects</b>
      <${OpSlider} id="adjust-blur" label="Blur" value=${amt("blur")} min=${0} max=${100} step=${1} show=${(v) => (v ? String(v) : "off")} opFor=${(v) => fop("blur", v)} ...${sl} />
      <${OpSlider} id="adjust-darken" label="Darken" value=${amt("darken")} min=${0} max=${100} step=${1} show=${(v) => (v ? v + "%" : "off")} opFor=${(v) => fop("darken", v)} ...${sl} />
      <${OpSlider} id="adjust-vignette" label="Vignette" value=${amt("vignette")} min=${0} max=${100} step=${1} show=${(v) => (v ? String(v) : "off")} opFor=${(v) => fop("vignette", v)} ...${sl} />
    </div>
    <${Btn} kind="ghost" size="xs" icon="trash" id="adjust-delete" onClick=${() => { doOp({ op: "delete_clip", track: "v3", clipId: c.id }); select(null); }}>Remove this adjustment layer<//>
  </div></div>`;
}

function WholeEditColor({ clips, projectId, mainVideo, aspect, lutList, reloadLuts, timeline, doOp, H, liveOp, toast, mattes, adjust }) {
  const fileRef = useRef(null); const [busy, setBusy] = useState(false);
  const v1 = clips.filter((c) => c.sourceIn != null);
  const g = v1[0]?.grade || {};
  const same = (f) => v1.every((c) => JSON.stringify((c.grade || {})[f] ?? null) === JSON.stringify(g[f] ?? null));
  const mixed = ["exposure", "contrast", "temperature", "tint", "saturation", "lut", "highlights", "shadows", "whites", "blacks", "vibrance", "wheels", "hsl", "hueSat", "hueHue", "lumaSat"].filter((f) => !same(f));
  const gop = (patch) => ({ op: "set_grade", all: true, ...patch });
  const sl = { H, liveOp };
  const fx = v1[0]?.effects || [];
  const sharpen = fx.find((e) => e.type === "sharpen")?.amount ?? 0;
  const ownFx = v1.some((c) => (c.effects || []).some((e) => e.type !== "sharpen" || e.area));
  const importLut = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      parseCube(text);
      const l = await api.uploadLut(file.name, text);
      delete lutData[l.id]; delete lutLoading[l.id];
      await reloadLuts();
      doOp(gop({ lut: { id: l.id, amount: 1 } }));
    } catch (e) { toast(e.message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  return html`<div class="pb" id="color-panel" style="padding-top:16px"><div class="col" style="gap:18px" id="whole-color">
    <p class="t-small muted" style="margin:0">The whole edit: every clip on V1 at once. Select a clip to grade it on its own, or for match, key, masks and blur.</p>
    <div class="col" style="gap:8px" id="whole-lut">
      <b class="t-label">Look (LUT)</b>
      <div class="row" style="gap:8px;align-items:flex-end">
        <label class="t-small grow" style="display:grid;gap:4px">LUT<select class="input sm" id="whole-lut-select" value=${same("lut") ? g.lut?.id || "" : ""} onChange=${(e) => doOp(gop({ lut: e.target.value ? { id: e.target.value, amount: g.lut?.amount ?? 1 } : null }))}>
          <option value="">${same("lut") ? "None" : "Different on each clip"}</option>${lutList.map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}</select></label>
        <${Btn} size="sm" id="whole-lut-import" icon="upload" disabled=${busy} onClick=${() => fileRef.current?.click()}>${busy ? "Importing…" : "Import .cube"}<//>
        <input ref=${fileRef} type="file" accept=".cube,text/plain" id="whole-lut-file" style="display:none" onChange=${(e) => importLut(e.target.files?.[0])} />
      </div>
      ${g.lut && same("lut") && html`<${OpSlider} id="whole-lut-amount" label="Amount" value=${g.lut.amount ?? 1} min=${0} max=${1} step=${0.01} show=${pct} opFor=${(v) => gop({ lut: { ...g.lut, amount: v } })} ...${sl} />`}
      <span class="t-small muted">Your AI can apply a LUT too: give it the .cube file.</span>
    </div>
    <${Scopes} idp="whole" grade=${g} luts=${lutData} />
    <div class="col" style="gap:8px" id="whole-grade">
      <div class="row between"><b class="t-label">Basic correction</b>${v1.some((c) => c.grade) && html`<${Btn} kind="ghost" size="xs" id="whole-reset" onClick=${() => doOp(gop({ reset: true }))}>Reset every clip<//>`}</div>
      ${mixed.length > 0 && html`<span class="t-small muted">Clips differ in ${mixed.join(", ")}: a slider sets that value on every clip.</span>`}
      <${OpSlider} id="whole-exposure" label="Exposure" value=${g.exposure || 0} min=${-3} max=${3} step=${0.05} show=${(v) => sgn(v, 2) + " stops"} opFor=${(v) => gop({ exposure: v })} ...${sl} />
      <${OpSlider} id="whole-contrast" label="Contrast" value=${g.contrast || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ contrast: v })} ...${sl} />
      <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id="whole-temperature" label="Temperature" value=${g.temperature || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ temperature: v })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="whole-tint" label="Tint" value=${g.tint || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ tint: v })} ...${sl} /></div></div>
      <${OpSlider} id="whole-saturation" label="Saturation" value=${g.saturation ?? 100} min=${0} max=${200} step=${1} show=${(v) => v + "%"} opFor=${(v) => gop({ saturation: v })} ...${sl} />
      <${GradeMore} idp="whole" g=${g} gop=${gop} doOp=${doOp} sl=${sl} />
    </div>
    <div class="col" style="gap:8px" id="whole-sharpen">
      <b class="t-label">Sharpen</b>
      ${ownFx ? html`<span class="t-small muted">Some clips have their own effects: sharpen them clip by clip.</span>`
        : html`<${OpSlider} id="whole-sharpen-amount" label="Amount" value=${sharpen} min=${0} max=${100} step=${1} show=${(v) => (v ? String(v) : "off")} opFor=${(v) => ({ op: "set_effects", all: true, effects: v ? [{ type: "sharpen", amount: v }] : [] })} ...${sl} />`}
    </div>
    <${BackgroundSection} targets=${v1} timeline=${timeline} doOp=${doOp} H=${H} liveOp=${liveOp} mattes=${mattes} />
    <${SkinSection} targets=${v1} projectId=${projectId} mainVideo=${mainVideo} aspect=${aspect} doOp=${doOp} H=${H} liveOp=${liveOp} toast=${toast} />
    ${adjust && html`<${AdjustList} adjust=${adjust} doOp=${doOp} />`}
    ${hdrRow(timeline, doOp)}
  </div></div>`;
}

function hdrRow(timeline, doOp) {
  const v = timeline.export?.hdr || "keep";
  return html`<label class="t-small" style="display:grid;gap:4px" id="hdr-row">HDR footage in the final<select class="input sm" id="hdr-select" value=${v} onChange=${(e) => doOp({ op: "set_export", hdr: e.target.value })}>
    <option value="keep">Keep HDR (10-bit HEVC, its own PQ or HLG)</option><option value="sdr">Convert to SDR</option></select></label>`;
}
