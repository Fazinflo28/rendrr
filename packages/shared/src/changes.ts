// Show only the fix (audit #23). After a comment fix, the moments of the new preview that differ from the preview
// before it, so the user can check the fix in seconds before the whole preview plays.
//
// Both previews are compared through their plans, moment by moment (every STEP seconds of the new one): a moment is
// the same when the new preview shows the same moment of the same footage, with the same framing and look, the same
// layers over it (b-roll, graphics, text, captions, zooms, music, sound effects) at the same point in each, and the same
// sound. A cut that moved (words cut or put back) shows as a jump in where the old preview's matching moment is.
import type { RenderPlan } from "./renderPlan";

export type Moment = { from: number; to: number };

const STEP = 0.2, PAD = 1, JOIN = 1.5, MIN = 2, MOST = 0.6, SLACK = 0.06;
type Part = { videoId: string; srcIn: number; srcOut: number; start: number; end: number; rate?: number; clipIds?: string[]; clipId?: string; muted?: boolean; silent?: boolean; rotate?: number; framing?: unknown };
type Timed = { start: number; end: number };

const at = <T extends Timed>(list: T[] | undefined, t: number): T[] => (list || []).filter((x) => x.start <= t + 1e-6 && t < x.end - 1e-6);
const srcOf = (p: Part, t: number) => p.srcIn + (t - p.start) * (p.rate ?? 1);
const TIME_KEYS = new Set(["start", "end", "at", "t"]);
/** An item as text, its times counted from the moment `t` (so the same layer at the same point reads the same). */
const canon = (x: unknown, t: number) => JSON.stringify(x, function (k, v) {
  if (typeof v !== "number") return v;
  return TIME_KEYS.has(k) ? Math.round((v - t) * 10) / 10 : Math.round(v * 1000) / 1000;
});
const LAYERS = ["broll", "graphics", "under", "zooms", "audio", "texts", "adjust", "transitions", "textMattes", "dialogueMutes"] as const;

function layersAt(plan: RenderPlan, t: number): string {
  const p = plan as unknown as Record<string, Timed[] | undefined>;
  const out: string[] = [];
  for (const k of LAYERS) for (const x of at(p[k], t)) out.push(k + canon(x, t));
  // Captions: the word on screen, not how the words are grouped (one word cut regroups every caption after it).
  if (plan.styledCaptions?.length) {
    for (const c of at(plan.styledCaptions, t)) { const ws = c.lines.flat().filter((w) => w.start <= t + 1e-6); out.push("cap:" + (ws.length ? ws[ws.length - 1].text : "")); }
  } else if (at(plan.captions, t).length) out.push("cap");
  for (const x of at(plan.audioMix?.dialogue as unknown as Timed[] | undefined, t)) out.push("dia" + canon(x, t));
  return out.sort().join("|");
}
function partLook(plan: RenderPlan, p: Part, t: number): string {
  const id = p.clipIds?.[0];
  return canon({ rotate: p.rotate ?? 0, framing: p.framing ?? null, rate: p.rate ?? 1, look: id ? plan.looks?.[id] ?? null : null, card: id ? plan.cards?.[id] ?? null : null, motion: id ? plan.clipMotion?.[id] ?? null : null }, t);
}
function soundAt(plan: RenderPlan, t: number): { videoId: string | null; src: number } {
  const s = at(plan.sound as unknown as Part[], t)[0];
  if (!s || s.muted || s.silent) return { videoId: null, src: 0 };
  return { videoId: s.videoId, src: srcOf(s, t) };
}
/** Where a moment of footage plays in a plan: every edit time showing it. */
function timesOf(plan: RenderPlan, videoId: string, src: number): number[] {
  const out: number[] = [];
  for (const p of plan.parts as unknown as Part[]) {
    if (p.videoId !== videoId) continue;
    const r = p.rate ?? 1, t = p.start + (src - p.srcIn) / r;
    if (t >= p.start - 1e-6 && t < p.end - 1e-6) out.push(t);
  }
  return out;
}
const closest = (xs: number[], want: number) => xs.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), xs[0]);
/** What the whole edit looks and sounds like (size, caption style, background, mix): a change there changes it all. */
const whole = (plan: RenderPlan) => {
  const { speech: _s, dialogue: _d, clipFx: _c, ...mix } = (plan.audioMix || {}) as Record<string, unknown>;
  return canon({ w: plan.width, h: plan.height, aspect: plan.aspect, style: plan.captionStyle ?? null, look: plan.captionLook ?? null, bg: plan.background ?? null, mix }, 0);
};

/** Moments as windows to watch: joined when close, padded, at least MIN long, inside the preview. */
function windows(times: number[], total: number): Moment[] {
  const ts = [...times].sort((a, b) => a - b), raw: Moment[] = [];
  for (const t of ts) {
    const last = raw[raw.length - 1];
    if (last && t - last.to <= JOIN) last.to = Math.max(last.to, t + STEP); else raw.push({ from: t, to: t + STEP });
  }
  const out: Moment[] = [];
  for (const w of raw) {
    let from = Math.max(0, w.from - PAD), to = Math.min(total, w.to + PAD);
    if (to - from < MIN) { const mid = (from + to) / 2; from = Math.max(0, mid - MIN / 2); to = Math.min(total, from + MIN); from = Math.max(0, to - MIN); }
    const last = out[out.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to); else out.push({ from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 });
  }
  return out;
}

/** A moment of the old preview (a comment's time) in the new one: where the same footage plays now, or the cut that
 *  took it out. Null when that footage is not in the new preview at all. */
export function mapMoment(old: RenderPlan, next: RenderPlan, t: number): number | null {
  const p = at(old.parts as unknown as Part[], t)[0];
  if (!p) return null;
  const src = srcOf(p, t), here = timesOf(next, p.videoId, src);
  if (here.length) return Math.round(closest(here, t) * 100) / 100;
  let best: { d: number; t: number } | null = null;
  for (const q of next.parts as unknown as Part[]) {
    if (q.videoId !== p.videoId) continue;
    const lo = Math.min(q.srcIn, q.srcOut), hi = Math.max(q.srcIn, q.srcOut);
    const d = src < lo ? lo - src : src - hi, tt = src < lo ? q.start : q.end;
    if (!best || d < best.d || (d === best.d && Math.abs(tt - t) < Math.abs(best.t - t))) best = { d, t: tt };
  }
  return best ? Math.round(Math.min(best.t, next.outputSeconds) * 100) / 100 : null;
}

/**
 * The moments of `next` that differ from `old`, as windows to watch (edit seconds of `next`), with `also` (moments of
 * `next` to show anyway, such as the fixed comments) added. Null when there is nothing to compare, or when so much
 * changed that the whole preview is the thing to watch.
 */
export function changedMoments(old: RenderPlan | null | undefined, next: RenderPlan | null | undefined, also: number[] = []): Moment[] | null {
  if (!old?.parts || !next?.parts || !(next.outputSeconds > 0)) return null;
  if (whole(old) !== whole(next)) return null;
  const total = next.outputSeconds, changed: number[] = [...also.filter((t) => t >= 0 && t <= total)];
  let prev: number | undefined;
  const mark = (t: number) => { changed.push(t); };
  for (let t = 0; t < total - 1e-6; t += STEP) {
    const p = at(next.parts as unknown as Part[], t)[0];
    if (!p) { if (prev !== undefined && at(old.parts as unknown as Part[], prev + STEP).length) mark(t); prev = prev === undefined ? undefined : prev + STEP; continue; }
    const cands = timesOf(old, p.videoId, srcOf(p, t));
    if (!cands.length) { mark(t); prev = undefined; continue; }
    const c = closest(cands, prev === undefined ? t : prev + STEP);
    if (prev === undefined ? t === 0 && c > SLACK : Math.abs(c - (prev + STEP)) > SLACK) { mark(t); if (t >= STEP) mark(t - STEP); }
    prev = c;
    const q = at(old.parts as unknown as Part[], c)[0];
    if (!q || partLook(next, p, t) !== partLook(old, q, c)) { mark(t); continue; }
    if (layersAt(next, t) !== layersAt(old, c)) { mark(t); continue; }
    const a = soundAt(next, t), b = soundAt(old, c);
    if (a.videoId !== b.videoId || (a.videoId && Math.abs(a.src - b.src) > 0.05)) mark(t);
  }
  // The old preview ran on past where the new one ends (its end was cut).
  if (prev !== undefined && old.outputSeconds - (prev + STEP) > 0.3) mark(Math.max(0, total - STEP));
  const out = windows(changed, total);
  const seconds = out.reduce((s, w) => s + (w.to - w.from), 0);
  return seconds > MOST * total ? null : out;
}
