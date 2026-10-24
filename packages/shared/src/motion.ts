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
export const RampPointSchema = z.object({ at: z.number().finite().min(0).max(24 * 3600), speed: z.number().min(0.1).max(10) });
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
    if (src <= b.at) return b.at - a.at < 1e-9 ? b.speed : a.speed + ((b.speed - a.speed) * (src - a.at)) / (b.at - a.at);
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
export const TRANSITIONS = ["cut", "dissolve", "dip-black", "dip-white", "whip", "zoom", "slide"] as const;
export type TransitionType = (typeof TRANSITIONS)[number];
export const DIRS = ["left", "right", "up", "down"] as const;
export type Dir = (typeof DIRS)[number];
export const TransitionSchema = z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.1).max(4), dir: z.enum(DIRS).optional() });
export type Transition = z.infer<typeof TransitionSchema>;
/** These show both sides at once, so they use footage past the cut (handles). */
export const USES_HANDLES: TransitionType[] = ["dissolve", "whip", "slide"];
/** How far the zoom transition goes in, and the whip's blur (share of the frame's width or height, at its middle). */
export const ZOOM_PEAK = 1.6;
export const WHIP_BLUR = 0.03;
/** Smoothstep: the slide and whip movement. */
export const smooth = (p: number) => p * p * (3 - 2 * p);
export const smoothExpr = (p: string) => `(${p})*(${p})*(3-2*(${p}))`;
/** The direction a side moves in, as a unit vector (left: towards the left). */
export const dirVec = (d: Dir = "left"): [number, number] => (d === "left" ? [-1, 0] : d === "right" ? [1, 0] : d === "up" ? [0, -1] : [0, 1]);

export type SideLook = { x: number; y: number; opacity: number };
export type TransitionLook = { a: SideLook; b: SideLook; color: { hex: string; opacity: number } | null; zoom: number; blur: { x: number; y: number } };
/** What a transition shows at progress p (0 at the window's start, 1 at its end; the cut is at 0.5). B is drawn over A. */
export function transitionAt(tr: { type: TransitionType; dir?: Dir }, p: number, W: number, H: number): TransitionLook {
  const q = Math.min(1, Math.max(0, p));
  const [dx, dy] = dirVec(tr.dir);
  const still: SideLook = { x: 0, y: 0, opacity: 1 };
  const look: TransitionLook = { a: still, b: still, color: null, zoom: 1, blur: { x: 0, y: 0 } };
  if (tr.type === "dissolve") look.b = { x: 0, y: 0, opacity: q };
  else if (tr.type === "slide") { const e = 1 - smooth(q); look.b = { x: -dx * W * e, y: -dy * H * e, opacity: 1 }; }
  else if (tr.type === "whip") {
    const e = smooth(q);
    look.a = { x: dx * W * e, y: dy * H * e, opacity: 1 };
    look.b = { x: dx * W * e - dx * W, y: dy * H * e - dy * H, opacity: 1 };
    const s = Math.sin(Math.PI * q);
    look.blur = { x: dx ? W * WHIP_BLUR * s : 0, y: dy ? H * WHIP_BLUR * s : 0 };
  } else if (tr.type === "dip-black" || tr.type === "dip-white") look.color = { hex: tr.type === "dip-black" ? "#000000" : "#FFFFFF", opacity: q < 0.5 ? 2 * q : 2 * (1 - q) };
  else if (tr.type === "zoom") look.zoom = 1 + (ZOOM_PEAK - 1) * (q < 0.5 ? (2 * q) ** 2 : (2 - 2 * q) ** 2);
  return look;
}
