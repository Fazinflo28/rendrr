// Pins: a comment left on a spot of the picture (x, y in shares of the frame, 0-1 from the top left) at a moment of
// the edit. layersAt says what is on screen at that moment and which of it sits under the spot, so an AI reading the
// comment knows exactly which clip, graphic, text or caption it is about.
import { cornersOf, keyTracks, motionAt, type Key } from "./motion";
import { isCaptionMarker, type Timeline } from "./timeline";

export type PinPoint = { x: number; y: number };
export type PinLayer = {
  track: "v1" | "v2" | "v3";
  id: string;
  /** footage (V1), broll, zoom, graphic, text, caption, adjust */
  kind: string;
  label: string;
  start: number;
  end: number;
  /** "covers": the spot is on it; "near": close to it (text and captions, whose box is only estimated); "off": on
   *  screen at that moment but elsewhere on the picture. */
  hit: "covers" | "near" | "off";
  /** Where it sits on the frame (shares), when it can be worked out. */
  box?: { x0: number; y0: number; x1: number; y1: number };
};

type AnyClip = { id: string; start: number; end: number; label?: string; kind?: string; keys?: Key[]; under?: boolean; text?: string; style?: { x?: number; y?: number; size?: number; align?: string }; videoId?: string; graphicId?: string };

const inQuad = (q: [number, number][], x: number, y: number) => {
  // corners: top-left, top-right, bottom-left, bottom-right; walked round as a convex polygon.
  const poly = [q[0], q[1], q[3], q[2]];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % 4];
    const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
};
const boxOf = (q: [number, number][]) => {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { x0: r(Math.min(...xs)), y0: r(Math.min(...ys)), x1: r(Math.max(...xs)), y1: r(Math.max(...ys)) };
};

/**
 * What is on screen at edit second `t` of a laid-out timeline (layoutTimeline of asSequence: clips carry edit
 * start/end), top layer first, each marked by whether it sits under `pin`. `aspect`: the frame's width / height.
 */
export function layersAt(tl: Timeline, t: number, pin: PinPoint, aspect = 16 / 9): PinLayer[] {
  const out: PinLayer[] = [];
  const on = (c: AnyClip) => t >= c.start - 0.02 && t <= c.end + 0.02;
  const label = (c: AnyClip) => String(c.label || c.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const { x, y } = pin;
  const moved = (c: AnyClip) => cornersOf(motionAt(keyTracks(c.keys), Math.max(0, t - c.start)), 1, 1);
  const v3 = (tl.tracks.v3 as unknown as AnyClip[]).filter(on);
  // Captions are drawn last (on top), then the other V3 layers, the later ones over the earlier ones.
  const caps = v3.filter((c) => isCaptionMarker("v3", c as never));
  const capY = (tl as unknown as { captionStyle?: { y?: number } }).captionStyle?.y ?? 0.87;
  for (const c of caps) {
    const box = { x0: 0.08, y0: Math.max(0, capY - 0.14), x1: 0.92, y1: Math.min(1, capY + 0.03) };
    const hit = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 ? "near" : "off";
    out.push({ track: "v3", id: c.id, kind: "caption", label: label(c), start: c.start, end: c.end, hit, box });
  }
  for (const c of v3.filter((c) => !isCaptionMarker("v3", c as never)).reverse()) {
    const kind = c.kind || (c.graphicId ? "graphic" : c.text ? "text" : "graphic");
    if (kind === "adjust") { out.push({ track: "v3", id: c.id, kind, label: label(c), start: c.start, end: c.end, hit: "covers" }); continue; }
    if (kind === "text") {
      // The point the text hangs on, moved by its keys; its box is estimated from its size and length.
      const m = motionAt(keyTracks(c.keys), Math.max(0, t - c.start));
      const ax = (c.style?.x ?? 0.5) + m.x, ay = (c.style?.y ?? 0.5) + m.y;
      const size = ((c.style?.size ?? 6) / 100) * m.scale * (aspect >= 1 ? 1 : aspect); // share of the frame's height
      const lines = String(c.text || "").split("\n");
      const w = Math.min(1, (Math.max(...lines.map((l) => l.length)) * size * 0.55) / Math.max(aspect, 1e-3) + 0.04); // share of the width
      const hgt = lines.length * size * 1.3 + 0.04;
      const x0 = c.style?.align === "left" ? ax : c.style?.align === "right" ? ax - w : ax - w / 2;
      const box = { x0: Math.max(0, x0), y0: Math.max(0, ay - hgt / 2), x1: Math.min(1, x0 + w), y1: Math.min(1, ay + hgt / 2) };
      const hit = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 ? "near" : "off";
      out.push({ track: "v3", id: c.id, kind, label: label(c), start: c.start, end: c.end, hit, box });
      continue;
    }
    const q = moved(c);
    out.push({ track: "v3", id: c.id, kind, label: label(c), start: c.start, end: c.end, hit: inQuad(q, x, y) ? "covers" : "off", box: boxOf(q) });
  }
  const v2 = (tl.tracks.v2 as unknown as AnyClip[]).filter(on);
  const over = v2.filter((c) => !c.under), under = v2.filter((c) => c.under);
  for (const c of over.reverse()) {
    if (c.kind === "zoom") { out.push({ track: "v2", id: c.id, kind: "zoom", label: label(c), start: c.start, end: c.end, hit: "covers" }); continue; }
    const q = moved(c);
    out.push({ track: "v2", id: c.id, kind: c.kind || "broll", label: label(c), start: c.start, end: c.end, hit: inQuad(q, x, y) ? "covers" : "off", box: boxOf(q) });
  }
  for (const c of (tl.tracks.v1 as unknown as AnyClip[]).filter(on).slice(0, 1)) {
    const q = moved(c);
    out.push({ track: "v1", id: c.id, kind: "footage", label: label(c), start: c.start, end: c.end, hit: inQuad(q, x, y) ? "covers" : "off", box: boxOf(q) });
  }
  for (const c of under.reverse()) {
    const q = moved(c);
    out.push({ track: "v2", id: c.id, kind: (c.kind || "broll") + " (behind V1)", label: label(c), start: c.start, end: c.end, hit: inQuad(q, x, y) ? "covers" : "off", box: boxOf(q) });
  }
  return out;
}

const pct = (v: number) => Math.round(v * 100) + "%";
/** Where a pin is, in words: "42% across, 18% down (top left)". */
export function pinWhere(p: PinPoint): string {
  const h = p.x < 0.34 ? "left" : p.x > 0.66 ? "right" : "middle", v = p.y < 0.34 ? "top" : p.y > 0.66 ? "bottom" : "middle";
  return `${pct(p.x)} across, ${pct(p.y)} down (${v === h ? "centre" : v + " " + h})`;
}

/** layersAt in one line for an AI: what the spot is on (top first), then what else is on screen. */
export function pinLayersText(ls: PinLayer[]): string {
  const f = (n: number) => n.toFixed(2);
  const one = (l: PinLayer) => `${l.track} ${l.kind} ${l.id}${l.label ? ` "${l.label}"` : ""} ${f(l.start)}-${f(l.end)}s`;
  const under = ls.filter((l) => l.hit !== "off"), other = ls.filter((l) => l.hit === "off");
  const top = under.find((l) => l.kind !== "zoom" && l.kind !== "adjust") ?? under[0];
  return [
    under.length ? `under the pin (top first): ${under.map((l) => one(l) + (l.hit === "near" ? " (near)" : "")).join("; ")}` : "under the pin: nothing found",
    top ? `most likely about: ${top.track} ${top.kind} ${top.id}` : "",
    other.length ? `also on screen elsewhere: ${other.map(one).join("; ")}` : "",
  ].filter(Boolean).join(" | ");
}
