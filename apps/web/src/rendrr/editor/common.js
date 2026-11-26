// Shared bits of the editor: undo history, the track and tool lists, comment drawings and small helpers.
// Moved out of editor.js unchanged (audit #30): the editor imports it from here.
import { html, useCallback, useState } from "../ui";
// Web addresses in a comment as links (they open in a new tab); the rest stays text.
function linkified(text) {
  const out = [], re = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
  let last = 0, m;
  while ((m = re.exec(text || ""))) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""), href = /^https?:/i.test(url) ? url : "https://" + url;
    out.push(text.slice(last, m.index), html`<a href=${href} target="_blank" rel="noopener noreferrer">${url}</a>`);
    last = m.index + url.length; re.lastIndex = last;
  }
  out.push((text || "").slice(last));
  return out;
}
// Undo and redo over the whole edit state. `replace` changes without a history entry (typing), `commit` adds one.
function useHistory(initial) {
  const [h, setH] = useState({ past: [], present: initial, future: [] });
  const commit = useCallback((next) => setH((x) => { const p = typeof next === "function" ? next(x.present) : next; if (p === x.present) return x; return { past: [...x.past.slice(-60), x.present], present: p, future: [] }; }), []);
  const replace = useCallback((next) => setH((x) => ({ ...x, present: typeof next === "function" ? next(x.present) : next })), []);
  const commitFrom = useCallback((base) => setH((x) => (base === x.present ? x : { past: [...x.past.slice(-60), base], present: x.present, future: [] })), []);
  const undo = useCallback(() => setH((x) => (x.past.length ? { past: x.past.slice(0, -1), present: x.past[x.past.length - 1], future: [x.present, ...x.future] } : x)), []);
  const redo = useCallback(() => setH((x) => (x.future.length ? { past: [...x.past, x.present], present: x.future[0], future: x.future.slice(1) } : x)), []);
  return { state: h.present, commit, replace, commitFrom, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
const TRACKS = [["v3", "V3"], ["v2", "V2"], ["v1", "V1"], ["a1", "A1"], ["a2", "A2"], ["a3", "A3"]];
/** Timeline zoom in pixels a second: down to the whole edit, up to the 10 ms frames of the waveform (6 px each). */
const ZMIN = 4, ZMAX = 600;
/** Each track's height in pixels (the dialogue is taller: its waveform). */
const TRACK_H = { a1: 56, a2: 40, a3: 34, vo: 40 };
const TRACK_HINT = { v1: "Main cut", v2: "B-roll, effects", v3: "Titles", a1: "Dialogue", a2: "Music", a3: "Sound FX", bg: "Behind the picture", vo: "Your sound file, in place of the clips' own" };
// Premiere's tools and keys.
const TOOL_ICON = { select: "select", razor: "razor", ripple: "ripple", roll: "roll", slip: "slip", slide: "slide" };
const TOOLS = [["select", "V", "Select", "Click to select, drag a clip to reorder it, drag an edge to trim"], ["razor", "C", "Razor", "Click a clip to split it there"], ["ripple", "B", "Ripple", "Drag an edge: the clip gets longer or shorter and the edit closes up"], ["roll", "N", "Rolling", "Drag a cut: one clip gets longer, the next shorter"], ["slip", "Y", "Slip", "Drag a clip: same place and length, other footage"], ["slide", "U", "Slide", "Drag a clip between its neighbours"]];
const SHORTCUTS = [["Space", "Play or pause"], ["J", "Back 5 seconds"], ["K", "Pause"], ["L", "Forward 5 seconds"], ["Left / Right", "Back or forward one frame"], ["Shift + Left / Right", "Back or forward one second"], ["Home / End", "Go to the start or the end"], ["+ / -", "Zoom the timeline in or out"], ...TOOLS.map(([, k, l, d]) => [k, `${l}: ${d.charAt(0).toLowerCase() + d.slice(1)}`]), ["S", "Snapping on or off"], ["Shift Z", "Zoom the timeline to fit"], ["Cmd K", "Split at the playhead"], ["Alt drag", "Drag a dialogue edge: J or L cut"], ["Delete", "Cut selected words or clip"], ["Cmd Z", "Undo"], ["Cmd Shift Z", "Redo"], ["?", "Show shortcuts"]];
// The right panel, like Higgsfield's: Edit and Comments. Edit lists the tools in two groups, each opens on its own page
// with a back arrow. Tool key: label, icon.
// The comment composer: pen colours (as the app in the chat), quick emoji, and a picture made small enough to keep.
const PENS = ["#ff3b30", "#ffd60a", "#34c759", "#0a84ff", "#ffffff"];
const EMOJI = ["👍", "👎", "❤️", "🔥", "😂", "😮", "👀", "✅", "❌", "⚠️", "✂️", "🎵", "🎬", "💡", "⏩", "⏪"];
/** A comment's drawing as a clear PNG the size of the picture (up to 1280 wide), base64: the AI sees it on the frame. */
function drawingPng(d) {
  try {
    const W = Math.min(1280, d.w), H = Math.max(1, Math.round((W * d.h) / d.w));
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d"); if (!g) return null;
    g.lineCap = "round"; g.lineJoin = "round";
    for (const st of d.strokes) {
      g.strokeStyle = st.c; g.lineWidth = Math.max(1, st.w * W); g.beginPath();
      for (let k = 0; k + 1 < st.p.length; k += 2) { const x = st.p[k] * W, y = st.p[k + 1] * H; k ? g.lineTo(x, y) : g.moveTo(x, y); }
      if (st.p.length === 2) g.lineTo(st.p[0] * W + 0.1, st.p[1] * H);
      g.stroke();
    }
    return cv.toDataURL("image/png").split(",")[1] || null;
  } catch { return null; }
}

async function readCommentImage(file) {
  const b64 = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
  const bmp = await createImageBitmap(file);
  let w = bmp.width, h = bmp.height, type = file.type, data;
  if (file.size <= 1_000_000 && Math.max(w, h) <= 2400) data = await b64(file);
  else {
    const k = Math.min(1, 1600 / Math.max(w, h)), cv = document.createElement("canvas");
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    type = "image/jpeg"; w = cv.width; h = cv.height;
    data = cv.toDataURL("image/jpeg", 0.85).split(",")[1];
    if (data.length > 1_400_000) data = cv.toDataURL("image/jpeg", 0.6).split(",")[1];
  }
  const t = document.createElement("canvas"); t.width = 96; t.height = 72;
  const tk = Math.max(96 / bmp.width, 72 / bmp.height);
  t.getContext("2d").drawImage(bmp, (96 - bmp.width * tk) / 2, (72 - bmp.height * tk) / 2, bmp.width * tk, bmp.height * tk);
  return { local: Math.random().toString(36).slice(2), type, data, name: file.name || null, w, h, thumb: t.toDataURL("image/jpeg", 0.8) };
}

// The editor is laid out like Instagram Edits' desktop app: a rail of tools on the left, each opening its tool in the
// panel beside it (Media first; X closes it); the player in the middle; the inspector on the right, with the settings
// of what is selected on the timeline; the timeline across the bottom, its tools in one bar above it.
// Rail: key, label, icon. Comments and what your AI did are in the right panel.
const RAIL = [["media", "Media", "rMedia"], ["audio", "Audio", "rAudio"], ["text", "Text", "rText"], ["captions", "Captions", "rCaptions"], ["color", "Color", "rColor"], ["multicam", "Multicam", "rMulticam"], ["transcript", "Transcript", "rTranscript"]];
const PANEL_TOOLS = Object.fromEntries(RAIL.map(([k, l, ic]) => [k, [l, ic]]));
// A tab remembered from the old layout opens Media (the clip's settings are in the inspector now).
const railTab = (t) => (t === null ? null : PANEL_TOOLS[t] ? t : "media");
const ASPECT_NAMES = { "9:16": "Reels, TikTok, Shorts", "16:9": "YouTube, broadcast", "4:5": "Instagram feed", "1:1": "Square" };
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export { ASPECT_NAMES, EMOJI, PANEL_TOOLS, PENS, RAIL, SHORTCUTS, TOOLS, TOOL_ICON, TRACKS, TRACK_H, TRACK_HINT, ZMAX, ZMIN, clamp, drawingPng, linkified, r2, railTab, readCommentImage, useHistory };
