// Frames on the timeline's V1 clips, like Premiere's and CapCut's filmstrips: each clip shows its own footage, a frame
// every tile, drawn in the browser from the preview copy the editor already plays (no server work, any video). Frames
// are grabbed by one hidden video per source, in the order they are asked for, only for clips on screen, and kept
// (by source and half second) for the session.
import { useEffect, useRef, useState, html } from "./ui";

const TILE_H = 54, TILE_W = 96; // what a frame is drawn at (the clip shows it scaled to its own height)
const cache = new Map(); // url -> Map(key -> dataURL)
const grabbers = new Map(); // url -> { video, queue, busy }
const waiters = new Map(); // url|key -> [resolve]

const keyOf = (t) => Math.round(t * 2) / 2; // half-second steps: neighbouring tiles and zoom levels share frames

function grabberFor(url) {
  let g = grabbers.get(url);
  if (g) return g;
  const video = document.createElement("video");
  Object.assign(video, { crossOrigin: "anonymous", muted: true, preload: "auto", playsInline: true, src: url });
  const canvas = document.createElement("canvas"); canvas.width = TILE_W; canvas.height = TILE_H;
  g = { video, canvas, queue: [], busy: false, failed: false };
  video.addEventListener("error", () => { g.failed = true; for (const k of g.queue) settle(url, k, null); g.queue = []; });
  grabbers.set(url, g);
  return g;
}

function settle(url, k, data) {
  const id = url + "|" + k, list = waiters.get(id) || [];
  waiters.delete(id);
  for (const r of list) r(data);
}

async function pump(url) {
  const g = grabberFor(url);
  if (g.busy || g.failed) return;
  g.busy = true;
  while (g.queue.length) {
    const k = g.queue.shift();
    if (cache.get(url)?.has(k)) { settle(url, k, cache.get(url).get(k)); continue; }
    const data = await new Promise((resolve) => {
      const v = g.video, done = () => { v.removeEventListener("seeked", onSeek); clearTimeout(timer); };
      const onSeek = () => {
        done();
        try {
          const c = g.canvas.getContext("2d"), vw = v.videoWidth || 16, vh = v.videoHeight || 9, s = Math.max(TILE_W / vw, TILE_H / vh);
          c.drawImage(v, (TILE_W - vw * s) / 2, (TILE_H - vh * s) / 2, vw * s, vh * s);
          resolve(g.canvas.toDataURL("image/jpeg", 0.7));
        } catch { resolve(null); } // a source without CORS taints the canvas: no frames, the clip stays plain
      };
      const timer = setTimeout(() => { done(); resolve(null); }, 4000);
      v.addEventListener("seeked", onSeek);
      const go = () => { try { v.currentTime = Math.min(Math.max(0, k), Math.max(0, (v.duration || k + 1) - 0.05)); } catch { done(); resolve(null); } };
      if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
    });
    if (!cache.has(url)) cache.set(url, new Map());
    if (data) cache.get(url).set(k, data);
    settle(url, k, data);
  }
  g.busy = false;
}

/** The frame of `url` at `t` seconds (a data URL), or null when it cannot be drawn. */
export function frameAt(url, t) {
  const k = keyOf(t), have = cache.get(url)?.get(k);
  if (have) return Promise.resolve(have);
  return new Promise((resolve) => {
    const id = url + "|" + k;
    if (!waiters.has(id)) { waiters.set(id, []); grabberFor(url).queue.push(k); }
    waiters.get(id).push(resolve);
    pump(url);
  });
}

/** A V1 clip's frames: tiles across its width, each the footage at its place in the clip. Draws only once on screen. */
export function Filmstrip({ url, from, to, width, height = 26 }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  const [frames, setFrames] = useState({});
  const tileW = Math.round((height * 16) / 9);
  const n = url && width > 6 ? Math.min(80, Math.max(1, Math.ceil(width / tileW))) : 0;
  const times = Array.from({ length: n }, (_, i) => from + ((i + 0.5) / n) * Math.max(0, to - from));
  useEffect(() => {
    if (!ref.current || seen) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (!seen || !n) return;
    let live = true;
    for (const t of times) frameAt(url, t).then((d) => { if (live && d) setFrames((f) => (f[keyOf(t)] ? f : { ...f, [keyOf(t)]: d })); });
    return () => { live = false; };
  }, [seen, url, from, to, n]);
  return html`<span class="strip" ref=${ref} aria-hidden="true">${times.map((t, i) => { const d = frames[keyOf(t)]; return html`<i key=${i} style=${{ width: tileW + "px", backgroundImage: d ? `url(${d})` : "none" }} />`; })}</span>`;
}
