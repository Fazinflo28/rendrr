// A V1 clip drawn as a card (crop, rounded corners, drop shadow, border) and what is behind V1 for the whole edit
// (a colour, a gradient, a library video, or the clip's own picture blurred). For layouts like a talking head as a
// small rounded card on a coloured background. The render (FFmpeg) and the editor's player both use these numbers:
//   crop and corners   one more mask on the clip (look.ts), so they are drawn exactly as masks are
//   shadow and border  greyscale pictures at the output size, in the framed position, made here (a PGM file for
//                      FFmpeg, a canvas in the player), filled with their colour
//   gradient           an RGB picture at the output size, made here (a PPM file for FFmpeg, a canvas in the player)
import { z } from "zod";
import { areaCoverage, type Area, type Mask } from "./look";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #FF66AA");
const unit = z.number().min(0).max(1);
const side = z.number().min(0).max(0.45);

/** Crop: shares of the fitted picture cut from each side. radius: share of the card's shorter side (0.5 = round
 *  ends). shadow: blur and x, y offset as shares of the frame's shorter side. border: width as a share of it. */
export const CardLookSchema = z.object({
  crop: z.object({ left: side.optional(), top: side.optional(), right: side.optional(), bottom: side.optional() }).optional(),
  radius: z.number().min(0).max(0.5).optional(),
  shadow: z.object({ color: hex.optional(), opacity: unit.optional(), blur: z.number().min(0).max(0.2).optional(), x: z.number().min(-0.2).max(0.2).optional(), y: z.number().min(-0.2).max(0.2).optional() }).optional(),
  border: z.object({ color: hex, width: z.number().min(0.001).max(0.05) }).optional(),
});
export type CardLook = z.infer<typeof CardLookSchema>;
export const SHADOW_DEFAULTS = { color: "#000000", opacity: 0.35, blur: 0.03, x: 0, y: 0.012 };

/** What is behind V1: one of a colour, a gradient (angle in degrees as in CSS: 0 = bottom to top, 90 = left to right,
 *  180 = top to bottom), a library video (looped, filling the frame) or the clip's own picture blurred (1-100). */
export const BackgroundSchema = z.object({
  color: hex.optional(),
  gradient: z.object({ from: hex, to: hex, angle: z.number().min(0).max(360).optional() }).optional(),
  videoId: z.string().min(1).max(80).optional(),
  blur: z.number().min(1).max(100).optional(),
}).superRefine((b, ctx) => {
  const n = [b.color, b.gradient, b.videoId, b.blur].filter((x) => x != null).length;
  if (n !== 1) ctx.addIssue({ code: "custom", message: "a background is one of color, gradient, videoId or blur" });
});
export type Background = z.infer<typeof BackgroundSchema>;

export const hasCard = (c: CardLook | null | undefined): c is CardLook => !!c && (!!c.radius || !!c.shadow || !!c.border || !!c.crop && Object.values(c.crop).some((v) => !!v));

/** The card's box in the fitted picture (shares of the frame). */
export function cardBox(c: CardLook): { x: number; y: number; w: number; h: number } {
  const l = c.crop?.left ?? 0, t = c.crop?.top ?? 0, r = c.crop?.right ?? 0, b = c.crop?.bottom ?? 0;
  return { x: l, y: t, w: Math.max(0.05, 1 - l - r), h: Math.max(0.05, 1 - t - b) };
}

/** Crop and corners as a mask on the clip's picture (null: neither), joined to the clip's own masks by intersect. */
export function cardMask(c: CardLook | null | undefined): Mask | null {
  if (!c) return null;
  const b = cardBox(c);
  const cropped = b.x > 0 || b.y > 0 || b.w < 1 || b.h < 1;
  if (!cropped && !c.radius) return null;
  return { shape: "rect", ...b, ...(c.radius ? { radius: c.radius } : {}) };
}

/** The clip's masks with its card's (the card shape keeps only what is inside it). */
export function masksWithCard(masks: Mask[] | undefined, c: CardLook | null | undefined): Mask[] | undefined {
  const m = cardMask(c);
  if (!m) return masks?.length ? masks : undefined;
  return masks?.length ? [...masks, { ...m, mode: "intersect" }] : [m];
}

type Framing = { scale: number; x: number; y: number };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Where the card sits on screen at W x H (pixels): the fitted picture scaled about its centre and moved, as the render
 *  frames it, then the crop. */
export function cardScreenBox(c: CardLook, f: Framing | null, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const fr = f ?? { scale: 1, x: 0, y: 0 };
  const sw = even(W * fr.scale), sh = even(H * fr.scale);
  const ox = Math.round((W - sw) / 2 + fr.x * W), oy = Math.round((H - sh) / 2 + fr.y * H);
  const b = cardBox(c);
  return { x: ox + b.x * sw, y: oy + b.y * sh, w: b.w * sw, h: b.h * sh };
}

/** The drop shadow as coverage 0-255 at W x H: the card's shape, moved by the offset, its edge softened across the
 *  blur, times the opacity. */
export function cardShadowPicture(c: CardLook, f: Framing | null, W: number, H: number): Uint8Array {
  const s = { ...SHADOW_DEFAULTS, ...c.shadow };
  const S = Math.min(W, H), box = cardScreenBox(c, f, W, H);
  const a: Area = { shape: "rect", x: (box.x + s.x * S) / W, y: (box.y + s.y * S) / H, w: box.w / W, h: box.h / H, feather: s.blur * 2, ...(c.radius ? { radius: c.radius } : {}) };
  const cov = areaCoverage(a, W, H), out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(cov[i] * s.opacity * 255);
  return out;
}

/** The border as coverage 0-255 at W x H: a ring just inside the card's edge, `width` wide. */
export function cardBorderPicture(c: CardLook, f: Framing | null, W: number, H: number): Uint8Array {
  const S = Math.min(W, H), box = cardScreenBox(c, f, W, H), w = (c.border?.width ?? 0) * S;
  const outer: Area = { shape: "rect", x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H, ...(c.radius ? { radius: c.radius } : {}) };
  const ix = box.x + w, iy = box.y + w, iw = Math.max(1, box.w - 2 * w), ih = Math.max(1, box.h - 2 * w);
  // The inner edge keeps the same corner centres: its radius is the outer one less the width.
  const rOut = Math.min(box.w, box.h) * (c.radius ?? 0), rIn = Math.max(0, rOut - w);
  const inner: Area = { shape: "rect", x: ix / W, y: iy / H, w: iw / W, h: ih / H, ...(rIn ? { radius: rIn / Math.min(iw, ih) } : {}) };
  const o = areaCoverage(outer, W, H), n = areaCoverage(inner, W, H), out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.max(0, o[i] - n[i]) * 255);
  return out;
}

const rgbOf = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** A linear gradient as RGB at W x H, by the CSS rule: the line through the centre at `angle`, long enough that the
 *  corners land on its ends; colours mixed in sRGB. */
export function gradientPicture(g: { from: string; to: string; angle?: number }, W: number, H: number): Uint8Array {
  const a = ((g.angle ?? 180) * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const L = Math.abs(W * dx) + Math.abs(H * dy);
  const [r0, g0, b0] = rgbOf(g.from), [r1, g1, b1] = rgbOf(g.to);
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = Math.min(1, Math.max(0, ((x + 0.5 - W / 2) * dx + (y + 0.5 - H / 2) * dy) / L + 0.5));
    const i = (y * W + x) * 3;
    out[i] = Math.round(r0 + (r1 - r0) * t); out[i + 1] = Math.round(g0 + (g1 - g0) * t); out[i + 2] = Math.round(b0 + (b1 - b0) * t);
  }
  return out;
}

/** RGB as a binary PPM file (FFmpeg reads it as a picture). */
export function ppm(px: Uint8Array, W: number, H: number): Uint8Array {
  const head = new TextEncoder().encode(`P6\n${W} ${H}\n255\n`);
  const out = new Uint8Array(head.length + px.length);
  out.set(head, 0); out.set(px, head.length);
  return out;
}

/** Background blur (1-100) as a Gaussian sigma in pixels at W x H: 100 = 4% of the short side. */
export const backgroundSigma = (amount: number, W: number, H: number) => Math.max(1, Math.round((amount / 100) * 0.04 * Math.min(W, H) * 100) / 100);
/** How much the blurred picture is scaled up: three blur widths a side, so the soft edges a blur makes (FFmpeg and the
 *  browser treat a picture's edges differently) stay outside the frame in both. */
export const backgroundScale = (sigma: number, W: number, H: number) => Math.round((1 + (6 * sigma) / Math.min(W, H)) * 1000) / 1000;

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
export function cardLookText(c: CardLook): string {
  const b = cardBox(c), parts: string[] = [];
  if (b.x || b.y || b.w < 1 || b.h < 1) parts.push(`cropped to ${pct(b.w)}x${pct(b.h)} at ${pct(b.x)},${pct(b.y)}`);
  if (c.radius) parts.push(`corners ${pct(c.radius)}`);
  if (c.shadow) { const s = { ...SHADOW_DEFAULTS, ...c.shadow }; parts.push(`shadow ${s.color} ${Math.round(s.opacity * 100)}% blur ${pct(s.blur)}${s.x || s.y ? ` offset ${pct(s.x)},${pct(s.y)}` : ""}`); }
  if (c.border) parts.push(`border ${c.border.color} ${pct(c.border.width)}`);
  return parts.join(", ") || "plain";
}
export function backgroundText(b: Background | null | undefined, videoName?: (id: string) => string | undefined): string {
  if (!b) return "black";
  if (b.color) return b.color;
  if (b.gradient) return `gradient ${b.gradient.from} to ${b.gradient.to} at ${b.gradient.angle ?? 180}°`;
  if (b.videoId) return `video ${b.videoId}${videoName?.(b.videoId) ? ` "${videoName(b.videoId)}"` : ""} (looped)`;
  return `the clip's own picture, blurred ${b.blur}`;
}
