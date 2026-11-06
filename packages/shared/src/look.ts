// Phase 6: colour and compositing. The numbers the render (FFmpeg) and the editor's player (WebGL) both use:
//   grade    one 3D LUT (33 points a side) built here: white balance and exposure in linear light, contrast,
//            saturation, curves, an imported LUT. FFmpeg reads it as a .cube file (lut3d, trilinear); the player
//            uploads the same numbers as a 3D texture (trilinear).
//   masks    one greyscale picture at the output size (signed distance to each shape's edge, feathered), drawn
//            here; FFmpeg reads it as a PGM file, the player as a texture.
//   key      FFmpeg's colorkey and despill formulas, which the player's shader repeats.
//   match    shot matching from measured pixels: three-point curves per channel and a saturation ratio.
import { z } from "zod";
import { matteTimeoutMs, PREFIX } from "./constants";

const unit = z.number().min(0).max(1);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #00FF00");

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------
/** A curve: points [in, out] (0-1), sorted by `in`. Without a point at 0 or 1 the curve starts at (0,0) / ends at (1,1). */
export const CurveSchema = z.array(z.tuple([unit, unit])).min(1).max(16);
export type Curve = [number, number][];
export const CURVE_CHANNELS = ["master", "r", "g", "b"] as const;
export const CurvesSchema = z.object({ master: CurveSchema.optional(), r: CurveSchema.optional(), g: CurveSchema.optional(), b: CurveSchema.optional() });
export type Curves = z.infer<typeof CurvesSchema>;
/** An imported LUT: its id, how much of it (0-1), input: applied first (a technical LUT for log footage), else last (a look). */
export const LutRefSchema = z.object({ id: z.string().min(1).max(80), amount: unit.optional(), input: z.boolean().optional() });
export type LutRef = z.infer<typeof LutRefSchema>;
/** What set_grade's lut takes: an imported LUT by id or name, or the .cube file's own text (the server imports it
 *  first, so an AI can apply a LUT from its workspace in the same call). Only the id is kept in the grade. */
export const LutInputSchema = z.object({
  id: z.string().min(1).max(80).optional(), name: z.string().trim().min(1).max(120).optional(), cube: z.string().min(10).max(20 * 1024 * 1024).optional(),
  amount: unit.optional(), input: z.boolean().optional(),
}).refine((l) => !!(l.id || l.name || l.cube), "lut needs its id, its name, or the .cube text (cube)");
export type LutInput = z.infer<typeof LutInputSchema>;
/**
 * A clip's grade. exposure: stops (+1 = twice the light); contrast -100..100 (0 = as is); temperature -100 (cooler,
 * blue) .. 100 (warmer, orange); tint -100 (green) .. 100 (magenta); saturation % (100 = as is, 0 = grey).
 */
const signed = z.number().min(-100).max(100);
/** Phase 5: a colour wheel (Lumetri's shadows, midtones, highlights): a push towards a hue (degrees) by amount 0-100,
 *  and that range's brightness (luma -100..100). */
export const WheelSchema = z.object({ hue: z.number().min(0).max(360).optional(), amount: z.number().min(0).max(100).optional(), luma: signed.optional() });
export type Wheel = z.infer<typeof WheelSchema>;
export const WHEELS = ["shadows", "midtones", "highlights"] as const;
export const WheelsSchema = z.object({ shadows: WheelSchema.optional(), midtones: WheelSchema.optional(), highlights: WheelSchema.optional() });
/** Phase 5: an HSL secondary: the colours near a hue (fully within range/2 degrees, fading out by range), at least satMin
 *  saturated (0-1), changed: hue turned by hueShift degrees, saturation to saturation % of itself, lightness -100..100. */
export const HslSchema = z.object({ hue: z.number().min(0).max(360), range: z.number().min(4).max(180).optional(), satMin: unit.optional(), hueShift: z.number().min(-180).max(180).optional(), saturation: z.number().min(0).max(300).optional(), lightness: signed.optional() });
export type Hsl = z.infer<typeof HslSchema>;
export const GradeSchema = z.object({
  exposure: z.number().min(-4).max(4).optional(),
  contrast: z.number().min(-100).max(100).optional(),
  temperature: z.number().min(-100).max(100).optional(),
  tint: z.number().min(-100).max(100).optional(),
  saturation: z.number().min(0).max(200).optional(),
  /** Phase 5 (Lumetri's Basic tone): highlights, shadows, whites, blacks -100..100; vibrance -100..100 (saturation that
   *  spares colours already strong). */
  highlights: signed.optional(),
  shadows: signed.optional(),
  whites: signed.optional(),
  blacks: signed.optional(),
  vibrance: signed.optional(),
  wheels: WheelsSchema.optional(),
  hsl: z.array(HslSchema).max(4).optional(),
  /** Phase 5: Hue vs Sat: points [hue 0-1, saturation 0-1 where 0.5 leaves it], round the hue circle. */
  hueSat: CurveSchema.optional(),
  /** Phase 14: Hue vs Hue: points [hue 0-1, shift 0-1 where 0.5 leaves it; 0 = -180°, 1 = +180°] round the hue circle
   *  (greys keep theirs). Luma vs Sat: points [luma 0-1, saturation 0-1 where 0.5 leaves it] (0.25 = half). */
  hueHue: CurveSchema.optional(),
  lumaSat: CurveSchema.optional(),
  curves: CurvesSchema.optional(),
  lut: LutRefSchema.optional(),
});
export type Grade = z.infer<typeof GradeSchema>;
/** set_grade's fields as a change: a value sets it, null removes it; wheels merge by wheel and field, curves by
 *  channel; hsl replaces (empty or null removes). */
export type GradePatch = { [K in keyof Grade]?: unknown };
export function mergeGrade(base: Grade, patch: GradePatch): Grade {
  const g: Grade = { ...base }, p = patch as Record<string, unknown>;
  for (const f of ["exposure", "contrast", "temperature", "tint", "saturation", "lut", "highlights", "shadows", "whites", "blacks", "vibrance", "hueSat", "hueHue", "lumaSat"] as const) {
    const v = p[f];
    if (v === null) delete g[f]; else if (v !== undefined) (g as Record<string, unknown>)[f] = v;
  }
  if (p.wheels === null) delete g.wheels;
  else if (p.wheels) {
    const w = { ...(g.wheels ?? {}) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(p.wheels as Record<string, unknown>)) { if (v === null) delete w[k]; else if (v) w[k] = { ...((w[k] as object) ?? {}), ...(v as object) }; }
    if (Object.keys(w).length) g.wheels = w as Grade["wheels"]; else delete g.wheels;
  }
  const hsl = p.hsl as Grade["hsl"] | null | undefined;
  if (hsl === null || hsl?.length === 0) delete g.hsl; else if (hsl) g.hsl = hsl;
  if (p.curves === null) delete g.curves;
  else if (p.curves) {
    const cv = { ...(g.curves ?? {}) } as Record<string, unknown>;
    for (const [ch, pts] of Object.entries(p.curves as Record<string, [number, number][] | null>)) { if (pts === null) delete cv[ch]; else if (pts) cv[ch] = [...pts].sort((a, b) => a[0] - b[0]); }
    g.curves = cv as Grade["curves"];
  }
  return g;
}

/** Chroma key: the colour to remove, how close a colour must be to go (similarity 0-1, RGB distance), how soft the
 *  edge is (blend 0-1), and how much of the key colour's spill is taken off what stays (spill 0-1). */
export const ChromaKeySchema = z.object({ color: hex, similarity: z.number().min(0.01).max(1), blend: unit, spill: unit });
export type ChromaKey = z.infer<typeof ChromaKeySchema>;
export const KEY_DEFAULTS: Omit<ChromaKey, "color"> = { similarity: 0.25, blend: 0.1, spill: 0.5 };

export const SHAPES = ["rect", "ellipse", "path"] as const;
export const MASK_MODES = ["add", "subtract", "intersect"] as const;
const coord = z.number().min(-1).max(2);
/**
 * Phase 3: a rect's or an ellipse's box at a moment of its clip (`at`: the clip's own footage seconds). Between keys
 * the box moves in a straight line; before the first and after the last it stays.
 */
export const AreaKeySchema = z.object({ at: z.number().min(0).max(24 * 3600), x: coord, y: coord, w: z.number().min(0.001).max(3), h: z.number().min(0.001).max(3) });
export type AreaKey = z.infer<typeof AreaKeySchema>;
export const MAX_AREA_KEYS = 3000;
/**
 * Mask path keyframes: a path's shape at a moment of its clip (`at`, as AreaKey). Between keys every point moves in a
 * straight line to its place in the next shape (shapes of different point counts are first spaced out to the same
 * count along their outline); before the first key and after the last the shape stays.
 */
export const PathKeySchema = z.object({ at: z.number().min(0).max(24 * 3600), points: z.array(z.tuple([coord, coord])).min(3).max(64) });
export type PathKey = z.infer<typeof PathKeySchema>;
export const MAX_PATH_KEYS = 600;
/**
 * A shape on the clip's picture, in shares of the frame (0,0 top left; 1,1 bottom right), before framing and
 * keyframes move the clip: rect and ellipse by their box (x, y = top left, w, h), path by its points (a polygon).
 * feather: soft edge as a share of the frame's short side; invert: the outside instead.
 */
export const AreaSchema = z.object({
  shape: z.enum(SHAPES),
  x: coord.optional(), y: coord.optional(), w: z.number().min(0.001).max(3).optional(), h: z.number().min(0.001).max(3).optional(),
  points: z.array(z.tuple([coord, coord])).min(3).max(64).optional(),
  feather: z.number().min(0).max(0.5).optional(),
  invert: z.boolean().optional(),
  /** rect: rounded corners, as a share of the box's shorter side (0.5 = round ends). */
  radius: z.number().min(0).max(0.5).optional(),
  /** Phase 3: the box over time (a moving rect or ellipse). follow "face": Rendrr made the keys from the speaker's face,
   *  measured over the clip (the box keeps its place and size against the face). */
  keys: z.array(AreaKeySchema).max(MAX_AREA_KEYS).optional(),
  follow: z.enum(["face", "object"]).optional(),
  /** Object tracking: the tracked object (its id on the same clip) a shape with follow "object" follows. */
  object: z.string().max(40).optional(),
  /** Mask path keyframes: a path's shape over time (its points at each key). */
  pathKeys: z.array(PathKeySchema).max(MAX_PATH_KEYS).optional(),
}).superRefine((a, ctx) => {
  if (a.shape === "path" && (a.keys?.length || a.follow)) ctx.addIssue({ code: "custom", message: "keys and follow move a rect or an ellipse; a path changes shape with pathKeys" });
  if (a.shape !== "path" && a.pathKeys?.length) ctx.addIssue({ code: "custom", message: "pathKeys change a path's shape; a rect or an ellipse moves with keys" });
  if (a.follow === "object" && !a.object) ctx.addIssue({ code: "custom", message: "follow \"object\" needs object: a tracked object's id on the clip (track_object)" });
  if (a.shape === "path" && !a.points && !a.pathKeys?.length) ctx.addIssue({ code: "custom", message: "a path needs points (at least 3), or pathKeys" });
  // A shape that follows the face or an object may leave its box out: an ellipse round the face, a box round the object.
  if (a.shape !== "path" && a.follow !== "face" && a.follow !== "object" && (a.x == null || a.y == null || a.w == null || a.h == null)) ctx.addIssue({ code: "custom", message: `a ${a.shape} needs x, y, w and h` });
});
export type Area = z.infer<typeof AreaSchema>;
/** A mask: the clip shows only inside its masks. add: joins the masks before it; subtract: cuts it out; intersect: keeps
 *  only the overlap. */
export const MaskSchema = AreaSchema.and(z.object({ mode: z.enum(MASK_MODES).optional() }));
export type Mask = Area & { mode?: (typeof MASK_MODES)[number] };
export const EFFECTS = ["blur", "pixelate", "sharpen", "darken", "vignette", "glow", "grain", "rgbsplit", "shake", "mirror", "pin"] as const;
/** Phase 12: the effects drawn in the render only (the player shows the clip without them). Phase 19: glow, grain, RGB
 *  split, shake and mirror are drawn in the player too; only the corner pin is left. */
export const RENDER_ONLY_EFFECTS = ["pin"] as const;
/** Phase 5: a vignette is darken outside a soft ellipse a little larger than the frame (its own area if it has one). */
export const VIGNETTE_AREA = { shape: "ellipse" as const, x: -0.1, y: -0.1, w: 1.2, h: 1.2, invert: true, feather: 0.3 };
/** Blur (amount 1-100: 100 = a Gaussian of 5% of the short side), pixelate (amount 1-100: blocks of amount/10 % of the
 *  short side), sharpen (an unsharp mask, amount 1-100: 100 adds twice the detail, 20 is a light touch) or darken
 *  (Phase 3: amount % darker, 100 = black; outside an ellipse on the face it is a spotlight), over the whole picture or
 *  inside an area. */
/** Phase 12: glow (the bright parts bloom: amount = strength), grain (film grain), rgbsplit (red and blue pulled apart:
 *  chromatic aberration), shake (a hand-held camera's jitter), mirror (the left half reflected onto the right), pin
 *  (corner pin: the picture's corners moved to `corners`, shares of the frame, top left, top right, bottom left,
 *  bottom right; outside them what is under the clip shows). */
export const EffectSchema = z.object({ type: z.enum(EFFECTS), amount: z.number().min(1).max(100), area: AreaSchema.optional(), corners: z.array(z.tuple([z.number().min(-1).max(2), z.number().min(-1).max(2)])).length(4).optional() });
export type Effect = z.infer<typeof EffectSchema>;

const share100 = z.number().min(0).max(100);
/**
 * Skin retouch on a clip's skin (found by its colour, inside `area` when set; Rendrr sets the face's area from the faces
 * it measured): smooth (pores and fine texture, edges kept), blemishes (small dark spots and marks, filled from the
 * skin around them), even (blotchy colour evened out; lips keep theirs), brighten (lifts the skin's mid-tones). Each
 * 0-100. The skin's own tone is kept: nothing lightens or darkens it except brighten.
 */
export const SkinSchema = z.object({ smooth: share100, blemishes: share100, even: share100, brighten: share100, area: AreaSchema.optional(), face: z.boolean().optional() });
export type Skin = z.infer<typeof SkinSchema>;
/** The skin's area around a face box Rendrr measured: as wide as 1.6 faces, 1.9 tall, its middle a fifth of a face
 *  lower (cheeks and ears, forehead to neck). */
export const FACE_AREA = { w: 1.6, h: 1.9, down: 0.2, feather: 0.04 } as const;
/** The skin's area (an ellipse, feathered) around a face's box on screen ([x0, y0, x1, y1], shares of the frame). */
export function faceSkinArea(b: [number, number, number, number]): Area {
  const w = b[2] - b[0], h = b[3] - b[1], cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2 + FACE_AREA.down * h, aw = w * FACE_AREA.w, ah = h * FACE_AREA.h;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return { shape: "ellipse", x: r4(cx - aw / 2), y: r4(cy - ah / 2), w: r4(aw), h: r4(ah), feather: FACE_AREA.feather };
}
/** Phase 3: a clip's face measured over it, as the render places it: [footage second, x0, y0, x1, y1] (shares of the frame). */
export type FaceTrack = [number, number, number, number, number][];
export const FaceTracksSchema = z.record(z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).max(200_000).nullable());
/** Phase 3: an area moves when it has keys at two or more moments. */
export const moving = (a: Area | undefined): boolean => (!!a?.keys && a.keys.length > 1 && a.keys.some((k) => k.at !== a.keys![0].at)) || (!!a?.pathKeys && a.pathKeys.length > 1 && a.pathKeys.some((k) => k.at !== a.pathKeys![0].at));
/** A path's shape keys in time order (one per moment), its points the first key's when it was sent without its own. */
export function normalizePath<A extends Area>(a: A): A {
  if (a.shape !== "path" || !a.pathKeys?.length) return a;
  const ks = [...a.pathKeys].sort((p, q) => p.at - q.at).filter((k, i, arr) => i === arr.length - 1 || arr[i + 1].at - k.at > 1e-6);
  // One key (a shape redrawn at one moment): that key's shape is the path's, whatever it was before.
  return { ...a, points: ks.length === 1 ? ks[0].points : a.points ?? ks[0].points, pathKeys: ks };
}
/** When a moving area's keys start (its first key's moment). */
/** A path's points as drawn when it does not move: its points, else its first key's (never undefined). */
export const pathPoints = (a: Area): [number, number][] => (a.points ?? a.pathKeys?.[0]?.points ?? []) as [number, number][];
export const firstKeyAt = (a: Area): number => (a.pathKeys?.length ? a.pathKeys[0].at : a.keys?.[0]?.at ?? 0);
type Pt = [number, number];
/**
 * A closed outline spaced out to n points along its length, starting at its first point (so a shape drawn again with
 * more or fewer points morphs into the other without turning). Exact for n = its own count.
 */
export function resamplePath(points: Pt[], n: number): Pt[] {
  if (points.length === n) return points.map((p) => [p[0], p[1]] as Pt);
  const seg = points.map((p, i) => { const q = points[(i + 1) % points.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
  const total = seg.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return Array.from({ length: n }, () => [points[0][0], points[0][1]] as Pt);
  const out: Pt[] = [];
  let i = 0, run = 0;
  for (let k = 0; k < n; k++) {
    const want = (k / n) * total;
    while (i < seg.length - 1 && run + seg[i] < want - 1e-12) { run += seg[i]; i++; }
    const p = points[i], q = points[(i + 1) % points.length], u = seg[i] > 0 ? Math.min(1, Math.max(0, (want - run) / seg[i])) : 0;
    out.push([Math.round((p[0] + (q[0] - p[0]) * u) * 10000) / 10000, Math.round((p[1] + (q[1] - p[1]) * u) * 10000) / 10000]);
  }
  return out;
}
/** A path's shape at t from its pathKeys (straight between keys, matched point for point). */
function pathAt(pk: PathKey[], t: number): Pt[] {
  if (t <= pk[0].at) return pk[0].points as Pt[];
  const j = pk.findIndex((x) => x.at >= t);
  if (j < 0) return pk[pk.length - 1].points as Pt[];
  const p = pk[j - 1], q = pk[j], u = q.at > p.at ? (t - p.at) / (q.at - p.at) : 1;
  const n = Math.max(p.points.length, q.points.length), a = resamplePath(p.points as Pt[], n), b = resamplePath(q.points as Pt[], n);
  return a.map((x, k) => [x[0] + (b[k][0] - x[0]) * u, x[1] + (b[k][1] - x[1]) * u] as Pt);
}
/** Phase 3: the area at `t` (the clip's footage seconds): its box from its keys (a straight line between them). */
export function areaAt<A extends Area>(a: A, t: number): A {
  if (a.shape === "path" && a.pathKeys?.length) return { ...a, points: pathAt(a.pathKeys, t) };
  const ks = a.keys;
  if (!ks?.length) return a;
  let k = ks[0];
  if (t > ks[0].at) {
    const j = ks.findIndex((x) => x.at >= t);
    if (j < 0) k = ks[ks.length - 1];
    else {
      const p = ks[j - 1], q = ks[j], u = q.at > p.at ? (t - p.at) / (q.at - p.at) : 1;
      k = { at: t, x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, w: p.w + (q.w - p.w) * u, h: p.h + (q.h - p.h) * u };
    }
  }
  return { ...a, x: k.x, y: k.y, w: k.w, h: k.h };
}
/**
 * Phase 3: keys for an area that follows the face, from the face's box on screen over the clip ([at, x0, y0, x1, y1],
 * shares of the frame). With its own box, the area keeps its place and size against the face where the face is first
 * seen; without one it is an ellipse round the face (forehead to neck). Keys a little apart where the face is still
 * (a key is kept where the box would be off by more than 0.4% of the frame without it), at most MAX_AREA_KEYS.
 */
export function followFace(a: Area, track: FaceTrack): Area {
  if (!track.length) return a;
  const [, fx0, fy0, fx1, fy1] = track[0], fw = fx1 - fx0, fh = fy1 - fy0;
  const own = a.shape !== "path" && a.x != null && a.y != null && a.w != null && a.h != null;
  const rel = own ? { x: (a.x! - fx0) / fw, y: (a.y! - fy0) / fh, w: a.w! / fw, h: a.h! / fh } : null;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const all: AreaKey[] = track.map(([at, x0, y0, x1, y1]) => {
    const w = x1 - x0, h = y1 - y0;
    if (rel) return { at, x: r4(x0 + rel.x * w), y: r4(y0 + rel.y * h), w: r4(rel.w * w), h: r4(rel.h * h) };
    const f = faceSkinArea([x0, y0, x1, y1]);
    return { at, x: f.x!, y: f.y!, w: f.w!, h: f.h! };
  });
  const keys = simplifyKeys(all, 0.004);
  const first = keys[0];
  return { ...a, shape: a.shape === "path" ? "ellipse" : a.shape, x: first.x, y: first.y, w: first.w, h: first.h, ...(own ? {} : { feather: a.feather ?? FACE_AREA.feather }), keys, follow: "face" };
}
/**
 * Object tracking: an object on a clip, followed by Rendrr from the box drawn at `at` (the clip's footage second, on
 * its fitted frame, shares): track holds its box every 0.1 s where it was found ([footage second, x0, y0, x1, y1]);
 * lost: where it was not (covered, out of frame, blurred) and what follows it holds still.
 */
export const TrackedObjectSchema = z.object({
  id: z.string().min(1).max(40), label: z.string().max(60).optional(), at: z.number().min(0).max(24 * 3600),
  box: z.object({ x: coord, y: coord, w: z.number().min(0.005).max(3), h: z.number().min(0.005).max(3) }),
  track: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).max(40_000),
  lost: z.array(z.tuple([z.number(), z.number()])).max(500).optional(),
});
export type TrackedObject = z.infer<typeof TrackedObjectSchema>;
/** The tracker's rows ([second, x0, y0, x1, y1, confidence]) as an object's track: the confident boxes, lightly smoothed
 *  over three samples, and the stretches where it was lost. */
export function objectTrack(rows: [number, number, number, number, number, number][], minConf = 0.35): { track: FaceTrack; lost: [number, number][] } {
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const ok = rows.filter((r) => r[5] >= minConf);
  // Smoothed only between two neighbours (a one-sided average would pull a moving box back at the ends and at gaps).
  const near = (q: (typeof ok)[number] | undefined, p: (typeof ok)[number]) => !!q && Math.abs(q[0] - p[0]) < 0.25;
  const track: FaceTrack = ok.map((p, i) => { const n = near(ok[i - 1], p) && near(ok[i + 1], p) ? [ok[i - 1], p, ok[i + 1]] : [p]; return [p[0], ...[1, 2, 3, 4].map((k) => r4(n.reduce((a, q) => a + q[k], 0) / n.length))] as FaceTrack[number]; });
  const lost: [number, number][] = [];
  let from: number | null = null;
  for (const r of rows) {
    if (r[5] < minConf) { if (from == null) from = r[0]; }
    else if (from != null) { lost.push([from, r[0]]); from = null; }
  }
  if (from != null && rows.length) lost.push([from, rows[rows.length - 1][0]]);
  return { track, lost };
}
/**
 * A shape that follows a tracked object: it keeps its place and size against the object's box as it was where the
 * object was drawn (`at`); without its own box it is a box round the object. Keys where the object was found.
 * prev: the object as it was tracked before (tracked again): the shape keeps its place against that one.
 */
export function followObject(a: Area, obj: TrackedObject, prev?: TrackedObject): Area {
  const tr = obj.track;
  if (!tr.length) return a;
  const basis = prev?.track.length ? prev : obj;
  const [fx0, fy0, fx1, fy1] = objectBoxAt(basis, basis.at)!, fw = Math.max(1e-4, fx1 - fx0), fh = Math.max(1e-4, fy1 - fy0);
  // A shape that already moves: where it is at that moment.
  const cur = a.keys?.length ? areaAt(a, basis.at) : a;
  const own = cur.shape !== "path" && cur.x != null && cur.y != null && cur.w != null && cur.h != null;
  const rel = own ? { x: (cur.x! - fx0) / fw, y: (cur.y! - fy0) / fh, w: cur.w! / fw, h: cur.h! / fh } : { x: -0.05, y: -0.05, w: 1.1, h: 1.1 };
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const keys = simplifyKeys(tr.map(([at, x0, y0, x1, y1]) => { const w = x1 - x0, h = y1 - y0; return { at, x: r4(x0 + rel.x * w), y: r4(y0 + rel.y * h), w: r4(rel.w * w), h: r4(rel.h * h) }; }), 0.003);
  const near = keys.reduce((b, k) => (Math.abs(k.at - obj.at) < Math.abs(b.at - obj.at) ? k : b), keys[0]);
  return { ...a, shape: a.shape === "path" ? "rect" : a.shape, x: near.x, y: near.y, w: near.w, h: near.h, keys, follow: "object", object: obj.id };
}
/** An object's box at footage second t (straight between its samples; held before, after and through a gap). */
export function objectBoxAt(obj: TrackedObject, t: number): [number, number, number, number] | null {
  const tr = obj.track;
  if (!tr.length) return null;
  if (t <= tr[0][0]) return [tr[0][1], tr[0][2], tr[0][3], tr[0][4]];
  const j = tr.findIndex((p) => p[0] >= t);
  if (j < 0) { const q = tr[tr.length - 1]; return [q[1], q[2], q[3], q[4]]; }
  const p = tr[j - 1], q = tr[j], u = q[0] > p[0] ? (t - p[0]) / (q[0] - p[0]) : 1;
  return [1, 2, 3, 4].map((k) => p[k] + (q[k] - p[k]) * u) as [number, number, number, number];
}
/** Keys left out where a straight line between their neighbours is within `tol` of them (Douglas-Peucker on the box). */
export function simplifyKeys(ks: AreaKey[], tol: number): AreaKey[] {
  if (ks.length <= 2) return ks;
  const keep = new Uint8Array(ks.length); keep[0] = keep[ks.length - 1] = 1;
  const off = (a: AreaKey, b: AreaKey, m: AreaKey) => { const u = b.at > a.at ? (m.at - a.at) / (b.at - a.at) : 0; return Math.max(...(["x", "y", "w", "h"] as const).map((p) => Math.abs(a[p] + (b[p] - a[p]) * u - m[p]))); };
  const stack: [number, number][] = [[0, ks.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1, far = tol;
    for (let k = i + 1; k < j; k++) { const d = off(ks[i], ks[j], ks[k]); if (d > far) { far = d; best = k; } }
    if (best >= 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  let out = ks.filter((_, i) => keep[i]);
  // Over the limit: every other key left out until it fits (first and last kept).
  while (out.length > MAX_AREA_KEYS) out = out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
  return out;
}
/** A natural retouch: what retouch_skin sets when it is sent without values. */
export const SKIN_DEFAULTS = { smooth: 35, blemishes: 40, even: 35, brighten: 0 } as const;
export const skinActive = (s: Skin | undefined) => !!s && (s.smooth > 0 || s.blemishes > 0 || s.even > 0 || s.brighten > 0);

/**
 * remove_background: the person in a clip kept and everything around them made transparent, from a matte Rendrr makes
 * of the footage with an AI model (MediaPipe's selfie segmenter: people, not objects). What shows instead is what is
 * behind V1: set_background, or b-roll laid behind with set_under. edge: the matte's edge moved out (+) or in (-), in
 * pixels at 1080p; soft: its feather, 0-100; invert: the person removed, the background kept.
 */
export const SubjectSchema = z.object({ edge: z.number().min(-20).max(20), soft: share100, invert: z.boolean().optional() });
export type Subject = z.infer<typeof SubjectSchema>;
export const SUBJECT_DEFAULTS = { edge: 0, soft: 20 } as const;
export const subjectText = (s: Subject) => `background removed${s.invert ? " (inverted: the person removed)" : ""}${s.edge ? `, edge ${s.edge > 0 ? "+" : ""}${s.edge}` : ""}${s.soft !== SUBJECT_DEFAULTS.soft ? `, soft ${s.soft}` : ""}`;
/**
 * The matte is made in blocks of footage (MATTE_BLOCK seconds from the video's start), each once per video and kept:
 * a clip trimmed or moved reuses the blocks it already had. MATTE_VERSION changes when the matte does.
 */
export const MATTE_BLOCK = 10;
export const MATTE_VERSION = 2;
/** Where a block of a video's matte is kept (with the video's frames, deleted with it), and the job that makes it.
 *  turn: the turn that makes the footage's people upright (the model sees them upright). */
export const matteKey = (userId: string, videoId: string, turn: number, k: number) => `${PREFIX.frames}${userId}/${videoId}/matte-v${MATTE_VERSION}-t${turn}-${k}.mp4`;
export const matteJobId = (videoId: string, turn: number, k: number) => `matte-${videoId}-t${turn}-${k}`;
/** The blocks footage srcIn..srcOut needs, with `margin` seconds each side (transitions show footage past a cut). */
export function matteBlocks(srcIn: number, srcOut: number, seconds = Infinity, margin = 2): number[] {
  const last = Math.max(0, Math.ceil(Math.min(seconds, srcOut + margin) / MATTE_BLOCK) - 1);
  const k0 = Math.min(last, Math.floor(Math.max(0, srcIn - margin) / MATTE_BLOCK));
  return Array.from({ length: last - k0 + 1 }, (_, i) => k0 + i);
}

/**
 * The extra time a render of this timeline may spend making its mattes (every block of every V1 clip with
 * remove_background, two at once, as if none were made yet): added to the render's own limits, which only count the
 * render's work. 0 with no remove_background.
 */
export function matteAllowanceMs(timeline: unknown): number {
  const tracks = (timeline as { tracks?: { v1?: unknown; v3?: unknown } } | null)?.tracks;
  const v1 = (tracks?.v1 ?? []) as { sourceVideoId?: string; sourceIn?: number; sourceOut?: number; subject?: unknown }[];
  // Phase 2: a layer behind the person needs the matte of the clips under it: every V1 clip is counted (only a limit).
  const behind = Array.isArray(tracks?.v3) && (tracks!.v3 as { behind?: boolean }[]).some((c) => c?.behind);
  const blocks = new Set<string>();
  for (const c of Array.isArray(v1) ? v1 : []) if (c?.subject || behind) for (const k of matteBlocks(c.sourceIn ?? 0, c.sourceOut ?? 0)) blocks.add(`${c.sourceVideoId ?? ""}:${k}`);
  return blocks.size ? matteTimeoutMs(Math.ceil(blocks.size / 2)) : 0;
}

/**
 * The extra time a render of this timeline may take for its layers: every b-roll, graphic, text, sound and other
 * video it draws or mixes is one more input the encode decodes and scales (a heavy edit has dozens). A final gets
 * 20 s a layer, a preview (540p, from the preview copies) 5 s.
 */
export function layerAllowanceMs(timeline: unknown, kind: "preview" | "final"): number {
  const t = (timeline as { tracks?: Record<string, unknown> } | null)?.tracks;
  const list = (k: string) => (Array.isArray(t?.[k]) ? (t![k] as { kind?: string; sourceVideoId?: string }[]) : []);
  const v1Sources = new Set(list("v1").map((c) => c?.sourceVideoId ?? "")).size;
  const layers = list("v2").filter((c) => c?.kind !== "zoom").length + list("v3").filter((c) => c?.kind !== "caption").length + list("a2").length + list("a3").length + Math.max(0, v1Sources - 1);
  return layers * (kind === "final" ? 20_000 : 5_000);
}

/** Everything Phase 6 adds to a drawn clip (V1, b-roll). */
export type ClipLook = { grade?: Grade; key?: ChromaKey; masks?: Mask[]; effects?: Effect[]; skin?: Skin; subject?: Subject; objects?: TrackedObject[] };
export const hasLook = (c: ClipLook | null | undefined) => !!c && (!!c.grade && gradeIsActive(c.grade) || !!c.key || !!c.masks?.length || !!c.effects?.length || skinActive(c.skin) || !!c.subject);
export const gradeIsActive = (g: Grade | undefined) => !!g && (!!g.exposure || !!g.contrast || !!g.temperature || !!g.tint || (g.saturation != null && g.saturation !== 100) || !!g.lut || !!g.curves && Object.values(g.curves).some(Boolean)
  || !!g.highlights || !!g.shadows || !!g.whites || !!g.blacks || !!g.vibrance || wheelsActive(g.wheels) || !!g.hsl?.length || !!g.hueSat?.length || !!g.hueHue?.length || !!g.lumaSat?.length);
const wheelsActive = (w: Grade["wheels"]) => !!w && WHEELS.some((k) => !!w[k]?.amount || !!w[k]?.luma);

// ---------------------------------------------------------------------------------------------
// Grade -> function -> LUT
// ---------------------------------------------------------------------------------------------
/** An imported LUT, normalized: 3D (size^3 RGB triplets, red fastest) or 1D (size RGB triplets), with its domain. */
export type Lut = { kind: "3d" | "1d"; size: number; data: Float32Array; min: [number, number, number]; max: [number, number, number]; title?: string };

const GAMMA = 2.4; // BT.1886: the display curve the grade's "linear light" steps undo
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lin = (v: number) => Math.pow(Math.max(0, v), GAMMA);
const gam = (v: number) => Math.pow(Math.max(0, v), 1 / GAMMA);

/** Monotone cubic (Fritsch-Carlson) through a curve's points; (0,0) and (1,1) are added when the curve has no end there. */
export function curveFn(points: Curve): (x: number) => number {
  const p = [...points].map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number]).sort((a, b) => a[0] - b[0]).filter((q, i, a) => i === 0 || q[0] - a[i - 1][0] > 1e-4);
  if (!p.length || p[0][0] > 0.001) p.unshift([0, 0]);
  if (p[p.length - 1][0] < 0.999) p.push([1, 1]);
  const n = p.length;
  if (n === 1) return () => p[0][1];
  const d = p.slice(0, -1).map((q, i) => (p[i + 1][1] - q[1]) / (p[i + 1][0] - q[0]));
  const m = p.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (x > p[i + 1][0]) i++;
    const h = p[i + 1][0] - p[i][0], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return clamp01((2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]);
  };
}

/** Samples a LUT at (r,g,b) (trilinear for 3D, linear per channel for 1D), inside its domain. */
export function sampleLut(l: Lut, r: number, g: number, b: number): [number, number, number] {
  const N = l.size, s = N - 1;
  const at = (v: number, c: number) => clamp01((v - l.min[c]) / (l.max[c] - l.min[c] || 1)) * s;
  if (l.kind === "1d") {
    const one = (v: number, c: number) => { const x = at(v, c), i = Math.min(s - 1, Math.floor(x)), f = x - i; return l.data[i * 3 + c] * (1 - f) + l.data[(i + 1) * 3 + c] * f; };
    return [one(r, 0), one(g, 1), one(b, 2)];
  }
  const x = at(r, 0), y = at(g, 1), z = at(b, 2);
  const x0 = Math.min(s - 1, Math.floor(x)), y0 = Math.min(s - 1, Math.floor(y)), z0 = Math.min(s - 1, Math.floor(z));
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const out: [number, number, number] = [0, 0, 0];
  const idx = (i: number, j: number, k: number) => ((k * N + j) * N + i) * 3;
  for (let c = 0; c < 3; c++) {
    const v = (i: number, j: number, k: number) => l.data[idx(x0 + i, y0 + j, z0 + k) + c];
    const c00 = v(0, 0, 0) * (1 - fx) + v(1, 0, 0) * fx, c10 = v(0, 1, 0) * (1 - fx) + v(1, 1, 0) * fx;
    const c01 = v(0, 0, 1) * (1 - fx) + v(1, 0, 1) * fx, c11 = v(0, 1, 1) * (1 - fx) + v(1, 1, 1) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}

// Phase 5: the steps Lumetri adds, each a function of a pixel, so they go into the same LUT.
const luma = (p: [number, number, number]) => LUMA[0] * p[0] + LUMA[1] * p[1] + LUMA[2] * p[2];
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Highlights, shadows, whites, blacks: the pixel's luma moved by four bumps (shadows peak at 1/3, highlights at 2/3,
 *  blacks at 0, whites at 1), the colour scaled with it (moved by the same amount near black). */
function toneStep(g: Grade): ((p: [number, number, number]) => [number, number, number]) | null {
  const sh = (g.shadows ?? 0) / 100, hl = (g.highlights ?? 0) / 100, wh = (g.whites ?? 0) / 100, bl = (g.blacks ?? 0) / 100;
  if (!sh && !hl && !wh && !bl) return null;
  return (p) => {
    const y = luma(p), u = 1 - y;
    const y2 = clamp01(y + 0.25 * sh * 6.75 * y * u * u + 0.25 * hl * 6.75 * y * y * u + 0.2 * bl * u * u * u + 0.2 * wh * y * y * y);
    const t = smooth(0, 0.08, y), k = y > 1e-5 ? y2 / y : 1, d = y2 - y;
    return [clamp01(t * p[0] * k + (1 - t) * (p[0] + d)), clamp01(t * p[1] * k + (1 - t) * (p[1] + d)), clamp01(t * p[2] * k + (1 - t) * (p[2] + d))];
  };
}
/** A hue (degrees) as a fully saturated colour. */
export function hueRgb(h: number): [number, number, number] {
  const x = (((h % 360) + 360) % 360) / 60, i = Math.floor(x), f = x - i;
  return ([[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]] as [number, number, number][])[i % 6];
}
/** The wheels: each range (shadows (1-y)^2, midtones 4y(1-y), highlights y^2) pushed towards its hue (the hue's colour
 *  less its own luma, so the brightness stays) and lifted by its luma. */
function wheelStep(w: Grade["wheels"]): ((p: [number, number, number]) => [number, number, number]) | null {
  if (!wheelsActive(w)) return null;
  const vec = (x: Wheel | undefined): [number, number, number] => {
    const a = (x?.amount ?? 0) / 100, l = (x?.luma ?? 0) / 100, c = hueRgb(x?.hue ?? 0), y = luma(c);
    return [0.25 * (a * (c[0] - y) + l), 0.25 * (a * (c[1] - y) + l), 0.25 * (a * (c[2] - y) + l)];
  };
  const vs = vec(w!.shadows), vm = vec(w!.midtones), vh = vec(w!.highlights);
  return (p) => {
    const y = luma(p), ws = (1 - y) * (1 - y), wm = 4 * y * (1 - y), wh = y * y;
    return [0, 1, 2].map((c) => clamp01(p[c] + vs[c] * ws + vm[c] * wm + vh[c] * wh)) as [number, number, number];
  };
}
export function rgbHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx === 0 ? 0 : d / mx, mx];
}
export function hsvRgb(h: number, s: number, v: number): [number, number, number] {
  const c = hueRgb(h * 360);
  return [v * (1 - s + s * c[0]), v * (1 - s + s * c[1]), v * (1 - s + s * c[2])];
}
/** Hue vs Sat: a curve round the hue circle (points [hue, value], 0.5 = no change), eased between points. */
export function hueCurveFn(points: Curve): (h: number) => number {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (p.length === 1) return () => p[0][1];
  return (h) => {
    let j = p.findIndex((q) => q[0] > h);
    if (j < 0) j = 0;
    const a = p[(j - 1 + p.length) % p.length], b = p[j];
    const span = ((b[0] - a[0] + 1) % 1) || 1, t = ((h - a[0] + 1) % 1) / span, e = t * t * (3 - 2 * t);
    return a[1] + (b[1] - a[1]) * e;
  };
}
/** A curve of values over 0-1 (not round): smooth between its points, flat past the first and the last. */
export function valueCurveFn(points: Curve): (x: number) => number {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    const j = p.findIndex((q) => q[0] > x);
    if (j < 0) return p[p.length - 1][1];
    const a = p[j - 1], b = p[j], t = (x - a[0]) / (b[0] - a[0] || 1), e = t * t * (3 - 2 * t);
    return a[1] + (b[1] - a[1]) * e;
  };
}
/** HSL secondaries, Hue vs Hue, Hue vs Sat and Luma vs Sat: each qualifier weighs the pixel by its hue's distance and
 *  its saturation, then turns its hue, scales its saturation and moves its brightness by that weight; the curves turn
 *  the hue by the hue (greys left alone), scale the saturation by the hue and by the brightness. */
function hueStep(g: Grade): ((p: [number, number, number]) => [number, number, number]) | null {
  const qs = g.hsl ?? [], hs = g.hueSat?.length ? hueCurveFn(g.hueSat) : null;
  const hh = g.hueHue?.length ? hueCurveFn(g.hueHue) : null, ls = g.lumaSat?.length ? valueCurveFn(g.lumaSat) : null;
  if (!qs.length && !hs && !hh && !ls) return null;
  return (p) => {
    const y = LUMA[0] * p[0] + LUMA[1] * p[1] + LUMA[2] * p[2];
    let [h, s, v] = rgbHsv(p[0], p[1], p[2]);
    for (const q of qs) {
      const range = q.range ?? 40, dist = Math.abs(((h * 360 - q.hue + 540) % 360) - 180);
      const w = (1 - smooth(range / 2, range, dist)) * smooth(q.satMin ?? 0.1, (q.satMin ?? 0.1) + 0.1, s);
      if (w <= 0) continue;
      h = (h + ((q.hueShift ?? 0) / 360) * w + 1) % 1;
      s = clamp01(s * (1 + ((q.saturation ?? 100) / 100 - 1) * w));
      v = clamp01(v + ((q.lightness ?? 0) / 100) * 0.5 * w);
    }
    if (hh) h = (h + (hh(h) - 0.5) * smooth(0.03, 0.12, s) + 1) % 1;
    if (hs) s = clamp01(s * 2 * hs(h));
    if (ls) s = clamp01(s * 2 * ls(y));
    return hsvRgb(h, s, v);
  };
}

/**
 * The grade as a function of a pixel (0-1, as displayed): [input LUT] -> white balance and exposure in linear light
 * -> contrast (around 0.5, like CSS contrast()) -> saturation (Rec. 709 luma) -> curves (master, then each channel)
 * -> [look LUT, by its amount] -> clipped to 0-1.
 */
export function gradeFn(g: Grade, lut?: Lut | null): (r: number, gg: number, b: number) => [number, number, number] {
  const k = (g.temperature ?? 0) / 100, m = (g.tint ?? 0) / 100;
  let wr = Math.pow(2, 0.35 * k), wg = Math.pow(2, -0.35 * m), wb = Math.pow(2, -0.35 * k);
  const norm = LUMA[0] * wr + LUMA[1] * wg + LUMA[2] * wb;
  const ex = Math.pow(2, g.exposure ?? 0);
  wr = (wr / norm) * ex; wg = (wg / norm) * ex; wb = (wb / norm) * ex;
  const linStep = wr !== 1 || wg !== 1 || wb !== 1;
  const c = 1 + (g.contrast ?? 0) / 100, s = (g.saturation ?? 100) / 100;
  const cv = g.curves ?? {};
  const master = cv.master ? curveFn(cv.master) : null, cr = cv.r ? curveFn(cv.r) : null, cg = cv.g ? curveFn(cv.g) : null, cb = cv.b ? curveFn(cv.b) : null;
  const useLut = lut && g.lut ? lut : null, amt = g.lut?.amount ?? 1, first = !!g.lut?.input;
  const mix = (a: [number, number, number], b: [number, number, number]): [number, number, number] => (amt >= 1 ? b : [a[0] + (b[0] - a[0]) * amt, a[1] + (b[1] - a[1]) * amt, a[2] + (b[2] - a[2]) * amt]);
  const tone = toneStep(g), wheels = wheelStep(g.wheels), vib = (g.vibrance ?? 0) / 100, hues = hueStep(g);
  return (r0: number, g0: number, b0: number) => {
    let p: [number, number, number] = [r0, g0, b0];
    if (useLut && first) p = mix(p, sampleLut(useLut, p[0], p[1], p[2]));
    if (linStep) p = [clamp01(gam(lin(p[0]) * wr)), clamp01(gam(lin(p[1]) * wg)), clamp01(gam(lin(p[2]) * wb))];
    if (c !== 1) p = [clamp01((p[0] - 0.5) * c + 0.5), clamp01((p[1] - 0.5) * c + 0.5), clamp01((p[2] - 0.5) * c + 0.5)];
    if (tone) p = tone(p);
    if (wheels) p = wheels(p);
    if (s !== 1) { const y = LUMA[0] * p[0] + LUMA[1] * p[1] + LUMA[2] * p[2]; p = [clamp01(y + (p[0] - y) * s), clamp01(y + (p[1] - y) * s), clamp01(y + (p[2] - y) * s)]; }
    if (vib) { const y = LUMA[0] * p[0] + LUMA[1] * p[1] + LUMA[2] * p[2], k = Math.max(0, 1 + vib * (1 - (Math.max(...p) - Math.min(...p)))); p = [clamp01(y + (p[0] - y) * k), clamp01(y + (p[1] - y) * k), clamp01(y + (p[2] - y) * k)]; }
    if (hues) p = hues(p);
    if (master) p = [master(p[0]), master(p[1]), master(p[2])];
    if (cr) p[0] = cr(p[0]);
    if (cg) p[1] = cg(p[1]);
    if (cb) p[2] = cb(p[2]);
    if (useLut && !first) p = mix(p, sampleLut(useLut, p[0], p[1], p[2]));
    return [clamp01(p[0]), clamp01(p[1]), clamp01(p[2])];
  };
}

export const LUT_SIZE = 33;
/** Phase 5: a finer LUT for a grade with HSL secondaries or Hue vs Sat (their edges are sharp between 33 points). The
 *  render and the player both use this size, so they stay the same. */
export const lutSizeFor = (g: Grade) => (g.hsl?.length || g.hueSat?.length || g.hueHue?.length || g.lumaSat?.length ? 49 : LUT_SIZE);
/** The grade as a 3D LUT: size^3 RGB triplets, red changing fastest (the .cube order). */
export function buildLut(g: Grade, lut?: Lut | null, size = LUT_SIZE): Float32Array {
  const f = gradeFn(g, lut);
  const out = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) for (let gg = 0; gg < size; gg++) for (let r = 0; r < size; r++) {
    const v = f(r / (size - 1), gg / (size - 1), b / (size - 1));
    out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2];
  }
  return out;
}

/** A 3D LUT as a .cube file (what FFmpeg's lut3d reads). */
export function cubeText(data: Float32Array, size = LUT_SIZE, title = "rendrr grade"): string {
  const lines = [`TITLE "${title.replace(/"/g, "")}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return lines.join("\n") + "\n";
}

/** Reads a .cube file (Adobe/Resolve: 3D or 1D, with a domain). Throws a plain message when it is not one. */
export function parseCube(text: string): Lut {
  let size3 = 0, size1 = 0, title: string | undefined;
  let min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [kw, ...rest] = line.split(/\s+/);
    const up = kw.toUpperCase();
    if (up === "TITLE") { title = line.slice(5).trim().replace(/^"|"$/g, "").slice(0, 120); continue; }
    if (up === "LUT_3D_SIZE") { size3 = Number(rest[0]); continue; }
    if (up === "LUT_1D_SIZE") { size1 = Number(rest[0]); continue; }
    if (up === "DOMAIN_MIN") { min = rest.slice(0, 3).map(Number) as [number, number, number]; continue; }
    if (up === "LUT_3D_INPUT_RANGE" || up === "LUT_1D_INPUT_RANGE") { const [lo, hi] = rest.map(Number); min = [lo, lo, lo]; max = [hi, hi, hi]; continue; }
    if (up === "DOMAIN_MAX") { max = rest.slice(0, 3).map(Number) as [number, number, number]; continue; }
    if (/^[A-Z_]+$/.test(up)) continue; // other keywords (LUT_IN_VIDEO_RANGE…)
    const nums = line.split(/\s+/).map(Number);
    if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) throw new Error(`This is not a .cube LUT: a line reads "${line.slice(0, 40)}".`);
    vals.push(nums[0], nums[1], nums[2]);
  }
  if (!size3 && !size1) throw new Error("This .cube file has no LUT_3D_SIZE or LUT_1D_SIZE line.");
  if (size3 && (size3 < 2 || size3 > 65)) throw new Error(`LUT_3D_SIZE ${size3} is not supported (2 to 65).`);
  if (size1 && (size1 < 2 || size1 > 65536)) throw new Error(`LUT_1D_SIZE ${size1} is not supported (2 to 65536).`);
  const want = size3 ? size3 ** 3 : size1;
  if (vals.length / 3 !== want) throw new Error(`This .cube file should have ${want} rows of numbers and has ${vals.length / 3}.`);
  if ([0, 1, 2].some((c) => !(max[c] > min[c]))) throw new Error("This .cube file's DOMAIN_MAX must be above its DOMAIN_MIN.");
  return { kind: size3 ? "3d" : "1d", size: size3 || size1, data: Float32Array.from(vals), min, max, ...(title ? { title } : {}) };
}

/** A short stable name for a grade (with its LUT), so clips with the same grade share one file and one texture. */
export function hashOf(x: unknown): string {
  const s = JSON.stringify(x);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------------------------
// Masks and effect areas: one greyscale picture at the output size
// ---------------------------------------------------------------------------------------------
/** Signed distance (pixels, negative inside) from pixel centre (px, py) to the area's edge, at W x H. */
function distanceFn(a: Area, W: number, H: number): (px: number, py: number) => number {
  if (a.shape === "path") {
    const pts = pathPoints(a).map(([x, y]) => [x * W, y * H] as [number, number]);
    const n = pts.length;
    if (n < 3) return () => 1e9;
    return (px, py) => {
      let best = Infinity, inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        const dx = xj - xi, dy = yj - yi, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / L)) : 0;
        const ex = xi + t * dx - px, ey = yi + t * dy - py;
        const d = ex * ex + ey * ey;
        if (d < best) best = d;
      }
      return inside ? -Math.sqrt(best) : Math.sqrt(best);
    };
  }
  const cx = (a.x! + a.w! / 2) * W, cy = (a.y! + a.h! / 2) * H, hx = (a.w! * W) / 2, hy = (a.h! * H) / 2;
  if (a.shape === "rect") {
    const r = Math.min(hx, hy) * 2 * Math.min(0.5, a.radius ?? 0);
    return (px, py) => {
      const qx = Math.abs(px - cx) - hx + r, qy = Math.abs(py - cy) - hy + r;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
  }
  // Ellipse: k0 (k0 - 1) / k1, a close distance estimate near the edge (where the feather is).
  return (px, py) => {
    const x = px - cx, y = py - cy;
    const k0 = Math.hypot(x / hx, y / hy), k1 = Math.hypot(x / (hx * hx), y / (hy * hy));
    return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(hx, hy);
  };
}

/** One area as coverage 0-1 per pixel (row by row), feathered across its edge and inverted when asked. */
export function areaCoverage(a: Area, W: number, H: number): Float32Array {
  const d = distanceFn(a, W, H);
  const f = Math.max(1, (a.feather ?? 0) * Math.min(W, H));
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = clamp01(0.5 - d(x + 0.5, y + 0.5) / f);
    out[y * W + x] = a.invert ? 1 - v : v;
  }
  return out;
}

/** The clip's masks combined in order (add, subtract, intersect), as 8-bit values row by row. */
export function maskPicture(masks: Mask[], W: number, H: number): Uint8Array {
  const acc = new Float32Array(W * H).fill(!masks.length || (masks[0].mode ?? "add") === "add" ? 0 : 1);
  if (!masks.length) acc.fill(1);
  for (const m of masks) {
    const c = areaCoverage(m, W, H), mode = m.mode ?? "add";
    for (let i = 0; i < acc.length; i++) acc[i] = mode === "add" ? Math.max(acc[i], c[i]) : mode === "subtract" ? acc[i] * (1 - c[i]) : acc[i] * c[i];
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(acc[i] * 255);
  return out;
}

/** An effect's area as 8-bit values (null: the whole picture). */
export function areaPicture(a: Area | undefined, W: number, H: number): Uint8Array | null {
  if (!a) return null;
  const c = areaCoverage(a, W, H), out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(c[i] * 255);
  return out;
}

/** 8-bit greyscale as a binary PGM file (FFmpeg reads it as a picture). */
export function pgm(px: Uint8Array, W: number, H: number): Uint8Array {
  const head = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
  const out = new Uint8Array(head.length + px.length);
  out.set(head, 0); out.set(px, head.length);
  return out;
}

/** Blur sigma in pixels at W x H (amount 100 = 5% of the short side). */
export const blurSigma = (amount: number, W: number, H: number) => Math.max(0.5, Math.round((amount / 100) * 0.05 * Math.min(W, H) * 100) / 100);
/** Pixelate block size in pixels at W x H (amount 100 = 10% of the short side). */
export const pixelBlock = (amount: number, W: number, H: number) => Math.max(2, Math.round((amount / 1000) * Math.min(W, H)));
/** Sharpen's kernel at W x H: a 3x3 binomial blur (sigma 0.71 px) up to 720p, 5x5 (sigma 1 px) above. */
export const sharpenSize = (W: number, H: number) => (Math.min(W, H) <= 720 ? 3 : 5);
/** Sharpen as integer convolution weights (rows top down) and their divisor: out = x + k (x - blur(x)), k = amount / 50,
 *  blur a binomial kernel of `size`. FFmpeg's convolution runs it on 16-bit RGB (unsharp does nothing at 16 bits); the
 *  player's shader uses the same weights. */
export function sharpenKernel(amount: number, size: number): { m: number[]; div: number } {
  const row = size === 3 ? [1, 2, 1] : [1, 4, 6, 4, 1];
  const d = row.reduce((a, b) => a + b, 0) ** 2, div = d * 100, a = Math.round(amount * 2), c = (size * size - 1) / 2;
  const m = row.flatMap((y) => row.map((x) => -a * x * y));
  m[c] += div + a * d;
  return { m, div };
}
/** The effect's size in pixels at W x H: blur sigma, block size, or sharpen's kernel (darken has none). */
export const effectPx = (e: Effect, W: number, H: number) => {
  const short = Math.min(W, H);
  switch (e.type) {
    case "blur": return blurSigma(e.amount, W, H);
    case "pixelate": return pixelBlock(e.amount, W, H);
    case "sharpen": return sharpenSize(W, H);
    // Phase 12: glow's spread (sigma), the RGB split's shift and the shake's reach, in pixels at the plan's size.
    case "glow": return Math.max(1, Math.round(short * 0.04 * (0.4 + e.amount / 100) * 10) / 10);
    case "rgbsplit": return Math.max(1, Math.round((short * 0.012 * e.amount) / 100));
    case "shake": return Math.max(1, Math.round((short * 0.03 * e.amount) / 100));
    default: return 0;
  }
};

// ---------------------------------------------------------------------------------------------
// Key: FFmpeg's colorkey and despill (the player's shader repeats these)
// ---------------------------------------------------------------------------------------------
export const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** colorkey: alpha 0-255 of an 8-bit pixel. */
export function keyAlpha(r: number, g: number, b: number, k: ChromaKey): number {
  const [kr, kg, kb] = hexRgb(k.color);
  const diff = Math.sqrt(((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / (255 * 255 * 3));
  if (k.blend > 0.0001) return Math.trunc(clamp01((diff - k.similarity) / k.blend) * 255);
  return diff > k.similarity ? 255 : 0;
}
/** Which channel spills: the key colour's stronger of green and blue. */
export const spillType = (k: ChromaKey): "green" | "blue" => { const [, g, b] = hexRgb(k.color); return b > g ? "blue" : "green"; };
/** despill (mix 0.5, expand 0): the spilling channel goes down by `spill` times its excess over the other two's mean. */
export function despillPx(r: number, g: number, b: number, k: ChromaKey): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const blue = spillType(k) === "blue";
  const map = Math.max(blue ? B - (R * 0.5 + G * 0.5) : G - (R * 0.5 + B * 0.5), 0);
  const c8 = (v: number) => Math.min(255, Math.max(0, Math.trunc(Math.max(v, 0) * 255)));
  return blue ? [c8(R), c8(G), c8(B - map * k.spill)] : [c8(R), c8(G - map * k.spill), c8(B)];
}

// ---------------------------------------------------------------------------------------------
// Shot matching from measured pixels
// ---------------------------------------------------------------------------------------------
/** Small frames of a clip as the editor shows it (turned and fitted), RGB bytes, several frames one after another. */
export type ColorSample = { w: number; h: number; rgb: Uint8Array | number[] };
export type ColorStats = { lo: [number, number, number]; mid: [number, number, number]; hi: [number, number, number]; sat: number; mean: [number, number, number] };

/** Per channel the 2nd, 50th and 98th percentiles, the mean, and the mean colourfulness (max - min) of the pixels. */
export function colorStats(px: ArrayLike<number>, f?: (r: number, g: number, b: number) => [number, number, number]): ColorStats {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let sat = 0, n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i + 2 < px.length; i += 3) {
    let v: [number, number, number] = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    if (f) v = f(v[0], v[1], v[2]);
    for (let c = 0; c < 3; c++) { hist[c][Math.round(clamp01(v[c]) * 255)]++; sum[c] += v[c]; }
    sat += Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2]);
    n++;
  }
  const pct = (c: number, p: number) => { const want = p * n; let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[c][i]; if (acc >= want) return i / 255; } return 1; };
  const tri = (p: number) => [pct(0, p), pct(1, p), pct(2, p)] as [number, number, number];
  return { lo: tri(0.02), mid: tri(0.5), hi: tri(0.98), sat: n ? sat / n : 0, mean: [sum[0] / (n || 1), sum[1] / (n || 1), sum[2] / (n || 1)] };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/**
 * The grade that makes the target look like the reference, from their measured pixels: each channel's 2nd, 50th
 * and 98th percentiles of the target go onto the reference's (three-point curves, slopes kept between 1/4 and 4,
 * carried on straight to 0 and 1), then saturation brings the target's mean colourfulness to the reference's.
 * `ref` is measured as it looks, with its own grade.
 */
export function matchGrade(target: ArrayLike<number>, ref: ArrayLike<number>, refLook?: (r: number, g: number, b: number) => [number, number, number]): { grade: Grade; text: string } {
  const t = colorStats(target), R = colorStats(ref, refLook);
  const curves: Curves = {};
  const names = ["r", "g", "b"] as const;
  names.forEach((ch, c) => {
    const xs = [t.lo[c], t.mid[c], t.hi[c]], ys = [R.lo[c], R.mid[c], R.hi[c]];
    if (!(xs[1] - xs[0] > 0.01 && xs[2] - xs[1] > 0.01)) return; // a flat channel cannot be matched by a curve
    const sl = (i: number) => Math.min(4, Math.max(0.25, (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])));
    const y0 = clamp01(ys[0]);
    const y1 = clamp01(y0 + sl(0) * (xs[1] - xs[0]));
    const y2 = clamp01(y1 + sl(1) * (xs[2] - xs[1]));
    const pts: Curve = [[0, clamp01(y0 - sl(0) * xs[0])], [xs[0], y0], [xs[1], y1], [xs[2], y2], [1, clamp01(y2 + sl(1) * (1 - xs[2]))]];
    curves[ch] = pts.map(([x, y]) => [r3(x), r3(y)] as [number, number]);
  });
  let grade: Grade = Object.keys(curves).length ? { curves } : {};
  // Saturation: twice, since it acts before the curves.
  for (let i = 0; i < 2; i++) {
    const now = colorStats(target, gradeFn(grade)).sat;
    if (now < 0.005 || R.sat < 0.005) break;
    const s = Math.round(Math.min(200, Math.max(25, (grade.saturation ?? 100) * (R.sat / now))));
    grade = { ...grade, saturation: s };
  }
  if (grade.saturation === 100) delete grade.saturation;
  const fmt = (v: [number, number, number]) => v.map((x) => x.toFixed(2)).join("/");
  return { grade, text: `levels ${fmt(t.mid)} → ${fmt(R.mid)} (RGB medians)${grade.saturation ? `, saturation ${grade.saturation}%` : ""}` };
}

// ---------------------------------------------------------------------------------------------
// Text for the check and get_project
// ---------------------------------------------------------------------------------------------
const sgn = (n: number) => (n > 0 ? "+" : "") + n;
/** "exposure +0.5, contrast +10, temp -20, saturation 120%, curves master/r, LUT lut_ab12 80% (input)" */
export function gradeText(g: Grade, lutName?: (id: string) => string | undefined): string {
  const out: string[] = [];
  if (g.exposure) out.push(`exposure ${sgn(g.exposure)}`);
  if (g.contrast) out.push(`contrast ${sgn(g.contrast)}`);
  if (g.temperature) out.push(`temp ${sgn(g.temperature)}`);
  if (g.tint) out.push(`tint ${sgn(g.tint)}`);
  if (g.saturation != null && g.saturation !== 100) out.push(`saturation ${g.saturation}%`);
  for (const k of ["highlights", "shadows", "whites", "blacks", "vibrance"] as const) if (g[k]) out.push(`${k} ${sgn(g[k]!)}`);
  for (const k of WHEELS) { const w = g.wheels?.[k]; if (w?.amount || w?.luma) out.push(`${k} wheel${w.amount ? ` ${Math.round(w.hue ?? 0)}° ${w.amount}` : ""}${w.luma ? ` luma ${sgn(w.luma)}` : ""}`); }
  for (const q of g.hsl ?? []) out.push(`HSL ${Math.round(q.hue)}°±${(q.range ?? 40) / 2}${q.hueShift ? ` hue ${sgn(q.hueShift)}°` : ""}${q.saturation != null && q.saturation !== 100 ? ` sat ${q.saturation}%` : ""}${q.lightness ? ` light ${sgn(q.lightness)}` : ""}`);
  if (g.hueSat?.length) out.push(`hue vs sat (${g.hueSat.length} points)`);
  if (g.hueHue?.length) out.push(`hue vs hue (${g.hueHue.filter((q) => Math.abs(q[1] - 0.5) > 0.002).map((q) => `${Math.round(q[0] * 360)}° ${sgn(Math.round((q[1] - 0.5) * 360))}°`).join(", ") || "flat"})`);
  if (g.lumaSat?.length) out.push(`luma vs sat (${g.lumaSat.map((q) => `${Math.round(q[0] * 100)}% → ${Math.round(q[1] * 200)}%`).join(", ")})`);
  const ch = CURVE_CHANNELS.filter((c) => g.curves?.[c]);
  if (ch.length) out.push(`curves ${ch.join("/")}`);
  if (g.lut) { const nm = lutName?.(g.lut.id); out.push(`LUT ${nm ? `"${nm}"` : g.lut.id}${g.lut.amount != null && g.lut.amount < 1 ? ` ${Math.round(g.lut.amount * 100)}%` : ""}${g.lut.input ? " (input)" : ""}`); }
  return out.join(", ") || "none";
}
const pct = (n: number) => `${Math.round(n * 100)}%`;
export const areaText = (a: Area) => `${a.invert ? "outside " : ""}${a.shape === "path" ? `path of ${pathPoints(a).length} points` : `${a.shape} ${pct(a.w!)}x${pct(a.h!)} at ${pct(a.x!)},${pct(a.y!)}`}${a.radius ? ` corners ${pct(a.radius)}` : ""}${a.feather ? ` feather ${pct(a.feather)}` : ""}${a.follow === "face" ? ` following the face (${a.keys?.length ?? 0} keys)` : a.follow === "object" ? ` following object ${a.object} (${a.keys?.length ?? 0} keys)` : a.pathKeys?.length && moving(a) ? ` changing shape (${a.pathKeys.length} keys, ${+a.pathKeys[0].at.toFixed(2)}-${+a.pathKeys[a.pathKeys.length - 1].at.toFixed(2)}s)` : moving(a) ? ` moving (${a.keys!.length} keys, ${+a.keys![0].at.toFixed(2)}-${+a.keys![a.keys!.length - 1].at.toFixed(2)}s)` : ""}`;
export const chromaKeyText = (k: ChromaKey) => `${k.color} similarity ${k.similarity} blend ${k.blend}${k.spill ? ` spill ${k.spill}` : ""}`;
export const masksText = (ms: Mask[]) => ms.map((m, i) => `${i && m.mode && m.mode !== "add" ? m.mode + " " : ""}${areaText(m)}`).join(", ");
export const effectsText = (es: Effect[]) => es.map((e) => e.type === "pin" ? `corner pin${e.corners ? ` to ${e.corners.map((c) => `${Math.round(c[0] * 100)}%,${Math.round(c[1] * 100)}%`).join(" ")}` : ""}` : `${e.type === "rgbsplit" ? "RGB split" : e.type} ${e.amount}${e.area ? ` in ${areaText(e.area)}` : ""}`).join(", ");
/** face: the area is the face Rendrr measured (forehead to neck). */
export const skinText = (s: Skin) => `skin retouch: smooth ${s.smooth}, blemishes ${s.blemishes}, even ${s.even}, brighten ${s.brighten}${s.area ? (s.face ? ", on the face" : `, in ${areaText(s.area)}`) : ", whole picture"}`;

// ---------------------------------------------------------------------------------------------
// Skin retouch: the numbers the render's graph and the player's shader both use
// ---------------------------------------------------------------------------------------------
/** The skin's colour: a hue band (radians in the Cb/Cr plane, 0 = towards blue-yellow's yellow) and a saturation band,
 *  both with soft edges, measured on 8-bit BT.709 limited range; a luma floor keeps hair and shadows out. */
export const SKIN_TONE = { hue: 0.85, hueFull: 0.28, hueSoft: 0.16, sat: [7, 11, 44, 56], lumaFloor: 40, lumaSoft: 30, strength: 0.9 } as const;
/** How likely an 8-bit (Cb, Cr) pair is skin, 0-1 (the render's lut2 and the player's shader). */
export function skinChroma(cb: number, cr: number): number {
  const t = SKIN_TONE, sat = Math.hypot(cb - 128, cr - 128), hue = Math.atan2(cr - 128, 128 - cb);
  const c = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return c((t.hueFull + t.hueSoft - Math.abs(hue - t.hue)) / t.hueSoft) * c((sat - t.sat[0]) / (t.sat[1] - t.sat[0])) * c((t.sat[3] - sat) / (t.sat[3] - t.sat[2]));
}
/** The FFmpeg expression of skinChroma (x = Cb, y = Cr), scaled to 0-255. */
export function skinChromaExpr(): string {
  const t = SKIN_TONE, sat = "hypot(x-128,y-128)", hue = "atan2(y-128,128-x)";
  return `255*clip((${t.hueFull + t.hueSoft}-abs(${hue}-${t.hue}))/${t.hueSoft},0,1)*clip((${sat}-${t.sat[0]})/${t.sat[1] - t.sat[0]},0,1)*clip((${t.sat[3]}-${sat})/${t.sat[3] - t.sat[2]},0,1)`;
}
/**
 * A skin retouch's numbers at a W x H picture. The work is done at a working size whose short side is 540 at most (a
 * preview works at its own size), and only its change is added to the full picture, so the fine texture above that
 * size is kept and a preview and a final look alike. Sizes are pixels at the working size.
 */
export function skinParams(sk: Skin, W: number, H: number) {
  const s = sk.smooth / 100, b = sk.blemishes / 100, e = sk.even / 100, r = sk.brighten / 100;
  const k = Math.min(1, 540 / Math.min(W, H)), even2 = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const ww = even2(W * k), wh = even2(H * k), ws = Math.min(ww, wh), r3 = (v: number) => Math.round(v * 1000) / 1000;
  // Sizes follow the face: its height at the working size (from the face's area; else a talking head's, 35% of the
  // short side). Tuned on faces about 200 px tall.
  const face = Math.max(24, sk.area && sk.face && sk.area.h ? (sk.area.h / FACE_AREA.h) * H * k : 0.35 * ws);
  const passes = Math.max(1, Math.round(((0.6 + 1.2 * b) * face) / 245));
  return {
    ww, wh, mw: even2(ww / 2), mh: even2(wh / 2), hw: even2(ww / 2), hh: even2(wh / 2),
    // smooth: an edge-keeping (bilateral) blur, sigma in pixels and its range (shares of full scale)
    smooth: s > 0 ? { sigmaS: r3(Math.max(0.5, ((0.2 + 0.8 * s) * face) / 54.5)), sigmaR: r3(0.04 + 0.06 * s) } : null,
    // blemishes: a closing (passes of 3x3 at half the working size) finds what is darker than the skin around it; a
    // pixel 1-2 (ramp in) to 3-4 (ramp out) shares darker than the closing is a spot (deeper ones, like brows and lash
    // lines, are left), filled from the skin around it (blur sigma `fill`, the spot itself left out)
    blemishes: b > 0 ? { passes, fill: r3(passes * 2.2), level: r3(Math.max(6, passes * 6)), r1: r3(0.08 - 0.03 * b), r2: r3(0.13 - 0.03 * b), r3: r3(0.14 + 0.06 * b), r4: r3(0.22 + 0.08 * b) } : null,
    // even: the colour planes blurred (sigma) and moved towards it only where they differ by less than `limit` (8-bit)
    even: e > 0 ? { sigma: r3(Math.max(0.5, e * face * 0.044)), limit: Math.round(5 + 10 * e) } : null,
    // brighten: the skin's luma through a gamma
    brighten: r > 0 ? { gamma: r3(1 - 0.3 * r) } : null,
  };
}
export type SkinParams = ReturnType<typeof skinParams>;

// ---------------------------------------------------------------------------------------------
// HDR: SDR pictures placed in an HDR output at SDR white (203 nits, ITU-R BT.2408)
// ---------------------------------------------------------------------------------------------
export type HdrTransfer = "pq" | "hlg";
export const SDR_WHITE_NITS = 203;
const M709to2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.088, 0.8956]];
const pqOetf = (nits: number) => {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const y = Math.pow(Math.max(0, nits) / 10000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
};
const hlgOetf = (e: number) => (e <= 1 / 12 ? Math.sqrt(3 * e) : 0.17883277 * Math.log(12 * e - 0.28466892) + 0.55991073);
/** An SDR pixel (BT.709, as displayed) as the same light in a BT.2020 PQ or HLG picture. */
export function sdrToHdr(r: number, g: number, b: number, t: HdrTransfer): [number, number, number] {
  const L = [lin(r), lin(g), lin(b)];
  const W = M709to2020.map((row) => row[0] * L[0] + row[1] * L[1] + row[2] * L[2]);
  // HLG: SDR white at 75% signal (scene light 0.265), as BT.2408 places it.
  return W.map((v) => clamp01(t === "pq" ? pqOetf(v * SDR_WHITE_NITS) : hlgOetf(v * 0.2647))) as [number, number, number];
}
/** That conversion as a 3D LUT (for lut3d on SDR footage, b-roll and graphics in an HDR render), after an optional grade. */
export function hdrLut(t: HdrTransfer, before?: (r: number, g: number, b: number) => [number, number, number], size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    let v: [number, number, number] = [r / (size - 1), g / (size - 1), b / (size - 1)];
    if (before) v = before(v[0], v[1], v[2]);
    const h = sdrToHdr(v[0], v[1], v[2], t);
    out[o++] = h[0]; out[o++] = h[1]; out[o++] = h[2];
  }
  return out;
}

/**
 * Phase 16: an adjustment layer's strength `t` seconds into it (`len` long): its opacity, ramped up over fadeIn and down
 * over fadeOut in straight lines (as the render's fade filter ramps the layer's alpha; the player sets it as opacity).
 */
export function adjustStrengthAt(a: { opacity?: number; fadeIn?: number; fadeOut?: number }, t: number, len: number): number {
  let s = a.opacity ?? 1;
  if (a.fadeIn) s *= Math.min(1, Math.max(0, t / a.fadeIn));
  if (a.fadeOut) s *= Math.min(1, Math.max(0, (len - t) / a.fadeOut));
  return s;
}
/** Phase 16: where and how strongly a layer works, in words ("" when everywhere at full strength). */
export const adjustText = (a: { masks?: Mask[]; opacity?: number; fadeIn?: number; fadeOut?: number }) =>
  [a.masks?.length ? `only in ${masksText(a.masks)}` : "", a.opacity != null && a.opacity < 1 ? `${Math.round(a.opacity * 100)}% strength` : "", a.fadeIn ? `fades in over ${+a.fadeIn.toFixed(2)} s` : "", a.fadeOut ? `fades out over ${+a.fadeOut.toFixed(2)} s` : ""].filter(Boolean).join(", ");

/**
 * Phase 9: an adjustment layer's preview in the editor as CSS filter functions on what is under it (backdrop-filter):
 * exposure as brightness, contrast and saturation as CSS's own (the grade's contrast and saturation are those formulas),
 * blur at its size on screen, darken as brightness. Near enough to judge; the render draws the layer exactly.
 */
export function adjustCss(a: { grade?: Grade; effects?: Effect[] }, W: number, H: number, screenScale: number): string {
  const g = a.grade ?? {}, out: string[] = [];
  if (g.exposure) out.push(`brightness(${Math.pow(2, g.exposure / 2.2).toFixed(3)})`);
  if (g.contrast) out.push(`contrast(${(1 + g.contrast / 100).toFixed(3)})`);
  if (g.saturation != null && g.saturation !== 100) out.push(`saturate(${(g.saturation / 100).toFixed(3)})`);
  for (const e of a.effects ?? []) {
    if (e.area) continue;
    if (e.type === "blur") out.push(`blur(${(blurSigma(e.amount, W, H) * screenScale).toFixed(2)}px)`);
    else if (e.type === "darken") out.push(`brightness(${(1 - e.amount / 100).toFixed(3)})`);
  }
  return out.join(" ") || "none";
}
