// Premiere parity, phase 4: blend modes and opacity on the layers over the picture (b-roll on V2, graphics on V3).
// The formulas are the W3C compositing ones (what CSS mix-blend-mode draws in the editor, and Premiere's and
// Photoshop's): base is the picture under the layer, layer the layer's colour, both 0-1. The render uses FFmpeg's blend
// filter where its mode is the same formula (top and bottom in the order that makes it so), and an expression where it
// is not (soft light).
import { z } from "zod";

export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "soft-light", "hard-light", "add", "lighten", "darken", "difference", "exclusion", "color-dodge", "color-burn"] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
export const BlendModeSchema = z.enum(BLEND_MODES);

/** One channel of the result where the layer is fully opaque. */
export function blendPixel(mode: BlendMode, base: number, layer: number): number {
  const b = base, s = layer;
  switch (mode) {
    case "normal": return s;
    case "multiply": return b * s;
    case "screen": return b + s - b * s;
    case "overlay": return blendPixel("hard-light", s, b);
    case "hard-light": return s <= 0.5 ? b * 2 * s : blendPixel("screen", b, 2 * s - 1);
    case "soft-light": {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    }
    case "add": return Math.min(1, b + s);
    case "lighten": return Math.max(b, s);
    case "darken": return Math.min(b, s);
    case "difference": return Math.abs(b - s);
    case "exclusion": return b + s - 2 * b * s;
    case "color-dodge": return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case "color-burn": return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
  }
}

/** The result with the layer's alpha (0-1, its own alpha times its opacity): mixed with the picture under it. */
export const composite = (mode: BlendMode, base: number, layer: number, alpha: number) => base + (blendPixel(mode, base, layer) - base) * alpha;

/** CSS mix-blend-mode for the editor's player. */
export const blendCss = (mode: BlendMode | undefined): string => (!mode || mode === "normal" ? "normal" : mode === "add" ? "plus-lighter" : mode);

/**
 * The render's blend filter for a mode: a built-in mode with the picture on top (top = the picture, bottom = the layer)
 * or, for dodge and burn, the layer on top (FFmpeg's dodge is bottom / (1 - top)); soft light as an expression (FFmpeg's
 * own soft light is another formula). max: 255 (8-bit RGB) or 65535 (16-bit).
 */
export function blendFilter(mode: Exclude<BlendMode, "normal">, max: number): { filter: string; layerOnTop: boolean } {
  const builtIn: Partial<Record<BlendMode, string>> = { multiply: "multiply", screen: "screen", overlay: "overlay", "hard-light": "hardlight", add: "addition", lighten: "lighten", darken: "darken", difference: "difference", exclusion: "exclusion", "color-dodge": "dodge", "color-burn": "burn" };
  if (builtIn[mode]) return { filter: `blend=all_mode=${builtIn[mode]}`, layerOnTop: mode === "color-dodge" || mode === "color-burn" };
  // Soft light (W3C): A is the picture, B the layer, both 0..max.
  const M = max, a = `(A/${M})`, s = `(B/${M})`;
  const d = `if(lte(${a},0.25),((16*${a}-12)*${a}+4)*${a},sqrt(${a}))`;
  const expr = `${M}*if(lte(${s},0.5),${a}-(1-2*${s})*${a}*(1-${a}),${a}+(2*${s}-1)*(${d}-${a}))`;
  return { filter: `blend=all_expr='${expr}'`, layerOnTop: false };
}

/** What a layer's blend says in text: "screen 60%", "70% opacity", or "" for normal at full opacity. */
export const blendText = (mode: BlendMode | undefined, opacity: number | undefined) => {
  const m = mode && mode !== "normal" ? mode : "", o = opacity != null && opacity < 1 ? `${Math.round(opacity * 100)}%` : "";
  return m ? `${m}${o ? " " + o : ""}` : o ? `${o} opacity` : "";
};
