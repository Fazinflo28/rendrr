// Engine Part 4.1: how each library graphic is drawn. HTML for the graphics recorder and the editor's player (the
// same document, the same virtual clock): every frame is drawn from the time alone (renderFramePure), so any frame can
// be drawn on its own and the recording, the render and the editor agree. Params come checked (libraryParams) and are
// still escaped and clamped here.
import { libraryItem, type LibraryItem } from "./library";

type P = Record<string, unknown>;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const jsq = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c");
const col = (s: unknown, d: string) => (typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s) ? s : d);
const n = (v: unknown, d: number, lo: number, hi: number) => { const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : d)); };
const fontOf = (f: unknown) => (typeof f === "string" && /^[A-Za-z0-9 \-]{1,60}$/.test(f) ? f : "Inter");
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const strs = (v: unknown, max: number, len = 120): string[] => (Array.isArray(v) ? v : []).slice(0, max).map((x) => String(typeof x === "object" && x ? (x as { text?: unknown }).text ?? "" : x ?? "").slice(0, len));

/** Where a block sits: its anchor point (px) and the translate that puts the block's matching corner or edge there. */
function place(pos: unknown, w: number, h: number, def = "center"): { left: number; top: number; tx: string; align: "left" | "center" | "right" } {
  if (pos && typeof pos === "object" && !Array.isArray(pos)) {
    const o = pos as { x?: unknown; y?: unknown };
    return { left: n(o.x, 0.5, 0, 1) * w, top: n(o.y, 0.5, 0, 1) * h, tx: "translate(-50%,-50%)", align: "center" };
  }
  const name = typeof pos === "string" && pos !== "auto" ? pos : def;
  // A tall frame keeps clear of the app's buttons and text at its top and bottom (social safe areas).
  const tall = h > w * 1.2, T = tall ? 0.12 : 0.08, B = tall ? 0.8 : 0.9;
  const at: Record<string, [number, number, string, "left" | "center" | "right"]> = {
    center: [0.5, 0.5, "translate(-50%,-50%)", "center"], top: [0.5, tall ? 0.12 : 0.1, "translate(-50%,0)", "center"], bottom: [0.5, tall ? 0.8 : 0.88, "translate(-50%,-100%)", "center"],
    "lower-third": [0.06, tall ? 0.78 : 0.82, "translate(0,-100%)", "left"], "top-left": [0.06, T, "translate(0,0)", "left"], "top-right": [0.94, T, "translate(-100%,0)", "right"],
    "bottom-left": [0.06, B, "translate(0,-100%)", "left"], "bottom-right": [0.94, B, "translate(-100%,-100%)", "right"],
  };
  const [x, y, tx, align] = at[name] ?? at[def] ?? at.center;
  return { left: x * w, top: y * h, tx, align };
}

/** The page: size, a font, the runtime (clamp, easings, entrance and exit progress), the item's own CSS, body, script. */
function page(w: number, h: number, p: P, css: string, body: string, script: string, o: { background?: string; dur: number; easing?: string } = { dur: 3 }) {
  const m = Math.min(w, h);
  const rt = `var W=${w},H=${h},M=${m},DUR=${o.dur},SP=${n(p.speed, 1, 0.25, 4)},EXIT=${p.exit !== false};
var C=function(x,a,b){a=a===undefined?0:a;b=b===undefined?1:b;return Math.min(b,Math.max(a,x))};
var EZ={"linear":function(t){return t},"ease-out-cubic":function(t){return 1-Math.pow(1-t,3)},"ease-in-out":function(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2},"spring":function(t){return t>=1?1:1-Math.exp(-6.5*t)*Math.cos(10.5*t)}};
var ez=EZ[${jsq(o.easing ?? p.easing ?? "ease-out-cubic")}]||EZ["ease-out-cubic"];
var IN=0.6/SP,OUT=Math.min(0.45/SP,DUR/3);
function pin(t,t0,d){return ez(C((t-(t0||0))/(d||IN)))}
function pout(t){return EXIT?EZ["ease-in-out"](C((t-(DUR-OUT))/OUT)):0}
function $(s){return document.querySelector(s)}function $$(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
function rnd(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;var r=Math.imul(seed^seed>>>15,1|seed);r=r+Math.imul(r^r>>>7,61|r)^r;return((r^r>>>14)>>>0)/4294967296}}
function fmt(v,dec){return v.toLocaleString("en-US",{minimumFractionDigits:dec,maximumFractionDigits:dec})}
window.renderFramePure=true;`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${o.background ?? "transparent"};font-family:"${fontOf(p.font)}",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}.pos{position:absolute}${css}</style></head><body>${body}<script>${rt}
${script}
window.renderFrame(0);</script></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Text with an entrance (and the matching exit)
// ---------------------------------------------------------------------------------------------
function textBlock(p: P, w: number, h: number, kind: string) {
  const m = Math.min(w, h), size = n(p.size, 0.07, 0.015, 0.3) * m, color = col(p.color, "#ffffff"), accent = col(p.accent, "#ffcc00");
  const at = place(p.position, w, h, "center"), align = p.align === "left" || p.align === "right" ? p.align : p.position && typeof p.position === "string" && p.position !== "auto" ? at.align : "center";
  const text = String(p.text ?? "").slice(0, 200);
  const mark = String(p.mark ?? "").trim().toLowerCase();
  const lines = text.split("\n");
  // The marked words: the first run whose words match `mark` (default: the last word; underline: all of it).
  const all = lines.flatMap((l, li) => l.split(/\s+/).filter(Boolean).map((wd) => ({ wd, li })));
  const mk = mark ? mark.split(/\s+/) : [];
  let m0 = -1, m1 = -1;
  if (mk.length) for (let i = 0; i + mk.length <= all.length && m0 < 0; i++) if (mk.every((x, j) => all[i + j].wd.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "") === x.replace(/[^\p{L}\p{N}']/gu, ""))) { m0 = i; m1 = i + mk.length - 1; }
  if (m0 < 0 && ["highlight-wipe", "strike"].includes(kind)) { m0 = all.length - 1; m1 = all.length - 1; }
  if (m0 < 0 && kind === "underline") { m0 = 0; m1 = all.length - 1; }
  const chars = kind === "typewriter";
  let html = "", wi = 0;
  lines.forEach((l, li) => {
    if (li) html += "<br>";
    l.split(/\s+/).filter(Boolean).forEach((wd, j) => {
      // Each marked word is its own mark, so a long marked run still wraps.
      const on = wi >= m0 && wi <= m1 && m0 >= 0, open = on ? `<span class="mk">` : "", close = on ? `</span>` : "";
      const inner = chars ? Array.from(wd).map((c) => `<span class="c">${esc(c)}</span>`).join("") : esc(wd);
      html += `${j ? (chars ? `<span class="c"> </span>` : " ") : ""}${open}<span class="w">${inner}</span>${close}`;
      wi++;
    });
  });
  const box = p.box && typeof p.box === "object" ? (p.box as { color?: unknown; opacity?: unknown }) : null;
  const css = `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};max-width:${w * 0.88}px}
.an{display:inline-block;color:${color};font-weight:${n(p.weight, 800, 100, 900)};font-size:${size}px;line-height:1.12;letter-spacing:-0.01em;text-align:${align};white-space:pre-wrap;${p.shadow === false ? "" : `text-shadow:0 ${m * 0.004}px ${m * 0.02}px rgba(0,0,0,.45);`}${box ? `background:${rgba(col(box.color, "#000000"), n(box.opacity, 0.6, 0, 1))};padding:.3em .55em;border-radius:.22em;` : ""}}
.w{display:inline-block}.mk{position:relative;z-index:0;display:inline-block;white-space:nowrap}
.mk::before{content:"";position:absolute;left:-.14em;right:-.14em;top:.06em;bottom:0;background:${accent};border-radius:.12em;z-index:-1;transform:scaleX(var(--h,0));transform-origin:var(--o,left)}
.mk::after{content:"";position:absolute;left:-.04em;right:-.04em;height:.085em;border-radius:.05em;background:${accent};transform:scaleX(var(--u,0));transform-origin:var(--uo,left);${kind === "strike" ? "top:.55em" : "bottom:-.06em"}}
.c.cur::after{content:"";display:inline-block;width:.07em;height:.95em;background:currentColor;vertical-align:-.12em;margin-left:.05em}body.blink .c.cur::after{visibility:hidden}`;
  return { css, body: `<div class="pos"><div class="an">${html}</div></div>`, markColor: col(p.markColor, "#111111") };
}

const TEXT_SCRIPTS: Record<string, (p: P) => string> = {
  "blur-in": () => `window.renderFrame=function(t){var e=pin(t,0),x=pout(t),a=$(".an");a.style.opacity=C(e)*(1-x);a.style.filter="blur("+((1-C(e))*M*0.035+x*M*0.035).toFixed(2)+"px)";a.style.transform="scale("+(0.92+0.08*e-0.05*x)+")"};`,
  "slide-in": (p) => `var D=${jsq({ left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[String(p.from)] ?? [-1, 0])};
window.renderFrame=function(t){var e=pin(t,0),x=pout(t),a=$(".an"),k=(1-e)+x;a.style.opacity=C(e*2)*(1-C(x*1.6));a.style.transform="translate("+(D[0]*k*W*0.3).toFixed(1)+"px,"+(D[1]*k*H*0.25).toFixed(1)+"px)"};`,
  pop: () => `window.renderFrame=function(t){var e=pin(t,0,IN*1.25),x=pout(t),a=$(".an");a.style.opacity=C(e*3)*(1-C(x*1.3));a.style.transform="scale("+Math.max(0,e*(1-x*0.85)).toFixed(4)+")"};`,
  typewriter: () => `var CH=$$(".c"),N=CH.length,TD=Math.max(IN,N*0.05/SP);
window.renderFrame=function(t){var k=Math.floor(C(t/TD)*N+1e-6),x=pout(t),vis=Math.max(0,k-Math.floor(x*N+1e-6));for(var i=0;i<N;i++){CH[i].style.visibility=i<vis?"visible":"hidden";CH[i].classList.toggle("cur",i===vis-1)}document.body.classList.toggle("blink",t>TD&&x===0&&(t*2)%1>=0.5)};`,
  "word-by-word": () => `var WS=$$(".w"),NW=WS.length,ST=Math.min(0.28,(DUR*0.45)/Math.max(1,NW))/SP;
window.renderFrame=function(t){for(var i=0;i<NW;i++){var e=pin(t,i*ST,IN*0.8),xo=EXIT?EZ["ease-in-out"](C((t-(DUR-OUT)-i*ST*0.25)/(OUT*0.7))):0;WS[i].style.opacity=C(e)*(1-xo);WS[i].style.transform="translateY("+((1-e)*0.35-xo*0.25).toFixed(4)+"em)"}};`,
  "mask-reveal": () => `window.renderFrame=function(t){var e=C(pin(t,0,IN*1.2)),x=pout(t),a=$(".an"),v="inset(-30% "+((1-e)*100).toFixed(2)+"% -30% "+(x*100).toFixed(2)+"%)";a.style.clipPath=v;a.style.webkitClipPath=v};`,
  // The marks sweep one after another, left to right (all within the same time as one).
  "highlight-wipe": () => `var MK=$$(".mk"),NM=Math.max(1,MK.length);
window.renderFrame=function(t){var a=$(".an"),e=C(pin(t,0,IN*0.6)),x=pout(t),hl=C(pin(t,IN*0.5,IN*1.1))*(1-C(x*2));a.style.opacity=e*(1-C(x*2-1));MK.forEach(function(mk,i){var k=C(hl*NM-i);mk.style.setProperty("--h",k.toFixed(4));mk.style.setProperty("--o",x>0?"right":"left");mk.style.color=k>0.5?MARK:""})};`,
  underline: () => `var MK=$$(".mk"),NM=Math.max(1,MK.length);
window.renderFrame=function(t){var a=$(".an"),e=C(pin(t,0,IN*0.6)),x=pout(t),u=C(pin(t,IN*0.5,IN*1.1))*(1-C(x*2));a.style.opacity=e*(1-C(x*2-1));MK.forEach(function(mk,i){mk.style.setProperty("--u",C(u*NM-i).toFixed(4));mk.style.setProperty("--uo",x>0?"right":"left")})};`,
  strike: () => `var MK=$$(".mk"),NM=Math.max(1,MK.length);
window.renderFrame=function(t){var a=$(".an"),e=C(pin(t,0,IN*0.6)),x=pout(t),u=C(pin(t,IN*0.7,IN*0.9));a.style.opacity=e*(1-x);MK.forEach(function(mk,i){var k=C(u*NM-i);mk.style.setProperty("--u",k.toFixed(4));mk.style.opacity=String(1-0.45*k)})};`,
};

// ---------------------------------------------------------------------------------------------
// Lower thirds
// ---------------------------------------------------------------------------------------------
function lowerThird(style: string, p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), size = n(p.size, 0.05, 0.02, 0.12) * m, color = col(p.color, "#ffffff"), accent = col(p.accent, "#ffcc00"), panel = col(p.panel, "#111114");
  const at = place(p.position, w, h, "bottom-left");
  const name = esc(String(p.name ?? "").slice(0, 60)), title = esc(String(p.title ?? "").slice(0, 80));
  const base = `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx}}.lt{position:relative;color:${color};font-size:${size}px;line-height:1.15}.nm{font-weight:${n(p.weight, 800, 100, 900)};letter-spacing:-.01em;white-space:nowrap}.tt{font-weight:500;font-size:.62em;opacity:.88;white-space:nowrap;margin-top:.18em}`;
  const S: Record<string, [string, string, string]> = {
    bar: [`.lt{padding-left:.55em}.bar{position:absolute;left:0;top:0;bottom:0;width:.16em;border-radius:.08em;background:${accent};transform-origin:top}.tx{text-shadow:0 2px 12px rgba(0,0,0,.45)}`,
      `<div class="lt"><div class="bar"></div><div class="tx"><div class="nm">${name}</div>${title ? `<div class="tt">${title}</div>` : ""}</div></div>`,
      `window.renderFrame=function(t){var b=C(pin(t,0,IN*0.7)),e=C(pin(t,IN*0.35)),x=pout(t),v="inset(-20% "+((1-e+x)*100).toFixed(2)+"% -20% 0)";$(".bar").style.transform="scaleY("+(b*(1-x))+")";var s=$(".tx");s.style.clipPath=v;s.style.webkitClipPath=v};`],
    box: [`.lt{padding:.45em .75em;}.bg{position:absolute;inset:0;background:${panel};border-radius:.25em;box-shadow:0 .2em .8em rgba(0,0,0,.35);transform-origin:left}.tx{position:relative}`,
      `<div class="lt"><div class="bg"></div><div class="tx"><div class="nm">${name}</div>${title ? `<div class="tt">${title}</div>` : ""}</div></div>`,
      `window.renderFrame=function(t){var b=C(pin(t,0,IN*0.8)),e=C(pin(t,IN*0.45,IN*0.7)),x=pout(t);var g=$(".bg");g.style.transform="scaleX("+(b*(1-C(x*1.6-0.6)))+")";g.style.transformOrigin=x>0?"right":"left";var s=$(".tx");s.style.opacity=e*(1-C(x*2));s.style.transform="translateY("+((1-e)*0.3)+"em)"};`],
    split: [`.nm{display:inline-block;background:${accent};color:#111;padding:.18em .5em;border-radius:.12em}.tt{display:table;background:${panel};padding:.25em .65em;border-radius:.12em;margin-top:.12em;opacity:1}`,
      `<div class="lt"><div class="nm">${name}</div>${title ? `<div class="tt">${title}</div>` : ""}</div>`,
      `window.renderFrame=function(t){var a=C(pin(t,0)),b=C(pin(t,IN*0.3)),x=pout(t);var nm=$(".nm"),tt=$(".tt");nm.style.transform="translateX("+((1-a+x)*-110)+"%)";nm.style.opacity=C(a*2)*(1-x);if(tt){tt.style.transform="translateX("+((1-b+x)*-110)+"%)";tt.style.opacity=C(b*2)*(1-x)}};`],
    line: [`.ln{height:.07em;background:${accent};border-radius:.04em;margin:.18em 0 .12em;transform-origin:left}.lt{text-shadow:0 2px 12px rgba(0,0,0,.45)}`,
      `<div class="lt"><div class="nm">${name}</div><div class="ln"></div>${title ? `<div class="tt">${title}</div>` : ""}</div>`,
      `window.renderFrame=function(t){var a=C(pin(t,0)),l=C(pin(t,IN*0.35,IN*0.9)),b=C(pin(t,IN*0.7)),x=pout(t);var nm=$(".nm");nm.style.opacity=a*(1-x);nm.style.transform="translateY("+((1-a)*0.4+x*0.2)+"em)";$(".ln").style.transform="scaleX("+(l*(1-x))+")";var tt=$(".tt");if(tt){tt.style.opacity=b*(1-x)*0.88}};`],
    pill: [`.lt{display:flex;align-items:center;gap:.5em;background:${panel};border-radius:99em;padding:.38em .9em .38em .5em;box-shadow:0 .2em .8em rgba(0,0,0,.35);transform-origin:left center}.dot{width:.55em;height:.55em;border-radius:50%;background:${accent};flex:none}.tt{margin-top:0;margin-left:.2em}`,
      `<div class="lt"><div class="dot"></div><div class="nm">${name}</div>${title ? `<div class="tt">${title}</div>` : ""}</div>`,
      `window.renderFrame=function(t){var e=EZ.spring(C(t/(IN*1.2))),x=pout(t),s=$(".lt");s.style.transform="scale("+Math.max(0,e*(1-x))+")";s.style.opacity=C(e*3)*(1-x)};`],
    corner: [`.lt{padding:.5em .8em}.tt{font-size:.5em;letter-spacing:.14em;text-transform:uppercase;color:${accent};opacity:1;margin:0 0 .15em}.cn{position:absolute;inset:0;overflow:visible}.cn path{fill:none;stroke:${accent};stroke-width:${Math.max(2, size * 0.07)}px;stroke-linecap:round}.tx{text-shadow:0 2px 12px rgba(0,0,0,.45)}`,
      `<div class="lt"><svg class="cn" width="100%" height="100%" preserveAspectRatio="none"><path pathLength="1" d="M 0 30 L 0 0 L 30 0"/><path pathLength="1" d="M 100 0 L 100 0"/></svg><div class="tx">${title ? `<div class="tt">${title}</div>` : ""}<div class="nm">${name}</div></div></div>`,
      `var s=$(".cn"),ps=s.querySelectorAll("path");
window.renderFrame=function(t){var r=$(".lt").getBoundingClientRect(),w=r.width,hh=r.height,k=Math.min(w,hh)*0.35;ps[0].setAttribute("d","M 1 "+k+" L 1 1 L "+k+" 1");ps[1].setAttribute("d","M "+(w-1)+" "+(hh-k)+" L "+(w-1)+" "+(hh-1)+" L "+(w-k)+" "+(hh-1));var d=C(pin(t,0,IN*1.2)),e=C(pin(t,IN*0.4)),x=pout(t);for(var i=0;i<2;i++){ps[i].style.strokeDasharray="1";ps[i].style.strokeDashoffset=String(1-d*(1-x))}var tx=$(".tx");tx.style.opacity=e*(1-x);tx.style.transform="translateY("+((1-e)*0.3)+"em)"};`],
  };
  const [css, body, script] = S[style] ?? S.bar;
  return page(w, h, p, base + css, `<div class="pos">${body}</div>`, script, { dur });
}

// ---------------------------------------------------------------------------------------------
// Stats, lists, callouts
// ---------------------------------------------------------------------------------------------
const fadeIO = `function fio(t,el){var e=C(pin(t,0)),x=pout(t);el.style.opacity=e*(1-x);el.style.transform="translateY("+((1-e)*0.04*M+x*0.02*M)+"px)"}`;
function statHtml(id: string, p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), color = col(p.color, "#ffffff"), accent = col(p.accent, "#ffcc00"), at = place(p.position, w, h, "center");
  const posCss = `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};color:${color};text-align:center}`;
  const shadow = `text-shadow:0 2px ${m * 0.02}px rgba(0,0,0,.45);`;
  if (id === "lib_stat_counter") {
    const size = n(p.size, 0.16, 0.05, 0.35) * m;
    return page(w, h, p, `${posCss}.an{${p.card ? `background:rgba(17,17,20,.88);border-radius:${m * 0.03}px;padding:${m * 0.03}px ${m * 0.05}px;` : ""}}.v{font-weight:${n(p.weight, 800, 100, 900)};font-size:${size}px;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1;${p.card ? "" : shadow}}.l{font-weight:600;font-size:${size * 0.28}px;opacity:.88;margin-top:.4em;${p.card ? "" : shadow}}`,
      `<div class="pos"><div class="an"><div class="v" id="v"></div>${p.label ? `<div class="l">${esc(p.label)}</div>` : ""}</div></div>`,
      `${fadeIO}var A=${n(p.from, 0, -1e12, 1e12)},B=${n(p.to, 100, -1e12, 1e12)},D=${Math.round(n(p.decimals, 0, 0, 4))},PRE=${jsq(String(p.prefix ?? "").slice(0, 10))},SUF=${jsq(String(p.suffix ?? "").slice(0, 12))};
window.renderFrame=function(t){fio(t,$(".an"));var e=EZ["ease-out-cubic"](C((t-IN*0.3)/Math.max(0.5,DUR*0.6)));$("#v").textContent=PRE+fmt(A+(B-A)*e,D)+SUF};`, { dur });
  }
  if (id === "lib_stat_ring") {
    const size = n(p.size, 0.32, 0.1, 0.8) * m, sw = size * 0.09, r = (size - sw) / 2, circ = 2 * Math.PI * r;
    return page(w, h, p, `${posCss}.ring{position:relative;width:${size}px;height:${size}px;margin:0 auto}.ring svg{position:absolute;inset:0;transform:rotate(-90deg)}.v{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:${n(p.weight, 800, 100, 900)};font-size:${size * 0.26}px;font-variant-numeric:tabular-nums;${shadow}}.l{font-weight:600;font-size:${size * 0.1}px;margin-top:.5em;${shadow}}`,
      `<div class="pos"><div class="an"><div class="ring"><svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${rgba(color, 0.22)}" stroke-width="${sw}"/><circle id="f" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${accent}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"/></svg><div class="v" id="v"></div></div>${p.label ? `<div class="l">${esc(p.label)}</div>` : ""}</div></div>`,
      `${fadeIO}var PCT=${n(p.percent, 75, 0, 100)},CI=${circ};
window.renderFrame=function(t){fio(t,$(".an"));var e=EZ["ease-out-cubic"](C((t-IN*0.3)/Math.max(0.5,DUR*0.55))),v=PCT*e;$("#f").setAttribute("stroke-dashoffset",String(CI*(1-v/100)));$("#v").textContent=Math.round(v)+"%"};`, { dur });
  }
  if (id === "lib_stat_bars") {
    const size = n(p.size, 0.04, 0.015, 0.1) * m, bars = (Array.isArray(p.bars) ? p.bars : []).slice(0, 5).map((b) => ({ label: String((b as { label?: unknown })?.label ?? "").slice(0, 40), value: n((b as { value?: unknown })?.value, 0, -1e12, 1e12) }));
    const max = n(p.max, 100, 0.0001, 1e12), wbar = Math.min(w * 0.7, m * 1.1);
    return page(w, h, p, `${posCss}.an{width:${wbar}px;text-align:left;font-size:${size}px}.row{margin:.5em 0}.hd{display:flex;justify-content:space-between;font-weight:600;${shadow}}.tr{height:.7em;border-radius:.35em;background:${rgba(color, 0.2)};overflow:hidden;margin-top:.25em}.fl{height:100%;border-radius:.35em;background:${accent};width:0}`,
      `<div class="pos"><div class="an">${bars.map((b, i) => `<div class="row"><div class="hd"><span>${esc(b.label)}</span><span class="nv" data-i="${i}"></span></div><div class="tr"><div class="fl" data-i="${i}"></div></div></div>`).join("")}</div></div>`,
      `${fadeIO}var V=${jsq(bars.map((b) => b.value))},MX=${max},SUF=${jsq(String(p.suffix ?? "").slice(0, 12))},ST=Math.min(0.35,(DUR*0.4)/Math.max(1,V.length));
window.renderFrame=function(t){fio(t,$(".an"));var fl=$$(".fl"),nv=$$(".nv");for(var i=0;i<V.length;i++){var e=EZ["ease-out-cubic"](C((t-IN*0.3-i*ST)/Math.max(0.4,DUR*0.35)));fl[i].style.width=(C(V[i]/MX)*100*e).toFixed(2)+"%";nv[i].textContent=fmt(Math.round(V[i]*e*10)/10,V[i]%1?1:0)+SUF}};`, { dur });
  }
  // before / after
  const size = n(p.size, 0.11, 0.04, 0.25) * m;
  return page(w, h, p, `${posCss}.an{display:flex;align-items:center;gap:${size * 0.5}px}.col{text-align:center}.lb{font-weight:600;font-size:${size * 0.32}px;opacity:.85;${shadow}}.v{font-weight:${n(p.weight, 800, 100, 900)};font-size:${size}px;font-variant-numeric:tabular-nums;line-height:1.05;${shadow}}.af .v{color:${accent}}.ar{font-size:${size * 0.7}px;font-weight:800;color:${accent}}.dl{font-weight:700;font-size:${size * 0.3}px;color:${accent};margin-top:.3em}`,
    `<div class="pos"><div class="an"><div class="col"><div class="lb">${esc(String(p.beforeLabel ?? "Before").slice(0, 40))}</div><div class="v" id="b"></div></div><div class="ar">&rarr;</div><div class="col af"><div class="lb">${esc(String(p.afterLabel ?? "After").slice(0, 40))}</div><div class="v" id="a"></div><div class="dl" id="d"></div></div></div></div>`,
    `${fadeIO}var B=${n(p.before, 12, -1e12, 1e12)},A=${n(p.after, 48, -1e12, 1e12)},PRE=${jsq(String(p.prefix ?? "").slice(0, 10))},SUF=${jsq(String(p.suffix ?? "").slice(0, 12))},DEC=(String(B).split(".")[1]||String(A).split(".")[1]||"").length;
window.renderFrame=function(t){fio(t,$(".an"));var e1=EZ["ease-out-cubic"](C((t-IN*0.3)/Math.max(0.4,DUR*0.25))),e2=EZ["ease-out-cubic"](C((t-IN*0.3-DUR*0.25)/Math.max(0.4,DUR*0.3)));$("#b").textContent=PRE+fmt(B*e1,Math.min(2,DEC))+SUF;$("#a").textContent=PRE+fmt(B+(A-B)*e2,Math.min(2,DEC))+SUF;var ch=B?((A-B)/Math.abs(B))*100:0;var d=$("#d");d.textContent=B?((ch>=0?"+":"")+Math.round(ch)+"%"):"";d.style.opacity=String(C((t-IN*0.3-DUR*0.5)/0.3))};`, { dur });
}

function listHtml(id: string, p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), color = col(p.color, "#ffffff"), accent = col(p.accent, "#ffcc00"), size = n(p.size, 0.045, 0.02, 0.1) * m, at = place(p.position, w, h, "center");
  const items = strs(p.items, id === "lib_list_flow" ? 6 : 8);
  const posCss = `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};color:${color};font-size:${size}px;font-weight:${n(p.weight, 700, 100, 900)}}.tt{font-weight:800;font-size:1.25em;margin-bottom:.5em;text-shadow:0 2px 12px rgba(0,0,0,.45)}`;
  const times = `var N=${items.length},ST=(DUR-IN-OUT-0.3)/Math.max(1,N);`;
  if (id === "lib_list_flow") {
    const vertical = p.vertical === true || h > w;
    return page(w, h, p, `${posCss}.an{display:flex;flex-direction:${vertical ? "column" : "row"};align-items:center;gap:.3em}.bx{background:rgba(17,17,20,.88);border:.08em solid ${accent};border-radius:.35em;padding:.45em .8em;white-space:nowrap}.ar{width:${vertical ? "1em" : "2.2em"};height:${vertical ? "1.6em" : "1em"};flex:none}.ar path{fill:none;stroke:${accent};stroke-width:3;stroke-linecap:round;stroke-linejoin:round}`,
      `<div class="pos"><div class="an">${items.map((it, i) => `${i ? `<svg class="ar" viewBox="${vertical ? "0 0 20 32" : "0 0 44 20"}"><path pathLength="1" d="${vertical ? "M10 2 L10 28 M4 22 L10 29 L16 22" : "M2 10 L40 10 M33 4 L41 10 L33 16"}"/></svg>` : ""}<div class="bx">${esc(it)}</div>`).join("")}</div></div>`,
      `${times}window.renderFrame=function(t){var bx=$$(".bx"),ar=$$(".ar path"),x=pout(t);for(var i=0;i<N;i++){var tb=0.15+i*ST,e=EZ.spring(C((t-tb)/(IN*1.1)));bx[i].style.opacity=C((t-tb)/0.12)*(1-x);bx[i].style.transform="scale("+Math.max(0,e)+")";if(i){var a=C((t-(tb-ST*0.55))/(ST*0.5));ar[i-1].style.strokeDasharray="1";ar[i-1].style.strokeDashoffset=String(1-a);ar[i-1].style.opacity=String(1-x)}}};`, { dur });
  }
  const check = id === "lib_list_checklist";
  return page(w, h, p, `${posCss}.an{text-align:left}.it{display:flex;align-items:center;gap:.55em;margin:.45em 0;text-shadow:0 2px 12px rgba(0,0,0,.45)}.nb{width:1.5em;height:1.5em;flex:none;border-radius:50%;background:${accent};color:#111;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.85em;text-shadow:none}.cb{width:1.3em;height:1.3em;flex:none}.cb rect{fill:rgba(0,0,0,.35);stroke:${color};stroke-width:2.5}.cb path{fill:none;stroke:${accent};stroke-width:4;stroke-linecap:round;stroke-linejoin:round}`,
    `<div class="pos"><div class="an">${p.title ? `<div class="tt">${esc(String(p.title).slice(0, 80))}</div>` : ""}${items.map((it, i) => `<div class="it">${check ? `<svg class="cb" viewBox="0 0 26 26"><rect x="2" y="2" width="22" height="22" rx="5"/><path pathLength="1" d="M7 13.5 L11.5 18 L19.5 8.5"/></svg>` : `<div class="nb">${i + 1}</div>`}<div>${esc(it)}</div></div>`).join("")}</div></div>`,
    `${times}window.renderFrame=function(t){var it=$$(".it"),x=pout(t),tt=$(".tt");if(tt){var e0=C(pin(t,0));tt.style.opacity=e0*(1-x)}for(var i=0;i<N;i++){var tb=0.2+i*ST,e=C(pin(t,tb));it[i].style.opacity=(e*(${check ? "1" : "i<N-1&&t>0.2+(i+1)*ST?0.55:1"}))*(1-x);it[i].style.transform="translateX("+((1-e)*-0.06*M)+"px)";${check ? `var c=C((t-tb-IN*0.5)/0.35),pth=it[i].querySelector("path");pth.style.strokeDasharray="1";pth.style.strokeDashoffset=String(1-c);` : ""}}};`, { dur });
}

/** A hand-drawn line: a path from a to b that wobbles a little (seeded, so it is the same in every frame). */
function rough(x1: number, y1: number, x2: number, y2: number, seed: number) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const len = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / (len || 1), ny = (x2 - x1) / (len || 1), k = len * 0.06;
  const mx = (x1 + x2) / 2 + nx * k * r() * 2, my = (y1 + y2) / 2 + ny * k * r() * 2;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

function calloutHtml(id: string, p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), color = col(p.color, id === "lib_callout_circle" ? "#ff3b30" : id === "lib_callout_arrow" ? "#ffcc00" : "#ffffff"), x = n(p.x, 0.5, 0, 1) * w, y = n(p.y, 0.45, 0, 1) * h, size = n(p.size, 0.045, 0.015, 0.1) * m;
  const label = esc(String(p.label ?? "").slice(0, 60));
  const lab = (lx: number, ly: number, tx: string) => (label ? `<div class="lb" style="left:${lx.toFixed(1)}px;top:${ly.toFixed(1)}px;transform:${tx}">${label}</div>` : "");
  const css = `.lb{position:absolute;color:#111;background:${color};font-weight:800;font-size:${size}px;padding:.25em .55em;border-radius:.3em;white-space:nowrap;box-shadow:0 .15em .6em rgba(0,0,0,.35)}svg.f{position:absolute;inset:0}svg.f path{fill:none;stroke:${color};stroke-linecap:round;stroke-linejoin:round}`;
  if (id === "lib_callout_arrow") {
    // From a tail towards the middle of the frame to the point, bending a little.
    const cx = w / 2, cy = h / 2, dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy) || 1, L = m * 0.26;
    const tx = x + (dx / d) * L + (dy / d) * L * 0.25, ty = y + (dy / d) * L - (dx / d) * L * 0.25;
    const ang = Math.atan2(y - (y + ty) / 2, x - (x + tx) / 2), hl = m * 0.035, sw = Math.max(3, m * 0.009);
    const head = `M ${(x - hl * Math.cos(ang - 0.5)).toFixed(1)} ${(y - hl * Math.sin(ang - 0.5)).toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)} L ${(x - hl * Math.cos(ang + 0.5)).toFixed(1)} ${(y - hl * Math.sin(ang + 0.5)).toFixed(1)}`;
    return page(w, h, p, css, `<svg class="f" width="${w}" height="${h}"><path id="a" pathLength="1" stroke-width="${sw}" d="${rough(tx, ty, x, y, 7)}"/><path id="hd" stroke-width="${sw}" d="${head}"/></svg>${lab(tx, ty, `translate(${tx > x ? "0" : "-100%"},-50%)`)}`,
      `window.renderFrame=function(t){var e=C(pin(t,0,IN*1.2)),xx=pout(t),a=$("#a");a.style.strokeDasharray="1";a.style.strokeDashoffset=String(1-e);$("#hd").style.opacity=String(C((e-0.9)*10)*(1-xx));a.style.opacity=String(1-xx);var l=$(".lb");if(l){var k=EZ.spring(C(t/(IN*1.3)));l.style.transform=l.style.transform.replace(/ scale\\([^)]*\\)/,"")+" scale("+Math.max(0,k*(1-xx))+")"}};`, { dur });
  }
  if (id === "lib_callout_circle") {
    const r = n(p.radius, 0.12, 0.02, 0.5) * m, sw = Math.max(3, m * 0.008);
    let s = 11; const rr = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    const pts: string[] = [];
    for (let i = 0; i <= 40; i++) { const a = -Math.PI * 0.6 + (i / 40) * Math.PI * 2.25, k = 1 + rr() * 0.06 + i * 0.002; pts.push(`${(x + Math.cos(a) * r * 1.15 * k).toFixed(1)} ${(y + Math.sin(a) * r * k).toFixed(1)}`); }
    return page(w, h, p, css, `<svg class="f" width="${w}" height="${h}"><path id="c" pathLength="1" stroke-width="${sw}" d="M ${pts.join(" L ")}"/></svg>${lab(x, y + r * 1.1, "translate(-50%,0)")}`,
      `window.renderFrame=function(t){var e=C(pin(t,0,IN*1.3)),xx=pout(t),c=$("#c");c.style.strokeDasharray="1";c.style.strokeDashoffset=String(1-e);c.style.opacity=String(1-xx);var l=$(".lb");if(l)l.style.opacity=String(C((t-IN)/0.25)*(1-xx))};`, { dur });
  }
  if (id === "lib_callout_zoombox") {
    const bx = n(p.x, 0.35, 0, 1) * w, by = n(p.y, 0.3, 0, 1) * h, bw = n(p.w, 0.3, 0.02, 1) * w, bh = n(p.h, 0.3, 0.02, 1) * h, sw = Math.max(2, m * 0.006), k = Math.min(bw, bh) * 0.18;
    return page(w, h, p, `${css}.bx{position:absolute;left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;border:${sw}px solid ${rgba(color, 0.85)};border-radius:${sw * 2}px;box-shadow:0 0 0 ${m}px rgba(0,0,0,.25)}.ck{position:absolute;width:${k}px;height:${k}px;border:${sw * 2}px solid ${color}}`,
      `<div class="bx"><div class="ck" style="left:-${sw * 2}px;top:-${sw * 2}px;border-right:0;border-bottom:0"></div><div class="ck" style="right:-${sw * 2}px;top:-${sw * 2}px;border-left:0;border-bottom:0"></div><div class="ck" style="left:-${sw * 2}px;bottom:-${sw * 2}px;border-right:0;border-top:0"></div><div class="ck" style="right:-${sw * 2}px;bottom:-${sw * 2}px;border-left:0;border-top:0"></div></div>${lab(bx, by - sw * 3, "translate(0,-100%)")}`,
      `window.renderFrame=function(t){var e=C(pin(t,0)),xx=pout(t),b=$(".bx");b.style.opacity=e*(1-xx);b.style.transform="scale("+(1.15-0.15*e)+")";var l=$(".lb");if(l)l.style.opacity=String(C((t-IN*0.6)/0.25)*(1-xx))};`, { dur });
  }
  // spotlight
  const r = n(p.radius, 0.18, 0.03, 0.6) * m, dim = n(p.dim, 0.65, 0.1, 0.95);
  return page(w, h, p, `${css}.sp{position:absolute;inset:0;background:radial-gradient(circle at ${x.toFixed(1)}px ${y.toFixed(1)}px, rgba(0,0,0,0) ${(r * 0.92).toFixed(1)}px, rgba(0,0,0,${dim}) ${(r * 1.12).toFixed(1)}px)}`,
    `<div class="sp"></div>${lab(x, y + r * 1.15, "translate(-50%,0)")}`,
    `window.renderFrame=function(t){var e=C(pin(t,0)),xx=pout(t);$(".sp").style.opacity=String(e*(1-xx));var l=$(".lb");if(l)l.style.opacity=String(C((t-IN*0.6)/0.25)*(1-xx))};`, { dur });
}

// ---------------------------------------------------------------------------------------------
// Whiteboard
// ---------------------------------------------------------------------------------------------
function whiteboardHtml(p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), BW = w * 2.4, BH = h * 2.4, size = n(p.size, 0.09, 0.03, 0.2) * m;
  const raw = (Array.isArray(p.notes) ? p.notes : []).slice(0, 8);
  const notes = raw.map((x, i) => {
    const o = (x && typeof x === "object" ? x : { text: x }) as { text?: unknown; x?: unknown; y?: unknown };
    // Placed: where asked (0-1 of the board), else a zigzag across the board.
    const ax = 0.18 + (i % 3) * 0.32 + (Math.floor(i / 3) % 2 ? 0.08 : 0), ay = 0.22 + Math.floor(i / 3) * 0.3 + (i % 2 ? 0.06 : 0);
    return { text: String(o.text ?? "").slice(0, 60), x: n(o.x, ax, 0.05, 0.95) * BW, y: n(o.y, Math.min(0.9, ay), 0.05, 0.95) * BH };
  });
  const ink = col(p.ink, "#1f2937"), accent = col(p.accent, "#2563eb"), board = col(p.board, "#fbfbf7");
  const arrows = notes.slice(1).map((nt, i) => { const a = notes[i]; const dx = nt.x - a.x, dy = nt.y - a.y, d = Math.hypot(dx, dy) || 1, off = size * 1.4; return rough(a.x + (dx / d) * off, a.y + (dy / d) * off, nt.x - (dx / d) * off, nt.y - (dy / d) * off, 31 + i); });
  return page(w, h, p, `.bd{position:absolute;left:0;top:0;width:${BW}px;height:${BH}px;transform-origin:0 0;background-color:${board};background-image:radial-gradient(${rgba(ink, 0.12)} ${Math.max(1, m * 0.003)}px, transparent ${Math.max(1.5, m * 0.004)}px);background-size:${m * 0.06}px ${m * 0.06}px}
.nt{position:absolute;transform:translate(-50%,-50%);color:${ink};font-size:${size}px;font-weight:700;white-space:nowrap;line-height:1.1}.nt span{display:inline-block}svg.lines{position:absolute;left:0;top:0;width:${BW}px;height:${BH}px;overflow:visible}svg.lines path{fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    `<div class="bd"><svg class="lines" width="${BW}" height="${BH}">${arrows.map((d) => `<path class="arw" pathLength="1" stroke="${accent}" stroke-width="${Math.max(3, size * 0.07)}" d="${d}"/>`).join("")}${notes.map(() => `<path class="ul" pathLength="1" stroke="${accent}" stroke-width="${Math.max(3, size * 0.08)}" d=""/>`).join("")}</svg>${notes.map((nt) => `<div class="nt" style="left:${nt.x.toFixed(1)}px;top:${nt.y.toFixed(1)}px"><span>${esc(nt.text)}</span></div>`).join("")}</div>`,
    `var NT=${jsq(notes.map((x) => [x.x, x.y]))},N=NT.length,BW=${BW},BH=${BH},SEG=(DUR*0.82)/Math.max(1,N),done=false;
function ease(t){return EZ["ease-in-out"](C(t))}
window.renderFrame=function(t){var bd=$(".bd"),nts=$$(".nt span"),ul=$$(".ul"),arw=$$(".arw");
 if(!done){done=true;$$(".nt").forEach(function(el,i){var r=el.getBoundingClientRect(),s=1;var w2=el.offsetWidth/2,yy=NT[i][1]+el.offsetHeight*0.55;ul[i].setAttribute("d","M "+(NT[i][0]-w2)+" "+yy+" Q "+NT[i][0]+" "+(yy+el.offsetHeight*0.12)+" "+(NT[i][0]+w2)+" "+(yy-el.offsetHeight*0.05))})}
 var i=Math.min(N-1,Math.floor(t/SEG)),f=(t-i*SEG)/SEG,cx,cy,sc=1;
 var prev=NT[Math.max(0,i-1)],cur=NT[i],mv=i===0?1:ease(f/0.35);cx=prev[0]+(cur[0]-prev[0])*mv;cy=prev[1]+(cur[1]-prev[1])*mv;
 var pb=C((t-DUR*0.82)/(DUR*0.15)),fit=Math.min(W/BW,H/BH);if(pb>0){var e=ease(pb);sc=1+(fit-1)*e;cx=cx+(BW/2-cx)*e;cy=cy+(BH/2-cy)*e}
 bd.style.transform="translate("+(W/2-cx*sc).toFixed(2)+"px,"+(H/2-cy*sc).toFixed(2)+"px) scale("+sc.toFixed(5)+")";
 for(var k=0;k<N;k++){var s0=k*SEG+(k===0?0:SEG*0.3),wr=C((t-s0)/(SEG*0.4)),u=C((t-s0-SEG*0.4)/(SEG*0.25));var v="inset(-20% "+((1-wr)*100).toFixed(2)+"% -20% 0)";nts[k].style.clipPath=v;nts[k].style.webkitClipPath=v;ul[k].style.strokeDasharray="1";ul[k].style.strokeDashoffset=String(1-u);if(k>0){var a=C((t-k*SEG)/(SEG*0.35));arw[k-1].style.strokeDasharray="1";arw[k-1].style.strokeDashoffset=String(1-a)}}};`,
    { dur, background: board });
}

// ---------------------------------------------------------------------------------------------
// Transitions drawn over the picture
// ---------------------------------------------------------------------------------------------
function glitchHtml(p: P, w: number, h: number, dur: number) {
  return page(w, h, p, `canvas{position:absolute;inset:0}`, `<canvas id="c" width="${w}" height="${h}"></canvas>`,
    `var g=$("#c").getContext("2d"),I=${n(p.intensity, 0.7, 0.1, 1)},A=${jsq(col(p.color, "#00e5ff"))},B=${jsq(col(p.accent, "#ff2bd6"))};
window.renderFrame=function(t){g.clearRect(0,0,W,H);var env=Math.sin(Math.PI*C(t/DUR));if(env<=0.001)return;var r=rnd(Math.floor(t*30)+7),k=env*I;
 for(var i=0;i<Math.round(14*k)+2;i++){var y=r()*H,hh=(0.005+r()*0.06)*H,x=(r()-0.3)*W*0.4;g.globalAlpha=(0.25+r()*0.5)*k;g.fillStyle=r()<0.5?A:B;g.fillRect(x,y,W*(0.3+r()*0.9),hh)}
 g.globalAlpha=0.18*k;g.fillStyle="#ffffff";for(var y2=0;y2<H;y2+=4)g.fillRect(0,y2,W,1);
 for(var j=0;j<Math.round(30*k);j++){g.globalAlpha=r()*k;g.fillStyle=r()<0.5?"#000":"#fff";g.fillRect(r()*W,r()*H,r()*W*0.04,r()*H*0.01)}g.globalAlpha=1};`, { dur });
}
function lightLeakHtml(p: P, w: number, h: number, dur: number) {
  return page(w, h, p, `canvas{position:absolute;inset:0}`, `<canvas id="c" width="${w}" height="${h}"></canvas>`,
    `var g=$("#c").getContext("2d"),A=${jsq(col(p.color, "#ff9a3c"))},B=${jsq(col(p.accent, "#ff3c6e"))},S=${n(p.strength, 0.75, 0.1, 1)},DIR=${p.from === "right" ? -1 : 1};
function blob(x,y,r,c,a){var gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,c);gr.addColorStop(1,"rgba(0,0,0,0)");g.globalAlpha=a;g.fillStyle=gr;g.fillRect(0,0,W,H)}
window.renderFrame=function(t){g.clearRect(0,0,W,H);var u=C(t/DUR),env=Math.sin(Math.PI*u);if(env<=0.001)return;g.globalCompositeOperation="lighter";var cx=DIR>0?(-0.3+1.6*u)*W:(1.3-1.6*u)*W;
 blob(cx,H*0.35,Math.max(W,H)*0.55,A,0.65*S*env);blob(cx-DIR*W*0.25,H*0.75,Math.max(W,H)*0.45,B,0.5*S*env);blob(cx+DIR*W*0.15,H*0.1,Math.max(W,H)*0.3,"#fff6d5",0.35*S*env);g.globalCompositeOperation="source-over";g.globalAlpha=1};`, { dur });
}

// ---------------------------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------------------------
const heart = `<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3.1 4.5 6.9 4.5c2.1 0 3.6 1.2 5.1 3 1.5-1.8 3-3 5.1-3 3.8 0 6 3.9 4.5 7.3C19.5 16.4 12 21 12 21z" fill="#ef4444"/></svg>`;
function socialHtml(id: string, p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), size = n(p.size, 0.036, 0.015, 0.08) * m, at = place(p.position, w, h, "center");
  const posCss = `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};font-size:${size}px}`;
  const popIO = `function pio(t,el){var e=EZ.spring(C(t/(IN*1.25))),x=pout(t);el.style.transform="scale("+Math.max(0,e*(1-x*0.8))+")";el.style.opacity=String(C(e*3)*(1-x))}`;
  const initial = (s: unknown) => esc(String(s ?? "?").replace(/^[@.\s]+/, "").charAt(0).toUpperCase() || "?");
  if (id === "lib_social_comment") {
    return page(w, h, p, `${posCss}.cm{display:flex;gap:.7em;background:#fff;color:#111;border-radius:1em;padding:.8em 1em;max-width:${Math.min(w * 0.8, m * 1.1)}px;box-shadow:0 .3em 1.2em rgba(0,0,0,.35);transform-origin:left center}.av{width:2.4em;height:2.4em;border-radius:50%;flex:none;background:${col(p.avatar, "#7c3aed")};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1em}.nm{font-weight:700;font-size:.85em;opacity:.7}.tx{font-weight:600;margin-top:.2em;line-height:1.25}.lk{display:flex;align-items:center;gap:.3em;font-size:.8em;margin-top:.45em;opacity:.75}.hr{display:inline-flex}`,
      `<div class="pos"><div class="cm"><div class="av">${initial(p.name)}</div><div><div class="nm">${esc(String(p.name ?? "").slice(0, 40))}</div><div class="tx">${esc(String(p.text ?? "").slice(0, 200))}</div><div class="lk"><span class="hr">${heart}</span><span id="l"></span></div></div></div></div>`,
      `${popIO}var LK=${Math.round(n(p.likes, 128, 0, 1e9))};window.renderFrame=function(t){pio(t,$(".cm"));var e=EZ["ease-out-cubic"](C((t-IN)/Math.max(0.5,DUR*0.4)));$("#l").textContent=fmt(Math.round(LK*e),0);var b=C((t-DUR*0.45)/0.35);$(".hr").style.transform="scale("+(1+0.4*Math.sin(Math.PI*b))+")"};`, { dur });
  }
  if (id === "lib_social_notification") {
    const wn = Math.min(w * 0.9, m * 1.15);
    return page(w, h, p, `.nf{position:absolute;left:${(w - wn) / 2}px;top:${h * 0.03}px;width:${wn}px;font-size:${size}px;background:rgba(28,28,30,.92);color:#fff;border-radius:1.1em;padding:.8em 1em;display:flex;gap:.75em;box-shadow:0 .3em 1.4em rgba(0,0,0,.45)}.ic{width:2.3em;height:2.3em;border-radius:.6em;flex:none;background:${col(p.icon, "#111827")};display:flex;align-items:center;justify-content:center;font-weight:800;border:1px solid rgba(255,255,255,.15)}.hd{display:flex;justify-content:space-between;font-size:.78em;opacity:.65;text-transform:uppercase;letter-spacing:.04em}.tt{font-weight:700;margin-top:.15em}.bd{opacity:.85;margin-top:.1em;line-height:1.25}`,
      `<div class="nf"><div class="ic">${initial(p.app)}</div><div style="flex:1"><div class="hd"><span>${esc(String(p.app ?? "").slice(0, 30))}</span><span>now</span></div><div class="tt">${esc(String(p.title ?? "").slice(0, 60))}</div><div class="bd">${esc(String(p.body ?? "").slice(0, 120))}</div></div></div>`,
      `window.renderFrame=function(t){var e=pin(t,0,IN*1.1),x=pout(t),el=$(".nf");el.style.transform="translateY("+((1-e+x)*-140).toFixed(2)+"%)";el.style.opacity=String(C(e*2)*(1-C(x*1.5)))};`, { dur });
  }
  if (id === "lib_social_followers") {
    const color = col(p.color, "#ffffff"), accent = col(p.accent, "#ffcc00"), big = n(p.size, 0.12, 0.04, 0.25) * m;
    return page(w, h, p, `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};color:${color};text-align:center}.v{font-weight:${n(p.weight, 800, 100, 900)};font-size:${big}px;font-variant-numeric:tabular-nums;line-height:1;text-shadow:0 2px ${m * 0.02}px rgba(0,0,0,.45)}.l{font-weight:600;font-size:${big * 0.3}px;opacity:.88;text-shadow:0 2px 12px rgba(0,0,0,.45)}.ch{position:absolute;left:50%;top:0;background:${accent};color:#111;font-weight:800;font-size:${big * 0.22}px;padding:.15em .45em;border-radius:99em;opacity:0}`,
      `<div class="pos"><div class="an"><div class="v" id="v"></div><div class="l">${esc(String(p.label ?? "followers").slice(0, 30))}</div>${Array.from({ length: 6 }, () => `<div class="ch">+1</div>`).join("")}</div></div>`,
      `var A=${Math.round(n(p.from, 9870, 0, 1e12))},B=${Math.round(n(p.to, 10000, 0, 1e12))};
window.renderFrame=function(t){var e0=C(pin(t,0)),x=pout(t),an=$(".an");an.style.opacity=e0*(1-x);var e=EZ["ease-in-out"](C((t-IN*0.3)/Math.max(0.5,DUR*0.7)));$("#v").textContent=fmt(Math.round(A+(B-A)*e),0);
 $$(".ch").forEach(function(c,i){var r=rnd(i*97+5),t0=IN*0.4+i*(DUR*0.6/6),u=C((t-t0)/0.9);c.style.opacity=String(u>0&&u<1?Math.sin(Math.PI*u)*(1-x):0);c.style.transform="translate("+((r()-0.5)*260-50)+"%,"+(-60-u*160)+"%)"})};`, { dur });
  }
  if (id === "lib_social_chat") {
    const msgs = (Array.isArray(p.messages) ? p.messages : []).slice(0, 6).map((x) => ({ side: (x as { side?: unknown })?.side === "right" ? "right" : "left", text: String((x as { text?: unknown })?.text ?? x ?? "").slice(0, 160) }));
    const wc = Math.min(w * 0.8, m * 1.1);
    return page(w, h, p, `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};width:${wc}px;font-size:${size}px}.ms{display:flex;margin:.35em 0}.ms.right{justify-content:flex-end}.bb{max-width:78%;padding:.55em .85em;border-radius:1.1em;line-height:1.25;font-weight:500;box-shadow:0 .15em .6em rgba(0,0,0,.25)}.left .bb{background:${col(p.theirs, "#e5e7eb")};color:#111;border-bottom-left-radius:.3em}.right .bb{background:${col(p.mine, "#2563eb")};color:#fff;border-bottom-right-radius:.3em}.ty{display:none}.ty .bb{display:flex;gap:.25em;padding:.75em .9em}.ty i{width:.45em;height:.45em;border-radius:50%;background:#666;display:block}`,
      `<div class="pos">${msgs.map((x, i) => `${x.side === "left" ? `<div class="ms left ty" data-i="${i}"><div class="bb"><i></i><i></i><i></i></div></div>` : ""}<div class="ms ${x.side} mm" data-i="${i}"><div class="bb">${esc(x.text)}</div></div>`).join("")}</div>`,
      `var MS=$$(".mm"),N=MS.length,ST=(DUR-OUT-0.4)/Math.max(1,N);
window.renderFrame=function(t){var x=pout(t);for(var i=0;i<N;i++){var tb=0.25+i*ST,e=EZ.spring(C((t-tb)/(IN*1.1))),ty=document.querySelector('.ty[data-i="'+i+'"]');var showTy=ty&&t>tb-0.6&&t<tb;if(ty){ty.style.display=showTy?"flex":"none";ty.querySelectorAll("i").forEach(function(d,k){d.style.opacity=String(0.35+0.65*Math.abs(Math.sin((t*3+k*0.33)*Math.PI)))})}MS[i].style.display=t>=tb?"flex":"none";MS[i].style.opacity=String(C(e*3)*(1-x));MS[i].firstChild.style.transform="scale("+Math.max(0,e)+")"}};`, { dur });
  }
  // post card
  const wc = Math.min(w * 0.82, m * 1.15);
  const icon = (d: string) => `<svg viewBox="0 0 24 24" width="1.1em" height="1.1em"><path d="${d}" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return page(w, h, p, `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};font-size:${size}px}.pc{width:${wc}px;background:#fff;color:#0f172a;border-radius:1em;padding:1em 1.1em;box-shadow:0 .3em 1.4em rgba(0,0,0,.35)}.hd{display:flex;gap:.65em;align-items:center}.av{width:2.4em;height:2.4em;border-radius:50%;background:${col(p.avatar, "#f97316")};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}.nm{font-weight:800}.hn{color:#64748b;font-size:.9em}.tx{margin:.7em 0 .8em;font-size:1.08em;line-height:1.3}.ft{display:flex;gap:1.6em;color:#64748b;font-size:.85em}.ft span{display:flex;align-items:center;gap:.35em}`,
    `<div class="pos"><div class="pc"><div class="hd"><div class="av">${initial(p.name)}</div><div><div class="nm">${esc(String(p.name ?? "").slice(0, 40))}</div><div class="hn">${esc(String(p.handle ?? "").slice(0, 30))}</div></div></div><div class="tx">${esc(String(p.text ?? "").slice(0, 280))}</div><div class="ft"><span>${icon("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z")}<b id="r"></b></span><span>${icon("M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3")}<b id="s"></b></span><span>${icon("M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3.1 4.5 6.9 4.5c2.1 0 3.6 1.2 5.1 3 1.5-1.8 3-3 5.1-3 3.8 0 6 3.9 4.5 7.3C19.5 16.4 12 21 12 21z")}<b id="l"></b></span></div></div></div>`,
    `${popIO}var V=[${Math.round(n(p.replies, 48, 0, 1e9))},${Math.round(n(p.reposts, 210, 0, 1e9))},${Math.round(n(p.likes, 1900, 0, 1e9))}];
window.renderFrame=function(t){pio(t,$(".pc"));var e=EZ["ease-out-cubic"](C((t-IN)/Math.max(0.5,DUR*0.5)));["r","s","l"].forEach(function(k,i){$("#"+k).textContent=fmt(Math.round(V[i]*e),0)})};`, { dur });
}

// ---------------------------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------------------------
const SVG_TAGS = /^(path|circle|line|polyline|polygon|rect|ellipse|g)$/;
const SVG_ATTRS = /^(d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|points|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|transform|fill-rule|clip-rule|opacity)$/;
/** Only plain shapes and safe attributes of an icon's SVG are kept (it comes in a placement's params). */
export function cleanIconSvg(svg: unknown): string {
  const s = String(svg ?? "").slice(0, 20_000);
  const vb = /viewBox="([\d.\s-]+)"/.exec(s)?.[1] ?? "0 0 24 24";
  // A filled icon (its <svg> fills with currentColor) is drawn filled; others as lines.
  const filled = /<svg[^>]*\sfill="currentColor"/.test(s);
  const out: string[] = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, self] = m;
    if (!SVG_TAGS.test(tag)) continue;
    if (close) { out.push(`</${tag}>`); continue; }
    const kept = Array.from(attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)).filter(([, k, v]) => SVG_ATTRS.test(k) && /^[\w\s.,#()%-]*$/.test(v)).map(([, k, v]) => `${k}="${v}"`);
    out.push(`<${tag}${kept.length ? " " + kept.join(" ") : ""}${self ? "/" : ""}>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" ${filled ? `fill="currentColor" stroke="none"` : `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`}>${out.join("")}</svg>`;
}
function iconHtml(p: P, w: number, h: number, dur: number) {
  const m = Math.min(w, h), size = n(p.size, 0.16, 0.03, 0.6) * m, at = place(p.position, w, h, "center"), color = col(p.color, "#ffffff");
  const entrance = String(p.entrance ?? "pop");
  return page(w, h, p, `.pos{left:${at.left}px;top:${at.top}px;transform:${at.tx};color:${color}}.an{display:flex;align-items:center;gap:${size * 0.25}px}.ic svg{width:${size}px;height:${size}px;display:block;filter:drop-shadow(0 2px ${m * 0.012}px rgba(0,0,0,.4))}.lb{font-size:${size * 0.4}px;font-weight:${n(p.weight, 800, 100, 900)};text-shadow:0 2px 12px rgba(0,0,0,.45);white-space:nowrap}`,
    `<div class="pos"><div class="an"><div class="ic">${cleanIconSvg(p.svg)}</div>${p.label ? `<div class="lb">${esc(String(p.label).slice(0, 80))}</div>` : ""}</div></div>`,
    `var EN=${jsq(entrance)},ps=$$(".ic svg *");ps.forEach(function(e){e.setAttribute("pathLength","1")});
window.renderFrame=function(t){var e=pin(t,0,IN*(EN==="draw"?2:1.2)),x=pout(t),a=$(".an");
 if(EN==="pop"){var k=EZ.spring(C(t/(IN*1.25)));a.style.transform="scale("+Math.max(0,k*(1-x*0.85))+")";a.style.opacity=String(C(k*3)*(1-x))}
 else if(EN==="blur-in"){a.style.opacity=String(C(e)*(1-x));a.style.filter="blur("+((1-C(e)+x)*M*0.03).toFixed(2)+"px)"}
 else if(EN==="slide-in"){a.style.opacity=String(C(e*2)*(1-x));a.style.transform="translateX("+((1-e+x)*-W*0.25).toFixed(1)+"px)"}
 else if(EN==="mask-reveal"){var v="inset(-30% "+((1-C(e))*100).toFixed(2)+"% -30% "+(x*100).toFixed(2)+"%)";a.style.clipPath=v;a.style.webkitClipPath=v}
 else{ps.forEach(function(el){el.style.strokeDasharray="1";el.style.strokeDashoffset=String(1-C(e))});a.style.opacity=String(1-x);var lb=$(".lb");if(lb)lb.style.opacity=String(C((t-IN*1.5)/0.3))}};`, { dur });
}

// ---------------------------------------------------------------------------------------------
/** The HTML a library graphic is recorded and played from; null: not a library graphic. */
export function libraryHtml(id: string, params: P, w: number, h: number, dur: number): string | null {
  const it: LibraryItem | undefined = libraryItem(id);
  if (!it || it.place !== "graphic") return null;
  // Each default, replaced by what the placement sent (a placement keeps only what it set).
  const p: P = { ...Object.fromEntries(Object.entries(it.paramsSchema.properties).map(([k, s]) => [k, s.default ?? null])), ...(params ?? {}) };
  if (it.kind === "text") {
    const e = id.replace(/^lib_text_/, "").replace(/_/g, "-");
    const t = textBlock(p, w, h, e);
    return page(w, h, p, t.css, t.body, `var MARK=${jsq(t.markColor)};` + (TEXT_SCRIPTS[e] ?? TEXT_SCRIPTS["blur-in"])(p), { dur, easing: typeof p.easing === "string" ? p.easing : e === "pop" ? "spring" : "ease-out-cubic" });
  }
  if (it.kind === "lower_third") return lowerThird(id.replace(/^lib_lt_/, ""), p, w, h, dur);
  if (it.kind === "stat") return statHtml(id, p, w, h, dur);
  if (it.kind === "list") return listHtml(id, p, w, h, dur);
  if (it.kind === "callout") return calloutHtml(id, p, w, h, dur);
  if (it.kind === "whiteboard") return whiteboardHtml(p, w, h, dur);
  if (id === "lib_tr_glitch") return glitchHtml(p, w, h, dur);
  if (id === "lib_tr_light_leak") return lightLeakHtml(p, w, h, dur);
  if (it.kind === "social") return socialHtml(id, p, w, h, dur);
  if (it.kind === "icon") return iconHtml(p, w, h, dur);
  return null;
}
