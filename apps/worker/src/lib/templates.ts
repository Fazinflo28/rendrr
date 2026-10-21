// The six built-in graphic templates, as HTML + CSS animations. The recorder seeks every animation to the
// exact frame time, so they render the same every time. Params are escaped; colours are validated.
type P = Record<string, unknown>;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
        `const from=${from},to=${to},dur=${dur},dec=${Math.min(4, dec)},pre=${JSON.stringify(String(params.prefix ?? ""))},suf=${JSON.stringify(String(params.suffix ?? ""))};
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
