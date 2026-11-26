// The @ footage picker in comment boxes. Typing @ (at the start or after a space) opens a list over the box: the
// client's footage folder first, then every library folder. A folder opens as a dropdown of its folders and clips; a
// clip shows its picture and plays a short muted preview on hover; clicking it puts @[name](clip:videoId) into the
// comment (shown as a chip), so the AI knows exactly which video to use. Typing after the @ searches clips by name.
// Keys: up and down move, Enter or Tab picks (or opens a folder), right and left open and close a folder, Escape closes.
// ClipMention listens to the box itself (inputRef), so a comment box needs only `value` and `onChange`.
import { React, html, useState, useEffect, useRef, useCallback, fmtLen } from "./ui";
import { createPortal } from "react-dom";
import { clipLabel, clipRefParts, encodeClipPicks, mentionAt } from "@rendrr/shared";
import { api } from "./api";

const W = 340, MAX_H = 380;
const folderCache = new Map(); // projectId -> { at, data }
const clipCache = new Map(); // key -> { at, data }
// The clips picked in each comment box (the box shows @label; encodeClips turns each into @[name](clip:id) to send).
const picksFor = new WeakMap(); // the box's element -> [{ label, id, name }]
/** The box's words as they are sent: each picked clip's @label becomes its reference (the clip's real id). */
export const encodeClips = (el, text) => encodeClipPicks(text || "", (el && picksFor.get(el)) || []);
/** Picks of a comment being edited again (its references shown as @label). */
export const rememberClips = (el, picks) => { if (el && picks?.length) picksFor.set(el, [...(picksFor.get(el) || []).filter((p) => !picks.some((q) => q.label === p.label)), ...picks]); };
const FRESH_MS = 60_000;
const len = (c) => (c.still ? "Picture" : fmtLen(c.seconds || 0));

async function cached(map, key, load) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.data;
  const data = await load();
  map.set(key, { at: Date.now(), data });
  return data;
}

/** A comment's text with each @clip as a chip; `plain` draws the words in between (links, for example). */
export function withClipChips(text, plain = (s) => s) {
  return clipRefParts(text).map((p, i) => (typeof p === "string" ? plain(p) : html`<span key=${"clip" + i} class="clip-chip" title=${p.name}>${FILM}${clipLabel(p.name)}</span>`));
}
const FILM = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M6.5 6.2v3.6L9.8 8z" fill="currentColor" /></svg>`;
const FOLDER = html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.7l1.5 1.6h4.8A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>`;

/** The clip's shape (width over height), from its size and orientation (a phone video stored sideways is turned). */
const ratioOf = (c) => {
  let r = c.w && c.h ? c.w / c.h : c.orientation === "Portrait" ? 9 / 16 : c.orientation === "Square" ? 1 : 16 / 9;
  if (c.orientation === "Portrait" && r > 1) r = 1 / r;
  if (c.orientation === "Landscape" && r < 1) r = 1 / r;
  return Math.min(3, Math.max(0.3, r));
};
const PREVIEW_LONG = 220; // px on the preview's long side

/** The floating preview over the cursor: the clip in its own shape (tall, wide, square), its picture at once, then
 *  the tiny hover clip playing silently on top. */
function HoverPreview({ c, at }) {
  const [r, setR] = useState(() => ratioOf(c));
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setR(ratioOf(c)); setPlaying(false); }, [c.id]);
  const w = r >= 1 ? PREVIEW_LONG : Math.round(PREVIEW_LONG * r), h = r >= 1 ? Math.round(PREVIEW_LONG / r) : PREVIEW_LONG;
  const vw = window.innerWidth;
  const left = Math.max(8, Math.min(at.x - w / 2, vw - w - 8));
  const vh = window.innerHeight;
  // Above the cursor; under it when there is no room above; always wholly inside the window.
  const above = at.y - h - 18 >= 8;
  const top = Math.max(8, Math.min(above ? at.y - h - 18 : at.y + 22, vh - h - 8));
  // The real shape, once the picture or the clip says it.
  const fix = (nw, nh) => { if (nw > 0 && nh > 0) setR(Math.min(3, Math.max(0.3, nw / nh))); };
  return html`<div class="fp-hover" id="footage-hover" aria-hidden="true" style=${{ left: left + "px", top: top + "px", width: w + "px", height: h + "px" }}>
    ${c.thumb ? html`<img src=${c.thumb} alt="" onLoad=${(e) => fix(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />` : html`<span class="fp-hover-none">${FILM}</span>`}
    ${c.preview && html`<video key=${c.id} src=${c.preview} muted autoPlay loop playsInline preload="auto" class=${playing ? "on" : ""} onPlaying=${() => setPlaying(true)} onLoadedMetadata=${(e) => fix(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />`}
    ${(c.preview ? !playing : c.soon) && html`<span class="fp-hover-spin" role="status" aria-label="Loading the preview" />`}
    ${!c.preview && !c.soon && !c.thumb && html`<span class="fp-hover-tag">No preview</span>`}
    <span class="fp-hover-len">${len(c)}</span>
  </div>`;
}

export function ClipMention({ projectId, inputRef, value, onChange }) {
  const [m, setM] = useState(null); // { start, query, caret }
  const [data, setData] = useState(null); // footage-folders
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const [clips, setClips] = useState({}); // key -> { clips, more } | "loading" | { error }
  const [found, setFound] = useState(null); // search results
  const [active, setActive] = useState(0);
  const [hot, setHot] = useState(null); // { c, at: { x, y } }: the clip being hovered (or chosen with the keys), and where
  const [pos, setPos] = useState(null);
  const popRef = useRef(null);
  const kbd = useRef(false); // the last move was with the keys (the preview then follows the chosen row)
  const dismissed = useRef(-1); // the @ closed with Escape stays closed until another @ is typed
  const st = useRef({}); st.current = { m, value, onChange, items: [], active };

  // Where the @ is: read from the box on every keystroke and caret move.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const look = () => {
      const at = mentionAt(el.value, el.selectionStart ?? el.value.length);
      if (!at) dismissed.current = -1;
      const show = at && at.start !== dismissed.current;
      setM((old) => (show ? (old && old.start === at.start && old.query === at.query && old.caret === el.selectionStart ? old : { ...at, caret: el.selectionStart }) : old ? null : old));
    };
    const blur = () => setTimeout(() => { if (document.activeElement !== el && !popRef.current?.contains(document.activeElement)) setM(null); }, 120);
    el.addEventListener("input", look); el.addEventListener("click", look); el.addEventListener("keyup", look); el.addEventListener("blur", blur);
    return () => { el.removeEventListener("input", look); el.removeEventListener("click", look); el.removeEventListener("keyup", look); el.removeEventListener("blur", blur); };
  }, [inputRef.current]);

  const isOpen = !!m;
  // The folders, once per opening (kept a minute).
  useEffect(() => {
    if (!isOpen || !projectId) return;
    let live = true;
    setErr("");
    cached(folderCache, projectId, () => api.footageFolders(projectId)).then((d) => {
      if (!live) return;
      setData(d);
      if (d?.client?.libraryFolderId) setOpen((s) => (s.size ? s : new Set(["client:" + d.client.libraryFolderId])));
    }, (e) => live && setErr(e.message || "Could not load your folders."));
    return () => { live = false; };
  }, [isOpen, projectId]);
  // Typing after the @ searches clips by name (a moment after the last key).
  const query = (m?.query || "").trim();
  useEffect(() => {
    if (!isOpen || query.length < 2) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => cached(clipCache, "q:" + query.toLowerCase(), () => api.footageClips({ q: query })).then((d) => live && setFound(d), () => live && setFound({ clips: [], more: 0 })), 220);
    return () => { live = false; clearTimeout(t); };
  }, [isOpen, query]);
  useEffect(() => { setActive(0); if (!isOpen) setHot(null); }, [query, isOpen]);
  // Hover clips still being made: asked again a few seconds later (three times at most), so they come in by themselves.
  const tries = useRef({});
  useEffect(() => {
    if (!isOpen) return;
    const waiting = Object.entries(clips).filter(([k, d]) => d && d.clips && d.clips.some((c) => c.soon) && (tries.current[k] || 0) < 3);
    if (!waiting.length) return;
    const t = setTimeout(() => {
      for (const [k] of waiting) {
        tries.current[k] = (tries.current[k] || 0) + 1;
        clipCache.delete(k);
        const o = k === "loose" ? { loose: true } : { folderId: k.slice(2) };
        api.footageClips(o).then((d) => { clipCache.set(k, { at: Date.now(), data: d }); setClips((c) => ({ ...c, [k]: d })); setHot((h) => (h ? { ...h, c: d.clips.find((x) => x.id === h.c.id) || h.c } : h)); }, () => {});
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [isOpen, clips]);

  // Sits over (or under) the box, inside the window.
  useEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const el = inputRef.current;
      if (!el) return;
      // What shows of the window: on a phone the keyboard covers the bottom (visualViewport says how much).
      const r = el.getBoundingClientRect(), vv = window.visualViewport, vw = window.innerWidth, vh = window.innerHeight;
      const viewTop = vv ? vv.offsetTop : 0, viewBottom = vv ? vv.offsetTop + vv.height : vh;
      const w = Math.min(W, vw - 16), left = Math.max(8, Math.min(r.left, vw - w - 8));
      const below = viewBottom - r.bottom - 12, above = r.top - viewTop - 12;
      const up = below < 320 && above > below;
      setPos({ left, width: w, maxH: Math.max(140, Math.min(MAX_H, up ? above : below)), ...(up ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 }) });
    };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [isOpen, value]);

  const loadClips = useCallback((key, o) => {
    setClips((c) => (c[key] && c[key] !== "loading" && !c[key].error ? c : { ...c, [key]: "loading" }));
    cached(clipCache, key, () => api.footageClips(o)).then((d) => setClips((c) => ({ ...c, [key]: d })), (e) => setClips((c) => ({ ...c, [key]: { error: e.message || "Could not load the clips." } })));
  }, []);
  const toggle = (rowKey, folderId) => {
    setOpen((s) => { const n = new Set(s); if (n.has(rowKey)) n.delete(rowKey); else { n.add(rowKey); } return n; });
    if (!open.has(rowKey)) loadClips(folderId === "loose" ? "loose" : "f:" + folderId, folderId === "loose" ? { loose: true } : { folderId });
  };
  // Opened folders' clips are loaded (the client's folder opens by itself).
  useEffect(() => {
    if (!isOpen) return;
    for (const k of open) { const id = k.split(":").pop(); const key = id === "loose" ? "loose" : "f:" + id; if (!clips[key]) loadClips(key, id === "loose" ? { loose: true } : { folderId: id }); }
  }, [isOpen, open]);

  const pick = (c) => {
    const s = st.current;
    if (!s.m) return;
    const el = inputRef.current, v = el ? el.value : s.value;
    const end = el ? el.selectionStart ?? s.m.caret : s.m.caret;
    const label = clipLabel(c.name), ins = "@" + label + " ";
    if (el) rememberClips(el, [{ label, id: c.id, name: c.name }]);
    dismissed.current = s.m.start; // the @ just filled stays closed
    const next = v.slice(0, s.m.start) + ins + v.slice(Math.max(end, s.m.start + 1 + s.m.query.length));
    s.onChange(next.slice(0, 2000));
    setM(null); setHot(null);
    const caret = Math.min(2000, s.m.start + ins.length);
    requestAnimationFrame(() => { const e = inputRef.current; if (e) { e.focus(); try { e.setSelectionRange(caret, caret); } catch {} } });
  };
  const setClient = async (folderId) => {
    try {
      const d = await api.setClientFootage(projectId, folderId);
      folderCache.set(projectId, { at: Date.now(), data: d });
      setData(d);
      if (folderId) setOpen((s) => new Set([...s, "client:" + folderId]));
    } catch (e) { setErr(e.message || "Could not set the client folder."); }
  };

  // The rows shown, in order (for the keys).
  const items = [];
  const byParent = new Map();
  for (const f of data?.folders || []) { const k = f.parentId || ""; byParent.set(k, [...(byParent.get(k) || []), f]); }
  const folderRows = (f, depth, prefix) => {
    const rowKey = prefix + ":" + f.id;
    items.push({ kind: "folder", f, depth, rowKey });
    if (!open.has(rowKey)) return;
    for (const sub of byParent.get(f.id) || []) folderRows(sub, depth + 1, prefix);
    const got = clips["f:" + f.id];
    if (got === "loading" || !got) items.push({ kind: "note", depth: depth + 1, text: "Loading…", key: rowKey + ":l" });
    else if (got.error) items.push({ kind: "note", depth: depth + 1, text: got.error, key: rowKey + ":e" });
    else {
      for (const c of got.clips) items.push({ kind: "clip", c, depth: depth + 1, rowKey: rowKey + ":" + c.id });
      if (!got.clips.length && !(byParent.get(f.id) || []).length) items.push({ kind: "note", depth: depth + 1, text: "No clips in this folder.", key: rowKey + ":0" });
      if (got.more) items.push({ kind: "note", depth: depth + 1, text: `${got.more} more: type @ and a name to find one.`, key: rowKey + ":m" });
    }
  };
  const clientName = data?.client?.name || "this client";
  const clientFolder = data?.client?.libraryFolderId ? (data.folders || []).find((f) => f.id === data.client.libraryFolderId) : null;
  if (found && query.length >= 2) {
    items.push({ kind: "head", text: `Clips named "${query}"`, key: "hq" });
    for (const c of found.clips) items.push({ kind: "clip", c, depth: 0, rowKey: "q:" + c.id, path: true });
    if (!found.clips.length) items.push({ kind: "note", depth: 0, text: "No clip has that name. Keep typing, or delete the words to see your folders.", key: "q0" });
  } else if (data) {
    items.push({ kind: "head", text: clientName + "'s folder", key: "hc", client: true });
    if (clientFolder) folderRows(clientFolder, 0, "client");
    else items.push({ kind: "note", depth: 0, text: `No folder set for ${clientName} yet. Tap ☆ on a folder below to show it here every time.`, key: "c0" });
    items.push({ kind: "head", text: "All folders", key: "ha" });
    for (const f of byParent.get("") || []) folderRows(f, 0, "all");
    if (data.loose) {
      const rowKey = "all:loose";
      items.push({ kind: "folder", f: { id: "loose", name: "Not in a folder", count: data.loose, folders: 0 }, depth: 0, rowKey, loose: true });
      if (open.has(rowKey)) {
        const got = clips.loose;
        if (got === "loading" || !got) items.push({ kind: "note", depth: 1, text: "Loading…", key: "ll" });
        else if (got.error) items.push({ kind: "note", depth: 1, text: got.error, key: "le" });
        else for (const c of got.clips) items.push({ kind: "clip", c, depth: 1, rowKey: rowKey + ":" + c.id });
      }
    }
    if (!(data.folders || []).length && !data.loose) items.push({ kind: "note", depth: 0, text: "Your library has no videos yet. Add b-roll in the Library first.", key: "n0" });
  }
  const choosable = items.map((it, i) => (it.kind === "folder" || it.kind === "clip" ? i : -1)).filter((i) => i >= 0);
  const act = choosable.length ? choosable[Math.min(active, choosable.length - 1)] : -1;
  st.current.items = items; st.current.choosable = choosable; st.current.act = act;

  // Keys while the list is open (caught before the box's own Enter and Escape).
  useEffect(() => {
    if (!isOpen) return;
    const k = (e) => {
      if (e.target !== inputRef.current) return;
      const s = st.current, it = s.items[s.act];
      const stop = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.(); };
      if (e.key === "Escape") { stop(); dismissed.current = s.m ? s.m.start : -1; setM(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { if (!s.choosable.length) return; stop(); kbd.current = true; setActive((a) => { const n = s.choosable.length, cur = Math.min(a, n - 1); return e.key === "ArrowDown" ? (cur + 1) % n : (cur - 1 + n) % n; }); return; }
      if (!it) return;
      if (e.key === "Enter" || e.key === "Tab") { stop(); if (it.kind === "clip") pick(it.c); else toggle(it.rowKey, it.f.id); return; }
      if (it.kind === "folder" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { const isO = open.has(it.rowKey); if ((e.key === "ArrowRight") !== isO) { stop(); toggle(it.rowKey, it.f.id); } }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [isOpen, open, clips]);
  // The row chosen with the keys stays in view, and its clip previews.
  useEffect(() => {
    const it = items[act];
    const row = popRef.current?.querySelector(".fp-row.on");
    row?.scrollIntoView?.({ block: "nearest" });
    if (it?.kind === "clip" && kbd.current && row) { const r = row.getBoundingClientRect(); setHot({ c: it.c, at: { x: r.left + Math.min(120, r.width / 2), y: r.top } }); }
  }, [act]);

  if (!isOpen || !pos || typeof document === "undefined") return null;
  const pop = html`<div class="fp-pop" ref=${popRef} role="listbox" aria-label="Pick footage" id="footage-picker" data-nopin
      style=${{ left: pos.left + "px", width: pos.width + "px", maxHeight: pos.maxH + "px", ...(pos.top != null ? { top: pos.top + "px" } : { bottom: pos.bottom + "px" }) }}
      onMouseDown=${(e) => e.preventDefault()} onClick=${(e) => e.stopPropagation()} onPointerDown=${(e) => e.stopPropagation()}>
    <div class="fp-top"><b>Footage</b><span>Hover a clip to preview it, click to add it</span></div>
    ${err && html`<p class="fp-note fp-err">${err}</p>`}
    ${!data && !err && !found && html`<p class="fp-note">Loading your folders…</p>`}
    <div class="fp-list">
    ${items.map((it, i) => {
      if (it.kind === "head") return html`<div key=${it.key} class="fp-head">${it.text}${it.client && data?.client?.libraryFolderId && data.client.why !== "set" ? html`<span class="fp-guess">${data.client.why === "name" ? "same name" : "your footage's folder"}</span>` : null}</div>`;
      if (it.kind === "note") return html`<p key=${it.key} class="fp-note" style=${{ paddingLeft: 12 + it.depth * 16 + "px" }}>${it.text}</p>`;
      const on = i === act;
      if (it.kind === "folder") {
        const f = it.f, isO = open.has(it.rowKey), isClient = data?.client?.libraryFolderId === f.id;
        return html`<div key=${it.rowKey} class=${"fp-row fp-folder" + (on ? " on" : "")} role="option" aria-selected=${on} aria-expanded=${isO} style=${{ paddingLeft: 8 + it.depth * 16 + "px" }}
            onMouseEnter=${() => setActive(choosable.indexOf(i))} onClick=${() => toggle(it.rowKey, f.id)}>
          <span class=${"fp-chev" + (isO ? " open" : "")}>›</span><span class="fp-ico">${FOLDER}</span>
          <span class="fp-name">${f.name}</span><span class="fp-count">${f.count}${f.folders ? " · " + f.folders + (f.folders === 1 ? " folder" : " folders") : ""}</span>
          ${!it.loose && html`<button type="button" class=${"fp-star" + (isClient && data.client.why === "set" ? " set" : "")} title=${isClient && data.client.why === "set" ? `Shown first for ${clientName}. Click to stop.` : `Show this folder first for ${clientName}`} aria-label=${`Show first for ${clientName}`}
            onClick=${(e) => { e.stopPropagation(); setClient(isClient && data.client.why === "set" ? null : f.id); }}>${isClient && data.client.why === "set" ? "★" : "☆"}</button>`}
        </div>`;
      }
      const c = it.c;
      const at = (e) => ({ x: e.clientX, y: e.clientY });
      return html`<div key=${it.rowKey} class=${"fp-row fp-clip" + (on ? " on" : "") + (c.ready ? "" : " notready")} role="option" aria-selected=${on} style=${{ paddingLeft: 8 + it.depth * 16 + "px" }}
          onMouseEnter=${(e) => { kbd.current = false; setActive(choosable.indexOf(i)); setHot({ c, at: at(e) }); }} onMouseMove=${(e) => { if (!kbd.current) setHot((h) => (h && h.c.id === c.id && Math.abs(h.at.x - e.clientX) + Math.abs(h.at.y - e.clientY) < 6 ? h : { c, at: at(e) })); }}
          onMouseLeave=${() => setHot((h) => (h && h.c.id === c.id ? null : h))} onClick=${() => pick(c)}>
        <span class="fp-ico fp-film">${FILM}</span><span class="fp-name">${c.name}</span><span class="fp-count">${len(c)}${it.path && c.path ? " · " + c.path : ""}${c.ready ? "" : " · not ready"}</span>
      </div>`;
    })}
    </div>
  </div>`;
  return createPortal(html`<${React.Fragment}>${pop}${hot && html`<${HoverPreview} key="hover" c=${hot.c} at=${hot.at} />`}<//>`, document.body);
}
