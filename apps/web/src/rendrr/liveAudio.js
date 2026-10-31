// Phase 15: a clip's own pan, EQ and reverb heard live in the editor, with the render's numbers. Each media element that
// plays a clip with any of them goes once through a Web Audio chain: the EQ as the same RBJ biquads FFmpeg's bass,
// equalizer and treble use (eqBiquads), then the balance pan (panGains), then the dry sound plus the same room the
// render convolves with (reverbIr, seeded by size, so the same size is the same room), at the same level (reverbWet).
// An element is routed only when a clip it plays needs it (a routed element always plays through the chain), and its
// settings follow the clip under the playhead. The elements already ask for their media with CORS (crossOrigin), which
// Web Audio needs to hear them.
import { eqBiquads, panGains, reverbIr, reverbWet } from "@rendrr/shared";

let ctx = null;
const chains = new WeakMap();
const rooms = new Map();
const SLOTS = 7; // three fixed bands and four parametric ones

function audioCtx() {
  if (ctx) return ctx;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  ctx = new C({ latencyHint: "interactive" });
  return ctx;
}
/** Starts the context on a user gesture (play) where the browser holds it suspended. */
export function resumeLiveAudio() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }

function roomOf(c, size) {
  const k = `${size}|${c.sampleRate}`;
  if (rooms.has(k)) return rooms.get(k);
  const [l, r] = reverbIr(size, c.sampleRate), buf = c.createBuffer(2, l.length, c.sampleRate);
  buf.copyToChannel(l, 0); buf.copyToChannel(r, 1);
  rooms.set(k, buf);
  return buf;
}

function chainFor(el) {
  let ch = chains.get(el);
  if (ch) return ch;
  const c = audioCtx();
  if (!c) return null;
  let src;
  try { src = c.createMediaElementSource(el); } catch { return null; }
  const eq = Array.from({ length: SLOTS }, () => { const b = c.createBiquadFilter(); b.type = "peaking"; b.gain.value = 0; return b; });
  for (let i = 0; i < SLOTS - 1; i++) eq[i].connect(eq[i + 1]);
  src.connect(eq[0]);
  // Balance: each side its own gain (the far side goes down, the near one stays), as pan=stereo|c0=..|c1=.. does.
  const split = c.createChannelSplitter(2), gl = c.createGain(), gr = c.createGain(), merge = c.createChannelMerger(2);
  eq[SLOTS - 1].connect(split); split.connect(gl, 0); split.connect(gr, 1); gl.connect(merge, 0, 0); gr.connect(merge, 0, 1);
  const dry = c.createGain(), conv = c.createConvolver(), wet = c.createGain();
  conv.normalize = false; wet.gain.value = 0;
  merge.connect(dry); merge.connect(conv); conv.connect(wet);
  dry.connect(c.destination); wet.connect(c.destination);
  ch = { eq, gl, gr, conv, wet, size: null };
  chains.set(el, ch);
  return ch;
}

// Smoothly while the context runs (no clicks when a clip's settings change mid-play); at once while it is suspended.
const set = (p, v, c) => { if (Math.abs(p.value - v) <= 1e-4) return; if (c.state === "running") p.setTargetAtTime(v, c.currentTime, 0.015); else p.value = v; };

/**
 * Plays `el` through the chain with this clip's pan, EQ and reverb (fx: { pan, eq, reverb: { amount, size } }), or
 * flat when fx has none. Elements that never needed any are left as they are. Returns whether it is routed.
 */
export function applyLiveFx(el, fx) {
  if (!el) return false;
  const want = !!fx && (!!fx.pan || eqBiquads(fx.eq).length > 0 || !!fx.reverb?.amount);
  if (!want && !chains.has(el)) return false;
  const ch = chainFor(el);
  if (!ch) return false;
  const c = ctx;
  const bands = want ? eqBiquads(fx.eq) : [];
  ch.eq.forEach((b, i) => {
    const x = bands[i];
    if (!x) { set(b.gain, 0, c); return; }
    if (b.type !== x.type) b.type = x.type;
    set(b.frequency, x.f, c); set(b.Q, x.q, c); set(b.gain, x.gain, c);
  });
  const [l, r] = panGains(want ? fx.pan ?? 0 : 0);
  set(ch.gl.gain, l, c); set(ch.gr.gain, r, c);
  const rv = want ? fx.reverb : null;
  if (rv?.amount) {
    const size = rv.size ?? 40;
    if (ch.size !== size) { ch.conv.buffer = roomOf(c, size); ch.size = size; }
    set(ch.wet.gain, reverbWet(rv.amount), c);
  } else set(ch.wet.gain, 0, c);
  return true;
}

/** For tests: the chain's settings on an element (null when it is not routed). */
export function liveFxState(el) {
  const ch = chains.get(el);
  if (!ch) return null;
  return { eq: ch.eq.map((b) => ({ type: b.type, f: Math.round(b.frequency.value), gain: +b.gain.value.toFixed(2), q: +b.Q.value.toFixed(3) })).filter((b) => b.gain), left: +ch.gl.gain.value.toFixed(3), right: +ch.gr.gain.value.toFixed(3), wet: +ch.wet.gain.value.toFixed(4), room: ch.size };
}
if (typeof window !== "undefined") window.__rendrrLiveFx = liveFxState;
