// The six built-in graphic templates, as HTML + CSS animations, and the virtual clock that drives any graphic.
// The recorder (worker) and the editor's live player use the same HTML and clock, so a graphic looks the same in
// both. The recorder seeks every animation to the exact frame time. Params are escaped; colours are validated.
type P = Record<string, unknown>;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// A string for inline <script>: JSON, with "<" escaped so text like "</script>" cannot end the script early.
const js = (s: unknown) => JSON.stringify(String(s ?? "")).replace(/</g, "\\u003c");
const col = (s: unknown, d: string) => (typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s) ? s : d);
const num = (s: unknown, d: number) => (typeof s === "number" && isFinite(s) ? s : typeof s === "string" && s.trim() !== "" && isFinite(Number(s)) ? Number(s) : d);

const page = (w: number, h: number, css: string, body: string, script = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent;font-family:Inter,"Inter Display",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}${css}</style></head><body>${body}<script>${script}</script></body></html>`;

export function templateHtml(id: string, params: P, w: number, h: number, dur: number, brandLogo?: string | null): string {
  const m = Math.min(w, h);
  const out = Math.max(0.1, dur - 0.45);
  switch (id) {
    case "gt_title_card": {
      const c = col(params.color, "#ffffff"), a = col(params.accent, "#ffcc00");
      return page(w, h, `
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${m * 0.03}px;text-align:center;padding:0 8%;animation:fade ${dur}s linear forwards}
.t{color:${c};font-weight:700;font-size:${m * 0.1}px;line-height:1.05;letter-spacing:-0.02em;text-shadow:0 ${m * 0.006}px ${m * 0.03}px rgba(0,0,0,.45);animation:up .6s cubic-bezier(.2,.8,.2,1) both}
.s{color:${c};opacity:.85;font-weight:500;font-size:${m * 0.042}px;animation:up .6s .15s cubic-bezier(.2,.8,.2,1) both}
.bar{height:${m * 0.012}px;width:${m * 0.3}px;background:${a};border-radius:99px;transform-origin:center;animation:grow .7s .1s cubic-bezier(.2,.8,.2,1) both}
@keyframes up{from{transform:translateY(${m * 0.04}px);opacity:0}to{transform:none;opacity:1}}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes fade{0%{opacity:1}${((out / dur) * 100).toFixed(1)}%{opacity:1}100%{opacity:0}}`,
        `<div class="wrap"><div class="t">${esc(params.title || "Your title")}</div><div class="bar"></div>${params.subtitle ? `<div class="s">${esc(params.subtitle)}</div>` : ""}</div>`);
    }
    case "gt_lower_third": {
      const c = col(params.color, "#ffffff"), a = col(params.accent, "#0a0a0c");
      return page(w, h, `
.p{position:absolute;left:${w * 0.06}px;bottom:${h * 0.16}px;background:${a};border-radius:${m * 0.02}px;padding:${m * 0.022}px ${m * 0.035}px;display:flex;flex-direction:column;gap:${m * 0.006}px;animation:inout ${dur}s cubic-bezier(.2,.8,.2,1) forwards;box-shadow:0 ${m * 0.01}px ${m * 0.04}px rgba(0,0,0,.35)}
.n{color:${c};font-weight:700;font-size:${m * 0.048}px;letter-spacing:-0.01em}.r{color:${c};opacity:.8;font-weight:500;font-size:${m * 0.03}px}
@keyframes inout{0%{transform:translateX(-${w * 0.5}px);opacity:0}${((0.5 / dur) * 100).toFixed(1)}%{transform:none;opacity:1}${((out / dur) * 100).toFixed(1)}%{transform:none;opacity:1}100%{transform:translateX(-${w * 0.1}px);opacity:0}}`,
        `<div class="p"><div class="n">${esc(params.name || "Name")}</div>${params.role ? `<div class="r">${esc(params.role)}</div>` : ""}</div>`);
    }
    case "gt_number_counter": {
      const from = num(params.from, 0), to = num(params.to, 100), c = col(params.color, "#ffffff");
      const dec = Math.max(String(from).split(".")[1]?.length || 0, String(to).split(".")[1]?.length || 0);
      return page(w, h, `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${m * 0.02}px}
.v{color:${c};font-weight:800;font-size:${m * 0.16}px;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;text-shadow:0 ${m * 0.006}px ${m * 0.03}px rgba(0,0,0,.45)}
.l{color:${c};opacity:.85;font-weight:600;font-size:${m * 0.04}px}`,
        `<div class="wrap" id="w"><div class="v" id="v"></div>${params.label ? `<div class="l">${esc(params.label)}</div>` : ""}</div>`,
        `const from=${from},to=${to},dur=${dur},dec=${Math.min(4, dec)},pre=${js(params.prefix)},suf=${js(params.suffix)};
window.renderFrame=function(t){const p=Math.min(1,t/(dur*0.7));const e=1-Math.pow(1-p,3);const v=from+(to-from)*e;
document.getElementById('v').textContent=pre+v.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec})+suf;
const o=t<0.25?t/0.25:t>dur-0.35?Math.max(0,(dur-t)/0.35):1;document.getElementById('w').style.opacity=o;};window.renderFrame(0);`);
    }
    case "gt_kinetic_text": {
      const words = String(params.text || "COLD OUTREACH WORKS").split(/\s+/).filter(Boolean).slice(0, 24);
      const c = col(params.color, "#ffffff"), a = col(params.accent, "#ffcc00");
      const step = Math.min(0.35, (dur * 0.6) / Math.max(1, words.length));
      return page(w, h, `.wrap{position:absolute;inset:0;display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:${m * 0.02}px ${m * 0.03}px;padding:0 8%;animation:fade ${dur}s linear forwards}
.w{color:${c};font-weight:800;font-size:${m * 0.11}px;letter-spacing:-0.02em;line-height:1;text-shadow:0 ${m * 0.006}px ${m * 0.03}px rgba(0,0,0,.45);animation:pop .45s cubic-bezier(.2,1.4,.4,1) both}
.w.hl{color:${a}}
@keyframes pop{from{transform:scale(.3) translateY(${m * 0.05}px);opacity:0}to{transform:none;opacity:1}}
@keyframes fade{0%{opacity:1}${((out / dur) * 100).toFixed(1)}%{opacity:1}100%{opacity:0}}`,
        `<div class="wrap">${words.map((wd, i) => `<span class="w${i % 3 === 2 ? " hl" : ""}" style="animation-delay:${(i * step).toFixed(3)}s">${esc(wd)}</span>`).join("")}</div>`);
    }
    case "gt_progress_bar": {
      const from = Math.max(0, Math.min(100, num(params.from, 0))), to = Math.max(0, Math.min(100, num(params.to, 100))), c = col(params.color, "#ffffff");
      const top = params.position === "top";
      return page(w, h, `.wrap{position:absolute;left:6%;right:6%;${top ? "top" : "bottom"}:${h * 0.06}px;display:flex;flex-direction:column;gap:${m * 0.012}px}
.l{color:${c};font-weight:600;font-size:${m * 0.034}px;text-shadow:0 2px 8px rgba(0,0,0,.4)}
.t{height:${m * 0.016}px;background:rgba(255,255,255,.25);border-radius:99px;overflow:hidden}
.f{height:100%;background:${c};border-radius:99px;animation:fill ${dur}s linear forwards}
@keyframes fill{from{width:${from}%}to{width:${to}%}}`,
        `<div class="wrap">${params.label ? `<div class="l">${esc(params.label)}</div>` : ""}<div class="t"><div class="f"></div></div></div>`);
    }
    case "gt_logo_reveal": {
      const c = col(params.color, "#ffffff");
      const logo = params.logo === "brand" || params.logo == null ? brandLogo : null;
      return page(w, h, `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${m * 0.03}px;animation:fade ${dur}s linear forwards}
.logo{max-width:${m * 0.4}px;max-height:${m * 0.28}px;object-fit:contain;animation:zoom .8s cubic-bezier(.2,1.2,.3,1) both}
.n{color:${c};font-weight:700;font-size:${m * 0.07}px;letter-spacing:-0.01em;animation:rise .6s .35s cubic-bezier(.2,.8,.2,1) both}
@keyframes zoom{from{transform:scale(.4) rotate(-6deg);opacity:0}to{transform:none;opacity:1}}
@keyframes rise{from{transform:translateY(${m * 0.03}px);opacity:0}to{transform:none;opacity:1}}
@keyframes fade{0%{opacity:1}${((out / dur) * 100).toFixed(1)}%{opacity:1}100%{opacity:0}}`,
        `<div class="wrap">${logo ? `<img class="logo" src="${logo}">` : ""}${params.text ? `<div class="n">${esc(params.text)}</div>` : ""}</div>`);
    }
  }
  throw new Error("Unknown template " + id);
}

// Runs inside the page before any of its code: time is virtual and moves only when we say so. Everything a graphic
// can time itself by follows it: performance.now, Date.now, requestAnimationFrame, setTimeout/setInterval (they fire
// in order, each with the clock at its own due time), CSS animations and transitions and element.animate(). Each
// animation runs from the moment it appeared (a class added at 5 s starts its transition at 5 s), not from 0.
// Math.random is seeded, so every browser recording a part of the graphic sees the same "random" values.
// __rendrrAdvance(t, false) moves time without calling renderFrame: the recorder does that for frames it does not
// capture, only when the graphic says renderFrame draws the whole frame from t alone (window.renderFramePure = true).
export const GRAPHIC_CLOCK = `(() => {
  let now = 0, ticks = 0; const start = 1700000000000; let rafs = [], timers = [];
  let seed = 0x5eed1234;
  Math.random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let r = Math.imul(seed ^ (seed >>> 15), 1 | seed); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  const perf = performance.now.bind(performance);
  const born = new WeakMap();
  const seen = (at) => { for (const a of document.getAnimations()) if (!born.has(a)) born.set(a, at); };
  performance.now = () => now * 1000;
  Date.now = () => start + now * 1000;
  window.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
  window.cancelAnimationFrame = () => {};
  const add = (fn, ms, args, every) => { const id = ++ticks; timers.push({ id, at: now + Math.max(0, Number(ms) || 0) / 1000, fn, args, every }); return id; };
  window.setTimeout = (fn, ms, ...args) => add(fn, ms, args, 0);
  window.setInterval = (fn, ms, ...args) => add(fn, Math.max(1, Number(ms) || 0), args, Math.max(1, Number(ms) || 0) / 1000);
  window.clearTimeout = window.clearInterval = (id) => { timers = timers.filter((x) => x.id !== id); };
  const call = (x) => { try { typeof x.fn === "function" ? x.fn(...x.args) : (0, eval)(String(x.fn)); } catch (e) { console.error(e); } };
  window.__rendrrAdvance = (t, draw) => {
    for (let guard = 0; guard < 100000; guard++) {
      let next = null; for (const x of timers) if (x.at <= t && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      now = Math.max(now, next.at);
      if (next.every) next.at += next.every; else timers = timers.filter((x) => x !== next);
      call(next); seen(now);
    }
    now = t;
    const list = rafs; rafs = [];
    for (const cb of list) { try { cb(t * 1000); } catch (e) { console.error(e); } }
    if (draw !== false && typeof window.renderFrame === "function") window.renderFrame(t);
    seen(t);
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = Math.max(0, (t - born.get(a)) * 1000); } catch (e) {} }
    return perf();
  };
})();`;

/**
 * Font families installed in the graphics browser (worker image: apps/worker/fonts.txt plus Inter, Noto and the
 * caption fonts). Arial and Helvetica draw as Arimo, Times New Roman as Tinos, Georgia as Gelasio, Calibri as
 * Carlito, Courier as Cousine (each metric-compatible), Impact as Anton; anything else falls back to Noto Sans.
 */
export const GRAPHIC_FONTS = {
  sans: ["Inter", "Open Sans", "Roboto", "Lato", "Montserrat", "Poppins", "Raleway", "Nunito", "Work Sans", "DM Sans", "Manrope", "Outfit", "Plus Jakarta Sans", "Sora", "Rubik", "Barlow", "Archivo", "Space Grotesk", "Lexend", "Figtree", "Urbanist", "Kanit", "Source Sans 3", "Mulish", "Quicksand", "Josefin Sans", "Exo 2", "Inter Tight", "IBM Plex Sans", "Noto Sans"],
  display: ["Oswald", "Bebas Neue", "Anton", "Archivo Black", "League Spartan", "Fjalla One", "Teko", "Barlow Condensed", "Roboto Condensed", "Black Ops One", "Russo One", "Press Start 2P", "Abril Fatface", "Alfa Slab One", "Bungee", "Titan One", "Righteous", "Lilita One", "Luckiest Guy", "Bangers", "Fredoka", "Baloo 2", "Comfortaa"],
  serif: ["Playfair Display", "Merriweather", "Lora", "DM Serif Display", "Libre Baskerville", "EB Garamond", "Cormorant Garamond", "Roboto Slab", "Bitter", "Fraunces", "Noto Serif"],
  hand: ["Kalam", "Caveat", "Permanent Marker", "Pacifico", "Dancing Script", "Shadows Into Light", "Patrick Hand", "Indie Flower", "Architects Daughter", "Satisfy", "Great Vibes", "Lobster"],
  mono: ["Roboto Mono", "JetBrains Mono", "Fira Code", "Space Mono", "IBM Plex Mono", "Source Code Pro"],
};
export const GRAPHIC_FONT_ALIASES: Record<string, string> = { Arial: "Arimo", Helvetica: "Arimo", "Helvetica Neue": "Arimo", "Times New Roman": "Tinos", Georgia: "Gelasio", Calibri: "Carlito", "Courier New": "Cousine", Impact: "Anton" };

export const wrapGraphicHtml = (code: string, w: number, h: number) =>
  /<html|<body/i.test(code) ? code : `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent;font-family:Inter,system-ui,sans-serif}</style></head><body>${code}</body></html>`;

/**
 * A custom graphic's window.params: the values it was created with, each replaced by the placement's own. Set before
 * the graphic's own scripts run, so it can read them at load. JSON with "<" escaped, so a value cannot end the script.
 */
export function withParams(code: string, params: Record<string, unknown>) {
  return withEarly(code, `<script>window.params=Object.freeze(${JSON.stringify(params).replace(/</g, "\\u003c")});</script>`);
}
/** A tag placed before a graphic's own content and scripts: first in <head>, else <body> or <html>, else in front. */
export function withEarly(code: string, tag: string) {
  for (const re of [/<head[^>]*>/i, /<body[^>]*>/i, /<html[^>]*>/i]) if (re.test(code)) return code.replace(re, (m) => m + tag);
  return tag + code;
}

/**
 * Notes every font a graphic asks for (canvas ctx.font, the CSS of elements with text, as they are added and at the
 * end), so the recorder can say which ones were not there and drew with a fallback. __rendrrMissingFonts() returns
 * the first family of each font asked for (generic names aside) that is neither installed nor loaded by @font-face:
 * text set in "Family, serif" and "Family, monospace" is the same width only when Family itself draws it.
 */
export const GRAPHIC_FONT_WATCH = `(() => {
  const used = new Set(), C = CanvasRenderingContext2D.prototype, d = Object.getOwnPropertyDescriptor(C, "font");
  if (d && d.set) Object.defineProperty(C, "font", { configurable: true, get() { return d.get.call(this); }, set(v) { used.add(String(v)); d.set.call(this, v); } });
  const hasText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false; };
  const note = (el) => { if (el.nodeType === 1 && hasText(el)) { const f = getComputedStyle(el).fontFamily; if (f) used.add(f); } };
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { note(n); n.querySelectorAll("*").forEach(note); } }).observe(document, { childList: true, subtree: true });
  window.__rendrrMissingFonts = async () => {
    document.querySelectorAll("*").forEach(note);
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
    const loaded = new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/^["']|["']$/g, "").toLowerCase()));
    const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong|inherit|initial|unset|revert|-apple-system|blinkmacsystemfont)$/i;
    const probe = document.createElement("span"), c = document.createElement("canvas").getContext("2d"), fams = new Set();
    for (const v of used) {
      let list = v;
      if (/\\d(px|pt|em|rem|%|vh|vw|vmin|vmax)/.test(v)) { probe.style.font = ""; probe.style.font = v; list = probe.style.fontFamily; }
      const first = (list || "").split(",")[0].trim().replace(/^["']+|["']+$/g, "");
      if (first && !generic.test(first) && !loaded.has(first.toLowerCase())) fams.add(first);
    }
    const width = (f) => { if (d && d.set) d.set.call(c, "40px " + f); else c.font = "40px " + f; return c.measureText("Hamburgefonstiv 0123 QWX").width; };
    return [...fams].filter((f) => { const q = JSON.stringify(f); return Math.abs(width(q + ", serif") - width(q + ", monospace")) > 0.01; });
  };
})();`;

/** The virtual clock must run before any of the page's own scripts, so it goes first in <head>. */
export function withClock(html: string, extra = "") {
  const tag = `<script>${GRAPHIC_CLOCK}${extra}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + tag + "</head>");
  return tag + html;
}


/** The size a template is drawn at: the output's shape, at most 720p (the overlay scales it to the output size). */
export function templateSize(outW: number, outH: number) {
  const k = Math.min(1, 1280 / Math.max(outW, outH), 720 / Math.min(outW, outH));
  return { width: Math.round(outW * k), height: Math.round(outH * k) };
}

/**
 * A template for the editor's live player: the recorder's exact HTML and clock, no network (CSP), and time set
 * by the player with postMessage({ rendrrT: seconds }). Shown in a sandboxed iframe (scripts only).
 */
export function playerGraphicHtml(id: string, params: Record<string, unknown>, w: number, h: number, dur: number): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`;
  const listen = `<script>addEventListener("message",function(e){var t=e.data&&e.data.rendrrT;if(typeof t==="number")window.__rendrrAdvance(t)});window.__rendrrAdvance(0);</script>`;
  const html = withClock(templateHtml(id, params, w, h, dur, null));
  return html.replace(/<head[^>]*>/i, (m) => m + csp).replace(/<\/body>/i, listen + "</body>");
}
