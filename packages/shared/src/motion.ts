// Phase 5: speed, transitions and keyframes. The numbers the render (as FFmpeg expressions) and the editor's player
// both use, so they agree frame for frame:
//   keyframes    every property's curve becomes one piecewise-linear table (16 pieces per eased segment)
//   speed ramps  steps of at most 0.2 s of edit, each at one speed
//   transitions  where each side is and how opaque, at each moment of the window
import { z } from "zod";

const unit = z.number().min(0).max(1);
export const EASES = ["linear", "in", "out", "in-out"] as const;
/** Easing to the next key: a named curve (the CSS ones) or a cubic bezier [x1, y1, x2, y2] like CSS cubic-bezier(). */
export const EaseSchema = z.union([z.enum(EASES), z.tuple([unit, z.number().min(-2).max(3), unit, z.number().min(-2).max(3)])]);
export type Ease = z.infer<typeof EaseSchema>;
export const KEY_PROPS = ["x", "y", "scale", "rotation", "opacity"] as const;
/** Phase 11: the point a clip turns and scales about (Premiere's Anchor Point), as shares of its frame (0.5, 0.5 = the
 *  middle; 0, 0 = top left). */
export const AnchorSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type Anchor = z.infer<typeof AnchorSchema>;
export type KeyProp = (typeof KEY_PROPS)[number];
/**
 * A keyframe: at time t, the properties it sets. x, y: offset of the centre as a share of the frame's width and height
 * (0.25 = a quarter of the width to the right); scale: 1 = as is; rotation: degrees clockwise; opacity 0-1.
 * t: seconds from the clip's start in the edit (a V1 clip stores the footage second instead, so keys move with the
 * footage when the clip is cut or split).
 */
export const KeySchema = z.object({
  t: z.number().finite().min(0).max(24 * 3600),
  x: z.number().min(-3).max(3).optional(),
  y: z.number().min(-3).max(3).optional(),
  scale: z.number().min(0.05).max(4).optional(),
  rotation: z.number().min(-3600).max(3600).optional(),
  opacity: unit.optional(),
  ease: EaseSchema.optional(),
});
export type Key = z.infer<typeof KeySchema>;
export const KeysSchema = z.array(KeySchema).max(60);
export type Motion = Record<KeyProp, number>;
export const NO_MOTION: Motion = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

// ---------------------------------------------------------------------------------------------
// Easing: a cubic bezier sampled at 17 points (16 pieces). The table is all either side ever uses.
// ---------------------------------------------------------------------------------------------
export const PIECES = 16;
const NAMED: Record<(typeof EASES)[number], [number, number, number, number]> = { linear: [0, 0, 1, 1], in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1], "in-out": [0.42, 0, 0.58, 1] };
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** y of a CSS cubic-bezier(x1, y1, x2, y2) at x (0-1). */
export function bezierAt(b: [number, number, number, number], x: number): number {
  const [x1, y1, x2, y2] = b;
  const f = (p1: number, p2: number, s: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(x1, x2, m) < x) lo = m; else hi = m; }
  return f(y1, y2, (lo + hi) / 2);
}
const curveOf = (e: Ease | undefined) => (Array.isArray(e) ? e : NAMED[e ?? "linear"]);
const isLinear = (b: [number, number, number, number]) => b[0] === b[1] && b[2] === b[3];
/** An ease's progress (0-1) at x (0-1). */
export const easeAt = (e: Ease | undefined, x: number) => { const b = curveOf(e); return isLinear(b) ? x : bezierAt(b, Math.min(1, Math.max(0, x))); };
const tables = new Map<string, number[]>();
function tableOf(b: [number, number, number, number]): number[] {
  const k = b.join(",");
  let t = tables.get(k);
  if (!t) { t = Array.from({ length: PIECES + 1 }, (_, j) => (j === 0 ? 0 : j === PIECES ? 1 : bezierAt(b, j / PIECES))); tables.set(k, t); }
  return t;
}

/** One property's curve as points of a piecewise-linear function of t (sorted; two points at one t = a jump). */
export type Track = { t: number; v: number }[];

export function keyTrack(keys: Key[], prop: KeyProp): Track | null {
  const ks = keys.filter((k) => k[prop] != null).sort((a, b) => a.t - b.t);
  if (!ks.length) return null;
  const pts: Track = [{ t: r6(ks[0].t), v: r6(ks[0][prop]!) }];
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i], b = ks[i + 1], va = a[prop]!, vb = b[prop]!;
    const c = curveOf(a.ease);
    if (b.t - a.t < 1e-6 || isLinear(c) || va === vb) { pts.push({ t: r6(b.t), v: r6(vb) }); continue; }
    const tab = tableOf(c);
    for (let j = 1; j <= PIECES; j++) pts.push({ t: r6(a.t + ((b.t - a.t) * j) / PIECES), v: r6(va + (vb - va) * tab[j]) });
  }
  return pts;
}

/** The curve's value at t: v0 plus each piece's change, ramped over the piece (a jump at a zero-length piece). */
export function trackAt(pts: Track, t: number): number {
  let v = pts[0].v;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dv = b.v - a.v;
    if (!dv) continue;
    const dt = b.t - a.t;
    v += dv * (dt <= 0 ? (t >= a.t ? 1 : 0) : Math.min(1, Math.max(0, (t - a.t) / dt)));
  }
  return v;
}

/** The same curve as an FFmpeg expression of `tv` (a time variable or expression). */
export function trackExpr(pts: Track, tv = "t"): string {
  const n = (x: number) => String(r6(x));
  const terms: string[] = [n(pts[0].v)];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dv = r6(b.v - a.v);
    if (!dv) continue;
    const dt = r6(b.t - a.t);
    terms.push(dt <= 0 ? `${n(dv)}*gte(${tv},${n(a.t)})` : `${n(dv)}*clip((${tv}-${n(a.t)})/${n(dt)},0,1)`);
  }
  return terms.length === 1 ? terms[0] : `(${terms.join("+")})`;
}

export type KeyTracks = Partial<Record<KeyProp, Track>>;
export function keyTracks(keys: Key[] | undefined): KeyTracks | null {
  if (!keys?.length) return null;
  const out: KeyTracks = {};
  for (const p of KEY_PROPS) { const tr = keyTrack(keys, p); if (tr) out[p] = tr; }
  return Object.keys(out).length ? out : null;
}
/** Position, scale, rotation and opacity at t (properties no key sets keep their plain value). */
export function motionAt(tracks: KeyTracks | null, t: number): Motion {
  if (!tracks) return NO_MOTION;
  const m = { ...NO_MOTION };
  for (const p of KEY_PROPS) { const tr = tracks[p]; if (tr) m[p] = trackAt(tr, t); }
  return m;
}
export const motionExpr = (tracks: KeyTracks | null, p: KeyProp, tv = "t") => (tracks?.[p] ? trackExpr(tracks[p]!, tv) : String(NO_MOTION[p]));
/** The biggest and smallest scale the curve reaches (its points are its extremes). */
export const scaleRange = (tracks: KeyTracks | null): [number, number] => {
  const vs = tracks?.scale?.map((p) => p.v) ?? [1];
  return [Math.min(...vs), Math.max(...vs)];
};
/** The corners a w x h picture centred in a W x H frame lands on (top-left, top-right, bottom-left, bottom-right). */
export function cornersOf(m: Motion, W: number, H: number, w = W, h = H): [number, number][] {
  const th = (m.rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const cx = W / 2 + m.x * W, cy = H / 2 + m.y * H;
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
    const dx = (sx * w) / 2 * m.scale, dy = (sy * h) / 2 * m.scale;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
}

// ---------------------------------------------------------------------------------------------
// Speed ramps: speed points at footage moments of the clip, linear between them, constant outside.
// ---------------------------------------------------------------------------------------------
/** Phase 11: ease: how the speed changes on the way to the next point (linear by default; in, out, in-out or a
 *  bezier ease the change in and out, as Premiere's speed ramp handles). */
export const RampPointSchema = z.object({ at: z.number().finite().min(0).max(24 * 3600), speed: z.number().min(0.1).max(10), ease: EaseSchema.optional() });
export type RampPoint = z.infer<typeof RampPointSchema>;
/** Longest step of a ramp, in edit seconds: each step plays at one speed. */
export const RAMP_STEP = 0.2;
/** Sound plays between these speeds (browsers mute it outside them); a clip outside them is silent everywhere. */
export const SOUND_SPEEDS: [number, number] = [0.5, 4];
export const audibleRate = (r: number) => r > 0 && r >= SOUND_SPEEDS[0] - 1e-9 && r <= SOUND_SPEEDS[1] + 1e-9;

export function speedAt(ramp: RampPoint[], src: number): number {
  const ps = [...ramp].sort((a, b) => a.at - b.at);
  if (src <= ps[0].at) return ps[0].speed;
  for (let i = 0; i + 1 < ps.length; i++) {
    const a = ps[i], b = ps[i + 1];
    if (src <= b.at) return b.at - a.at < 1e-9 ? b.speed : a.speed + (b.speed - a.speed) * easeAt(a.ease, (src - a.at) / (b.at - a.at));
  }
  return ps[ps.length - 1].speed;
}

/** Footage [a, b] of a ramped clip as steps in play order (each at most RAMP_STEP of edit, at its middle's speed). */
export function rampSteps(ramp: RampPoint[], a: number, b: number, reverse = false): { srcIn: number; srcOut: number; speed: number }[] {
  const out: { srcIn: number; srcOut: number; speed: number }[] = [];
  let x = reverse ? b : a;
  for (let guard = 0; guard < 100_000; guard++) {
    const left = reverse ? x - a : b - x;
    if (left <= 1e-9) break;
    const dir = reverse ? -1 : 1;
    let len = Math.min(left, RAMP_STEP * speedAt(ramp, x));
    const mid = speedAt(ramp, x + (dir * len) / 2);
    len = Math.min(left, RAMP_STEP * mid);
    const speed = Math.round(speedAt(ramp, x + (dir * len) / 2) * 1000) / 1000;
    out.push(reverse ? { srcIn: x - len, srcOut: x, speed } : { srcIn: x, srcOut: x + len, speed });
    x += dir * len;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Transitions: centred on the cut, `duration` long. Each side is drawn at an offset (px) with an opacity; a dip lays a
// colour over the picture; zoom scales the picture; whip blurs along its move.
// ---------------------------------------------------------------------------------------------
/** morph (Phase 8): Premiere's Morph Cut for a jump cut in a talking head: the last frame before the window flows into the
 *  first frame after it (motion-compensated in the render; the player shows a dissolve). */
/** flash: an overexposure flash, the picture itself blown out to white with a glow on the cut and back fast (as a
 *  camera flash or a light hit), not a white layer (dip-white). */
export const TRANSITIONS = ["cut", "dissolve", "dip-black", "dip-white", "flash", "whip", "zoom", "slide", "morph", "push", "wipe", "iris", "cross-zoom", "film-dissolve", "clock", "barn-door", "diamond", "box", "cross", "blinds", "checker", "wedge"] as const;
export type TransitionType = (typeof TRANSITIONS)[number];
export const DIRS = ["left", "right", "up", "down"] as const;
export type Dir = (typeof DIRS)[number];
/** face (morph only): false = a plain morph, the face not looked for (by default the face either side of the cut is
 *  found and slid into place). */
export const TransitionSchema = z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.1).max(4), dir: z.enum(DIRS).optional(), face: z.literal(false).optional() });
export type Transition = z.infer<typeof TransitionSchema>;
/** These show both sides at once, so they use footage past the cut (handles). */
export const USES_HANDLES: TransitionType[] = ["dissolve", "whip", "slide", "push", "wipe", "iris", "cross-zoom", "film-dissolve", "clock", "barn-door", "diamond", "box", "cross", "blinds", "checker", "wedge"];
/** Phase 20: Venetian blinds' bands, and the checker wipe's columns and rows (cells the frame's shape). */
export const BLINDS = 8;
export const CHECKER = { cols: 8, rows: 6 } as const;
/**
 * Phase 12: the transitions FFmpeg's xfade draws, by its own names (P runs from 1 at the window's start to 0 at its
 * end in its expressions). push: both sides move; wipe: B uncovered from the side `dir` points away from; iris: B in a
 * circle opening from the middle; cross-zoom: A zooms in as B fades up; film-dissolve: a dissolve in linear light (as
 * film exposes); clock: B swept round like a clock hand; barn-door: B in the middle, opening sideways (up/down: from
 * the middle up and down); diamond: B in a diamond opening from the middle. Phase 20: box (Iris Box), cross (Iris
 * Cross), blinds (Venetian Blinds), checker (Checker Wipe), wedge (Wedge Wipe).
 */
export function xfadeOf(type: TransitionType, dir?: Dir): string | null {
  switch (type) {
    case "push": return `slide${dir ?? "left"}`;
    case "wipe": return `wipe${dir ?? "left"}`;
    case "iris": return "circleopen";
    case "cross-zoom": return "zoomin";
    case "film-dissolve": return "fade";
    // A linear sweep clockwise from 12 o'clock (xfade's own radial lags and eases; this matches the player's).
    case "clock": return "custom:expr='if(lt(mod(atan2(X-W/2,H/2-Y)+2*PI,2*PI),(1-P)*2*PI),B,A)'";
    case "barn-door": return dir === "up" || dir === "down" ? "horzopen" : "vertopen";
    case "diamond": return "custom:expr='if(lt(abs(X/W-0.5)+abs(Y/H-0.5),1-P),B,A)'";
    // Phase 20, Premiere's Iris Box, Iris Cross, Venetian Blinds, Checker Wipe and Wedge Wipe (q = 1-P, 0 to 1).
    case "box": return "custom:expr='if(lt(max(abs(X/W-0.5),abs(Y/H-0.5)),(1-P)/2),B,A)'";
    case "cross": return "custom:expr='if(lt(min(abs(X/W-0.5),abs(Y/H-0.5)),(1-P)/2)*lt(max(abs(X/W-0.5),abs(Y/H-0.5)),1-P),B,A)'";
    // Each band opens from its top (left, right: vertical bands opening from their left).
    case "blinds": return dir === "left" || dir === "right" ? `custom:expr='if(lt(mod(X*${BLINDS}/W,1),1-P),B,A)'` : `custom:expr='if(lt(mod(Y*${BLINDS}/H,1),1-P),B,A)'`;
    // Every other cell first (left to right inside it, over the first half), then the rest (over the second half).
    case "checker": return `custom:expr='if(lt(mod(X*${CHECKER.cols}/W,1),if(mod(floor(X*${CHECKER.cols}/W)+floor(Y*${CHECKER.rows}/H),2),2*(1-P)-1,2*(1-P))),B,A)'`;
    // A wedge from 12 o'clock opening both ways round the middle.
    case "wedge": return "custom:expr='if(lt(abs(atan2(X-W/2,H/2-Y)),(1-P)*PI),B,A)'";
    default: return null;
  }
}
/** Phase 20: whether B shows at pixel centre (x, y) of a W x H frame at progress q, for the shape wipes: the same rule
 *  as their FFmpeg expressions and their CSS in the player (the tests check both against it). */
export function wipeCovers(type: "box" | "cross" | "blinds" | "checker" | "wedge", q: number, x: number, y: number, W: number, H: number, dir?: Dir): boolean {
  const u = Math.abs(x / W - 0.5), v = Math.abs(y / H - 0.5), fr = (n: number) => n - Math.floor(n);
  if (type === "box") return Math.max(u, v) < q / 2;
  if (type === "cross") return Math.min(u, v) < q / 2 && Math.max(u, v) < q;
  if (type === "blinds") return (dir === "left" || dir === "right" ? fr((x * BLINDS) / W) : fr((y * BLINDS) / H)) < q;
  if (type === "checker") { const cx = (x * CHECKER.cols) / W, cy = (y * CHECKER.rows) / H; return fr(cx) < ((Math.floor(cx) + Math.floor(cy)) % 2 ? 2 * q - 1 : 2 * q); }
  return Math.abs(Math.atan2(x - W / 2, H / 2 - y)) < q * Math.PI;
}
/** Phase 20: the checker wipe at progress q as a CSS mask (an SVG of the cells, each filled from its left: every
 *  other cell over the first half, the rest over the second), stretched over the frame. */
export function checkerMask(q: number): string {
  const { cols, rows } = CHECKER, rects: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const f = Math.min(1, Math.max(0, (c + r) % 2 ? 2 * q - 1 : 2 * q));
    if (f > 0) rects.push(`<rect x='${c}' y='${r}' width='${Math.round(f * 1000) / 1000}' height='1'/>`);
  }
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${cols} ${rows}' preserveAspectRatio='none' shape-rendering='crispEdges'>${rects.join("")}</svg>`)}")`;
}
/** How far the zoom transition goes in, and the whip's blur (share of the frame's width or height, at its middle). */
export const ZOOM_PEAK = 1.6;
export const WHIP_BLUR = 0.03;
/** Smoothstep: the slide and whip movement. */
export const smooth = (p: number) => p * p * (3 - 2 * p);
/**
 * The overexposure flash: how blown out the picture is (0 as shot, 1 the peak) at progress p of its window (the cut at
 * 0.5). It builds over the last frames before the cut (to the fourth power) and peaks on the first frame after it, then
 * falls fast and fades out softly: a quick drop and a slow tail, each an exponential, ending at 0. Fitted to a reference
 * flash: at 25 fps and 0.5 s its frames after the cut are as bright as the reference's (about 228, 117, 90, 81, 76 of
 * 255 on a frame of 70).
 */
export function flashLevel(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  if (q < 0.5) return (2 * q) ** 4;
  const g = (u: number) => 0.65 * Math.exp(-u / 0.06) + 0.35 * Math.exp(-u / 0.35);
  return Math.max(0, (g(2 * q - 1) - g(1)) / (g(0) - g(1)));
}
/** The flash at its peak, as FFmpeg's exposure filter takes it on the picture's own values: exposure in stops and the
 *  black level lowered below 0 (its cube: only near the peak), which together map v to (v - black) / (2^-stops -
 *  black): at the peak about 2.1 times v plus 0.74, so the highlights blow out, a dark shirt comes up to a light grey;
 *  and the glow of what goes over white (a Gaussian of this share of the frame's short side, screened over). */
export const FLASH_STOPS = 3, FLASH_LIFT = 0.35, FLASH_GLOW = 0.09;
/** The flash's map at level f: v times gain, plus add (FFmpeg's exposure with exposure FLASH_STOPS f, black -FLASH_LIFT f^3). */
export function flashMap(f: number): { gain: number; add: number } {
  const black = -FLASH_LIFT * f ** 3, gain = 1 / (2 ** (-FLASH_STOPS * f) - black);
  return { gain, add: -black * gain };
}
export const smoothExpr = (p: string) => `(${p})*(${p})*(3-2*(${p}))`;
/** The direction a side moves in, as a unit vector (left: towards the left). */
export const dirVec = (d: Dir = "left"): [number, number] => (d === "left" ? [-1, 0] : d === "right" ? [1, 0] : d === "up" ? [0, -1] : [0, 1]);

export type SideLook = { x: number; y: number; opacity: number };
/** Phase 12: clip: a CSS clip-path for B (wipes, iris, barn door, diamond); mask: a CSS mask for B (clock); aScale: A's
 *  zoom (cross zoom). */
export type TransitionLook = { a: SideLook; b: SideLook; color: { hex: string; opacity: number } | null; zoom: number; blur: { x: number; y: number }; clip?: string; mask?: string; aScale?: number;
  /** The overexposure flash in the player: the picture's brightness multiplied (CSS brightness) under a white layer of
   *  opacity lift (together the render's map, flashMap), and its level (0-1). */
  flash?: { bright: number; lift: number; level: number } };
/** What a transition shows at progress p (0 at the window's start, 1 at its end; the cut is at 0.5). B is drawn over A. */
export function transitionAt(tr: { type: TransitionType; dir?: Dir }, p: number, W: number, H: number): TransitionLook {
  const q = Math.min(1, Math.max(0, p));
  const [dx, dy] = dirVec(tr.dir);
  const still: SideLook = { x: 0, y: 0, opacity: 1 };
  const look: TransitionLook = { a: still, b: still, color: null, zoom: 1, blur: { x: 0, y: 0 } };
  if (tr.type === "dissolve" || tr.type === "morph") look.b = { x: 0, y: 0, opacity: q };
  else if (tr.type === "slide") { const e = 1 - smooth(q); look.b = { x: -dx * W * e, y: -dy * H * e, opacity: 1 }; }
  else if (tr.type === "whip") {
    const e = smooth(q);
    look.a = { x: dx * W * e, y: dy * H * e, opacity: 1 };
    look.b = { x: dx * W * e - dx * W, y: dy * H * e - dy * H, opacity: 1 };
    const s = Math.sin(Math.PI * q);
    look.blur = { x: dx ? W * WHIP_BLUR * s : 0, y: dy ? H * WHIP_BLUR * s : 0 };
  } else if (tr.type === "dip-black" || tr.type === "dip-white") look.color = { hex: tr.type === "dip-black" ? "#000000" : "#FFFFFF", opacity: q < 0.5 ? 2 * q : 2 * (1 - q) };
  else if (tr.type === "flash") {
    // As the render maps it (v * gain + add): CSS brightness under a white layer of opacity lift gives v * bright * (1 -
    // lift) + lift, so bright = gain / (1 - add) and lift = add.
    const f = flashLevel(q), m = flashMap(f), lift = Math.min(0.95, m.add);
    look.flash = { bright: m.gain / (1 - lift), lift, level: f };
  }
  else if (tr.type === "zoom") look.zoom = 1 + (ZOOM_PEAK - 1) * (q < 0.5 ? (2 * q) ** 2 : (2 - 2 * q) ** 2);
  else if (tr.type === "push") { look.a = { x: dx * W * q, y: dy * H * q, opacity: 1 }; look.b = { x: dx * W * (q - 1), y: dy * H * (q - 1), opacity: 1 }; }
  else if (tr.type === "film-dissolve") look.b = { x: 0, y: 0, opacity: q };
  else if (tr.type === "cross-zoom") { look.aScale = 1 + q; look.a = { x: 0, y: 0, opacity: 1 }; look.b = { x: 0, y: 0, opacity: q }; }
  else {
    const r = Math.round((1 - q) * 1000) / 10, h = Math.round((1 - q) * 500) / 10, k = Math.round(q * 1000) / 10;
    if (tr.type === "wipe") look.clip = tr.dir === "right" ? `inset(0 ${r}% 0 0)` : tr.dir === "up" ? `inset(${r}% 0 0 0)` : tr.dir === "down" ? `inset(0 0 ${r}% 0)` : `inset(0 0 0 ${r}%)`;
    else if (tr.type === "iris") look.clip = `circle(${Math.round(q * 710) / 10}% at 50% 50%)`;
    else if (tr.type === "barn-door") look.clip = tr.dir === "up" || tr.dir === "down" ? `inset(${h}% 0 ${h}% 0)` : `inset(0 ${h}% 0 ${h}%)`;
    else if (tr.type === "diamond") look.clip = `polygon(50% ${50 - k}%, ${50 + k}% 50%, 50% ${50 + k}%, ${50 - k}% 50%)`;
    else if (tr.type === "clock") look.mask = `conic-gradient(#000 ${Math.round(q * 3600) / 10}deg, transparent 0)`;
    // Phase 20: the same shapes as the render's expressions.
    else if (tr.type === "box") look.clip = `inset(${h}% ${h}% ${h}% ${h}%)`;
    else if (tr.type === "cross") {
      const a = 50 - q * 50, b = 50 + q * 50, c = 50 - q * 100, d = 50 + q * 100, f = (v: number) => Math.round(v * 10) / 10;
      look.clip = `polygon(${[[a, c], [b, c], [b, a], [d, a], [d, b], [b, b], [b, d], [a, d], [a, b], [c, b], [c, a], [a, a]].map(([x, y]) => `${f(x)}% ${f(y)}%`).join(", ")})`;
    } else if (tr.type === "blinds") {
      const band = 100 / BLINDS, open = Math.round(q * band * 100) / 100;
      look.mask = `repeating-linear-gradient(${tr.dir === "left" || tr.dir === "right" ? "to right" : "to bottom"}, #000 0 ${open}%, transparent ${open}% ${band}%)`;
    } else if (tr.type === "checker") look.mask = checkerMask(q);
    else if (tr.type === "wedge") { const deg = Math.round(q * 1800) / 10; look.mask = `conic-gradient(from ${-deg}deg at 50% 50%, #000 0 ${2 * deg}deg, transparent 0)`; }
  }
  return look;
}
