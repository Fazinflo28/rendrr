/* Rendrr motion template runtime. One spec (design system + motion system + camera + layers) drawn as a pure
   function of time: window.renderFrame(t). Slot values (text, images, colours) come in window.params.data.slots and
   replace {{slot}} anywhere in the spec. Coordinates are in a 1920x1080 (or spec w x h) design space, scaled to the
   real size. Built from frame-by-frame study of pro SaaS launch videos: word blur-ins, spring pops, morphs between
   elements, a camera that holds in UI scenes and moves big at reveals. */
(function () {
  "use strict";
  var RAW = window.__MOTION_SPEC__ || {};
  var P = window.params || {};
  var SLOTS = (P.data && P.data.slots) || {};

  // ---------- slots ----------
  function slotDefaults(spec) {
    var d = {};
    (spec.slots || []).forEach(function (s) { d[s.id] = s.default != null ? s.default : ""; });
    return d;
  }
  var VALUES = Object.assign(slotDefaults(RAW), SLOTS);
  function fill(v) {
    if (typeof v === "string") {
      var m = v.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
      if (m && Object.prototype.hasOwnProperty.call(VALUES, m[1])) return VALUES[m[1]];
      return v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, function (_, k) { return VALUES[k] != null ? String(VALUES[k]) : ""; });
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") { var o = {}; for (var k in v) o[k] = fill(v[k]); return o; }
    return v;
  }
  var S = fill(RAW);
  var W = S.w || 1920, H = S.h || 1080, DUR = S.duration || 10;
  var D = Object.assign({
    bg: "#F7F6F4", ink: "#141214", muted: "#A3A0A2", accent: ["#EE4F8C", "#B13FD9"], brand: "#D7193A",
    card: "#FFFFFF", line: "#E7E4E1", dark: "#160A10", font: "Inter", mono: "JetBrains Mono", headSize: 56,
    headWeight: 700, tracking: -0.025, radius: 22,
    shadow: "0 40px 80px -30px rgba(30,10,25,.28), 0 10px 24px -10px rgba(30,10,25,.14)",
    grid: { kind: "crosses", gap: 240, color: "#D9D5D2", size: 12 }
  }, S.design || {});
  var M = S.motion || {};
  var WORD = Object.assign({ ms: 110, stagger: 0.11, blur: 14, rise: 8, outMs: 160 }, M.word || {});

  // ---------- easing ----------
  function bezier(x1, y1, x2, y2) {
    function bx(t) { return 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t; }
    function by(t) { return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t; }
    return function (x) {
      if (x <= 0) return 0; if (x >= 1) return 1;
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 24; i++) { var v = bx(t); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
      return by(t);
    };
  }
  function spring(k, d) { // critically under-damped spring, settles at 1
    k = k || 9; d = d || 0.55;
    return function (x) { if (x <= 0) return 0; if (x >= 1) return 1; return 1 - Math.exp(-k * d * x) * Math.cos(k * Math.sqrt(1 - d * d) * x * 1.35); };
  }
  var EASES = {
    linear: function (x) { return x; },
    out: bezier(0.16, 1, 0.3, 1),          // expo out: most entrances
    in: bezier(0.55, 0, 1, 0.45),
    inOut: bezier(0.65, 0, 0.35, 1),       // camera moves, cursor
    reveal: bezier(0.40, 0, 0.25, 1.10),   // the big pull-out (measured)
    expand: bezier(0.32, 0, 0.67, 0),      // container grows to full frame, accelerating (ease-in cubic)
    soft: bezier(0.25, 0.1, 0.25, 1),
    spring: spring(9, 0.5),
    pop: spring(11, 0.42)
  };
  var custom = M.eases || {};
  for (var en in custom) { var c = custom[en]; if (Array.isArray(c) && c.length === 4) EASES[en] = bezier(c[0], c[1], c[2], c[3]); }
  function ease(name) { if (Array.isArray(name)) return bezier(name[0], name[1], name[2], name[3]); return EASES[name] || EASES.out; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function prog(t, t0, ms, e) { return ease(e)(clamp((t - t0) / Math.max(0.001, ms / 1000), 0, 1)); }
  function lerp(a, b, p) { return a + (b - a) * p; }

  // ---------- keyframes (After Effects model) ----------
  // A key: {t, <props>, e?, in?, out?, hold?, auto?, po?, pi?}. Every property has its own track (a key only joins
  // the tracks of the properties it sets), so x can ease while opacity holds.
  //   e      a preset or [x1,y1,x2,y2] for the segment arriving at this key (the plain way; kept as it was).
  //   out    {infl, speed}: this key's outgoing temporal handle. infl 0-1 = share of the segment the handle reaches
  //          (AE's influence, 0.33 = easy ease); speed in units per second at the key (0 = eases to a stop; a number
  //          or {prop: n}). in: the same for the incoming handle. Either one makes the segment an AE value curve:
  //          a cubic bezier in (time, value), solved for the time exactly, so speed is continuous inside it.
  //   hold   the value holds until the next key, then jumps (AE's hold keyframe).
  //   auto   continuous velocity through this key (AE's auto bezier): speed = the slope between its neighbours.
  //   po/pi  spatial out/in tangents [dx, dy] for position: x and y travel a curved motion path (AE's spatial
  //          bezier), at the speed the temporal ease gives along the path's real length.
  var trackCache = typeof WeakMap === "function" ? new WeakMap() : null;
  function trackOf(keys, prop) {
    var m = trackCache && trackCache.get(keys); if (!m) { m = {}; if (trackCache) trackCache.set(keys, m); }
    if (!m[prop]) m[prop] = keys.filter(function (k) { return k[prop] != null; });
    return m[prop];
  }
  function handleOf(k, side, prop) { var h = k[side]; if (!h) return null; return { infl: clamp(h.infl != null ? h.infl : 1 / 3, 0.01, 1), speed: h.speed == null ? 0 : typeof h.speed === "object" ? (h.speed[prop] || 0) : h.speed }; }
  function autoSpeed(list, i, prop) { var a = list[i - 1], b = list[i + 1]; if (!a || !b) return 0; return (b[prop] - a[prop]) / Math.max(1e-6, b.t - a.t); }
  function aeSegment(t0, v0, s0, i0, t1, v1, s1, i1, t) {
    var dt = Math.max(1e-6, t1 - t0); if (i0 + i1 > 1) { var k = 1 / (i0 + i1); i0 *= k; i1 *= k; }
    var x1 = i0 * dt, y1 = v0 + s0 * x1, x2 = dt - i1 * dt, y2 = v1 - s1 * i1 * dt, x = t - t0;
    var lo = 0, hi = 1, u = x / dt;
    for (var n = 0; n < 40; n++) { var bx = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u * dt; if (Math.abs(bx - x) < 1e-7) break; if (bx < x) lo = u; else hi = u; u = (lo + hi) / 2; }
    return (1 - u) * (1 - u) * (1 - u) * v0 + 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u * v1;
  }
  function segVal(list, i, prop, t) {
    var a = list[i], b = list[i + 1], va = a[prop], vb = b[prop];
    if (a.hold) return va;
    var ho = handleOf(a, "out", prop), hi = handleOf(b, "in", prop);
    if (ho || hi || a.auto || b.auto) {
      var lin = (vb - va) / Math.max(1e-6, b.t - a.t);
      var s0 = ho ? ho.speed : a.auto ? autoSpeed(list, i, prop) : lin, i0 = ho ? ho.infl : 1 / 3;
      var s1 = hi ? hi.speed : b.auto ? autoSpeed(list, i + 1, prop) : lin, i1 = hi ? hi.infl : 1 / 3;
      return aeSegment(a.t, va, s0, i0, b.t, vb, s1, i1, t);
    }
    return lerp(va, vb, ease(b.e || "inOut")((t - a.t) / Math.max(1e-6, b.t - a.t)));
  }
  function keyVal(keys, prop, t, def) {
    var list = trackOf(keys, prop); if (!list.length) return def;
    if (t <= list[0].t) return list[0][prop];
    var n = list.length; if (t >= list[n - 1].t) return list[n - 1][prop];
    for (var i = 0; i + 1 < n; i++) if (t < list[i + 1].t) return segVal(list, i, prop, t);
    return list[n - 1][prop];
  }
  // Position on a motion path: keys that set both x and y; a segment whose ends carry po/pi is a spatial bezier.
  function keyPos(keys, t, dx, dy) {
    var list = trackOf(keys, "x").filter(function (k) { return k.y != null; });
    var i = -1; for (var j = 0; j + 1 < list.length; j++) if (t >= list[j].t && t < list[j + 1].t) { i = j; break; }
    if (i < 0 || (!list[i].po && !list[i + 1].pi) || list[i].hold) return { x: keyVal(keys, "x", t, dx), y: keyVal(keys, "y", t, dy) };
    var a = list[i], b = list[i + 1], po = a.po || [0, 0], pi = b.pi || [0, 0];
    var P = [[a.x, a.y], [a.x + po[0], a.y + po[1]], [b.x + pi[0], b.y + pi[1]], [b.x, b.y]];
    function pt(u) { var m = 1 - u; return [m * m * m * P[0][0] + 3 * m * m * u * P[1][0] + 3 * m * u * u * P[2][0] + u * u * u * P[3][0], m * m * m * P[0][1] + 3 * m * m * u * P[1][1] + 3 * m * u * u * P[2][1] + u * u * u * P[3][1]]; }
    var lens = [0], prev = pt(0); for (var q = 1; q <= 48; q++) { var c = pt(q / 48); lens.push(lens[q - 1] + Math.hypot(c[0] - prev[0], c[1] - prev[1])); prev = c; }
    var Ltot = lens[48] || 1;
    // distance travelled: the temporal ease on 0..length (speeds in px/s along the path)
    var ho = handleOf(a, "out", "x"), hi2 = handleOf(b, "in", "x"), lin = Ltot / Math.max(1e-6, b.t - a.t);
    var dist = (ho || hi2) ? aeSegment(a.t, 0, ho ? ho.speed : lin, ho ? ho.infl : 1 / 3, b.t, Ltot, hi2 ? hi2.speed : lin, hi2 ? hi2.infl : 1 / 3, t)
      : Ltot * ease(b.e || "inOut")((t - a.t) / Math.max(1e-6, b.t - a.t));
    var k2 = 1; while (k2 < 48 && lens[k2] < dist) k2++;
    var f = (dist - lens[k2 - 1]) / Math.max(1e-6, lens[k2] - lens[k2 - 1]), u = (k2 - 1 + clamp(f, 0, 1)) / 48, r = pt(u);
    return { x: r[0], y: r[1] };
  }

  // ---------- DOM ----------
  var css = "html,body{margin:0;width:" + W + "px;height:" + H + "px;overflow:hidden;background:transparent}" +
    "*{box-sizing:border-box}#vp{position:absolute;inset:0;overflow:hidden;font-family:'" + D.font + "',Inter,sans-serif;-webkit-font-smoothing:antialiased;color:" + D.ink + "}" +
    "#cam{position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px;transform-origin:0 0}" +
    ".L{position:absolute;left:0;top:0;transform-origin:50% 50%;will-change:transform}" +
    ".w{display:inline-block;white-space:pre}.acc{background:linear-gradient(90deg," + D.accent[0] + "," + D.accent[1] + ");-webkit-background-clip:text;background-clip:text;color:transparent}" +
    ".mut{color:" + D.muted + "}.card{background:" + D.card + ";border-radius:" + D.radius + "px;box-shadow:" + D.shadow + ";border:1px solid rgba(0,0,0,.05);overflow:hidden}" +
    ".mono{font-family:'" + D.mono + "',monospace}.caret{display:inline-block;width:.06em;height:1.05em;vertical-align:-.15em;margin-left:.04em}" +
    ".pill{background:#fff;border-radius:999px;box-shadow:0 10px 24px -10px rgba(30,10,25,.25),0 2px 6px rgba(30,10,25,.08);border:1px solid rgba(0,0,0,.05);display:flex;align-items:center;gap:14px;padding:12px 22px 12px 12px;font-weight:600;white-space:nowrap}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  var vp = document.createElement("div"); vp.id = "vp"; document.body.appendChild(vp);
  var bgEl = document.createElement("div"); bgEl.style.cssText = "position:absolute;inset:0"; vp.appendChild(bgEl);
  var cam = document.createElement("div"); cam.id = "cam"; vp.appendChild(cam);
  var fixed = document.createElement("div"); fixed.style.cssText = "position:absolute;inset:0;pointer-events:none"; vp.appendChild(fixed);
  var scaleRoot = Math.min(window.innerWidth / W || 1, window.innerHeight / H || 1);

  function el(tag, cls, html, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; (parent || cam).appendChild(e); return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // A picture slot left empty draws a soft gradient in the template's own colours, so a template still reads well.
  function isVideo(src) { return typeof src === "string" && src.indexOf("video:") === 0; }
  function img(src) { if (isVideo(src)) return "none"; return src ? "url(\"" + String(src).replace(/"/g, "%22") + "\")" : "linear-gradient(135deg," + D.accent[0] + "40," + D.accent[1] + "66)"; }
  function iconSvg(name, color) {
    color = color || "currentColor";
    var p = {
      check: "<path d='M5 12.5l4.2 4.2L19 7' stroke='" + color + "' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/>",
      arrow: "<path d='M12 19V6M6 11l6-6 6 6' stroke='" + color + "' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/>",
      spark: "<path d='M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z' fill='" + color + "'/>",
      bolt: "<path d='M13 2L4 14h7l-1 8 9-12h-7z' fill='" + color + "'/>",
      card: "<rect x='3' y='6' width='18' height='12' rx='3' fill='" + color + "'/><rect x='3' y='9' width='18' height='2.5' fill='#fff' opacity='.6'/>",
      heart: "<path d='M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z' fill='" + color + "'/>",
      dot: "<circle cx='12' cy='12' r='6' fill='" + color + "'/>",
      play: "<path d='M7 4.5v15l12.5-7.5z' fill='" + color + "'/>",
      search: "<circle cx='10.5' cy='10.5' r='6' stroke='" + color + "' stroke-width='2.4' fill='none'/><path d='M15 15l5 5' stroke='" + color + "' stroke-width='2.4' stroke-linecap='round'/>",
      camera: "<rect x='3.5' y='3.5' width='17' height='17' rx='5' stroke='" + color + "' stroke-width='2.2' fill='none'/><circle cx='12' cy='12' r='4' stroke='" + color + "' stroke-width='2.2' fill='none'/><circle cx='17.2' cy='6.8' r='1.3' fill='" + color + "'/>",
      burst: "<g stroke='" + color + "' stroke-width='2.6' stroke-linecap='round'><path d='M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.3 5.3l4.2 4.2M14.5 14.5l4.2 4.2M18.7 5.3l-4.2 4.2M9.5 14.5l-4.2 4.2'/></g>",
      phone: "<path d='M6.6 3.5h3l1.5 4-2 1.4a10 10 0 0 0 6 6l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z' fill='" + color + "'/>",
      mail: "<rect x='3' y='5.5' width='18' height='13' rx='2.5' fill='" + color + "'/><path d='M4 7l8 6 8-6' stroke='#fff' stroke-width='1.8' fill='none' opacity='.85'/>",
      chat: "<path d='M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 17.5H10l-5 4v-4H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z' fill='" + color + "'/>",
      doc: "<path d='M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z' fill='" + color + "'/><path d='M8 12h8M8 15.5h8M8 19h5' stroke='#fff' stroke-width='1.6' opacity='.85'/>",
      comment: "<path d='M12 3.5c5 0 9 3.4 9 7.7s-4 7.7-9 7.7c-1 0-2-.1-2.9-.4L4 20.5l1.4-4.1A7.4 7.4 0 0 1 3 11.2c0-4.3 4-7.7 9-7.7z' fill='" + color + "'/>",
      share: "<path d='M21 3L10 14M21 3l-7 18-3.5-7.5L3 10z' stroke='" + color + "' stroke-width='2.2' fill='none' stroke-linejoin='round'/>",
      bookmark: "<path d='M6 3h12v18l-6-4.5L6 21z' fill='" + color + "'/>",
      plus: "<path d='M12 5v14M5 12h14' stroke='" + color + "' stroke-width='2.6' stroke-linecap='round'/>"
    }[name] || "<circle cx='12' cy='12' r='8' fill='" + color + "'/>";
    return "<svg viewBox='0 0 24 24' width='100%' height='100%'>" + p + "</svg>";
  }
  function logoTile(src, size, color) {
    return "<span style='display:inline-flex;align-items:center;justify-content:center;width:" + size + "px;height:" + size + "px;border-radius:" + size * 0.28 + "px;background:" + (src ? img(src) + " center/cover" : color || D.brand) + ";flex:none;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)'>" +
      (src ? "" : "<span style='width:52%;height:52%;color:#fff;display:block'>" + iconSvg("spark", "#fff") + "</span>") + "</span>";
  }

  // rich text: {accent}  [muted]  *bold*
  function words(text) {
    var out = [], re = /\{([^}]*)\}|\[([^\]]*)\]|\*([^*]*)\*|(\S+)/g, m;
    while ((m = re.exec(text))) {
      var cls = m[1] != null ? "acc" : m[2] != null ? "mut" : m[3] != null ? "b" : "";
      var s = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      s.split(/\s+/).filter(Boolean).forEach(function (wd) { out.push({ t: wd, c: cls }); });
    }
    return out;
  }

  var NS0 = "http://www.w3.org/2000/svg", NS = NS0;
  // ---------- layer builders ----------
  var layers = [], videoBackdrops = [];
  function base(spec) {
    var root = el("div", "L", null, spec.fixed ? fixed : cam);
    root.style.zIndex = spec.z || 1;
    return { spec: spec, root: root, keys: (spec.keys || []).slice().sort(function (a, b) { return a.t - b.t; }) };
  }
  // Motion blur (AE's, 180 degree shutter by default): how far the layer moves in the shutter time sets a
  // directional blur along x and y (an SVG gaussian with two deviations). mb: 0-1 per layer, motion.blur for all.
  var MB = M.blur != null ? M.blur : 0.5, SHUTTER = 1 / ((S.fps || 30) * 2);
  var svgDefs = null, mbCount = 0;
  function mbFilter() {
    if (!svgDefs) { var sv = document.createElementNS("http://www.w3.org/2000/svg", "svg"); sv.setAttribute("width", "0"); sv.setAttribute("height", "0"); sv.style.position = "absolute"; svgDefs = document.createElementNS("http://www.w3.org/2000/svg", "defs"); sv.appendChild(svgDefs); document.body.appendChild(sv); }
    var f = document.createElementNS("http://www.w3.org/2000/svg", "filter"), id = "mb" + mbCount++;
    f.setAttribute("id", id); f.setAttribute("x", "-20%"); f.setAttribute("y", "-20%"); f.setAttribute("width", "140%"); f.setAttribute("height", "140%"); f.setAttribute("color-interpolation-filters", "sRGB");
    var g = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur"); g.setAttribute("stdDeviation", "0 0"); f.appendChild(g); svgDefs.appendChild(f);
    return { id: id, g: g };
  }
  function motionOf(L, t) {
    var s = L.spec, k = L.keys, p = keyPos(k, t, s.x != null ? s.x : W / 2, s.y != null ? s.y : H / 2);
    return { x: p.x, y: p.y, s: keyVal(k, "s", t, s.s != null ? s.s : 1), w: keyVal(k, "w", t, s.w || 0), h: keyVal(k, "h", t, s.h || 0) };
  }
  function place(L, t, extra) {
    var s = L.spec, k = L.keys;
    var pos = keyPos(k, t, s.x != null ? s.x : W / 2, s.y != null ? s.y : H / 2), x = pos.x, y = pos.y;
    var w = keyVal(k, "w", t, s.w || 0), h = keyVal(k, "h", t, s.h || 0);
    var sc = keyVal(k, "s", t, s.s != null ? s.s : 1), sx = keyVal(k, "sx", t, 1), sy = keyVal(k, "sy", t, 1);
    var rx = keyVal(k, "rx", t, s.rx || 0), ry = keyVal(k, "ry", t, s.ry || 0), rz = keyVal(k, "r", t, s.r || 0);
    var o = keyVal(k, "o", t, 1), blur = keyVal(k, "blur", t, 0);
    var e = extra || {};
    if (e.o != null) o *= e.o; if (e.s != null) sc *= e.s; if (e.blur != null) blur += e.blur; if (e.dy) y += e.dy; if (e.dx) x += e.dx;
    var r = L.root;
    if (w) r.style.width = w + "px"; if (h) r.style.height = h + "px";
    var ww = w || r.offsetWidth, hh = h || r.offsetHeight;
    var ax = s.anchor === "left" ? x : s.anchor === "right" ? x - ww : x - ww / 2;
    var persp = s.persp || 1600;
    r.style.transform = "translate(" + ax + "px," + (y - hh / 2) + "px) perspective(" + persp + "px) rotateX(" + rx + "deg) rotateY(" + ry + "deg) rotateZ(" + rz + "deg) scale(" + sc * sx + "," + sc * sy + ")";
    r.style.opacity = clamp(o, 0, 1);
    var filt = blur > 0.05 ? "blur(" + blur + "px)" : "";
    var mb = s.mb != null ? s.mb : MB;
    if (mb > 0 && k.length > 1 && !s.noMotionBlur) {
      // blur follows the centre's travel and scale, not a change of size (a card that resizes keeps sharp content)
      var a2 = motionOf(L, t - SHUTTER), off = s.anchor === "left" ? 0.5 : s.anchor === "right" ? -0.5 : 0;
      var d = Math.abs((x + off * w) - (a2.x + off * a2.w)), dyy = Math.abs(y - a2.y);
      var dsc = Math.abs(sc - a2.s) * Math.max(ww, hh) * 0.5;
      var bx = (d + dsc) * mb * 0.5, by = (dyy + dsc) * mb * 0.5;
      if (bx > 0.6 || by > 0.6) {
        if (!L.mbf) L.mbf = mbFilter();
        L.mbf.g.setAttribute("stdDeviation", Math.min(bx, 40).toFixed(2) + " " + Math.min(by, 40).toFixed(2));
        filt += " url(#" + L.mbf.id + ")";
      }
    }
    r.style.filter = filt || "none";
    var rad = keyVal(k, "rad", t, null); if (rad != null) r.style.borderRadius = rad + "px";
    // wipe: the layer dissolves from one edge (a moving soft mask), as a card breaking into particles
    if (s.wipeOut) {
      var wo = prog(t, s.wipeOut.at, s.wipeOut.ms || 400, s.wipeOut.e || "inOut"), soft = s.wipeOut.soft || 0.25;
      var edge = (1 - wo) * (1 + soft) * 100, m = wo > 0 ? "linear-gradient(" + (s.wipeOut.dir === "right" ? "90deg" : "270deg") + ",transparent " + (100 - edge) + "%,#000 " + (100 - edge + soft * 100) + "%)" : "none";
      r.style.webkitMaskImage = m; r.style.maskImage = m;
    }
    return { w: ww, h: hh, x: x, y: y };
  }
  function live(s, t) { return t >= (s.t0 || 0) - 0.001 && t <= (s.t1 != null ? s.t1 : DUR) + 0.001; }
  function fadeIO(s, t) {
    var o = 1;
    if (s.fadeIn) o *= prog(t, s.t0 || 0, s.fadeIn * 1000, "out");
    if (s.fadeOut) o *= 1 - prog(t, (s.t1 != null ? s.t1 : DUR) - s.fadeOut, s.fadeOut * 1000, "in");
    return o;
  }

  var B = {};

  // Headline: words blur in one by one; leaves with a blur-out.
  B.text = function (s) {
    var L = base(s), list = words(s.text || "");
    var size = s.size || D.headSize;
    if (s.shadow) L.root.style.textShadow = s.shadow === true ? "0 2px 18px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.3)" : s.shadow;
    L.root.style.cssText += ";font-size:" + size + "px;font-weight:" + (s.weight || D.headWeight) + ";letter-spacing:" + (s.tracking != null ? s.tracking : D.tracking) + "em;white-space:nowrap;line-height:1.12;text-align:" + (s.align || "center") + ";color:" + (s.color || D.ink);
    if (s.maxWidth) { L.root.style.whiteSpace = "normal"; L.root.style.width = s.maxWidth + "px"; }
    L.w = list.map(function (wd, i) {
      var sp = el("span", "w" + (wd.c === "acc" ? " acc" : wd.c === "mut" ? " mut" : ""), esc(wd.t) + (i < list.length - 1 ? " " : ""), L.root);
      if (wd.c === "b") sp.style.fontWeight = s.boldWeight || 800;
      if (wd.c === "mut" && s.mutedColor) sp.style.color = s.mutedColor;
      return sp;
    });
    var wcfg = Object.assign({}, WORD, s.words || {});
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0;
      L.w.forEach(function (sp, i) {
        var at = s.mode === "line" ? t0 : t0 + i * wcfg.stagger;
        var p = prog(t, at, wcfg.ms * (s.mode === "line" ? 3 : 1), "out");
        sp.style.opacity = p; sp.style.filter = p < 0.999 ? "blur(" + (1 - p) * wcfg.blur + "px)" : "none";
        sp.style.transform = "translateY(" + (1 - p) * wcfg.rise + "px)";
      });
      var out = s.outAt != null ? prog(t, s.outAt, s.outMs || 220, "in") : 0;
      place(L, t, { o: (1 - out) * fadeIO(s, t), blur: out * 18, s: 1 + out * 0.04 });
    };
    return L;
  };

  // Opener: word, a dot that grows into a pill holding a picture, word. expandAt: the pill grows to fill the frame.
  B.wordpill = function (s) {
    var L = base(s), size = s.size || 120;
    L.root.style.cssText += ";width:" + W + "px;height:" + H + "px";
    var a = el("div", "w acc", esc(s.left || ""), L.root), b = el("div", "w acc", esc(s.right || ""), L.root);
    [a, b].forEach(function (e) { e.style.cssText += ";position:absolute;top:0;font-size:" + size + "px;font-weight:800;letter-spacing:-0.04em;line-height:1"; });
    var pill = el("div", "", "", L.root); pill.style.cssText = "position:absolute;overflow:hidden;background:#2a2024;box-shadow:0 30px 50px -20px rgba(40,10,30,.45)";
    var pimg = el("div", "", "", pill); pimg.style.cssText = "position:absolute;inset:-4%;background:" + img(s.src) + " center/cover";
    var pimg2 = el("div", "", "", pill); pimg2.style.cssText = "position:absolute;inset:0;background:" + img(s.next) + " center/cover;opacity:0";
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0, cy = s.y || H / 2;
      var pa = prog(t, t0, 130, "out"), pb = prog(t, t0 + 0.13, 130, "out");
      var dot = prog(t, t0 + 0.2, 170, "out");            // dot -> circle
      var grow = prog(t, t0 + 0.37, 420, "pop");          // circle -> pill with overshoot
      var ph = size * 0.92, pw = lerp(ph * 0.12 * dot + 0.001, ph, dot);
      var pwFull = ph * 2.2; pw = lerp(pw, pwFull, grow);
      var phh = lerp(ph * 0.12 + (ph - ph * 0.12) * dot, ph, 0);
      var gap = size * 0.12;
      var aw = a.offsetWidth, bw = b.offsetWidth;
      var ex = s.expandAt != null ? prog(t, s.expandAt, (s.expandMs || 520), "expand") : 0;
      var total = aw + gap + pw + gap + bw, x0 = W / 2 - total / 2;
      var px = x0 + aw + gap, pyc = cy;
      // expand: pill rect -> full frame, words pushed out + blurred
      var fx = lerp(px, 0, ex), fy = lerp(pyc - phh / 2, 0, ex), fw = lerp(pw, W, ex), fh = lerp(phh, H, ex);
      pill.style.left = fx + "px"; pill.style.top = fy + "px"; pill.style.width = fw + "px"; pill.style.height = fh + "px";
      pill.style.borderRadius = lerp(phh / 2, 0, ex) + "px";
      pill.style.opacity = dot > 0 ? 1 : 0;
      // the next picture pushes up from below as the pill fills the frame (with the push's own blur)
      var xfade = s.expandAt != null ? prog(t, s.expandAt + (s.expandMs || 520) * 0.0006, 200, "inOut") : 0;
      pimg.style.transform = "translateY(" + (-xfade * 40) + "%) scale(" + ((1.12 - 0.08 * clamp((t - t0) / 3, 0, 1)) * (1 + ex * 0.25)) + ")";
      pimg2.style.opacity = s.next && xfade > 0 ? 1 : 0; pimg2.style.transform = "translateY(" + (1 - xfade) * 100 + "%)";
      pimg.style.filter = pimg2.style.filter = xfade > 0 && xfade < 1 ? "blur(" + Math.sin(xfade * Math.PI) * 6 + "px)" : "none";
      a.style.left = (x0 - ex * W * 0.18) + "px"; a.style.top = (cy - size * 0.5) + "px";
      b.style.left = (px + pw + gap + ex * W * 0.18) + "px"; b.style.top = (cy - size * 0.5) + "px";
      a.style.opacity = pa * (1 - ex); b.style.opacity = pb * (1 - ex);
      a.style.filter = "blur(" + ((1 - pa) * 16 + ex * 14) + "px)"; b.style.filter = "blur(" + ((1 - pb) * 16 + ex * 14) + "px)";
      place(L, t, { o: fadeIO(s, t) });
    };
    return L;
  };

  // A picture (or a solid) in a card; keys move and resize it (w, h, rad). rings: [{at, color}] a border that
  // changes colour; checks: [{at, color}] a round check badge at the top right that pops and recolours; caption:
  // {at, text, meta} a small mono line under it; glowAt: a soft glow; ui: a phone app's rail and bar over it.
  B.media = function (s) {
    var L = base(s);
    L.root.style.cssText += ";border-radius:" + (s.rad != null ? s.rad : D.radius) + "px;box-shadow:" + (s.shadow === false ? "none" : D.shadow);
    var clip = el("div", "", "", L.root); clip.style.cssText = "position:absolute;inset:0;border-radius:inherit;overflow:hidden;background:" + (s.color || "#ddd");
    var im = el("div", "", "", clip); im.style.cssText = "position:absolute;inset:-3%;background:" + img(s.src) + " center/cover";
    var ring = el("div", "", "", L.root); ring.style.cssText = "position:absolute;inset:0;border-radius:inherit;pointer-events:none";
    var glow = s.glowAt != null ? true : false;
    var ck = s.checks ? el("div", "", iconSvg("check", "#fff"), L.root) : null;
    if (ck) ck.style.cssText = "position:absolute;right:-12px;top:-12px;width:38px;height:38px;border-radius:99px;padding:6px;box-shadow:0 3px 8px rgba(0,0,0,.25);border:2.5px solid #fff";
    var cap = s.caption ? el("div", "mono", "", L.root) : null;
    if (cap) { cap.style.cssText = "position:absolute;left:-30px;right:-30px;top:calc(100% + 14px);text-align:center;font-size:17px;color:" + D.muted + ";white-space:nowrap"; cap.innerHTML = esc(s.caption.text || "") + (s.caption.meta ? " · <span style='color:" + (s.caption.color || "#16A34A") + "'>" + esc(s.caption.meta) + "</span>" : ""); }
    function latest(list, t) { var c = null; (list || []).forEach(function (r) { if (t >= r.at) c = r; }); return c; }
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var life = clamp((t - (s.t0 || 0)) / Math.max(1, (s.t1 || DUR) - (s.t0 || 0)), 0, 1);
      im.style.transform = "scale(" + lerp(s.kb ? s.kb[0] : 1.06, s.kb ? s.kb[1] : 1.0, life) + ")";
      var pin = s.popIn ? prog(t, s.t0 || 0, 480, "pop") : 1;
      var rg = latest(s.rings, t), rq = rg ? prog(t, rg.at, 250, "out") : 0;
      var sh = s.shadow === false ? "none" : D.shadow;
      if (glow) { var gq = prog(t, s.glowAt, 400, "out"); sh += ",0 0 " + 34 * gq + "px " + 2 * gq + "px " + (s.glowColor || D.accent[0]) + "55"; }
      L.root.style.boxShadow = sh;
      ring.style.boxShadow = rg ? "inset 0 0 0 " + (s.ringWidth || 4) * (s.rings[0] === rg ? rq : 1) + "px " + rg.color : "none";
      if (ck) { var c0 = s.checks[0], cl = latest(s.checks, t), cq = prog(t, c0.at, 360, "pop"); ck.style.opacity = clamp(cq * 2, 0, 1); ck.style.transform = "scale(" + lerp(0.3, 1, cq) + ")"; ck.style.background = cl ? cl.color : c0.color; }
      if (cap) { var kq = prog(t, s.caption.at, 300, "out") * (s.caption.until != null ? 1 - prog(t, s.caption.until, 150, "in") : 1); cap.style.opacity = kq; cap.style.transform = "translateY(" + (1 - kq) * 8 + "px)"; }
      place(L, t, { o: fadeIO(s, t) * (s.popIn ? clamp(pin * 3, 0, 1) : 1), s: s.popIn ? lerp(0.6, 1, pin) : 1 });
    };
    return L;
  };

  // Full-frame picture behind everything; keys: blur, dim (0-1), s.
  B.backdrop = function (s) {
    s.fixedSize = true;
    var L = base(s); L.root.style.cssText += ";width:" + W + "px;height:" + H + "px;overflow:hidden";
    // A video picked for this slot plays as b-roll under the graphic: leave the picture out (the dim still darkens it).
    var vid = isVideo(s.src); if (vid) videoBackdrops.push(s);
    var im = el("div", "", "", L.root); im.style.cssText = "position:absolute;inset:-4%;background:" + img(s.src) + " center/cover;" + (vid ? "display:none" : "");
    var dim = el("div", "", "", L.root); dim.style.cssText = "position:absolute;inset:0;background:" + (s.dimColor || "#0b0508");
    var tint = s.tint ? el("div", "", "", L.root) : null; if (tint) tint.style.cssText = "position:absolute;inset:0;background:" + s.tint + ";mix-blend-mode:" + (s.tintBlend || "color") + ";opacity:" + (s.tintOpacity != null ? s.tintOpacity : 0.5);
    var vig = el("div", "", "", L.root); vig.style.cssText = "position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 45%,rgba(0,0,0," + (s.vignette != null ? s.vignette : 0.35) + ") 100%)";
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var life = clamp((t - (s.t0 || 0)) / Math.max(1, (s.t1 || DUR) - (s.t0 || 0)), 0, 1);
      im.style.transform = "scale(" + lerp(s.kb ? s.kb[0] : 1.0, s.kb ? s.kb[1] : 1.08, life) + ")";
      im.style.filter = "blur(" + keyVal(L.keys, "bblur", t, 0) + "px)";
      dim.style.opacity = keyVal(L.keys, "dim", t, s.dim || 0);
      if (tint) tint.style.opacity = keyVal(L.keys, "tint", t, s.tintOpacity != null ? s.tintOpacity : 0.5);
      place(L, t, { o: fadeIO(s, t) });
    };
    return L;
  };

  // Outline title in a thin guide frame: guide lines run the frame's edges across the whole screen with small
  // crosses at its corners; letters appear in a shuffled order; a brand row (logo, name, tag, partner); a toggle;
  // then the cursor flips it and the title fills: a top-to-bottom gradient, a glow behind it and soft light beams.
  B.frametitle = function (s) {
    var L = base(s), size = s.size || 190, cy = s.y || H / 2;
    L.root.style.cssText += ";width:" + W + "px;height:" + H + "px";
    var glow = el("div", "", "", L.root); glow.style.cssText = "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px;background:radial-gradient(ellipse " + size * 3.4 + "px " + size * 1.7 + "px at 50% " + cy + "px," + D.accent[0] + "66,transparent 70%)";
    var stops = [], nb = s.beams || 7, span = 110;
    for (var bi = 0; bi < nb; bi++) { var c0 = -span / 2 + (bi + 0.5) * span / nb, wdt = 3 + (bi * 37 % 5); stops.push("transparent " + (180 + c0 - wdt) + "deg", "rgba(255,255,255," + (0.10 + (bi * 13 % 7) / 70) + ") " + (180 + c0) + "deg", "transparent " + (180 + c0 + wdt) + "deg"); } // beams point up: angles from straight down
    var rays = el("div", "", "", L.root);
    rays.style.cssText = "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px;background:conic-gradient(from 180deg at 50% " + cy + "px," + stops.join(",") + ");-webkit-mask-image:radial-gradient(ellipse " + size * 4.5 + "px " + size * 3 + "px at 50% " + cy + "px,transparent 18%,#000 40%,transparent 100%);mask-image:radial-gradient(ellipse " + size * 4.5 + "px " + size * 3 + "px at 50% " + cy + "px,transparent 18%,#000 40%,transparent 100%);filter:blur(6px)";
    var guides = [0, 1, 2, 3].map(function (i) { var g = el("div", "", "", L.root); g.style.cssText = "position:absolute;background:rgba(255,255,255,.13);" + (i < 2 ? "left:0;width:" + W + "px;height:1px" : "top:0;height:" + H + "px;width:1px"); return g; });
    var ticks = [0, 1, 2, 3].map(function () { var tk = el("div", "", "<svg width='28' height='28' viewBox='0 0 28 28'><path d='M14 0v28M0 14h28' stroke='rgba(255,255,255,.75)' stroke-width='1.5'/></svg>", L.root); tk.style.cssText = "position:absolute;width:28px;height:28px"; return tk; });
    var brand = el("div", "", "", L.root);
    brand.style.cssText = "position:absolute;left:0;width:100%;display:flex;justify-content:center;align-items:center;gap:10px;color:rgba(255,255,255,.9);font-size:" + size * 0.135 + "px;font-weight:600";
    brand.innerHTML = (s.logo != null ? logoTile(s.logo, size * 0.16) : "") + "<span>" + esc(s.brandName || "") + "</span>" + (s.brandTag ? "<span style='color:rgba(255,255,255,.5)'>" + esc(s.brandTag) + "</span>" : "") +
      (s.partner ? "<span style='color:rgba(255,255,255,.5);margin:0 4px'>·</span><span style='width:" + size * 0.13 + "px;height:" + size * 0.13 + "px;display:inline-block'>" + (s.partnerLogo ? logoTile(s.partnerLogo, size * 0.13) : iconSvg("burst", "#D97757")) + "</span><span>" + esc(s.partner) + "</span>" : "") + (s.brandLine ? "<span>" + esc(s.brandLine) + "</span>" : "");
    var frame = el("div", "", "", L.root);
    var title = el("div", "", "", L.root);
    title.style.cssText = "position:absolute;left:0;width:100%;text-align:center;font-weight:800;letter-spacing:-0.035em;line-height:1;font-size:" + size + "px;top:" + (cy - size * 0.52) + "px";
    var letters = String(s.text || "").split("").map(function (ch) { var sp = el("span", "", ch === " " ? "&nbsp;" : esc(ch), title); sp.style.cssText = "display:inline-block;-webkit-text-stroke:2px rgba(255,255,255,.75);color:transparent"; return sp; });
    var order = letters.map(function (_, i) { return i; });
    var seed = 7; order.sort(function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; });
    var tog = el("div", "", "", L.root);
    var tw2 = size * 0.5, th2 = size * 0.27;
    tog.style.cssText = "position:absolute;left:50%;top:" + (cy + size * 0.98) + "px;width:" + tw2 + "px;height:" + th2 + "px;margin-left:-" + tw2 / 2 + "px;border-radius:99px;background:rgba(255,255,255,.2)";
    var knob = el("div", "", "", tog); knob.style.cssText = "position:absolute;top:12%;width:" + th2 * 0.76 + "px;height:76%;border-radius:99px;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4)";
    var sub = el("div", "", "", L.root);
    sub.style.cssText = "position:absolute;left:0;width:100%;text-align:center;top:" + (cy + size * 2.05) + "px;color:rgba(255,255,255,.72);font-size:" + size * 0.15 + "px;letter-spacing:.16em;font-weight:600;text-transform:uppercase";
    sub.textContent = s.sub || "";
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0;
      var wTxt = 0; letters.forEach(function (sp) { wTxt += sp.offsetWidth; });
      var fw = wTxt + size * 0.55, fh = size * 1.32, fp = prog(t, t0, 520, "out"), sc = lerp(1.18, 1, fp);
      var fl = W / 2 - fw * sc / 2, ft = cy - fh * sc / 2 - size * 0.03, fr = fl + fw * sc, fb = ft + fh * sc;
      frame.style.cssText = "position:absolute;left:" + fl + "px;top:" + ft + "px;width:" + fw * sc + "px;height:" + fh * sc + "px;border:1.5px solid rgba(255,255,255," + 0.5 * fp + ")";
      var gq = prog(t, t0 + 0.1, 600, "out");
      guides[0].style.top = ft + "px"; guides[1].style.top = fb + "px"; guides[2].style.left = fl + "px"; guides[3].style.left = fr + "px";
      guides.forEach(function (g, i) { g.style.opacity = gq; g.style.transform = i < 2 ? "scaleX(" + gq + ")" : "scaleY(" + gq + ")"; });
      [[fl, ft], [fr, ft], [fl, fb], [fr, fb]].forEach(function (c, i) { ticks[i].style.left = (c[0] - 14) + "px"; ticks[i].style.top = (c[1] - 14) + "px"; ticks[i].style.opacity = fp; });
      order.forEach(function (li, j) { var p = prog(t, t0 + 0.12 + j * 0.06, 170, "out"); letters[li].style.opacity = p; letters[li].style.filter = p < 1 ? "blur(" + (1 - p) * 10 + "px)" : "none"; });
      var bq = prog(t, t0 + 0.75, 300, "out"); brand.style.top = (ft - size * 0.32) + "px"; brand.style.opacity = bq; brand.style.filter = bq < 1 ? "blur(" + (1 - bq) * 10 + "px)" : "none";
      var tg = prog(t, t0 + 0.95, 380, "pop"); tog.style.opacity = clamp(tg * 2, 0, 1); tog.style.transform = "scale(" + lerp(0.5, 1, tg) + ")";
      var sq = prog(t, t0 + 1.05, 900, "out"); sub.style.opacity = sq; sub.style.filter = sq < 1 ? "blur(" + (1 - sq) * 8 + "px)" : "none";
      var f = s.fillAt != null ? prog(t, s.fillAt, 420, "out") : 0;
      knob.style.left = lerp(10, 52, f) + "%"; tog.style.background = f > 0.5 ? D.brand : "rgba(255,255,255,.2)"; tog.style.boxShadow = f > 0 ? "0 0 " + 30 * f + "px " + D.brand : "none";
      letters.forEach(function (sp) {
        sp.style.backgroundImage = f > 0 ? "linear-gradient(180deg,#fff 5%," + D.accent[0] + " 95%)" : "none";
        sp.style.webkitBackgroundClip = "text"; sp.style.backgroundClip = "text";
        if (f > 0) { sp.style.color = "transparent"; sp.style.webkitTextStroke = (2 * (1 - f)) + "px rgba(255,255,255,.75)"; }
      });
      title.style.filter = f > 0 ? "drop-shadow(0 0 " + 34 * f + "px " + D.accent[0] + "aa)" : "none";
      glow.style.opacity = f * 0.9; rays.style.opacity = f; rays.style.transform = "scale(" + lerp(0.85, 1, f) + ")";
      place(L, t, { o: fadeIO(s, t) });
    };
    return L;
  };

  // A white UI card whose content changes between views with a top-down wipe. views: dialog | prompt | image |
  // mosaic | blank | scene (dark frame title inside a card).
  B.card = function (s) {
    var L = base(s);
    L.root.className += " card";
    if (s.rad != null) L.root.style.borderRadius = s.rad + "px";
    var views = (s.views || [{ at: s.t0 || 0, kind: "blank" }]).map(function (v) {
      var box = el("div", "", "", L.root); box.style.cssText = "position:absolute;inset:0;overflow:hidden;background:" + (v.bg || "#fff");
      var V = VIEW[v.kind] ? VIEW[v.kind](v, box, s) : { draw: function () {} };
      V.v = v; V.box = box; return V;
    });
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var g = place(L, t, { o: fadeIO(s, t) * (s.popIn ? clamp(prog(t, s.t0, 300, "out") * 2, 0, 1) : 1), s: s.popIn ? lerp(0.85, 1, prog(t, s.t0, 520, "pop")) : 1 });
      if (s.glowAt != null) { var gq = prog(t, s.glowAt, 450, "out"); L.root.style.boxShadow = D.shadow + ",0 0 0 " + 4 * gq + "px " + (s.glowColor || D.accent[0]) + ",0 0 " + 70 * gq + "px " + 10 * gq + "px " + (s.glowColor || D.accent[0]) + "77"; }
      var active = 0; views.forEach(function (V, i) { if (t >= V.v.at) active = i; });
      views.forEach(function (V, i) {
        var show = i === active || (i === active - 1 && t < views[active].v.at + (views[active].v.wipeMs || 140) / 1000);
        V.box.style.display = show ? "block" : "none";
        if (i === active && i > 0) {
          var wp = prog(t, V.v.at, V.v.wipeMs || 140, "inOut");
          V.box.style.clipPath = V.v.wipe === "fade" ? "none" : "inset(0 0 " + (1 - wp) * 100 + "% 0)";
          V.box.style.opacity = V.v.wipe === "fade" ? wp : 1;
        } else { V.box.style.clipPath = "none"; V.box.style.opacity = 1; }
        if (show) V.draw(t, g);
      });
    };
    L.post = function (t) { if (L.root.style.display === "none") return; views.forEach(function (V) { if (V.post && V.box.style.display !== "none") V.post(t); }); };
    return L;
  };

  function typed(str, t, t0, t1) { if (t1 <= t0) return str; var n = Math.round(clamp((t - t0) / (t1 - t0), 0, 1) * str.length); return str.slice(0, n); }
  function caretOn(t) { return Math.floor(t * 2.2) % 2 === 0; }
  var VIEW = {};
  VIEW.blank = function () { return { draw: function () {} }; };
  VIEW.image = function (v, box) { box.style.background = img(v.src) + " center/cover"; return { draw: function () {} }; };
  VIEW.dialog = function (v, box) {
    box.style.padding = "34px 38px"; box.style.fontSize = "26px";
    var head = el("div", "", logoTile(v.icon, 30) + "<span style='margin-left:14px;font-weight:650'>" + esc(v.title || "") + "</span>", box); head.style.cssText = "display:flex;align-items:center;margin-bottom:26px";
    var fields = (v.fields || []).map(function (f) {
      var lab = el("div", "", esc(f.label || ""), box); lab.style.cssText = "color:" + D.muted + ";font-size:20px;margin:6px 0 10px";
      var inp = el("div", f.mono ? "mono" : "", "", box); inp.style.cssText += ";border:1.5px solid " + D.line + ";border-radius:12px;padding:14px 18px;margin-bottom:18px;display:flex;align-items:center;gap:12px;min-height:58px;font-size:" + (f.mono ? 22 : 24) + "px;font-weight:" + (f.mono ? 400 : 600);
      return { f: f, inp: inp };
    });
    var row = el("div", "", "", box); row.style.cssText = "display:flex;justify-content:flex-end;gap:18px;align-items:center;margin-top:8px";
    var cancel = el("div", "", esc(v.cancel || "Cancel"), row); cancel.style.cssText = "color:" + D.ink + ";font-size:22px;font-weight:550;border:1.5px solid " + D.line + ";border-radius:10px;padding:10px 22px;background:#fff";
    var ok = el("div", "", esc(v.ok || "Add"), row); ok.style.cssText = "background:" + D.ink + ";color:#fff;border-radius:10px;padding:12px 26px;font-size:22px;font-weight:650";
    return {
      draw: function (t) {
        fields.forEach(function (F) {
          var f = F.f, txt = f.typeFrom != null ? typed(f.value || "", t, f.typeFrom, f.typeTo) : (f.value || "");
          var focus = f.typeFrom != null && t >= f.typeFrom - 0.4 && t <= f.typeTo + 0.6;
          F.inp.style.borderColor = focus ? D.accent[0] + "aa" : D.line;
          F.inp.innerHTML = (f.icon != null ? logoTile(f.icon, 26) : "") + (f.prefix ? "<span style='color:" + D.muted + "'>" + esc(f.prefix) + "</span>" : "") + "<span>" + esc(txt) + "</span>" + (focus && caretOn(t) ? "<span class='caret' style='background:" + D.ink + "'></span>" : "");
        });
        var pr = v.pressAt != null ? (t >= v.pressAt && t < v.pressAt + 0.16 ? 0.92 : 1) : 1;
        ok.style.transform = "scale(" + pr + ")";
      }
    };
  };
  VIEW.prompt = function (v, box) {
    box.style.padding = "30px 34px";
    var txt = el("div", "", "", box); txt.style.cssText = "font-size:" + (v.size || 30) + "px;line-height:1.35;font-weight:500;letter-spacing:-0.01em;min-height:" + (v.size || 30) * 2.7 + "px";
    // every character its own span (inside a no-wrap span per word), so each one types in with a short blur and
    // the wide-lens shot can shrink and soften the ones near the frame's sides
    var full = (v.cmd ? v.cmd + " " : "") + (v.text || ""), nCmd = v.cmd ? v.cmd.length : 0, chars = [];
    var word = null;
    for (var ci = 0; ci < full.length; ci++) {
      var ch = full[ci];
      if (ch === " ") { word = null; var sp0 = el("span", "", " ", txt); sp0.style.whiteSpace = "pre"; chars.push({ e: sp0, i: ci, space: true }); continue; }
      if (!word) { word = el("span", "", "", txt); word.style.whiteSpace = "nowrap"; }
      var c = el("span", "", esc(ch), word); c.style.display = "inline-block";
      if (ci < nCmd) { c.style.color = D.brand; c.style.fontWeight = 650; }
      chars.push({ e: c, i: ci });
    }
    var caret = el("span", "caret", "", txt); caret.setAttribute("data-caret", "1"); caret.style.background = D.brand;
    var slots = v.drop ? el("div", "", "", box) : null;
    if (slots) slots.style.cssText = "position:absolute;left:34px;right:34px;top:26px;display:flex;gap:18px";
    var dropEls = v.drop ? v.drop.items.map(function () {
      var d = el("div", "", "", slots); d.style.cssText = "flex:1;height:" + (v.drop.h || 110) + "px;border-radius:14px;background:" + D.accent[0] + "14;border:1.5px dashed " + D.accent[0] + "66;display:flex;align-items:center;justify-content:center;gap:14px;padding:12px;font-size:19px;color:" + D.accent[0] + ";overflow:hidden;font-weight:500";
      return d;
    }) : [];
    var foot = el("div", "", "", box); foot.style.cssText = "position:absolute;left:34px;bottom:24px;display:flex;align-items:center;gap:10px;color:" + D.muted + ";font-size:20px";
    foot.innerHTML = v.model ? "<span style='width:20px;height:20px;display:inline-block'>" + (v.modelIcon ? logoTile(v.modelIcon, 20) : iconSvg("burst", "#D97757")) + "</span>" + esc(v.model) : "";
    var send = el("div", "", iconSvg("arrow", "#fff"), box); send.style.cssText = "position:absolute;right:28px;bottom:20px;width:52px;height:52px;border-radius:99px;background:" + D.brand + ";padding:12px";
    var perChar = v.typeFrom != null ? (v.typeTo - v.typeFrom) / Math.max(1, full.length) : 0;
    var V = {
      caret: caret,
      draw: function (t) {
        var shown = v.typeFrom != null ? Math.round(clamp((t - v.typeFrom) / Math.max(1e-6, v.typeTo - v.typeFrom), 0, 1) * full.length) : full.length;
        var last = null;
        chars.forEach(function (C) {
          var on = C.i < shown; C.e.style.display = on ? (C.space ? "inline" : "inline-block") : "none";
          if (!on || C.space) return; last = C.e;
          var at = v.typeFrom != null ? v.typeFrom + C.i * perChar : -1, q = at < 0 ? 1 : prog(t, at, v.charMs || 140, "out");
          C.q = q; C.e.style.opacity = 0.25 + 0.75 * q; C.e.style.filter = q < 0.999 ? "blur(" + ((1 - q) * 7).toFixed(2) + "px)" : "none"; C.e.style.transform = "none";
        });
        caret.style.visibility = (caretOn(t) || (v.typeFrom != null && t < v.typeTo + 0.1)) ? "visible" : "hidden";
        var top = v.drop && t >= v.drop.at ? (v.drop.push || 132) * prog(t, v.drop.at, 380, "out") : 0;
        txt.style.marginTop = top + "px";
        if (slots) {
          var sp = prog(t, v.drop.at, 380, "out"); slots.style.opacity = sp; slots.style.transform = "translateY(" + (1 - sp) * -16 + "px)";
          dropEls.forEach(function (d, i) {
            var it = v.drop.items[i], fillAt = (v.drop.fillAt || 0) + i * 0.12, f = t >= fillAt, fq = prog(t, fillAt, 300, "out");
            d.style.borderStyle = f ? "solid" : "dashed"; d.style.borderColor = f ? "transparent" : D.accent[0] + "66"; d.style.background = f ? "#F4F2F1" : D.accent[0] + "14"; d.style.color = f ? D.ink : D.accent[0];
            d.style.justifyContent = f ? "flex-start" : "center";
            d.innerHTML = f ? "<span style='width:" + (v.drop.h || 110) * 0.5 + "px;height:" + (v.drop.h || 110) * 0.62 + "px;border-radius:8px;flex:none;background:" + img(it.src) + " center/cover;transform:scale(" + lerp(0.6, 1, fq) + ")'></span><span style='line-height:1.25;opacity:" + fq + "'><b style='font-weight:650;font-size:19px'>" + esc(it.label || "") + "</b><br><span style='font-size:15px;color:" + D.muted + "'>" + esc(it.kind || "") + " · </span><span class='mono' style='color:" + D.brand + ";font-size:15px'>" + esc(it.meta || "") + "</span><br><span style='color:" + D.muted + ";font-size:14px'>" + esc(it.sub || "") + "</span></span>" : (i === 1 ? esc(v.drop.hint || "Drop here") : "");
          });
        }
        var pr = v.sendAt != null && t >= v.sendAt && t < v.sendAt + 0.16 ? 0.88 : 1; send.style.transform = "scale(" + pr + ")";
        this.caret = caret;
      },
      // after the camera: on the wide-lens shot, characters toward the frame's sides get smaller, softer and paler
      post: function () {
        var amt = LENS.on; if (amt < 0.01) return;
        var s0 = scaleRoot, rects = chars.map(function (C) { return C.space || C.e.style.display === "none" ? null : C.e.getBoundingClientRect(); });
        chars.forEach(function (C, i) {
          var rc = rects[i]; if (!rc) return;
          var xn = ((rc.left + rc.width / 2) / s0 - W / 2) / (W / 2), d = Math.max(0, Math.abs(xn) - 0.3);
          var zf = Math.max(0.2, (rc.height / s0) / Math.max(1, C.e.offsetHeight)); // how much the camera magnifies it
          var sc = 1 - amt * 0.14 * xn * xn, bl = (amt * 16 * d * d + (1 - (C.q == null ? 1 : C.q)) * 12) / zf;
          C.e.style.transform = "translateX(" + (-xn * amt * 0.06 * C.e.offsetWidth) + "px) scale(" + sc.toFixed(3) + ")";
          C.e.style.filter = bl > 0.05 ? "blur(" + bl.toFixed(2) + "px)" : "none";
          C.e.style.opacity = ((0.25 + 0.75 * (C.q == null ? 1 : C.q)) * (1 - amt * 0.55 * Math.min(1, d * 1.6))).toFixed(3);
        });
      }
    };
    return V;
  };
  VIEW.mosaic = function (v, box) { // a picture built from tiles, bottom up, with a progress pill
    var cols = v.cols || 14, rows = v.rows || 26, tiles = [];
    var grid = el("div", "", "", box); grid.style.cssText = "position:absolute;inset:0;display:grid;grid-template-columns:repeat(" + cols + ",1fr);grid-template-rows:repeat(" + rows + ",1fr)";
    var full = el("div", "", "", box); full.style.cssText = "position:absolute;inset:0;background:" + img(v.src) + " center/cover;opacity:0";
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      var d = el("div", "", "", grid); d.style.cssText = "background:" + img(v.src) + ";background-size:" + cols * 100 + "% " + rows * 100 + "%;background-position:" + (c / (cols - 1)) * 100 + "% " + (r / (rows - 1)) * 100 + "%;margin:1px;border-radius:2px";
      var seed = Math.sin((r + 1) * 12.9898 + (c + 1) * 78.233) * 43758.5453; seed = seed - Math.floor(seed);
      tiles.push({ d: d, k: (rows - 1 - r) / rows * 0.75 + seed * 0.25 });
    }
    return {
      draw: function (t) {
        var p = clamp((t - v.from) / (v.to - v.from), 0, 1);
        tiles.forEach(function (T) { var q = clamp((p - T.k * 0.85) / 0.15, 0, 1); T.d.style.opacity = q; T.d.style.transform = "translateY(" + (1 - q) * 18 + "px) scale(" + lerp(0.4, 1, q) + ")"; T.d.style.filter = q < 1 ? "grayscale(" + (1 - q) + ") contrast(1.2)" : "none"; });
        full.style.opacity = clamp((p - 0.92) / 0.08, 0, 1);
      }
    };
  };
  function fmtCount(n) { return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n >= 1e5 ? Math.round(n / 1e3) : (n / 1e3).toFixed(1)) + "K" : String(Math.round(n)); }
  // A finished post in a phone frame: the picture, a rail of actions with counts (likes count up), a bar with the
  // account and a Follow button, hearts that float up; at nextAt the picture changes to the next scene's.
  VIEW.post = function (v, box) {
    var im = el("div", "", "", box); im.style.cssText = "position:absolute;inset:0;background:" + img(v.src) + " center/cover";
    var nx = v.next ? el("div", "", "", box) : null; if (nx) nx.style.cssText = "position:absolute;inset:0;background:" + img(v.next) + " center/cover;opacity:0";
    var ui = el("div", "", "", box); ui.style.cssText = "position:absolute;inset:0";
    var shade = el("div", "", "", ui); shade.style.cssText = "position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 60%,rgba(0,0,0,.5))";
    var rail = el("div", "", "", ui); rail.style.cssText = "position:absolute;right:14px;bottom:110px;display:flex;flex-direction:column;align-items:center;gap:18px;color:#fff;font-size:15px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.5)";
    var items = [["heart", "#FF2D55"], ["comment", "#fff"], ["share", "#fff"], ["bookmark", "#fff"]].map(function (it, i) {
      var d = el("div", "", "<span style='width:38px;height:38px;display:block'>" + iconSvg(it[0], it[1]) + "</span><span></span>", rail); d.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px"; return d.lastChild;
    });
    var barEl = el("div", "", logoTile(v.logo, 34) + "<b style='font-weight:650'>" + esc(v.handle || "") + "</b><span style='border:1.5px solid #fff;border-radius:7px;padding:2px 10px;font-size:14px'>" + esc(v.follow || "Follow") + "</span>", ui);
    barEl.style.cssText = "position:absolute;left:16px;bottom:18px;display:flex;align-items:center;gap:10px;color:#fff;font-size:17px;text-shadow:0 1px 3px rgba(0,0,0,.5)";
    var hearts = []; for (var i = 0; i < 9; i++) { var h = el("div", "", iconSvg("heart", "#FF2D55"), box); h.style.cssText = "position:absolute;width:30px;height:30px;right:18px;bottom:300px;opacity:0"; hearts.push(h); }
    return {
      draw: function (t) {
        var lk = v.likes || [0, 0, 0, 1], q = clamp((t - lk[2]) / Math.max(0.01, lk[3] - lk[2]), 0, 1), e = 1 - Math.pow(1 - q, 2);
        var n = lk[0] + (lk[1] - lk[0]) * e;
        items[0].textContent = fmtCount(n); items[1].textContent = fmtCount(n * 0.067); items[2].textContent = fmtCount(n * 0.16); items[3].textContent = "";
        var uq = prog(t, v.uiAt != null ? v.uiAt : -1, 300, "out"), nq = nx ? prog(t, v.nextAt, v.nextMs || 280, "inOut") : 0;
        ui.style.opacity = uq * (1 - nq); if (nx) nx.style.opacity = nq;
        hearts.forEach(function (h, k) {
          var h0 = (v.hearts ? v.hearts[0] : 1e9) + k * 0.13, hp = clamp((t - h0) / 1.1, 0, 1);
          h.style.opacity = hp > 0 && hp < 1 ? (hp < 0.15 ? hp / 0.15 : 1 - (hp - 0.15) / 0.85) * (1 - nq) : 0;
          h.style.transform = "translate(" + Math.sin(hp * 5 + k) * 14 + "px," + (-hp * 260) + "px) scale(" + (0.6 + 0.5 * Math.sin(k * 1.7) * 0.5 + hp * 0.4) + ")";
        });
      }
    };
  };
  VIEW.scene = function (v, box) { // the dark title scene, whole, inside the card (for scene-to-card morphs)
    box.style.background = D.dark;
    if (v.src) { var b = el("div", "", "", box); b.style.cssText = "position:absolute;inset:-4%;background:" + img(v.src) + " center/cover;filter:blur(16px);opacity:.5"; }
    if (v.tint) { var tn = el("div", "", "", box); tn.style.cssText = "position:absolute;inset:0;background:" + v.tint + ";mix-blend-mode:color;opacity:.55"; }
    var sz = v.size || 120, t = el("div", "", "", box); t.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;gap:" + sz * 0.18 + "px";
    t.innerHTML = (v.brandRow ? "<div style='font-size:" + sz * 0.135 + "px;font-weight:600;opacity:.9;display:flex;gap:10px;align-items:center'>" + logoTile(v.logo, sz * 0.16) + esc(v.brandRow) + "</div>" : "") +
      "<div style='font-size:" + sz + "px;font-weight:800;letter-spacing:-0.035em;line-height:1.05;background:linear-gradient(180deg,#fff 5%," + D.accent[0] + " 95%);-webkit-background-clip:text;color:transparent;filter:drop-shadow(0 0 24px " + D.accent[0] + "aa);border:1.5px solid rgba(255,255,255,.45);padding:" + sz * 0.1 + "px " + sz * 0.28 + "px'>" + esc(v.text || "") + "</div>" +
      "<div style='width:" + sz * 0.5 + "px;height:" + sz * 0.27 + "px;border-radius:99px;background:" + D.brand + ";position:relative;box-shadow:0 0 24px " + D.brand + "'><div style='position:absolute;right:12%;top:12%;width:" + sz * 0.2 + "px;height:76%;border-radius:99px;background:#fff'></div></div>" +
      (v.sub ? "<div style='font-size:" + sz * 0.15 + "px;letter-spacing:.16em;font-weight:600;text-transform:uppercase;opacity:.72;margin-top:" + sz * 0.3 + "px'>" + esc(v.sub) + "</div>" : "");
    return { draw: function () {} };
  };


  // Node pill (logo + name in a gradient ring) with curved gradient branches that draw out to source chips (each
  // with its own icon), staggered; then the chips fold back, or the node grows into the next card (morphTo).
  B.node = function (s) {
    var L = base(s); L.root.style.cssText += ";width:" + W + "px;height:" + H + "px";
    var cx = s.x || W / 2, cy = s.y || H / 2, reach = s.reach || 430, spread = s.spread || 104;
    L.root.style.transform = "none";
    var svg = document.createElementNS(NS0, "svg"); svg.setAttribute("width", W); svg.setAttribute("height", H); svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible"; L.root.appendChild(svg);
    var gid = "ng" + (s.id || "node");
    svg.innerHTML = "<defs><linearGradient id='" + gid + "' x1='0' x2='1'><stop offset='0' stop-color='" + D.accent[0] + "'/><stop offset='1' stop-color='" + D.accent[1] + "'/></linearGradient></defs>";
    var node = el("div", "", logoTile(s.icon, 58) + "<span>" + esc(s.label || "") + "</span>", L.root);
    node.style.cssText = "position:absolute;display:flex;align-items:center;gap:16px;font-size:34px;font-weight:650;padding:12px 36px 12px 12px;border-radius:999px;border:3px solid transparent;background:linear-gradient(#fff,#fff) padding-box,linear-gradient(120deg," + D.accent[0] + "," + D.accent[1] + " 55%,#F59E0B) border-box;box-shadow:0 18px 36px -16px rgba(30,10,25,.3);white-space:nowrap;overflow:hidden";
    var nodeIn = node.innerHTML;
    var br = (s.branches || []).map(function (b, i, arr) {
      var n = arr.length, ty = cy + (i - (n - 1) / 2) * spread;
      var path = document.createElementNS(NS0, "path"); path.setAttribute("fill", "none"); path.setAttribute("stroke", "url(#" + gid + ")"); path.setAttribute("stroke-width", "3"); path.setAttribute("stroke-linecap", "round"); svg.appendChild(path);
      var dot = document.createElementNS(NS0, "circle"); dot.setAttribute("r", "5"); dot.setAttribute("fill", D.accent[1]); svg.appendChild(dot);
      var icon = b.icon ? logoTile(b.icon, 38) : "<span style='width:38px;height:38px;border-radius:10px;display:inline-block;padding:8px;background:" + (b.color || D.ink) + "'>" + iconSvg(b.glyph || "dot", "#fff") + "</span>";
      var chip = el("div", "pill", icon + "<span>" + esc(b.label || "") + "</span>", L.root);
      chip.style.cssText += ";position:absolute;font-size:24px;padding:8px 22px 8px 8px;gap:12px;box-shadow:0 0 0 2px rgba(0,0,0,.06),0 10px 22px -12px rgba(30,10,25,.3)";
      return { b: b, path: path, dot: dot, chip: chip, ty: ty };
    });
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0, np = prog(t, t0, 380, "pop");
      var mo = s.morphAt != null ? prog(t, s.morphAt, s.morphMs || 160, "inOut") : 0;
      node.style.width = ""; node.style.height = "";
      var nw = node.offsetWidth, nh = node.offsetHeight, sx = cx - nw / 2;
      if (mo > 0) {
        var R2 = s.morphTo; // [centre x, centre y, w, h]
        var w2 = lerp(nw, R2[2], mo), h2 = lerp(nh, R2[3], mo), x2 = lerp(cx, R2[0], mo), y2 = lerp(cy, R2[1], mo);
        node.style.width = w2 + "px"; node.style.height = h2 + "px"; node.style.left = (x2 - w2 / 2) + "px"; node.style.top = (y2 - h2 / 2) + "px";
        node.style.borderRadius = lerp(nh / 2, D.radius, mo) + "px"; node.style.transform = "none"; node.style.opacity = 1;
        node.style.background = "linear-gradient(#fff,#fff) padding-box,linear-gradient(120deg," + D.accent[0] + "," + D.accent[1] + " 55%,#F59E0B) border-box";
        node.style.borderColor = "rgba(255,255,255," + mo + ")"; node.style.color = "rgba(0,0,0," + (1 - mo) + ")";
      } else {
        node.style.left = (cx - nw / 2) + "px"; node.style.top = (cy - nh / 2) + "px"; node.style.transform = "scale(" + lerp(0.7, 1, np) + ")"; node.style.opacity = clamp(np * 2, 0, 1);
        node.style.borderRadius = "999px"; node.style.borderColor = "transparent"; node.style.color = "";
      }
      var fold = s.foldAt != null ? prog(t, s.foldAt, 360, "inOut") : 0, away = mo > 0 ? clamp(mo * 3, 0, 1) : 0;
      br.forEach(function (B2, i) {
        var at = (s.branchAt || t0 + 0.3) + i * 0.13, p = prog(t, at, 420, "out");
        var x0 = cx + nw / 2 - 4, tx = lerp(cx + reach, cx + reach * 0.75, fold), mx = (x0 + tx) / 2;
        var d = "M" + x0 + "," + cy + " C" + mx + "," + cy + " " + mx + "," + B2.ty + " " + (tx - 14) + "," + B2.ty;
        B2.path.setAttribute("d", d); var len = 900; B2.path.setAttribute("stroke-dasharray", len); B2.path.setAttribute("stroke-dashoffset", len * (1 - p)); B2.path.style.opacity = 0.85 * (1 - away);
        B2.dot.setAttribute("cx", tx - 14); B2.dot.setAttribute("cy", B2.ty); B2.dot.style.opacity = (p > 0.95 ? 1 : 0) * (1 - away);
        var cp = prog(t, at + 0.24, 420, "pop");
        B2.chip.style.left = tx + "px"; B2.chip.style.top = (B2.ty - B2.chip.offsetHeight / 2) + "px";
        B2.chip.style.transform = "scale(" + lerp(0.4, 1, cp) * lerp(1, 0.85, fold) + ")"; B2.chip.style.transformOrigin = "0 50%"; B2.chip.style.opacity = clamp(cp * 2, 0, 1) * (1 - away);
      });
      L.root.style.opacity = fadeIO(s, t) * (1 - (s.outAt != null ? prog(t, s.outAt, 200, "in") : 0));
    };
    return L;
  };

  // A browser window of tall tiles (as a social feed): each tile a picture with its own caption, a play count and a
  // coloured tag; tiles swap now and then while it scans, a highlight hops between them, tags float off its side
  // on thin lines; picks light up one by one, then the rest grey out.
  B.grid = function (s) {
    var L = base(s); L.root.className += " card";
    var cols = s.cols || 6, pad = s.pad || 22, gap = s.gap || 14, barH = s.bar || 58, Wd = s.w || 1340;
    var tw = (Wd - 2 * pad - (cols - 1) * gap) / cols, th = tw * 16 / 9, rows = Math.ceil((s.tiles || []).length / cols);
    var Hd = pad * 2 + barH + rows * th + (rows - 1) * gap; L.root.style.width = Wd + "px"; L.root.style.height = Hd + "px";
    var bar = el("div", "", "", L.root);
    bar.style.cssText = "position:absolute;left:" + pad + "px;right:" + pad + "px;top:" + pad + "px;height:" + (barH - 16) + "px;display:flex;align-items:center;font-size:22px";
    bar.innerHTML = logoTile(s.icon, 34) +
      "<b style='font-weight:650;margin:0 22px 0 12px'>" + esc(s.title || "") + "</b><span style='flex:1;display:flex;align-items:center;gap:8px;background:#F2F0EE;border-radius:10px;padding:9px 14px;color:" + D.muted + ";font-size:17px'><span style='width:16px;height:16px;display:inline-block'>" + iconSvg("search", D.muted) + "</span>" + esc(s.query || "") + "</span>";
    var area = el("div", "", "", L.root); area.style.cssText = "position:absolute;left:" + pad + "px;top:" + (pad + barH) + "px;width:" + (Wd - 2 * pad) + "px;height:" + (rows * th + (rows - 1) * gap) + "px";
    var srcs = s.tiles || [], caps = String(s.captions || "").split("|"), tags = String(s.tags || "").split(","), tagCols = s.tagColors || ["#F59E0B", "#22C55E", "#EF4444", "#3B82F6", "#A855F7", "#EC4899", "#14B8A6"];
    var views = s.views || ["1.4M", "698K", "5.1M", "2.3M", "3.2M", "64K", "1.1M", "7.4M", "880K", "1.6M", "2.2M", "22K"];
    var holder = el("div", "", "", L.root); holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    var tiles = srcs.map(function (src, i) {
      var col = i % cols, row = Math.floor(i / cols), x = col * (tw + gap), y = row * (th + gap);
      var d = el("div", "", "", area); d.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px;width:" + tw + "px;height:" + th + "px;border-radius:12px;overflow:hidden;background:#1d1a1c";
      var a1 = el("div", "", "", d); a1.style.cssText = "position:absolute;inset:0;background:" + img(src) + " center/cover";
      var alt = srcs[(i + 5) % srcs.length], a2 = el("div", "", "", d); a2.style.cssText = "position:absolute;inset:0;background:" + img(alt) + " center/cover;opacity:0";
      var shade = el("div", "", "", d); shade.style.cssText = "position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35),rgba(0,0,0,0) 30%,rgba(0,0,0,0) 70%,rgba(0,0,0,.45))";
      var cap = el("div", "", esc(caps[i % caps.length] || ""), d); cap.style.cssText = "position:absolute;left:10%;right:10%;top:13%;text-align:center;color:#fff;font-weight:700;font-size:" + tw * 0.085 + "px;line-height:1.15;text-shadow:0 1px 4px rgba(0,0,0,.7)";
      var cnt = el("div", "", "<span style='width:" + tw * 0.07 + "px;height:" + tw * 0.07 + "px;display:inline-block'>" + iconSvg("play", "#fff") + "</span>" + esc(views[i % views.length]), d); cnt.style.cssText = "position:absolute;left:8px;bottom:7px;color:#fff;font-size:" + tw * 0.07 + "px;font-weight:600;display:flex;align-items:center;gap:4px";
      var tc = tagCols[i % tagCols.length], tg = (tags[i % tags.length] || "").trim();
      var chip = tg ? el("div", "", esc((s.tagPrefix ? s.tagPrefix + " · " : "") + tg), d) : null;
      if (chip) chip.style.cssText = "position:absolute;left:" + (10 + (i * 37) % 30) + "%;top:" + (28 + (i * 53) % 44) + "%;background:" + tc + ";color:#fff;font-size:" + tw * 0.062 + "px;font-weight:650;padding:3px 8px;border-radius:5px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25)";
      var ring = el("div", "", "", d); ring.style.cssText = "position:absolute;inset:0;border-radius:12px;box-shadow:inset 0 0 0 0 transparent";
      var ck = el("div", "", iconSvg("check", "#fff"), d); ck.style.cssText = "position:absolute;right:7px;top:7px;width:28px;height:28px;border-radius:99px;background:" + D.brand + ";padding:4px;opacity:0;box-shadow:0 2px 6px rgba(0,0,0,.3)";
      var im = null; if (src && !isVideo(src)) { im = document.createElement("img"); im.src = src; holder.appendChild(im); }
      return { d: d, a2: a2, chip: chip, ring: ring, ck: ck, x: x, y: y, col: col, row: row, im: im, i: i };
    });
    // tags that float off the window's right side on thin lines
    var side = (s.sideTags || []).map(function (tg, k) {
      var c = el("div", "", esc((s.tagPrefix ? s.tagPrefix + " · " : "") + tg), L.root);
      c.style.cssText = "position:absolute;left:" + (Wd + 34) + "px;top:" + (Hd * (0.36 + k * 0.12)) + "px;background:" + (["#14B8A6", "#38BDF8", "#A855F7"][k % 3]) + ";color:#fff;font-size:15px;font-weight:650;padding:4px 10px;border-radius:6px;white-space:nowrap";
      var ln = el("div", "", "", L.root); ln.style.cssText = "position:absolute;left:" + (Wd - 6) + "px;top:" + (Hd * (0.36 + k * 0.12) + 13) + "px;height:1.5px;width:40px;background:" + (["#14B8A6", "#38BDF8", "#A855F7"][k % 3]) + "aa;transform-origin:0 50%";
      return { c: c, ln: ln };
    });
    L.root.style.overflow = "visible";
    L.tileBoxes = function () { var gx = (s.x || W / 2) - Wd / 2 + pad, gy = (s.y || H / 2) - Hd / 2 + pad + barH; return tiles.map(function (T) { return { x: gx + T.x, y: gy + T.y, w: tw, h: th, im: T.im }; }); };
    var picks = s.picks || [], hl = s.highlightColors || [D.accent[0], D.accent[1]];
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0, sw = s.revealSweep, areaW = Wd - 2 * pad;
      var frame = prog(t, s.frameAt != null ? s.frameAt : t0, 300, "out");
      var dimQ = s.dimAt != null ? prog(t, s.dimAt, 350, "inOut") : 0;
      var hop = s.scan ? Math.floor((t - s.scan[0]) / (s.scan[2] || 0.3)) : -1, hopOn = s.scan && t >= s.scan[0] && t < s.scan[1];
      tiles.forEach(function (T, i) {
        var p;
        if (sw) { var swX = lerp(areaW + 22, -22, clamp((t - sw[0]) / (sw[1] - sw[0]), 0, 1)); p = clamp((T.x + tw * 0.75 - swX) / (tw * 0.9), 0, 1); }
        else p = prog(t, t0 + 0.05 + (T.col + T.row) * 0.045, 420, "out");
        var pick = picks.indexOf(i), pickAt = pick >= 0 ? (s.pickAt || t0 + 1) + pick * 0.45 : 1e9, pk = prog(t, pickAt, 300, "pop");
        T.d.style.opacity = p; T.d.style.transform = "scale(" + (1 + pk * 0.035) + ")";
        // swaps: unpicked tiles change picture once or twice while it scans
        var sAt = s.swapFrom != null ? s.swapFrom + ((i * 7) % 12) * (s.swapStep || 0.16) : 1e9, sw2 = pick >= 0 ? 0 : prog(t, sAt, 220, "inOut") * (1 - prog(t, sAt + (s.swapHold || 1.1), 220, "inOut"));
        T.a2.style.opacity = sw2;
        if (T.chip) { var cq = sw ? prog(t, sw[0] - 0.25 + ((i * 29) % 12) * 0.04, 300, "pop") : p; T.chip.style.opacity = clamp(cq * 2, 0, 1); T.chip.style.transform = "scale(" + lerp(0.5, 1, cq) + ")"; }
        var hlOn = hopOn && pick < 0 && ((hop * 5 + 3) % srcs.length === i || (hop * 7 + 8) % srcs.length === i);
        var ringC = pk > 0 ? D.brand : hlOn ? hl[hop % hl.length] : null;
        T.ring.style.boxShadow = ringC ? "inset 0 0 0 " + (pk > 0 ? 4 * pk : 3) + "px " + ringC : "none";
        T.ck.style.opacity = pk; T.ck.style.transform = "scale(" + lerp(0.3, 1, pk) + ")";
        T.d.style.filter = pick < 0 && dimQ > 0 ? "grayscale(" + dimQ * 0.7 + ") brightness(" + (1 - dimQ * 0.12) + ") contrast(" + (1 - dimQ * 0.25) + ")" : "none";
        if (pick < 0 && dimQ > 0) T.d.style.opacity = p * (1 - dimQ * 0.35);
      });
      side.forEach(function (S2, k) { var q = prog(t, (s.sideAt || t0 + 1) + k * 0.25, 360, "out"); S2.c.style.opacity = q; S2.c.style.transform = "translateX(" + (1 - q) * -20 + "px) translateY(" + Math.sin(t * 1.3 + k) * 4 + "px)"; S2.ln.style.opacity = q; S2.ln.style.transform = "scaleX(" + q + ")"; });
      var clear = s.clearAt != null ? prog(t, s.clearAt, 380, "in") : 0;
      L.root.style.background = "rgba(255,255,255," + frame * (1 - clear) + ")"; L.root.style.boxShadow = frame > 0.5 && clear < 0.5 ? D.shadow : "none";
      L.root.style.borderColor = "rgba(0,0,0," + 0.05 * frame * (1 - clear) + ")";
      bar.style.opacity = frame * (1 - clear);
      area.style.opacity = 1 - clear; side.forEach(function (S2) { S2.c.style.opacity *= 1 - clear; S2.ln.style.opacity *= 1 - clear; });
      place(L, t, { o: fadeIO(s, t), s: lerp(0.97, 1, frame) });
    };
    return L;
  };

  // A thin outline box (selection frame); keys move and resize it. Used to carry the eye from one element to the next.
  B.box = function (s) {
    var L = base(s); L.root.style.cssText += ";border:" + (s.stroke || 1.5) + "px solid " + (s.color || "rgba(255,255,255,.7)");
    if (s.ticks) [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (c) { var tk = el("div", "", "<svg width='30' height='30' viewBox='0 0 30 30'><path d='M15 0v30M0 15h30' stroke='" + (s.color || "rgba(255,255,255,.7)") + "' stroke-width='1.5'/></svg>", L.root); tk.style.cssText = "position:absolute;width:30px;height:30px;" + (c[0] ? "right" : "left") + ":-16px;" + (c[1] ? "bottom" : "top") + ":-16px"; });
    L.draw = function (t) { var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return; place(L, t, { o: fadeIO(s, t) }); };
    return L;
  };

  // Notification toasts (frosted): each new one blurs in at the bottom and pushes the stack up; the oldest fade.
  // focusAt: the rest fade and the newest glides to the middle of the frame (it carries into the next scene).
  B.toasts = function (s) {
    var L = base(s), n = s.count || 6, every = s.every || 0.3, gap = s.gap || 108, tw = s.w || 600;
    L.root.style.cssText += ";width:" + tw + "px;height:" + (s.h || 640) + "px";
    var items = []; for (var i = 0; i < n; i++) {
      var d = el("div", "", "<span style='width:46px;height:46px;border-radius:12px;background:" + (s.iconColor || "#5B4BFF") + ";padding:10px;display:inline-block;flex:none'>" + iconSvg(s.icon || "card", "#fff") + "</span><span style='flex:1;line-height:1.25'><b style='font-weight:650'>" + esc(s.title || "Payment received") + "</b><br><span style='color:" + D.muted + ";font-size:16px'>" + esc(s.meta || "just now") + "</span></span><b class='mono' style='color:#16A34A;font-weight:600'>" + esc(s.amount || "+$49.00") + "</b>", L.root);
      d.style.cssText = "position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:16px;padding:14px 22px 14px 14px;border-radius:18px;background:rgba(255,255,255,.86);box-shadow:0 18px 40px -18px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.6);font-size:21px;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)";
      items.push(d);
    }
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0, fo = s.focusAt != null ? prog(t, s.focusAt, s.focusMs || 450, "inOut") : 0;
      var g = place(L, t, { o: fadeIO(s, t) });
      var newest = -1; for (var k = 0; k < n; k++) if (t >= t0 + k * every) newest = k;
      items.forEach(function (d, i) {
        var at = t0 + i * every, p = prog(t, at, 420, "out");
        var stackUp = 0; for (var j = i + 1; j < n; j++) stackUp += prog(t, t0 + j * every, 420, "out");
        var y = (1 - p) * 40 + stackUp * -gap, x = 0, sc = lerp(0.94, 1, p), o = p * (stackUp > (s.keep || 5) ? Math.max(0, 1 - (stackUp - (s.keep || 5))) : 1);
        if (fo > 0) {
          if (i === newest) { // glide to the frame's middle, in this layer's own coordinates
            var cxL = W / 2 - (g.x - tw / 2) - tw / 2, cyL = H / 2 - (g.y + (s.h || 640) / 2) + 40;
            x = lerp(0, cxL, fo); y = lerp(y, cyL, fo); sc *= lerp(1, s.focusScale || 1.08, fo);
          } else o *= 1 - fo;
        }
        d.style.transform = "translate(" + x + "px," + y + "px) scale(" + sc + ")";
        d.style.opacity = o; d.style.filter = p < 0.999 ? "blur(" + (1 - p) * 10 + "px)" : "none";
      });
    };
    return L;
  };

  // End card: logo + name + accent word, a line, a CTA pill (logo + partner, label, divider, badge), small url.
  B.cta = function (s) {
    var L = base(s); L.root.style.cssText += ";width:" + W + "px;height:" + H + "px";
    var size = s.size || 120, cy = s.y || H * 0.36, parts = [];
    var head = el("div", "", "", L.root); head.style.cssText = "position:absolute;left:0;width:100%;top:" + (cy - size * 0.6) + "px;display:flex;justify-content:center;align-items:center;gap:" + size * 0.2 + "px;color:#fff;font-size:" + size + "px;font-weight:700;letter-spacing:-0.04em;line-height:1.2;text-shadow:0 4px 30px rgba(0,0,0,.25)";
    var logo = el("span", "", logoTile(s.logo, size * 0.66), head); parts.push(logo); logo.style.display = "inline-flex";
    var nm = el("span", "", esc(s.name || ""), head); parts.push(nm);
    if (s.accent) { var ac = el("span", "acc", esc(s.accent), head); parts.push(ac); }
    var tag = el("div", "", "", L.root); tag.style.cssText = "position:absolute;left:0;width:100%;text-align:center;top:" + (cy + size * 0.95) + "px;color:rgba(255,255,255,.9);font-size:" + size * 0.36 + "px;font-weight:500;letter-spacing:-0.01em";
    var tw = words(s.tagline || "").map(function (wd, i, arr) { var sp = el("span", "w", esc(wd.t) + (i < arr.length - 1 ? " " : ""), tag); if (wd.c === "mut") sp.style.color = "rgba(255,255,255,.55)"; return sp; });
    var bh = size * 0.62;
    var btn = el("div", "pill", "", L.root);
    btn.innerHTML = logoTile(s.logo, bh * 0.62) + (s.partner != null ? "<span style='color:#B9B4B6;font-weight:500'>+</span><span style='width:" + bh * 0.46 + "px;height:" + bh * 0.46 + "px;display:inline-block'>" + (s.partnerLogo ? logoTile(s.partnerLogo, bh * 0.46) : iconSvg("burst", "#D97757")) + "</span>" : "") +
      "<span>" + esc(s.button || "Get started") + "</span>" + (s.badge ? "<span style='width:1.5px;height:" + bh * 0.5 + "px;background:#E3DFE0'></span><span style='color:" + D.brand + ";font-weight:700'>" + esc(s.badge) + "</span>" : "");
    btn.style.cssText += ";position:absolute;left:50%;top:" + (cy + size * 1.85) + "px;height:" + bh + "px;font-size:" + size * 0.24 + "px;padding:0 " + size * 0.22 + "px 0 " + bh * 0.16 + "px;gap:" + size * 0.1 + "px"; parts.push(btn);
    var url = el("div", "", esc(s.url || ""), L.root); url.style.cssText = "position:absolute;left:0;width:100%;text-align:center;top:" + (cy + size * 3.1) + "px;color:rgba(255,255,255,.7);font-size:" + size * 0.19 + "px"; parts.push(url);
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var t0 = s.t0 || 0, delays = [0, 0.1, 0.22, 0.95, 1.15], ki = 0;
      parts.forEach(function (p) {
        var isB = p === btn, isU = p === url, at = t0 + (isB ? 0.95 : isU ? 1.2 : delays[Math.min(ki++, 2)]), q = prog(t, at, isB ? 560 : 260, isB ? "pop" : "out");
        p.style.opacity = clamp(q * (isB ? 2 : 1), 0, 1); p.style.filter = q < 1 && !isB ? "blur(" + (1 - q) * 14 + "px)" : "none";
        if (isB) p.style.transform = "translateX(-50%) scale(" + lerp(0.6, 1, q) + ")";
      });
      tw.forEach(function (sp, i) { var q = prog(t, t0 + 0.45 + i * WORD.stagger, WORD.ms, "out"); sp.style.opacity = q; sp.style.filter = q < 0.999 ? "blur(" + (1 - q) * WORD.blur + "px)" : "none"; });
      place(L, t, { o: fadeIO(s, t) });
    };
    return L;
  };

  // Halftone break-up (canvas): a click bursts into a square grid of dots that spreads from the click, thins and
  // rounds toward its edge, then a sweep (right to left) turns each cell into the picture's own pixel under it and
  // the real tiles show through: one element dissolving into the next.
  B.halftone = function (s) {
    var L = base(s); L.root.style.cssText += ";width:" + W + "px;height:" + H + "px"; L.root.style.transform = "none";
    var cv = document.createElement("canvas"); cv.width = W; cv.height = H; cv.style.cssText = "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px"; L.root.appendChild(cv);
    var g2 = cv.getContext("2d"), P = s.pitch || 22, R = s.to || [W * 0.15, H * 0.15, W * 0.7, H * 0.75];
    var ox = s.x || W / 2, oy = s.y || H / 2, cells = [], seed = 11;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var x0 = Math.min(R[0], ox - 200), x1 = Math.max(R[0] + R[2], ox + 260), y0 = Math.min(R[1], oy - 260), y1 = Math.max(R[1] + R[3], oy + 260);
    var far = 0; [[R[0], R[1]], [R[0], R[1] + R[3]], [R[0] + R[2], R[1]], [R[0] + R[2], R[1] + R[3]]].forEach(function (c) { far = Math.max(far, Math.hypot(c[0] - ox, c[1] - oy)); });
    var pal = s.colors || [D.brand, D.accent[0], "#F48FB1", "#E8436E", "#F7B6C9"];
    for (var y = y0; y < y1; y += P) for (var x = x0; x < x1; x += P) {
      var inside = x >= R[0] && x < R[0] + R[2] && y >= R[1] && y < R[1] + R[3];
      cells.push({ x: x, y: y, d: Math.hypot(x + P / 2 - ox, (y + P / 2 - oy) * 1.15), n: rnd(), m: rnd(), c: pal[Math.floor(rnd() * pal.length)], inside: inside });
    }
    // the tiles' own pixels, read once the pictures are decoded (pictures that are not ready keep the dot colours)
    var tilesL = null, pix = null;
    function readPixels() {
      tilesL = s.tiles && byId[s.tiles]; if (!tilesL || !tilesL.tileBoxes) return;
      var off = document.createElement("canvas"), cw = Math.ceil(R[2] / P), ch = Math.ceil(R[3] / P); off.width = cw; off.height = ch;
      var o2 = off.getContext("2d"), ok = true;
      tilesL.tileBoxes().forEach(function (b) { if (!b.im || !b.im.complete || !b.im.naturalWidth) { ok = false; return; }
        var iw = b.im.naturalWidth, ih = b.im.naturalHeight, ar = b.w / b.h, sw = iw, sh = iw / ar; if (sh > ih) { sh = ih; sw = ih * ar; }
        o2.drawImage(b.im, (iw - sw) / 2, (ih - sh) / 2, sw, sh, (b.x - R[0]) / P, (b.y - R[1]) / P, b.w / P, b.h / P); });
      if (!ok) return;
      try { var dt = o2.getImageData(0, 0, cw, ch).data; pix = function (x, y) { var i = (Math.floor((y - R[1]) / P) * cw + Math.floor((x - R[0]) / P)) * 4; return dt[i + 3] > 10 ? "rgb(" + dt[i] + "," + dt[i + 1] + "," + dt[i + 2] + ")" : null; }; } catch (e) { pix = null; }
    }
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      if (!pix) readPixels();
      var t0 = s.t0 || 0, grow = prog(t, t0, s.growMs || 650, "out"), Rad = 40 + far * 1.08 * grow;
      var sw = s.sweep || [t0 + 0.45, t0 + 1.05], swX = lerp(R[0] + R[2] + P, R[0] - P, clamp((t - sw[0]) / (sw[1] - sw[0]), 0, 1));
      var fadeAll = s.fadeAt != null ? prog(t, s.fadeAt, 300, "in") : 0;
      g2.clearRect(0, 0, W, H);
      for (var i = 0; i < cells.length; i++) {
        var C = cells[i]; if (C.d > Rad) continue;
        var dn = 1 - C.d / Rad; // 1 at the click, 0 at the front
        var outside = !C.inside, gone = outside ? prog(t, t0 + 0.22 + C.n * 0.18, 200, "in") : 0;
        if (gone >= 1) continue;
        var front = clamp((Rad - C.d) / 90, 0, 1); // cells just reached grow in
        if (C.n > 0.18 + 0.82 * Math.pow(dn, 0.6) + (C.inside ? 0.25 : 0)) continue;
        var size = P * (0.22 + 0.62 * Math.pow(dn, 0.55)) * (0.75 + 0.25 * C.m) * front;
        var a = (1 - gone) * (1 - fadeAll), cx = C.x + P / 2, cy = C.y + P / 2, col = C.c, sq = dn > 0.42;
        if (C.inside && cx > swX) { // the sweep passed: the cell becomes the picture's pixel, then lets the tile through
          var since = clamp((cx - swX) / (R[2] * 0.22), 0, 1), px = pix ? pix(cx, cy) : null;
          if (px) col = px; size = lerp(size, P - 1, Math.min(1, since * 2.2)); sq = true; a *= 1 - clamp((since - 0.45) / 0.55, 0, 1);
          if (a <= 0.01) continue;
        }
        g2.globalAlpha = a; g2.fillStyle = col;
        if (sq) g2.fillRect(cx - size / 2, cy - size / 2, size, size);
        else { g2.beginPath(); g2.arc(cx, cy, size / 2, 0, 6.2832); g2.fill(); }
      }
      g2.globalAlpha = 1;
      L.sweepX = swX;
    };
    return L;
  };

  // A small status pill (logo, label, a number that counts): "Building post 58%".
  B.chip = function (s) {
    var L = base(s); L.root.className += " pill"; L.root.style.fontSize = (s.size || 20) + "px"; L.root.style.padding = "8px 18px 8px 8px"; L.root.style.gap = "10px";
    L.root.innerHTML = logoTile(s.icon, (s.size || 20) * 1.4) + "<span>" + esc(s.text || "") + "</span><b class='mono' style='color:" + D.brand + ";font-weight:600'></b>";
    var num = L.root.lastChild;
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "flex" : "none"; if (!vis) return;
      var c = s.count; if (c) { var q = clamp((t - c.t0) / (c.t1 - c.t0), 0, 1); num.textContent = Math.round(lerp(c.from, c.to, q)) + (c.suffix || ""); }
      var pq = prog(t, s.t0 || 0, 420, "pop");
      place(L, t, { o: fadeIO(s, t) * clamp(pq * 2, 0, 1), s: lerp(0.7, 1, pq) });
    };
    return L;
  };

  // Cursor: a mac arrow that glides between points (ease in-out) and presses on clicks.
  B.cursor = function (s) {
    var L = base(s); L.root.style.cssText += ";width:34px;height:34px;z-index:" + (s.z || 50);
    L.root.innerHTML = "<svg viewBox='0 0 24 24' width='34' height='34'><path d='M4 2l15 11.5-6.6.9 3.9 7.4-3 1.4-3.8-7.5L4 20z' fill='#111' stroke='#fff' stroke-width='1.4' stroke-linejoin='round'/></svg>";
    var path = (s.path || []).slice().sort(function (a, b) { return a.t - b.t; });
    L.keys = path.map(function (p) { return { t: p.t, x: p.x + 12, y: p.y + 14, e: p.e || "inOut", out: p.out, in: p["in"], auto: p.auto, po: p.po, pi: p.pi }; });
    L.draw = function (t) {
      var vis = live(s, t); L.root.style.display = vis ? "block" : "none"; if (!vis) return;
      var click = 1; path.forEach(function (p) { if (p.click && t >= p.t && t < p.t + 0.18) click = 0.82; });
      place(L, t, { o: fadeIO(s, t), s: click });
    };
    return L;
  };

  // Canvas: background colour and the sparse cross grid.
  function drawBackground(t) {
    var g = D.grid || {};
    bgEl.style.background = D.bg;
    bgEl.style.visibility = videoBackdrops.some(function (b) { return live(b, t); }) ? "hidden" : "visible";
    if (g.kind === "crosses" && !bgEl.dataset.done) {
      var gap = g.gap || 240, sz = g.size || 12, svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + gap + "' height='" + gap + "'><path d='M" + (gap / 2 - sz / 2) + " " + gap / 2 + "h" + sz + "M" + gap / 2 + " " + (gap / 2 - sz / 2) + "v" + sz + "' stroke='" + g.color + "' stroke-width='2'/></svg>";
      bgEl.style.backgroundImage = "url(\"data:image/svg+xml;utf8," + encodeURIComponent(svg) + "\")"; bgEl.style.backgroundSize = gap + "px " + gap + "px"; bgEl.dataset.done = "1";
    }
    if (S.transparentBg) bgEl.style.display = "none";
  }

  // ---------- camera ----------
  // Keys: z (zoom), x, y (the design point at the centre), r (roll); AE ease fields work here too. track: follow a
  // typing caret. lens 0-1: a wide lens close up (as the original's typing shot): the card's straight edges bow
  // (barrel), the frame darkens to the corners and its sides blur; lensLayer names the card whose edges bow.
  var camKeys = (S.camera || []).slice().sort(function (a, b) { return a.t - b.t; });
  var camMb = null, CAM_MB = M.cameraBlur != null ? M.cameraBlur : MB;
  var lensBox = document.createElement("div"); lensBox.style.cssText = "position:absolute;inset:0;pointer-events:none;display:none;z-index:5"; vp.appendChild(lensBox);
  var lensSvg = document.createElementNS(NS, "svg"); lensSvg.setAttribute("width", W); lensSvg.setAttribute("height", H); lensSvg.style.cssText = "position:absolute;left:0;top:0"; lensBox.appendChild(lensSvg);
  lensSvg.innerHTML = "<defs><filter id='lensSh' x='-5%' y='-50%' width='110%' height='200%'><feGaussianBlur stdDeviation='10'/></filter></defs>";
  var lensShadow = document.createElementNS(NS, "path"); lensShadow.setAttribute("fill", "none"); lensShadow.setAttribute("stroke", "rgba(40,30,40,.16)"); lensShadow.setAttribute("stroke-width", "16"); lensShadow.setAttribute("filter", "url(#lensSh)"); lensSvg.appendChild(lensShadow);
  var lensPage = document.createElementNS(NS, "path"); lensPage.setAttribute("fill", D.bg); lensSvg.appendChild(lensPage);
  var lensCardBand = document.createElementNS(NS, "path"); lensCardBand.setAttribute("fill", D.card); lensSvg.appendChild(lensCardBand);
  var lensEdge = document.createElementNS(NS, "path"); lensEdge.setAttribute("fill", "none"); lensEdge.setAttribute("stroke", "rgba(0,0,0,.07)"); lensEdge.setAttribute("stroke-width", "2"); lensSvg.appendChild(lensEdge);
  var lensVig = document.createElement("div"); lensVig.style.cssText = "position:absolute;inset:0;background:radial-gradient(ellipse 62% 58% at 50% 52%,rgba(255,255,255,0) 35%,rgba(70,62,68,.30) 100%)"; lensBox.appendChild(lensVig);
  var lensL = document.createElement("div"), lensR = document.createElement("div");
  [lensL, lensR].forEach(function (e, i) { e.style.cssText = "position:absolute;top:0;bottom:0;width:30%;" + (i ? "right:0" : "left:0") + ";-webkit-mask-image:linear-gradient(" + (i ? "270deg" : "90deg") + ",#000 10%,transparent);mask-image:linear-gradient(" + (i ? "270deg" : "90deg") + ",#000 10%,transparent)"; lensBox.appendChild(e); });
  var LENS = { on: 0 };
  // zoom keys interpolate in log space, so a 4x pull-out feels even all the way (as measured on the reference)
  var camKeysL = camKeys.map(function (k) { if (k.z == null) return k; var o = {}; for (var q in k) o[q] = k[q]; o.z = Math.log(Math.max(1e-3, k.z)); return o; });
  function camAt(t) { return { z: Math.exp(keyVal(camKeysL, "z", t, 0)), x: keyVal(camKeys, "x", t, W / 2), y: keyVal(camKeys, "y", t, H / 2), r: keyVal(camKeys, "r", t, 0) }; }
  function camera(t) {
    var c = camAt(t), z = c.z, x = c.x, y = c.y, r = c.r;
    var tr = null; camKeys.forEach(function (k) { if (k.track && t >= k.t && t <= k.track.to) tr = k; });
    if (tr) {
      var L = byId[tr.track.layer]; var cr = L && L.root.querySelector("[data-caret]");
      if (cr) {
        cam.style.transform = "none";
        var rc = cr.getBoundingClientRect(), s0 = scaleRoot;
        var cx = rc.left / s0, w = tr.track.weight != null ? tr.track.weight : 1;
        var blend = clamp((t - tr.t) / 0.4, 0, 1) * (1 - clamp((t - (tr.track.to - 0.25)) / 0.25, 0, 1));
        blend = blend * blend * (3 - 2 * blend);
        x = lerp(x, cx - (tr.track.lead || 0) / z, blend * w);
        if (tr.track.y) { var cy2 = (rc.top + rc.height / 2) / s0; y = lerp(y, cy2, blend); }
      }
    }
    cam.style.transform = "translate(" + (W / 2 - x * z) + "px," + (H / 2 - y * z) + "px) scale(" + z + ") rotate(" + r + "deg)";
    // camera motion blur: how far the frame's content moves during the shutter
    var p = camAt(t - SHUTTER), bz = Math.abs(Math.log(z / p.z)) * W * 0.06; // a zoom blurs the edges, not the middle: kept light
    var pan = tr ? 0 : 1; // while it follows a caret the keyed x is not where it looks, so no pan blur from it
    var bx = (bz + pan * Math.abs(c.x - p.x) * z) * CAM_MB * 0.5, by = (bz * 0.56 + pan * Math.abs(c.y - p.y) * z) * CAM_MB * 0.5;
    if (bx > 0.8 || by > 0.8) { if (!camMb) camMb = mbFilter(); camMb.g.setAttribute("stdDeviation", Math.min(bx, 30).toFixed(2) + " " + Math.min(by, 30).toFixed(2)); cam.style.filter = "url(#" + camMb.id + ")"; }
    else cam.style.filter = "none";
    lens(t, z);
  }
  function lens(t, z) {
    var amt = keyVal(camKeys, "lens", t, 0); LENS.on = amt;
    if (amt < 0.01) { lensBox.style.display = "none"; return; }
    lensBox.style.display = "block";
    lensVig.style.opacity = amt; lensL.style.backdropFilter = lensR.style.backdropFilter = "blur(" + (amt * 7).toFixed(1) + "px)";
    lensL.style.webkitBackdropFilter = lensR.style.webkitBackdropFilter = lensL.style.backdropFilter;
    var lid = null; camKeys.forEach(function (k) { if (k.lensLayer && t >= k.t) lid = k.lensLayer; });
    var L = lid && byId[lid]; if (!L) { lensPage.setAttribute("d", ""); lensCardBand.setAttribute("d", ""); lensEdge.setAttribute("d", ""); lensShadow.setAttribute("d", ""); return; }
    var rc = L.root.getBoundingClientRect(), s0 = scaleRoot, top = rc.top / s0, bot = rc.bottom / s0, cy = H / 2, k = 0.42 * amt;
    function f(xn, yn) { return 1 / (1 + k * (xn * xn + yn * yn)); }
    function curve(edge) {
      var yn = (edge - cy) / (H / 2), f0 = f(0, yn), pts = [];
      for (var i = 0; i <= 24; i++) { var xx = (i / 24) * W, xn = (xx - W / 2) / (W / 2); pts.push([xx, cy + (edge - cy) * f(xn, yn) / f0]); }
      return pts;
    }
    function d(pts) { return pts.map(function (q, i) { return (i ? "L" : "M") + q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(""); }
    var tp = curve(top), bp = curve(bot), page = "", band = "", edgeD = "";
    if (top > -H && top < H * 1.2) { page += d(tp) + "L" + W + ",-10L0,-10Z"; band += d(tp) + "L" + W + "," + (top + 4) + "L0," + (top + 4) + "Z"; edgeD += d(tp); }
    if (bot > -H * 0.2 && bot < H * 2) { page += d(bp) + "L" + W + "," + (H + 10) + "L0," + (H + 10) + "Z"; band += d(bp) + "L" + W + "," + (bot - 4) + "L0," + (bot - 4) + "Z"; edgeD += d(bp); }
    lensPage.setAttribute("d", page); lensCardBand.setAttribute("d", band); lensEdge.setAttribute("d", edgeD); lensShadow.setAttribute("d", edgeD);
  }

  // ---------- build ----------
  var byId = {};
  (S.layers || []).forEach(function (spec) {
    var f = B[spec.kind]; if (!f) return;
    var L = f(spec); L.id = spec.id; layers.push(L); if (spec.id) byId[spec.id] = L;
  });
  function fit() { var s = Math.min(window.innerWidth / W, window.innerHeight / H); if (!isFinite(s) || s <= 0) s = 1; scaleRoot = s; vp.style.transform = "scale(" + s + ")"; vp.style.transformOrigin = "0 0"; vp.style.width = W + "px"; vp.style.height = H + "px"; }
  fit();
  window.renderFrame = function (t) {
    drawBackground(t);
    cam.style.transform = "none";
    for (var i = 0; i < layers.length; i++) layers[i].draw(t);
    camera(t);
    for (var j = 0; j < layers.length; j++) if (layers[j].post) layers[j].post(t);
  };
  window.renderFramePure = true;
  window.__motion = { spec: S, values: VALUES, duration: DUR };
  window.renderFrame(0);
})();
