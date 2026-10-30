// Colour and compositing in the editor (Phase 6): the look canvas the player draws a clip through (the render's
// numbers, see look-gl.js), the Color tab (grade, LUTs, copy, match, key, masks, blur/pixelate, under layer, HDR) and
// the overlay on the picture (mask outlines, drawing a path, picking the key colour). Every control sends the
// connector's own op.
import { useState, useEffect, useRef, useMemo, html, Btn, Icon } from "./ui";
import { api } from "./api";
import { OpColor, OpSlider } from "./controls";
import { createLookRenderer } from "./look-gl";
import { areaPicture, buildLut, CURVE_CHANNELS, curveFn, fitCrop, gradeText, hashOf, hexRgb, LUT_SIZE, maskPicture, parseCube, SKIN_DEFAULTS, spillType } from "@rendrr/shared";

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
    lut: g ? { id: hashOf([g, lutReady]), n: LUT_SIZE, data: buildLut(g, g.lut ? luts[g.lut.id] : null) } : null,
    key: look?.key ? { rgb: hexRgb(look.key.color).map((v) => v / 255), sim: look.key.similarity, blend: look.key.blend, spill: look.key.spill, blue: spillType(look.key) === "blue" } : null,
    mask: look?.masks?.length ? { key: hashOf([look.masks, W, H]), px: maskPicture(look.masks, W, H) } : null,
    effects: (look?.effects || []).map((e) => ({ type: e.type, px: e.px, amount: e.amount, area: e.area ? { key: hashOf([e.area, W, H]), px: areaPicture(e.area, W, H) } : null })),
    skin: look?.skin ? { p: look.skin.p, area: look.skin.skin.area ? { key: hashOf([look.skin.skin.area, W, H]), px: areaPicture(look.skin.skin.area, W, H) } : null } : null,
  };
  specs.set(id, spec);
  if (specs.size > 40) specs.delete(specs.keys().next().value);
  return spec;
}

/**
 * The picture of one video element drawn through its look, the size of the plan. The video stays the clock (hidden);
 * the canvas redraws on every new frame, seek and look change. onFail: no WebGL2 here (the video then shows plain).
 */
export function LookCanvas({ videoRef, look, W, H, rotate = 0, fitY = 0.4, focus = null, luts, onFail }) {
  const cv = useRef(null);
  const spec = lookSpec(look, W, H, luts);
  const cur = useRef(null);
  cur.current = { ...spec, rotate, fitY, focus };
  useEffect(() => {
    let r = null;
    try { r = createLookRenderer(cv.current); } catch (e) { console.warn(e); }
    if (!r) { onFail?.(); return; }
    let raf = 0, last = "", dirty = true, el = null;
    const mark = () => { dirty = true; };
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
        const k = `${el.currentTime.toFixed(4)}|${s.id}|${s.rotate}|${s.fitY}|${s.focus ? s.focus.x + "," + s.focus.y : ""}`;
        if (dirty || k !== last || !el.paused) {
          try { r.draw(el, s); cv.current.dataset.drawn = String((+cv.current.dataset.drawn || 0) + 1); } catch (e) { console.warn(e); }
          last = k; dirty = false;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); el?.removeEventListener("seeked", mark); el?.removeEventListener("loadeddata", mark); r.dispose(); };
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

/** Sliders for a shape's box and feather, and its invert box (masks and effect areas). */
function AreaControls({ idp, a, set, sl }) {
  return html`<div class="col" style="gap:6px">
    ${a.shape !== "path" && html`<div class="row" style="gap:8px">
      <div class="grow"><${OpSlider} id=${idp + "-x"} label="Left" value=${a.x} min=${-0.5} max=${1} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, x: v })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-y"} label="Top" value=${a.y} min=${-0.5} max=${1} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, y: v })} ...${sl} /></div></div>
    <div class="row" style="gap:8px">
      <div class="grow"><${OpSlider} id=${idp + "-w"} label="Width" value=${a.w} min=${0.02} max=${1.5} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, w: v })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-h"} label="Height" value=${a.h} min=${0.02} max=${1.5} step=${0.01} show=${pct} opFor=${(v) => set({ ...a, h: v })} ...${sl} /></div></div>`}
    <${OpSlider} id=${idp + "-feather"} label="Feather" value=${a.feather || 0} min=${0} max=${0.3} step=${0.005} show=${pct} opFor=${(v) => set({ ...a, feather: v })} ...${sl} />
    <label class="t-small row" style="gap:6px"><input type="checkbox" id=${idp + "-invert"} checked=${!!a.invert} onChange=${(e) => set({ ...a, invert: e.target.checked }, true)} />Outside instead (invert)</label>
  </div>`;
}

export function ColorTab({ clip, track, projectId, mainVideo, aspect, clips, lutList, reloadLuts, timeline, doOp, H, liveOp, mode, setMode, draft, setDraft, toast }) {
  const [ch, setCh] = useState("master");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  if (!clip || !(track === "v1" || track === "a1" || (track === "v2" && clip.kind === "broll"))) {
    return html`<${WholeEditColor} clips=${clips} projectId=${projectId} mainVideo=${mainVideo} aspect=${aspect} lutList=${lutList} reloadLuts=${reloadLuts} timeline=${timeline} doOp=${doOp} H=${H} liveOp=${liveOp} toast=${toast} />`;
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
    <div class="t-small muted" id="color-clip">${clip.label || clip.id}${g && Object.keys(g).length ? " · " + gradeText(g, (id) => lutList.find((l) => l.id === id)?.name) : " · no grade"}</div>

    <div class="col" style="gap:8px" id="grade-panel">
      <div class="row between"><b class="t-label">Grade</b>${clip.grade && html`<${Btn} kind="ghost" size="xs" id="grade-reset" onClick=${() => doOp(gop({ reset: true }))}>Reset<//>`}</div>
      <${OpSlider} id="grade-exposure" label="Exposure" value=${g.exposure || 0} min=${-3} max=${3} step=${0.05} show=${(v) => sgn(v, 2) + " stops"} opFor=${(v) => gop({ exposure: v })} ...${sl} />
      <${OpSlider} id="grade-contrast" label="Contrast" value=${g.contrast || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ contrast: v })} ...${sl} />
      <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id="grade-temperature" label="Temperature" value=${g.temperature || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ temperature: v })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="grade-tint" label="Tint" value=${g.tint || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ tint: v })} ...${sl} /></div></div>
      <${OpSlider} id="grade-saturation" label="Saturation" value=${g.saturation ?? 100} min=${0} max=${200} step=${1} show=${(v) => v + "%"} opFor=${(v) => gop({ saturation: v })} ...${sl} />
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
          <${AreaControls} idp=${"mask-" + i} a=${m} set=${setMask(i)} sl=${sl} />
        </div>`) : html`<p class="t-small muted">The clip shows only inside its masks. Shapes are on the clip's picture and move with it.</p>`}
    </div>

    ${track === "v1" || clip.sourceIn != null ? html`<${SkinSection} targets=${[clip]} projectId=${projectId} mainVideo=${mainVideo} aspect=${aspect} doOp=${doOp} H=${H} liveOp=${liveOp} toast=${toast} />` : null}
    <div class="col" style="gap:8px" id="effects-panel">
      <div class="row between"><b class="t-label">Blur, pixelate, sharpen</b><span class="row" style="gap:4px">
        <${Btn} kind="ghost" size="xs" id="fx-add-blur" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "blur", amount: 30 }]))}>+ Blur<//>
        <${Btn} kind="ghost" size="xs" id="fx-add-pixelate" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "pixelate", amount: 20 }]))}>+ Pixelate<//>
        <${Btn} kind="ghost" size="xs" id="fx-add-sharpen" disabled=${effects.length >= 4} onClick=${() => doOp(eop([...effects, { type: "sharpen", amount: 25 }]))}>+ Sharpen<//></span></div>
      ${effects.map((e, i) => html`<div key=${i} class="col card flat" style="gap:6px;padding:10px" data-effect=${i}>
        <div class="row between"><span class="t-small">${{ blur: "Blur", pixelate: "Pixelate", sharpen: "Sharpen" }[e.type]}</span>
          <span class="row" style="gap:6px"><select class="input sm" id=${"fx-area-" + i} value=${e.area?.shape || "all"} onChange=${(ev) => setEffect(i)({ ...e, area: ev.target.value === "all" ? undefined : { ...BOX(ev.target.value), w: 0.3, h: 0.3, x: 0.35, y: 0.25 } }, true)}><option value="all">Whole picture</option><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select>
          <button class="btn icon sm quiet" aria-label="Remove" id=${"fx-del-" + i} onClick=${() => doOp(eop(effects.filter((_, j) => j !== i)), false)}><${Icon} name="x" size="12" /></button></span></div>
        <${OpSlider} id=${"fx-amount-" + i} label="Amount" value=${e.amount} min=${1} max=${100} step=${1} show=${(v) => String(v)} opFor=${(v) => setEffect(i)({ ...e, amount: v })} ...${sl} />
        ${e.area && html`<${AreaControls} idp=${"fx-" + i} a=${e.area} set=${(a, now) => setEffect(i)({ ...e, area: a }, now)} sl=${sl} />`}
      </div>`)}
    </div>

    ${track === "v2" && html`<label class="t-small row" style="gap:6px" id="under-row"><input type="checkbox" id="under-v1" checked=${!!clip.under} onChange=${(e) => doOp({ op: "set_under", clipId: clip.id, under: e.target.checked })} />Behind the main picture (shows where V1 is keyed, masked or framed smaller)</label>`}
    ${hdrRow(timeline, doOp)}
    <p class="t-small muted" id="color-note">The picture here is drawn with the render's own numbers: the same LUT, key, masks, blur and sharpen.</p>
  </div></div>`;
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
function WholeEditColor({ clips, projectId, mainVideo, aspect, lutList, reloadLuts, timeline, doOp, H, liveOp, toast }) {
  const fileRef = useRef(null); const [busy, setBusy] = useState(false);
  const v1 = clips.filter((c) => c.sourceIn != null);
  const g = v1[0]?.grade || {};
  const same = (f) => v1.every((c) => JSON.stringify((c.grade || {})[f] ?? null) === JSON.stringify(g[f] ?? null));
  const mixed = ["exposure", "contrast", "temperature", "tint", "saturation", "lut"].filter((f) => !same(f));
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
    <div class="col" style="gap:8px" id="whole-grade">
      <div class="row between"><b class="t-label">Basic correction</b>${v1.some((c) => c.grade) && html`<${Btn} kind="ghost" size="xs" id="whole-reset" onClick=${() => doOp(gop({ reset: true }))}>Reset every clip<//>`}</div>
      ${mixed.length > 0 && html`<span class="t-small muted">Clips differ in ${mixed.join(", ")}: a slider sets that value on every clip.</span>`}
      <${OpSlider} id="whole-exposure" label="Exposure" value=${g.exposure || 0} min=${-3} max=${3} step=${0.05} show=${(v) => sgn(v, 2) + " stops"} opFor=${(v) => gop({ exposure: v })} ...${sl} />
      <${OpSlider} id="whole-contrast" label="Contrast" value=${g.contrast || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ contrast: v })} ...${sl} />
      <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id="whole-temperature" label="Temperature" value=${g.temperature || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ temperature: v })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="whole-tint" label="Tint" value=${g.tint || 0} min=${-100} max=${100} step=${1} show=${(v) => sgn(v)} opFor=${(v) => gop({ tint: v })} ...${sl} /></div></div>
      <${OpSlider} id="whole-saturation" label="Saturation" value=${g.saturation ?? 100} min=${0} max=${200} step=${1} show=${(v) => v + "%"} opFor=${(v) => gop({ saturation: v })} ...${sl} />
    </div>
    <div class="col" style="gap:8px" id="whole-sharpen">
      <b class="t-label">Sharpen</b>
      ${ownFx ? html`<span class="t-small muted">Some clips have their own effects: sharpen them clip by clip.</span>`
        : html`<${OpSlider} id="whole-sharpen-amount" label="Amount" value=${sharpen} min=${0} max=${100} step=${1} show=${(v) => (v ? String(v) : "off")} opFor=${(v) => ({ op: "set_effects", all: true, effects: v ? [{ type: "sharpen", amount: v }] : [] })} ...${sl} />`}
    </div>
    <${SkinSection} targets=${v1} projectId=${projectId} mainVideo=${mainVideo} aspect=${aspect} doOp=${doOp} H=${H} liveOp=${liveOp} toast=${toast} />
    ${hdrRow(timeline, doOp)}
  </div></div>`;
}

function hdrRow(timeline, doOp) {
  const v = timeline.export?.hdr || "keep";
  return html`<label class="t-small" style="display:grid;gap:4px" id="hdr-row">HDR footage in the final<select class="input sm" id="hdr-select" value=${v} onChange=${(e) => doOp({ op: "set_export", hdr: e.target.value })}>
    <option value="keep">Keep HDR (10-bit HEVC, its own PQ or HLG)</option><option value="sdr">Convert to SDR</option></select></label>`;
}
