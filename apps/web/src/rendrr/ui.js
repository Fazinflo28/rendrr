/* ===================== shared UI ===================== */
// Ported from ui/rendrr-ui.html (shared UI script). Changes: module imports/exports, the app contexts
// live here, the Player can play a real video (`src`), and Thumb shows a real frame when there is one.
import React, { useState, useEffect, useRef, useMemo, useCallback, useContext, createContext } from "react";
import htm from "htm";
// htm gives us HTML-style props; turn string styles into objects and plain attribute names into React's.
const parseStyle = (s) => Object.fromEntries(s.split(";").filter((d) => d.includes(":")).map((d) => { const i = d.indexOf(":"); return [d.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()), d.slice(i + 1).trim()]; }));
const PROP_MAP = { class: "className", for: "htmlFor", tabindex: "tabIndex", novalidate: "noValidate", autofocus: "autoFocus", readonly: "readOnly", autocomplete: "autoComplete" };
const h = (type, props, ...kids) => {
  if (props) { let p = null; for (const k in props) { const nk = PROP_MAP[k]; if (nk || (k === "style" && typeof props[k] === "string")) { p ||= { ...props }; if (nk) { p[nk] = props[k]; delete p[k]; } else p.style = parseStyle(props[k]); } } props = p || props; }
  return React.createElement(type, props, ...kids);
};
const html = htm.bind(h);

const fmtTime = (s, frames = false) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); const sec = Math.floor(s % 60); const base = String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0"); return frames ? base + ":" + String(Math.floor((s % 1) * 24)).padStart(2, "0") : base; };
const fmtLen = (s) => { const m = Math.floor(s / 60), sec = Math.round(s % 60); return m ? m + "m " + String(sec).padStart(2, "0") + "s" : sec + "s"; };
const fmtAgo = (t) => { const d = Math.max(0, Date.now() - t) / 60000; if (d < 1) return "Just now"; if (d < 60) return Math.round(d) + " min ago"; if (d < 60 * 24) return Math.round(d / 60) + " h ago"; return Math.round(d / 1440) + " d ago"; };
const initials = (n) => (n || "?").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();

// Soft bold icons: thick rounded strokes (2.2px), squircle frames and filled inner accents, drawn on a 24px grid.
// `s` = stroked paths, `f` = filled shapes. Both use currentColor so they tint with the theme and active state.
const SQ = "M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5z";
const ICONS = {
  logo: { s: SQ, f: "M9 8.2l7 3.8-7 3.8z" },
  home: { s: "M4 10.5 12 4l8 6.5V18a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18z", f: "M10 20.5v-5.5a2 2 0 0 1 4 0v5.5z" },
  library: { s: SQ, f: "M3.5 7A3.5 3.5 0 0 1 7 3.5h10A3.5 3.5 0 0 1 20.5 7v2.5h-17z M9.5 12.5h5v2.4h-5z" },
  projects: { s: SQ, f: "M7.5 7.5h3.5v9H7.5z" },
  styles: { s: "M12 3.5l2.2 5.8 5.8 2.2-5.8 2.2L12 19.5l-2.2-5.8L4 11.5l5.8-2.2z", f: "M12 8.5l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9-2.9-1.1 2.9-1.1z" },
  reviews: { s: "M7 4h10a3.5 3.5 0 0 1 3.5 3.5v6A3.5 3.5 0 0 1 17 17h-5.5L8 20.5V17H7a3.5 3.5 0 0 1-3.5-3.5v-6A3.5 3.5 0 0 1 7 4z", f: "M8 9h8v2.4H8z M8 12.6h5v2.4H8z" },
  connect: { s: "M7.5 15.5A3.5 3.5 0 0 1 7 8.5a5 5 0 0 1 9.8-1A3.75 3.75 0 0 1 17.5 15.5 M12 15.5v5 M8.5 20.5h7", f: "M9.5 15.5h5v2.6h-5z" },
  usage: { s: SQ, f: "M7 12.5h2.5v4.5H7z M10.75 7.5h2.5v9.5h-2.5z M14.5 10h2.5v7h-2.5z" },
  settings: { s: "M19.14 11.10 L21.18 11.35 L21.18 12.65 L19.14 12.90 L17.69 16.41 L18.95 18.03 L18.03 18.95 L16.41 17.69 L12.90 19.14 L12.65 21.18 L11.35 21.18 L11.10 19.14 L7.59 17.69 L5.97 18.95 L5.05 18.03 L6.31 16.41 L4.86 12.90 L2.82 12.65 L2.82 11.35 L4.86 11.10 L6.31 7.59 L5.05 5.97 L5.97 5.05 L7.59 6.31 L11.10 4.86 L11.35 2.82 L12.65 2.82 L12.90 4.86 L16.41 6.31 L18.03 5.05 L18.95 5.97 L17.69 7.59z", f: "M12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z" },
  search: { s: "M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M19.5 19.5l-4.3-4.3", f: "M10.5 7.8a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z" },
  upload: { s: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", f: "M12 7l4 4.2h-2.6V17h-2.8v-5.8H8z" },
  play: { s: SQ, f: "M9.5 8l7 4-7 4z" },
  pause: { s: SQ, f: "M8 7.5h2.6v9H8z M13.4 7.5H16v9h-2.6z" },
  undo: { s: "M4.5 9.5h9a5 5 0 0 1 0 10H9", f: "M4 9.5l5-4.5v9z" },
  redo: { s: "M19.5 9.5h-9a5 5 0 0 0 0 10H15", f: "M20 9.5l-5-4.5v9z" },
  scissors: { s: "M9 10.5 20 5 M9 13.5 20 19", f: "M6.5 4.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6.5 13.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" },
  trash: { s: "M5 7h14 M7 7l.8 12.5h8.4L17 7", f: "M9 3.5h6v3H9z M10 10h1.6v6.5H10z M12.4 10H14v6.5h-1.6z" },
  plus: { s: "M12 5v14 M5 12h14" },
  check: { s: "M5 12.5l4.5 4.5L19 7.5" },
  x: { s: "M6 6l12 12 M18 6 6 18" },
  copy: { s: "M9.5 9.5H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2z", f: "M4 6a2 2 0 0 1 2-2h8.5v2.5H6.5V15H4z" },
  link: { s: "M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1.5 1.5 M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1.5-1.5" },
  chev: { s: "M9.5 6l6 6-6 6" },
  down: { s: "M6 9.5l6 6 6-6" },
  back: { s: "M14.5 6l-6 6 6 6" },
  lock: { s: "M8 10.5V7.5a4 4 0 0 1 8 0v3", f: "M6.5 10.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" },
  more: { f: "M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M18 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" },
  comment: { s: SQ, f: "M4 8l8 5.5L20 8v2.6l-8 5.4-8-5.4z" },
  download: { s: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", f: "M12 17l-4-4.2h2.6V7h2.8v5.8H16z" },
  alert: { s: "M10 4.3a2.3 2.3 0 0 1 4 0l7 12.2a2.3 2.3 0 0 1-2 3.5H5a2.3 2.3 0 0 1-2-3.5z", f: "M10.8 8.5h2.4v5.5h-2.4z M12 15.3a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z" },
  spark: { s: "M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z", f: "M18.5 3l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" },
  film: { s: SQ, f: "M3.5 8.5h3v2.5h-3z M3.5 13h3v2.5h-3z M17.5 8.5h3v2.5h-3z M17.5 13h3v2.5h-3z M9.5 8l6 4-6 4z" },
  eye: { s: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z", f: "M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z" },
  key: { s: "M13 12h8 M18 12v3.5 M15 12v2.5", f: "M8 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M8 10.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" },
  user: { s: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", f: "M12 7.2a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8z M6.8 18a5.2 5.2 0 0 1 10.4 0 8.4 8.4 0 0 1-10.4 0z" },
  logout: { s: "M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10", f: "M14.5 7.5 20 12l-5.5 4.5v-3H9v-3h5.5z" },
  zap: { f: "M13.5 2.5 4.5 13.5h6l-1 8 9-11h-6z" },
  clock: { s: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", f: "M10.9 7h2.2v5.4l3.2 1.9-1.1 1.9-4.3-2.6z" },
  refresh: { s: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3", f: "M20.5 3.5v6.5H14z" },
  help: { s: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M9.3 9.5a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.1.9-1.1 1.7", f: "M12 15.8a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z" },
  mic: { s: "M6 11.5a6 6 0 0 0 12 0 M12 17.5v3 M9 20.5h6", f: "M12 3.5a3.5 3.5 0 0 1 3.5 3.5v4.5a3.5 3.5 0 0 1-7 0V7A3.5 3.5 0 0 1 12 3.5z" },
  image: { s: SQ, f: "M5 16.5l4.5-5 3 3.2 2-2 4.5 4.3V17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z M15.5 7.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" },
  sun: { s: "M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6l1.4 1.4 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4", f: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  moon: { f: "M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" },
  monitor: { s: "M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 14V7A2.5 2.5 0 0 1 6 4.5z", f: "M10.8 16.5h2.4v2.5H16v2H8v-2h2.8z" },
  heart: { s: "M12 20s-7.5-4.6-7.5-10A4 4 0 0 1 12 7.6 4 4 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" },
  globe: { s: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", f: "M8 6.5c2 0 3 1.5 2 3s-3 1-3 3 2 2 1 4-3 .5-3.5-1.5A8 8 0 0 1 8 6.5z M15.5 9c2 0 3.5 1 3.5 3s-2 1.5-2.5 3.5-2 2-3 1-1-2.5 0-3.5 0-2.5 2-4z" },
  broadcast: { s: "M8.5 15.5a5 5 0 0 1 0-7 M15.5 8.5a5 5 0 0 1 0 7 M6 18a8.5 8.5 0 0 1 0-12 M18 6a8.5 8.5 0 0 1 0 12", f: "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" },
  drive: { s: "M9 4h6l6 10.5-3 5.5H6l-3-5.5z M9 4l3 10.5h9 M15 4l-3 10.5-6 11", f: "M9.4 14.5h5.2l-2.6 4.5z" },
  laptop: { s: "M5 5.5h14a2 2 0 0 1 2 2V15H3V7.5a2 2 0 0 1 2-2z M2 18h20", f: "M9 15h6v2H9z" },
  layers: { s: "M12 3.5 3.5 8 12 12.5 20.5 8z M3.5 12 12 16.5 20.5 12 M3.5 16 12 20.5 20.5 16", f: "M12 5 6 8l6 3 6-3z" },
};
function Icon({ name, size }) {
  const ic = ICONS[name] || ICONS.more;
  return html`<svg viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true" class="gi">${ic.s && html`<path d=${ic.s} fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />`}${ic.f && html`<path d=${ic.f} fill="currentColor" stroke="none" />`}</svg>`;
}

const Btn = ({ kind = "primary", size = "", icon, children, className = "", ...rest }) => html`<button class=${["btn", kind, size, icon && !children ? "icon" : "", className].join(" ")} ...${rest}>${icon && html`<${Icon} name=${icon} />`}${children}</button>`;
const Toggle = ({ on, onChange, id, label }) => html`<button id=${id} role="switch" aria-checked=${!!on} aria-label=${label} class=${"toggle" + (on ? " on" : "")} onClick=${() => onChange(!on)} />`;
// JS masonry: fills every column edge to edge (shortest column first), unlike CSS columns which leave trailing columns empty.
const ORI_H = { "9:16": 16 / 9, "16:9": 9 / 16, "1:1": 1 };
function Masonry({ items, render, oriOf, colWidth = 230, gap = 6 }) {
  const ref = useRef(); const [cols, setCols] = useState(5);
  useEffect(() => { const el = ref.current; if (!el) return; const calc = () => setCols(Math.max(2, Math.floor((el.clientWidth + gap) / (colWidth + gap)))); calc(); const ro = new ResizeObserver(calc); ro.observe(el); return () => ro.disconnect(); }, [colWidth, gap]);
  const buckets = Array.from({ length: cols }, () => ({ h: 0, items: [] }));
  for (const it of items) { const b = buckets.reduce((a, c) => (c.h < a.h ? c : a)); b.items.push(it); b.h += (ORI_H[oriOf(it)] || 1) + gap / colWidth; }
  return html`<div class="jm" ref=${ref} style=${{ gap: gap + "px" }}>${buckets.map((b, i) => html`<div key=${i} class="jm-col" style=${{ gap: gap + "px" }}>${b.items.map(render)}</div>`)}</div>`;
}
// A small dropdown: a secondary button that opens a menu of options. Closes on outside click or Escape.
function Dropdown({ value, options, onChange, id, size = "sm", icon, left }) {
  const [open, setOpen] = useState(false); const ref = useRef();
  useEffect(() => { if (!open) return; const k = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); }; const esc = (e) => e.key === "Escape" && setOpen(false); window.addEventListener("mousedown", k); window.addEventListener("keydown", esc); return () => { window.removeEventListener("mousedown", k); window.removeEventListener("keydown", esc); }; }, [open]);
  const cur = options.find((o) => o.value === value) || options[0];
  return html`<div class="dd" ref=${ref}>
    <button class=${"btn secondary " + size} id=${id} aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen((o) => !o)}>${icon && html`<${Icon} name=${icon} size="14" />`}${cur?.label}<${Icon} name="down" size="14" /></button>
    ${open && html`<div class=${"menu dd-menu" + (left ? " left" : "")} role="menu">${options.map((o) => html`<button key=${o.value} class=${"item" + (o.value === value ? " on" : "")} role="menuitem" data-value=${o.value} onClick=${() => { onChange(o.value); setOpen(false); }}>${o.value === value ? html`<${Icon} name="check" />` : html`<span style="width:16px" />`}${o.label}</button>`)}</div>`}
  </div>`;
}
const Seg = ({ value, options, onChange, size = "" }) => html`<div class=${"seg " + size} role="tablist">${options.map((o) => { const v = typeof o === "string" ? o : o.value; const l = typeof o === "string" ? o : o.label; return html`<button key=${v} role="tab" aria-selected=${value === v} class=${value === v ? "on" : ""} onClick=${() => onChange(v)}>${l}</button>`; })}</div>`;
const Chip = ({ tone = "brand", size = "", children, ...rest }) => html`<span class=${"chip " + tone + " " + size} ...${rest}>${children}</span>`;
const Field = ({ label, hint, children, id }) => html`<div class="field">${label && html`<label for=${id}>${label}</label>`}${children}${hint && html`<span class="hint">${hint}</span>`}</div>`;

const StatusChip = ({ status }) => { const map = { "Draft": "neutral", "Rendering": "brand", "Preview ready": "brand", "In review": "neutral", "Changes requested": "ink", "Approved": "brand", "Final ready": "brand", "ready": "brand", "failed": "ink", "missing": "ink", "expired": "ink", "paused": "neutral" }; const label = { ready: "Ready", linking: "Linking", preview: "Making preview", previewing: "Making preview", uploading: "Uploading preview", processing: "Processing", failed: "Failed", missing: "Source missing", expired: "Preview expired", paused: "Paused" }[status] || status; const busy = ["Rendering", "processing", "linking", "preview", "previewing", "uploading"].includes(status); return html`<${Chip} tone=${map[status] || "neutral"} size="sm">${busy ? html`<i class="dot brand pulse" />` : null}${label}<//>`; };

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, opts = {}) => { const id = Math.random(); setItems((x) => [...x.slice(-2), { id, text, ...opts }]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), opts.ms || 2600); }, []);
  return html`<${ToastCtx.Provider} value=${push}>${children}<div class="toasts" aria-live="polite">${items.map((t) => html`<div key=${t.id} class=${"toast " + (t.tone || "")}>${t.icon && html`<${Icon} name=${t.icon} />`}${t.text}</div>`)}</div><//>`;
}
const useToast = () => useContext(ToastCtx);

// ---------- modal ----------
function Modal({ title, sub, onClose, children, wide, footer }) {
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose?.(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return html`<div class="scrim" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}><div class=${"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label=${title}>
    <div class="modal-head"><div><h2 class="t-title">${title}</h2>${sub && html`<p class="muted">${sub}</p>`}</div>${onClose && html`<${Btn} kind="quiet" icon="x" aria-label="Close" onClick=${onClose} />`}</div>
    ${children}
    ${footer && html`<div class="row" style="justify-content:flex-end">${footer}</div>`}
  </div></div>`;
}

// ---------- async states ----------
// status: loading | ready | empty | error. Delay the skeleton 250ms so quick loads do not flash.
function useAsync(fn, deps = []) {
  const [s, set] = useState({ status: "loading", data: null, error: null, slow: false });
  const n = useRef(0);
  const load = useCallback(() => {
    const me = ++n.current;
    set((x) => ({ ...x, status: "loading", error: null, slow: false }));
    const slowT = setTimeout(() => n.current === me && set((x) => (x.status === "loading" ? { ...x, slow: true } : x)), 250);
    Promise.resolve().then(fn).then((data) => { if (n.current !== me) return; clearTimeout(slowT); const empty = data == null || (Array.isArray(data) && data.length === 0); set({ status: empty ? "empty" : "ready", data, error: null, slow: false }); })
      .catch((error) => { if (n.current !== me) return; clearTimeout(slowT); set({ status: "error", data: null, error, slow: false }); });
    return () => clearTimeout(slowT);
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...s, reload: load, setData: (fnOrData) => set((x) => { const data = typeof fnOrData === "function" ? fnOrData(x.data) : fnOrData; const empty = data == null || (Array.isArray(data) && data.length === 0); return { ...x, data, status: empty ? "empty" : "ready" }; }) };
}
const Skeleton = ({ rows = 3, card = true }) => html`<div class=${card ? "card" : ""} aria-busy="true"><div class="col">${Array.from({ length: rows }).map((_, i) => html`<div key=${i} class="skeleton sk-line" style=${{ width: (85 - i * 17) + "%" }} />`)}</div></div>`;
const GridSkeleton = ({ n = 6 }) => html`<div class="grid" aria-busy="true">${Array.from({ length: n }).map((_, i) => html`<div key=${i} class="card tight"><div class="skeleton" style="aspect-ratio:16/10" /><div class="col" style="padding-top:12px"><div class="skeleton sk-line" style="width:70%" /><div class="skeleton sk-line" style="width:40%" /></div></div>`)}</div>`;
const EmptyState = ({ icon = "film", title, text, action }) => html`<div class="state"><div class="ico"><${Icon} name=${icon} /></div><h3 class="t-heading">${title}</h3>${text && html`<p>${text}</p>`}${action}</div>`;
const ErrorState = ({ error, onRetry, title = "Something went wrong" }) => html`<div class="state" role="alert"><div class="ico err"><${Icon} name="alert" /></div><h3 class="t-heading">${title}</h3><p>${error?.message || "Please try again."}</p>${onRetry && html`<${Btn} kind="secondary" size="sm" icon="refresh" onClick=${onRetry}>Try again<//>`}</div>`;
// Picks the view for a useAsync result. `whenEmpty` may be null to treat empty as ready.
function Async({ q, skeleton, whenEmpty, children }) {
  if (q.status === "loading") return q.slow ? (skeleton || html`<${Skeleton} />`) : html`<div style="min-height:120px" />`;
  if (q.status === "error") return html`<${ErrorState} error=${q.error} onRetry=${q.reload} />`;
  if (q.status === "empty" && whenEmpty) return whenEmpty;
  return children(q.data);
}

// ---------- fake video player ----------
// Plays a fake scene. `comments` show as dots on the scrub bar. onSeek/onClickVideo let parents hook in.
// With a real <video> attached (Player `src`), the video is the clock; otherwise wall time, like before.
function usePlayback(duration, { cuts = [] } = {}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const ref = useRef({ time: 0, playing: false, cuts, video: null });
  ref.current.cuts = cuts;
  useEffect(() => { ref.current.time = time; }, [time]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const n = performance.now(); const el = ref.current.video;
      let t = el ? (el.readyState >= 2 && !el.seeking ? el.currentTime : ref.current.time) : ref.current.time + (n - last) / 1000; last = n;
      for (const c of ref.current.cuts) if (t >= c.start && t < c.end) { t = c.end; if (el) el.currentTime = t; } // skip cut parts
      if (t >= duration || (el && el.ended)) { t = Math.min(duration, t); setPlaying(false); }
      ref.current.time = t; setTime(t);
    }, 50);
    return () => clearInterval(id);
  }, [playing, duration]);
  const seek = useCallback((t) => { const v = Math.min(duration, Math.max(0, t)); ref.current.time = v; setTime(v); const el = ref.current.video; if (el && Math.abs(el.currentTime - v) > 0.04) { try { el.currentTime = v; } catch {} } }, [duration]);
  const attach = useCallback((el) => { ref.current.video = el; }, []);
  return { time, playing, setPlaying, seek, attach, toggle: () => setPlaying((p) => (ref.current.time >= duration ? (seek(0), true) : !p)) };
}
const QUALITIES = ["Auto", "1080p", "720p", "480p"];
// Draws the current fake frame to a canvas so a snapshot is a real image.
function drawFrame({ aspect, time, caption, captionLook, zoom }) {
  const W = aspect === "9:16" ? 720 : 1280, H = aspect === "9:16" ? 1280 : aspect === "1:1" ? 1280 : 720;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.save(); g.translate(W / 2, H * .4); g.scale(zoom, zoom); g.translate(-W / 2, -H * .4);
  const bg = g.createRadialGradient(W * .35, H * .4, 0, W * .35, H * .4, Math.max(W, H) * .75); bg.addColorStop(0, "#2a2a2a"); bg.addColorStop(1, "#0a0a0a"); g.fillStyle = bg; g.fillRect(-W, -H, W * 3, H * 3);
  const sway = Math.sin(time * 1.3) * (W * .006);
  const bw = W * .46, bh = H * .7; const body = g.createLinearGradient(0, H - bh, 0, H); body.addColorStop(0, "#3a3a3a"); body.addColorStop(1, "#161616"); g.fillStyle = body;
  g.beginPath(); g.moveTo(W / 2 - bw / 2 + sway, H); g.lineTo(W / 2 - bw / 2 + sway, H - bh + bw * .45); g.quadraticCurveTo(W / 2 + sway, H - bh - bw * .2, W / 2 + bw / 2 + sway, H - bh + bw * .45); g.lineTo(W / 2 + bw / 2 + sway, H); g.fill();
  const r = W * .11; const head = g.createLinearGradient(0, H * .14, 0, H * .14 + r * 2); head.addColorStop(0, "#4a4a4a"); head.addColorStop(1, "#222"); g.fillStyle = head; g.beginPath(); g.arc(W / 2 + sway * 1.5, H * .14 + r, r, 0, Math.PI * 2); g.fill();
  g.restore();
  if (caption) { const fs = Math.round(W * .032); g.font = `600 ${fs}px Inter, system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; const tw = Math.min(W * .8, g.measureText(caption).width + fs * 1.4); const y = H * .82; if (captionLook === "bold") { g.fillStyle = "#fcfdff"; g.beginPath(); g.roundRect((W - tw) / 2, y - fs, tw, fs * 2, fs); g.fill(); g.fillStyle = "#0a0a0a"; g.fillText(caption.toUpperCase(), W / 2, y); } else if (captionLook === "outline") { g.lineWidth = fs * .18; g.strokeStyle = "#000"; g.strokeText(caption, W / 2, y); g.fillStyle = "#fff"; g.fillText(caption, W / 2, y); } else { g.fillStyle = "rgba(0,0,0,.55)"; g.beginPath(); g.roundRect((W - tw) / 2, y - fs, tw, fs * 2, fs * .5); g.fill(); g.fillStyle = "#fff"; g.fillText(caption, W / 2, y); } }
  g.fillStyle = "rgba(255,255,255,.7)"; g.font = `500 ${Math.round(W * .018)}px Inter, system-ui, sans-serif`; g.textAlign = "left"; g.textBaseline = "top"; g.fillText(fmtTime(time, true), W * .02, H * .02);
  return c.toDataURL("image/png");
}
function drawVideoFrame(video, { caption, captionLook, zoom = 1, aspect }) {
  const W = aspect === "9:16" ? 720 : 1280, H = aspect === "9:16" ? 1280 : aspect === "1:1" ? 1280 : 720;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  const vw = video.videoWidth || W, vh = video.videoHeight || H; const k = Math.max(W / vw, H / vh) * zoom;
  g.drawImage(video, (W - vw * k) / 2, (H - vh * k) * 0.4, vw * k, vh * k);
  if (caption) { const fs = Math.round(W * .032); g.font = `600 ${fs}px Inter, system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; const tw = Math.min(W * .8, g.measureText(caption).width + fs * 1.4); const y = H * .82; if (captionLook === "bold") { g.fillStyle = "#fcfdff"; g.beginPath(); g.roundRect((W - tw) / 2, y - fs, tw, fs * 2, fs); g.fill(); g.fillStyle = "#0a0a0a"; g.fillText(caption.toUpperCase(), W / 2, y); } else if (captionLook === "outline") { g.lineWidth = fs * .18; g.strokeStyle = "#000"; g.strokeText(caption, W / 2, y); g.fillStyle = "#fff"; g.fillText(caption, W / 2, y); } else { g.fillStyle = "rgba(0,0,0,.55)"; g.beginPath(); g.roundRect((W - tw) / 2, y - fs, tw, fs * 2, fs * .5); g.fill(); g.fillStyle = "#fff"; g.fillText(caption, W / 2, y); } }
  return c.toDataURL("image/png"); // throws when the video is from another origin without CORS
}
function Player({ pb, duration, caption, captionLook = "clean", zoom = 1, aspect = "16:9", marks = [], onMark, onClickVideo, showControls = true, style = {}, onSnapshot, children, src, videoFit = "contain", onVideoError }) {
  const ar = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" }[aspect] || "16 / 9";
  const toast = useToast();
  // Real footage: the <video> follows the playback state; pb uses it as its clock.
  const videoRef = useRef(null);
  useEffect(() => { pb.attach?.(src ? videoRef.current : null); return () => pb.attach?.(null); }, [src]);
  useEffect(() => { const el = videoRef.current; if (!el || !src) return; if (pb.playing) { if (Math.abs(el.currentTime - pb.time) > 0.3) el.currentTime = pb.time; el.play().catch(() => pb.setPlaying(false)); } else el.pause(); }, [pb.playing, src]);
  useEffect(() => { const el = videoRef.current; if (!el || !src || pb.playing) return; if (Math.abs(el.currentTime - pb.time) > 0.04) { try { el.currentTime = pb.time; } catch {} } }, [pb.time, src]);
  const [quality, setQuality] = useState("Auto"); const [qMenu, setQMenu] = useState(false); const [switching, setSwitching] = useState(false); const [snap, setSnap] = useState(null);
  const effective = quality === "Auto" ? "1080p" : quality;
  const pickQuality = (q) => { setQMenu(false); if (q === quality) return; setSwitching(true); setQuality(q); setTimeout(() => setSwitching(false), 650); };
  const takeSnapshot = (e) => { e?.stopPropagation(); pb.setPlaying(false); try { let url; try { url = src && videoRef.current ? drawVideoFrame(videoRef.current, { caption, captionLook, zoom, aspect }) : null; } catch { url = null; } url ||= drawFrame({ aspect, time: pb.time, caption, captionLook, zoom }); setSnap({ url, time: pb.time }); onSnapshot?.({ url, time: pb.time }); } catch (err) { toast("Could not take a snapshot: " + err.message); } };
  const copySnap = async () => { try { const blob = await (await fetch(snap.url)).blob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast("Snapshot copied", { icon: "check", tone: "brand" }); } catch { toast("Copy is blocked here. Right click the image to save it.", { ms: 4000 }); } };
  const pct = duration ? (pb.time / duration) * 100 : 0;
  const scrubRef = useRef();
  const seekFromEvent = (e) => { const r = scrubRef.current.getBoundingClientRect(); pb.seek(((e.clientX - r.left) / r.width) * duration); };
  const onScrubDown = (e) => { seekFromEvent(e); const mv = (ev) => seekFromEvent(ev); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); };
  const fit = style && style.height === "100%";
  return html`<div class=${"pwrap" + (fit ? " fit" : "")} onClick=${() => qMenu && setQMenu(false)}><div class=${"player q" + effective.replace("p", "")} style=${{ aspectRatio: ar, ...(fit ? {} : style) }}>
    <div class="screen" onClick=${(e) => onClickVideo?.(e)} data-testid="screen">
      ${src ? html`<video ref=${videoRef} src=${src} playsInline preload="auto" onLoadedMetadata=${(e) => { const el = e.currentTarget; if (Math.abs(el.currentTime - pb.time) > 0.1) { try { el.currentTime = pb.time; } catch {} } if (pb.playing) el.play().catch(() => pb.setPlaying(false)); }} onError=${() => onVideoError?.()} style=${{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: videoFit, objectPosition: "50% 40%", background: "#000", transform: `scale(${zoom})`, transformOrigin: "50% 40%", transition: "transform .4s cubic-bezier(.2,.8,.2,1)" }} />` : html`<div class="scene" style=${{ transform: `scale(${zoom})`, transformOrigin: "50% 40%", transition: "transform .4s cubic-bezier(.2,.8,.2,1)" }}>
        <div class="head" style=${{ transform: `translateX(calc(-50% + ${Math.sin(pb.time * 1.3) * 6}px))` }} />
        <div class="subject" style=${{ transform: `translateX(calc(-50% + ${Math.sin(pb.time * 1.3) * 4}px))` }} />
      </div>`}
      ${caption && html`<div class=${"cap " + captionLook}>${caption}</div>`}
      <div class="tc mono">${fmtTime(pb.time, true)}<span class="q-badge">${effective}</span></div>
      ${switching && html`<div class="q-switch"><span class="dot brand pulse" />Switching to ${effective}</div>`}
      ${!pb.playing && !switching && html`<div class="big"><button aria-label="Play" onClick=${(e) => { e.stopPropagation(); pb.toggle(); }}><${Icon} name="play" /></button></div>`}
      ${children}
    </div></div>
    ${showControls && html`<div class="controls">
      <button class="btn icon sm quiet" aria-label=${pb.playing ? "Pause" : "Play"} onClick=${pb.toggle}><${Icon} name=${pb.playing ? "pause" : "play"} /></button>
      <span class="mono t-small" style="min-width:40px">${fmtTime(pb.time)}</span>
      <div class="scrub" ref=${scrubRef} onPointerDown=${onScrubDown} role="slider" aria-label="Seek" aria-valuenow=${Math.round(pb.time)} aria-valuemax=${duration}>
        <div class="track" /><div class="fill" style=${{ width: pct + "%" }} />
        ${marks.map((m) => html`<div key=${m.id} class="mark" title=${m.text} style=${{ left: (m.time / duration) * 100 + "%" }} onPointerDown=${(e) => { e.stopPropagation(); onMark?.(m); }} />`)}
        <div class="knob" style=${{ left: pct + "%" }} />
      </div>
      <span class="mono t-small muted" style="min-width:40px">${fmtTime(duration)}</span>
      <div style="position:relative" onClick=${(e) => e.stopPropagation()}>
        <button class="pctl" id="quality" aria-haspopup="menu" aria-expanded=${qMenu} title="Preview quality" onClick=${() => setQMenu((m) => !m)}>${quality === "Auto" ? "Auto · " + effective : quality}</button>
        ${qMenu && html`<div class="menu qmenu" role="menu">${QUALITIES.map((q) => html`<button key=${q} role="menuitemradio" aria-checked=${q === quality} class=${"item" + (q === quality ? " on" : "")} data-q=${q} onClick=${() => pickQuality(q)}><${Icon} name=${q === quality ? "check" : "more"} />${q}${q === "Auto" ? html`<span class="muted t-small" style="margin-left:auto">best for you</span>` : q === "480p" ? html`<span class="muted t-small" style="margin-left:auto">fastest</span>` : null}</button>`)}</div>`}
      </div>
      <button class="pctl icon" id="snapshot" aria-label="Take a snapshot" title="Snapshot this frame" onClick=${takeSnapshot}><${Icon} name="image" /></button>
    </div>`}
    ${snap && html`<${Modal} title=${"Snapshot at " + fmtTime(snap.time, true)} sub="A still of this exact frame." onClose=${() => setSnap(null)} wide footer=${html`<${Btn} kind="ghost" onClick=${() => setSnap(null)}>Close<//><${Btn} kind="secondary" icon="copy" id="snap-copy" onClick=${copySnap}>Copy image<//><${Btn} icon="check" id="snap-keep" onClick=${() => { toast("Saved to key frames", { icon: "check", tone: "brand" }); setSnap(null); }}>Save to key frames<//>`}>
      <img id="snap-img" src=${snap.url} alt=${"Snapshot at " + fmtTime(snap.time)} style=${{ width: "100%", maxHeight: "60vh", objectFit: "contain", borderRadius: "var(--r-sm)", background: "#000" }} />
    <//>`}
  </div>`;
}
const Art = ({ art = "a", className = "", style }) => html`<div class=${"art " + art + " " + className} style=${style} />`;
// A real frame when we have one, the gradient art when we do not.
const Thumb = ({ src, art = "a" }) => (src ? html`<img class="art" src=${src} alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" />` : html`<${Art} art=${art} />`);
const OriIcon = ({ o }) => html`<${Chip} tone="neutral" size="sm" style="background:rgba(0,0,0,.5);color:#fff">${o === "Portrait" ? "9:16" : o === "Square" ? "1:1" : "16:9"}<//>`;

const NavCtx = createContext({ route: "/login", go: () => {} });
const useNav = () => useContext(NavCtx);
const AppCtx = createContext({});
const useApp = () => useContext(AppCtx);

// Light by default. The switch sets data-theme and remembers it in this browser.
// Dark only. The old light theme is gone; these stay so nothing else has to change.
const readTheme = () => "dark";
const applyTheme = () => { document.documentElement.dataset.theme = "dark"; };
const ThemeBtn = ({ compact }) => { const { theme, setTheme } = useApp(); const dark = theme === "dark"; if (compact) return html`<${Btn} kind="quiet" icon=${dark ? "sun" : "moon"} id="theme-switch" aria-label=${dark ? "Switch to light mode" : "Switch to dark mode"} title=${dark ? "Light mode" : "Dark mode"} onClick=${() => setTheme(dark ? "light" : "dark")} />`; return html`<button class=${"mode" + (dark ? " dark" : "")} id="theme-switch" role="switch" aria-checked=${dark} aria-label=${dark ? "Switch to light mode" : "Switch to dark mode"} title=${dark ? "Light mode" : "Dark mode"} onClick=${() => setTheme(dark ? "light" : "dark")}><i><${Icon} name=${dark ? "moon" : "sun"} /></i></button>`; };

// Copies text; falls back to selecting it when the clipboard is blocked.
async function copyText(text, toast) { try { await navigator.clipboard.writeText(text); toast("Copied", { icon: "check", tone: "brand" }); } catch { toast("Press Cmd+C to copy: " + text, { ms: 5000 }); } }
export {
  React, useState, useEffect, useRef, useMemo, useCallback, useContext, createContext,
  h, html, fmtTime, fmtLen, fmtAgo, initials, Icon, ICONS, Btn, Toggle, Seg, Chip, Field, StatusChip,
  ToastCtx, ToastHost, useToast, Modal, useAsync, Skeleton, GridSkeleton, EmptyState, ErrorState, Async,
  usePlayback, QUALITIES, drawFrame, Player, Art, Thumb, OriIcon, readTheme, applyTheme, ThemeBtn, copyText,
  NavCtx, useNav, AppCtx, useApp,
};
