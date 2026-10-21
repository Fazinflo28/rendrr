/* ===================== /editor/:id ===================== */
// Ported from ui/rendrr-ui.html (editor script). Changes: real footage in the player, live reload when an AI
// edits, autosave conflicts, real undo/restore, the rendered preview plays in the player, real downloads.
import { useState, useEffect, useRef, useMemo, useCallback, html, fmtTime, fmtAgo, Icon, Btn, Toggle, Chip, useToast, Modal, useAsync, Async, usePlayback, Player, Art, useNav, useApp } from "./ui";
import { StyleArt, CreateLinkModal } from "./screens";
import { api } from "./api";
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
const TRACK_HINT = { v1: "Main cut", v2: "B-roll, effects", v3: "Titles", a1: "Dialogue", a2: "Music", a3: "Sound FX" };
const SHORTCUTS = [["Space", "Play or pause"], ["J", "Back 5 seconds"], ["K", "Pause"], ["L", "Forward 5 seconds"], ["S", "Split at playhead"], ["Delete", "Cut selected words or clip"], ["Cmd Z", "Undo"], ["Cmd Shift Z", "Redo"], ["?", "Show shortcuts"]];

function EditorPage({ id }) {
  const q = useAsync(() => api.getProject(id), [id]);
  const { go } = useNav();
  // When your AI changes this edit, load its new version (the editor remounts on the new version).
  useEffect(() => api.watchProject(id, (m) => { if (m && m.by !== "user") q.reload(); }), [id]);
  return html`<${Async} q=${q} skeleton=${html`<div style="padding:24px" class="col"><div class="skeleton sk-pill" style="width:40%" /><div class="skeleton" style="height:60vh;border-radius:20px" /></div>`}>${(p) => html`<${EditorInner} key=${p.id + ":" + p.version} project=${p} reload=${q.reload} />`}<//>`;
}

function EditorInner({ project, reload }) {
  const { go } = useNav(); const toast = useToast(); const { refreshUsage } = useApp();
  const sq = useAsync(() => api.listStyles(), []);
  const tl = project.timeline; const words = useMemo(() => project.transcript.flatMap((l) => l.words), [project]);
  const H = useHistory({ name: project.name, styleId: project.styleId, aspect: project.aspect, cut: tl.cut, tracks: tl.tracks, captionsOn: tl.captionsOn, captionLook: tl.captionLook, captionText: tl.captionText });
  const S = H.state; const dur = tl.duration;
  const [sel, setSel] = useState(null); // {track,id}
  const [wsel, setWsel] = useState(null); // {a,b} word indexes
  const [rtab, setRtab] = useState("comments"); const [verMenu, setVerMenu] = useState(false);
  useEffect(() => { const k = () => setVerMenu(false); window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const [zoom, setZoom] = useState(36);
  const [render, setRender] = useState(null);
  const [share, setShare] = useState(false); const [help, setHelp] = useState(false);
  const [viewVer, setViewVer] = useState(null);
  const [activity, setActivity] = useState(project.activity); const [comments, setComments] = useState(project.comments);
  const [saved, setSaved] = useState("Saved");
  const [status, setStatus] = useState(project.status);
  const cutSet = useMemo(() => new Set(S.cut), [S.cut]);
  const cutRegions = useMemo(() => { const r = []; words.forEach((w, i) => { if (!cutSet.has(w.id)) return; const end = words[i + 1] ? words[i + 1].t : Math.max(w.t + 0.35, w.end || 0); const last = r[r.length - 1]; if (last && Math.abs(last.end - w.t) < 0.01) last.end = end; else r.push({ start: w.t, end }); }); return r; }, [cutSet, words]);
  const pb = usePlayback(dur, { cuts: cutRegions });
  // "Watch preview": the rendered file plays in the same player, without the live overlays.
  const [watch, setWatch] = useState(null);
  const wpb = usePlayback(watch?.seconds || 1);
  const style = (sq.data || []).find((s) => s.id === S.styleId) || project.style;

  // Autosave after each change.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setSaved("Saving…"); const t = setTimeout(() => api.updateProject(project.id, { name: S.name, styleId: S.styleId, aspect: S.aspect, timeline: { ...tl, cut: S.cut, tracks: S.tracks, captionsOn: S.captionsOn, captionLook: S.captionLook, captionText: S.captionText } }).then(() => setSaved("Saved")).catch((e) => { if (e.code === "stale") { toast(e.message, { icon: "spark" }); reload(); } else setSaved("Not saved"); }), 600); return () => clearTimeout(t); }, [S]);

  // Derived playback bits.
  const line = project.transcript.filter((l) => l.start <= pb.time).pop();
  const curWord = words.filter((w) => w.t <= pb.time).pop();
  const zoomClip = S.tracks.v2.find((z) => z.kind === "zoom" && pb.time >= z.start && pb.time < z.end);
  const inZoom = !!zoomClip && viewVer !== 1;
  const caption = S.captionsOn && line ? S.captionText[line.id] : null;

  // ---- editing actions ----
  const cutWords = (ids) => { if (!ids.length) return; H.commit((s) => ({ ...s, cut: Array.from(new Set([...s.cut, ...ids])) })); toast(ids.length + (ids.length === 1 ? " word cut" : " words cut"), { icon: "scissors" }); };
  const restoreWord = (wid) => H.commit((s) => ({ ...s, cut: s.cut.filter((x) => x !== wid) }));
  const selWords = () => { if (!wsel) return []; const [a, b] = [Math.min(wsel.a, wsel.b), Math.max(wsel.a, wsel.b)]; return words.slice(a, b + 1).filter((w) => !cutSet.has(w.id)).map((w) => w.id); };
  const split = () => { const t = pb.time; let target = sel && S.tracks[sel.track].find((c) => c.id === sel.id && t > c.start + .2 && t < c.end - .2) ? sel : null; if (!target) { const c = S.tracks.v1.find((c) => t > c.start + .2 && t < c.end - .2); if (c) target = { track: "v1", id: c.id }; } if (!target) { toast("Move the playhead inside a clip to split it"); return; } H.commit((s) => ({ ...s, tracks: { ...s.tracks, [target.track]: s.tracks[target.track].flatMap((c) => c.id !== target.id ? [c] : [{ ...c, end: +t.toFixed(2) }, { ...c, id: c.id + "b", start: +t.toFixed(2), label: c.label + " (2)" }]) } })); toast("Split at " + fmtTime(t), { icon: "scissors" }); };
  const removeSel = () => { if (!sel) return; H.commit((s) => ({ ...s, tracks: { ...s.tracks, [sel.track]: s.tracks[sel.track].filter((c) => c.id !== sel.id) } })); setSel(null); toast("Clip removed"); };
  const onDelete = () => { const ids = selWords(); if (ids.length) { cutWords(ids); setWsel(null); } else if (sel) removeSel(); };

  // ---- keyboard ----
  useEffect(() => {
    const k = (e) => {
      const tag = e.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
      if (render || share) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? H.redo() : H.undo(); return; }
      switch (e.key) {
        case " ": e.preventDefault(); pb.toggle(); break;
        case "j": case "J": pb.seek(pb.time - 5); break;
        case "k": case "K": pb.setPlaying(false); break;
        case "l": case "L": pb.seek(pb.time + 5); break;
        case "s": case "S": split(); break;
        case "Delete": case "Backspace": e.preventDefault(); onDelete(); break;
        case "?": setHelp((h) => !h); break;
        case "Escape": setHelp(false); setWsel(null); setSel(null); break;
      }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  // ---- render flow ----
  const startRender = async (kind) => {
    pb.setPlaying(false);
    setRender({ kind, status: "running", progress: { step: 0, steps: [], percent: 0 } });
    try {
      const fn = kind === "preview" ? api.renderPreview : api.renderFinal;
      const result = await fn(project.id, (p) => setRender((r) => r && { ...r, progress: p }));
      setRender((r) => ({ ...r, status: "done", result })); setStatus(kind === "preview" ? "Preview ready" : "Final ready"); refreshUsage();
      setActivity((a) => [{ id: "a" + Date.now(), ai: "Rendrr", text: "rendered " + kind, at: Date.now() }, ...a]);
    } catch (e) {
      // Local footage: full quality needs the original once. Ask for it, then run the final.
      if (e.code === "need-original") { setRender({ kind, status: "original", hasFile: api.hasLocalFile(project.videoId), error: null, progress: { step: 0, steps: [], percent: 0 } }); return; }
      setRender((r) => ({ ...r, status: "error", code: e.code, error: e.message }));
    }
  };
  const sendOriginal = async (file) => {
    setRender((r) => ({ ...r, status: "running", progress: { step: 0, steps: ["Uploading original"], percent: 0 } }));
    try { await api.uploadOriginalForExport(project.id, file, (p) => setRender((r) => r && { ...r, progress: p })); }
    catch (e) { setRender((r) => ({ ...r, status: "original", hasFile: api.hasLocalFile(project.videoId), error: e.message })); return; }
    startRender("final");
  };
  const reconnectDrive = async () => { try { await api.reconnectDriveFile(project.videoId, project.video?.driveFileId); toast("Drive file reconnected", { icon: "drive", tone: "brand" }); startRender("final"); } catch (e) { toast(e.message); } };

  // ---- transcript selection (drag over words) ----
  const dragRef = useRef(null);
  const onWordDown = (i) => (e) => { e.preventDefault(); dragRef.current = { a: i, moved: false }; setWsel({ a: i, b: i }); };
  const onWordEnter = (i) => () => { if (dragRef.current) { dragRef.current.moved = dragRef.current.moved || i !== dragRef.current.a; setWsel({ a: dragRef.current.a, b: i }); } };
  useEffect(() => { const up = () => { if (!dragRef.current) return; const d = dragRef.current; dragRef.current = null; if (!d.moved) { const w = words[d.a]; if (cutSet.has(w.id)) { restoreWord(w.id); setWsel(null); } else { pb.seek(w.t); } } }; window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, [words, cutSet]);
  const inWsel = (i) => wsel && i >= Math.min(wsel.a, wsel.b) && i <= Math.max(wsel.a, wsel.b);

  // ---- timeline pointer logic ----
  const canvasRef = useRef();
  const PAD = 12; const px = (t) => PAD + t * zoom; const tAt = (clientX) => { const r = canvasRef.current.getBoundingClientRect(); return Math.min(dur, Math.max(0, (clientX - r.left - PAD) / zoom)); };
  const scrubTimeline = (e) => { pb.seek(tAt(e.clientX)); const mv = (ev) => pb.seek(tAt(ev.clientX)); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); };
  const trim = (track, clip, edge) => (e) => {
    e.stopPropagation(); e.preventDefault(); setSel({ track, id: clip.id });
    const base = H.state; const x0 = e.clientX; const list = S.tracks[track]; const i = list.findIndex((c) => c.id === clip.id); const prev = list[i - 1], next = list[i + 1];
    const mv = (ev) => { const d = (ev.clientX - x0) / zoom; H.replace((s) => ({ ...s, tracks: { ...s.tracks, [track]: s.tracks[track].map((c) => { if (c.id !== clip.id) return c; if (edge === "l") return { ...c, start: +Math.max(prev ? prev.end : 0, Math.min(clip.end - .5, clip.start + d)).toFixed(2) }; return { ...c, end: +Math.min(next ? next.start : dur, Math.max(clip.start + .5, clip.end + d)).toFixed(2) }; }) } })); };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); H.commitFrom(base); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const canvasW = Math.max(900, px(dur) + 40);
  const ticks = []; for (let t = 0; t <= dur; t += zoom < 30 ? 5 : zoom < 60 ? 2 : 1) ticks.push(t);

  const undoAi = async (a) => { try { await api.undoAiAction(a.id); setActivity((x) => x.filter((i) => i.id !== a.id)); toast("Undone: " + a.text, { icon: "undo" }); reload(); } catch (e) { toast(e.message); } };
  const resolve = async (c) => { try { const u = await api.resolveComment(c.id, !c.resolved); setComments((x) => x.map((i) => (i.id === c.id ? { ...i, resolved: u.resolved } : i))); } catch (e) { toast(e.message); } };

  return html`<div class="editor">
    <div class="ed-top">
      <${Btn} kind="quiet" icon="back" aria-label="Back to projects" onClick=${() => go("/projects/" + project.folderId)} />
      <input id="project-name" class="name" value=${S.name} aria-label="Project name" onInput=${(e) => H.replace((s) => ({ ...s, name: e.target.value }))} onBlur=${(e) => { if (e.target.value !== project.name) H.commitFrom({ ...S, name: project.name }); }} />
      <div style="position:relative" onClick=${(e) => e.stopPropagation()}>
        <button class="btn secondary sm" id="version-btn" aria-haspopup="menu" aria-expanded=${verMenu} onClick=${() => setVerMenu((m) => !m)}>V${viewVer || project.versions.length}<${Icon} name="down" size="14" /></button>
        ${verMenu && html`<div class="menu" style="left:0;right:auto;top:40px;min-width:200px" role="menu">${[...project.versions].reverse().map((v) => { const latest = v.v === project.versions.length; const on = (viewVer || project.versions.length) === v.v; return html`<button key=${v.v} role="menuitemradio" aria-checked=${on} class=${"item" + (on ? " on" : "")} data-version=${v.v} onClick=${() => { setViewVer(latest ? null : v.v); setVerMenu(false); }}><${Icon} name=${on ? "check" : "film"} />V${v.v}<span class="muted t-small" style="margin-left:auto">${latest ? "Latest" : fmtAgo(v.at)}</span></button>`; })}</div>`}
      </div>
      <span class="t-small muted" id="saved" title=${saved} style="display:inline-flex;align-items:center;gap:4px;opacity:.7">${saved === "Saved" ? "" : saved}</span>
      <div class="grow" />
      <${Btn} kind="secondary" size="sm" id="render-preview" icon="play" onClick=${() => startRender("preview")}>Render preview<//>
      <${Btn} kind="secondary" size="sm" id="render-final" icon="film" onClick=${() => startRender("final")}>Render final<//>
      <${Btn} size="sm" id="share" icon="link" onClick=${() => setShare(true)}>Share for review<//>
    </div>

    <div class="ed-body">
      <div class="ed-left">
      <div class="center">
        ${viewVer && viewVer !== project.versions.length && html`<div class="ver-banner"><span>Viewing V${viewVer} of ${S.name} (read only)</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" onClick=${async () => { try { await api.restoreVersion(project.id, viewVer); toast("V" + viewVer + " restored as a new version"); setViewVer(null); reload(); } catch (e) { toast(e.message); } }}>Restore this version<//><${Btn} kind="ghost" size="xs" id="back-latest" onClick=${() => setViewVer(null)}>Back to latest<//></div></div>`}
        ${watch && html`<div class="ver-banner"><span>Watching the rendered preview (V${watch.version || project.version})</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" id="back-editing" onClick=${() => { wpb.setPlaying(false); setWatch(null); }}>Back to editing<//></div></div>`}
        <div style="flex:1;min-height:0;display:flex;justify-content:center">${watch
          ? html`<${Player} key="watch" style=${{ height: "100%", maxWidth: "100%" }} pb=${wpb} duration=${watch.seconds || 1} aspect=${S.aspect} src=${watch.url} />`
          : html`<${Player} key="edit" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} src=${project.video?.proxyUrl || undefined} videoFit="cover" caption=${caption} captionLook=${S.captionLook} zoom=${inZoom ? (zoomClip.zoom || 1.15) : 1} marks=${comments.filter((c) => c.time > 0)} onMark=${(c) => { pb.seek(c.time); setRtab("comments"); }} />`}</div>
      </div>
      <div class="tl">
      <div class="tl-bar">
        <div class="row" style="gap:6px"><${Btn} kind="quiet" size="xs" icon=${pb.playing ? "pause" : "play"} aria-label=${pb.playing ? "Pause" : "Play"} onClick=${pb.toggle} />
          <span class="mono t-small tc-ro"><b>${fmtTime(pb.time, true)}</b><span class="muted"> / ${fmtTime(dur, true)}</span></span></div>
        <div class="tl-tools">
          <button class="tool" id="split" onClick=${split}><${Icon} name="scissors" size="15" />Split<span class="kbd">S</span></button>
          <button class="tool" id="delete-clip" disabled=${!sel} onClick=${removeSel}><${Icon} name="trash" size="15" />Delete<span class="kbd">⌫</span></button>
          ${sel && html`<span class="t-small muted" style="margin-left:4px">${S.tracks[sel.track].find((c) => c.id === sel.id)?.label}</span>`}
        </div>
        <div class="zoom"><button class="tool icon" aria-label="Zoom out" onClick=${() => setZoom((z) => Math.max(16, z - 8))}><${Icon} name="more" size="14" /></button><input id="tl-zoom" type="range" min="16" max="90" value=${zoom} onInput=${(e) => setZoom(+e.target.value)} aria-label="Timeline zoom" /><button class="tool icon" aria-label="Zoom in" onClick=${() => setZoom((z) => Math.min(90, z + 8))}><${Icon} name="plus" size="14" /></button><button class="tool" onClick=${() => setZoom(Math.max(16, Math.min(90, Math.floor(((canvasRef.current?.parentElement?.clientWidth || 900) - 40) / dur))))}>Fit</button></div>
      </div>
      <div class="tl-body">
        <div class="tl-labels">${TRACKS.map(([k, l]) => html`<div key=${k} class=${k[0]} title=${TRACK_HINT[k]}><b>${l}</b><span>${TRACK_HINT[k]}</span></div>`)}</div>
        <div class="tl-scroll"><div class="tl-canvas" ref=${canvasRef} style=${{ width: canvasW }} id="timeline">
          <div class="ruler" onPointerDown=${scrubTimeline}>${ticks.map((t) => html`<span key=${t} style=${{ left: px(t) }}>${fmtTime(t)}</span>`)}${Array.from({ length: Math.floor(dur) + 1 }).map((_, t) => html`<i key=${"m" + t} class="mt" style=${{ left: px(t) }} />`)}
            ${comments.filter((c) => c.time > 0).map((c) => html`<div key=${c.id} class="cm" title=${c.text} onPointerDown=${(e) => { e.stopPropagation(); pb.seek(c.time); setRtab("comments"); }} style=${{ left: px(c.time) }} />`)}</div>
          ${TRACKS.map(([k]) => html`<div key=${k} class=${"track " + k[0] + (k === "v1" ? " v1main" : "")} onPointerDown=${(e) => { setSel(null); scrubTimeline(e); }}>
            ${S.tracks[k].map((c) => html`<div key=${c.id} class=${"clip " + (k === "v1" ? "video" : k[0] === "a" ? "audio" : c.kind === "zoom" ? "fx" : "title") + (sel?.track === k && sel?.id === c.id ? " on" : "")} data-clip=${c.id} style=${{ left: px(c.start), width: Math.max(8, (c.end - c.start) * zoom) }} onPointerDown=${(e) => { e.stopPropagation(); setSel({ track: k, id: c.id }); }}><span class="h l" onPointerDown=${trim(k, c, "l")} /><span class="cl">${c.label}</span><span class="h r" onPointerDown=${trim(k, c, "r")} /></div>`)}
          </div>`)}
          <div class="playhead" id="playhead" style=${{ left: px(pb.time) - 1 }}><i /></div>
        </div></div>
      </div>
    </div>

      </div>

      <div class="panel">
        <div class="tabs" role="tablist">${[["comments", "Comments"], ["ai", "AI"], ["style", "Style"], ["transcript", "Transcript"]].map(([k, l]) => html`<button key=${k} role="tab" id=${"tab-" + k} aria-selected=${rtab === k} class=${rtab === k ? "on" : ""} onClick=${() => setRtab(k)}>${l}${k === "comments" && comments.length ? " · " + comments.length : ""}</button>`)}</div>
        ${rtab === "transcript" && html`<div class="pb words" id="transcript" style="padding-top:12px">
          <div class="row between" style="margin-bottom:8px"><span class="t-small muted">Drag over words and press <span class="kbd">Delete</span> to cut them.</span><span class="t-small muted">${S.cut.length} cut</span></div>
          ${project.transcript.map((l) => html`<p key=${l.id}>${l.gapBefore ? html`<span class="gap">${l.gapBefore}s silence</span>` : null}<span class="ts">${fmtTime(l.start)}</span>${l.words.map((w) => { const i = words.indexOf(w); return html`<span key=${w.id} data-w=${w.id} class=${"w" + (cutSet.has(w.id) ? " cut" : "") + (inWsel(i) ? " sel" : "") + (w === curWord ? " now" : "") + (w.filler ? " filler" : "")} onPointerDown=${onWordDown(i)} onPointerEnter=${onWordEnter(i)}>${w.text}</span>${" "}`; })}</p>`)}
          ${selWords().length > 0 && html`<div class="selpop" id="cut-pop"><span class="t-small">${selWords().length} ${selWords().length === 1 ? "word" : "words"}</span><${Btn} size="xs" icon="scissors" id="cut-selected" onClick=${() => { cutWords(selWords()); setWsel(null); }}>Remove from video<//><${Btn} kind="quiet" size="xs" icon="play" aria-label="Play selection" onClick=${() => { const ids = selWords(); const w = words.find((x) => x.id === ids[0]); if (w) { pb.seek(w.t); pb.setPlaying(true); } }} /><${Btn} kind="quiet" size="xs" icon="x" aria-label="Clear selection" onClick=${() => setWsel(null)} /></div>`}
        </div>`}
        ${rtab === "ai" && html`<div class="pb" style="padding-top:16px"><div class="col" style="gap:12px">
          <p class="t-small muted">What your connected AI did on this project. Undo anything.</p>
          ${activity.length === 0 ? html`<div class="state" style="padding:32px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="spark" /></div><b class="t-label">No AI activity yet</b><p class="t-small">Ask Claude or ChatGPT to edit this project.</p></div>` : html`<div class="list">${activity.map((a) => html`<div key=${a.id} class="li" data-ai=${a.id}><${Chip} tone="neutral" size="sm">${a.ai}<//><div class="grow"><div class="t">${a.text}</div><div class="sub">${fmtAgo(a.at)}</div></div><${Btn} kind="ghost" size="xs" class="act" icon="undo" onClick=${() => undoAi(a)}>Undo<//></div>`)}</div>`}
        </div></div>`}
        ${rtab === "comments" && html`<div class="pb" style="padding-top:16px"><div class="col" style="gap:12px">
          ${comments.length === 0 ? html`<div class="state" style="padding:32px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="comment" /></div><b class="t-label">No client comments</b><p class="t-small">Share a review link and comments land here.</p><${Btn} size="sm" kind="secondary" onClick=${() => setShare(true)}>Share for review<//></div>` : html`<div class="list">${comments.map((c) => html`<div key=${c.id} class=${"li click" + (c.resolved ? " done" : "")} data-comment=${c.id} onClick=${() => c.time > 0 && pb.seek(c.time)}>${c.time > 0 && html`<${Chip} tone="brand" size="sm" class="mono">${fmtTime(c.time)}<//>`}<div class="grow"><div class="t">${c.text}</div><div class="sub">${c.author} · ${fmtAgo(c.at)}</div></div><${Btn} kind=${c.resolved ? "quiet" : "ghost"} size="xs" class="act" icon=${c.resolved ? "refresh" : "check"} onClick=${(e) => { e.stopPropagation(); resolve(c); }}>${c.resolved ? "Reopen" : "Resolve"}<//></div>`)}</div>`}
        </div></div>`}
        ${rtab === "style" && html`<div class="pb" style="padding-top:16px">
          ${rtab === "style" && html`<div class="col" style="gap:16px">
            ${style && html`<div><${StyleArt} s=${style} /><b class="t-heading">${style.name}</b><p class="t-small muted">${style.vibe}</p></div>
            <div class="list"><div class="li"><div><div class="sub">Cut pace</div><div class="t">${style.cutPace}</div></div></div><div class="li"><div><div class="sub">Zooms</div><div class="t">${style.zoomRules}</div></div></div><div class="li"><div><div class="sub">Music</div><div class="t">${style.musicVibe}</div></div></div></div>`}
            <div class="row between"><div><b class="t-label">Captions</b><p class="t-small muted">${S.captionsOn ? "Showing on the video" : "Hidden"}</p></div><${Toggle} id="captions-on" on=${S.captionsOn} onChange=${(v) => H.commit((s) => ({ ...s, captionsOn: v }))} label="Captions" /></div>
            <div><b class="t-label">Caption look</b><div class="look" style="margin-top:8px">${["clean", "bold", "outline"].map((k) => html`<button key=${k} data-look=${k} class=${S.captionLook === k ? "on" : ""} onClick=${() => H.commit((s) => ({ ...s, captionLook: k }))}><span class=${k}>Aa</span></button>`)}</div></div>
            <details><summary class="t-label" style="cursor:pointer">Edit caption text</summary><div class="col" style="gap:8px;margin-top:8px">${project.transcript.map((l) => html`<div key=${l.id} class="capline"><span class="ts mono t-small muted" style="width:40px">${fmtTime(l.start)}</span><input class="input sm" aria-label=${"Caption at " + fmtTime(l.start)} value=${S.captionText[l.id]} onFocus=${() => pb.seek(l.start)} onInput=${(e) => H.replace((s) => ({ ...s, captionText: { ...s.captionText, [l.id]: e.target.value } }))} onBlur=${(e) => { if (e.target.value !== tl.captionText[l.id]) H.commitFrom({ ...S, captionText: tl.captionText }); }} /></div>`)}</div></details>
            <div><b class="t-label">Switch style</b><div class="list" style="margin-top:8px">${(sq.data || []).map((s) => html`<button key=${s.id} class=${"li click" + (s.id === S.styleId ? " on" : "")} data-style=${s.id} onClick=${() => { H.commit((x) => ({ ...x, styleId: s.id, captionLook: s.captionLook })); toast("Style: " + s.name, { icon: "styles" }); }}><div class="mini"><${Art} art=${s.art} /></div><div class="grow"><div class="t" style="font-weight:500">${s.name}</div><div class="sub">${s.vibe}</div></div>${s.id === S.styleId && html`<${Icon} name="check" size="16" />`}</button>`)}</div></div>
          </div>`}
        </div>`}
      </div>
    </div>

    ${render && html`<${Modal} title=${render.kind === "preview" ? "Rendering preview" : "Rendering final"} sub=${render.status === "running" ? (render.kind === "preview" ? "Fast and low quality, just to check." : project.video?.source === "drive" ? "Full quality. We fetch the raw file from your Drive, then delete it." : "Full quality. This one takes a little longer.") : null} onClose=${render.status !== "running" ? () => setRender(null) : undefined}>
      ${render.status === "running" && html`<div class="col" style="gap:16px"><div class="bar big"><i style=${{ width: render.progress.percent + "%" }} /></div><div class="row between"><span class="t-small muted" id="render-step">${render.progress.steps[render.progress.step] || "Starting…"}</span><span class="t-small mono muted">${render.progress.percent}%</span></div>
        <div class="steps">${render.progress.steps.map((s, i) => html`<div key=${s} class=${"step" + (i < render.progress.step ? " done" : i === render.progress.step ? " now" : "")}><span class="ck">${i < render.progress.step && html`<${Icon} name="check" />`}</span>${s}</div>`)}</div></div>`}
      ${render.status === "done" && html`<div class="state" style="padding:24px 0;box-shadow:none;background:none"><div class="ico"><${Icon} name="check" /></div><h3 class="t-heading" id="render-done">${render.kind === "preview" ? "Preview is ready" : "Final is ready"}</h3><p id="render-note">${render.kind === "preview" ? "540p, quick check only" : render.result.note + " · 1080p · " + render.result.size}</p>
        <div class="row">${render.kind === "final" ? html`<${Btn} icon="download" id="download" onClick=${() => { if (render.result.downloadUrl) { window.open(render.result.downloadUrl, "_blank", "noopener"); toast("Download started", { icon: "download", tone: "brand" }); } }}>Download ${render.result.fileName || "final"}<//>` : html`<${Btn} icon="play" onClick=${() => { setRender(null); pb.setPlaying(false); setWatch({ url: render.result.url, seconds: render.result.seconds, version: render.result.version }); setTimeout(() => wpb.setPlaying(true), 50); }}>Watch preview<//>`}<${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
      ${render.status === "error" && html`<div class="state" role="alert" style="padding:24px 0;box-shadow:none;background:none"><div class="ico err"><${Icon} name="alert" /></div><h3 class="t-heading" id="render-error">${render.code === "drive" ? "Drive file out of reach" : "Render did not finish"}</h3><p>${render.error}</p><div class="row">${render.code === "drive" && html`<${Btn} id="render-reconnect" icon="drive" onClick=${reconnectDrive}>Reconnect<//>`}<${Btn} kind=${render.code === "drive" ? "secondary" : "primary"} id="render-retry" icon="refresh" onClick=${() => startRender(render.kind)}>Try again<//><${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
      ${render.status === "original" && html`<div class="col" style="gap:16px" id="need-original"><div class="card flat row" style="gap:12px;align-items:flex-start"><${Icon} name="laptop" size="18" /><div><b class="t-label">Full quality needs your original file once.</b><p class="t-small muted">We delete it within 24 hours of the export. Your preview copy stays.</p></div></div>
        ${project.video && html`<p class="t-small muted">Looking for <b style="color:var(--ink)">${project.video.originalName}</b> · ${project.video.size}</p>`}
        ${render.error && html`<p class="t-small" role="alert" id="original-error" style="color:var(--ink)"><${Icon} name="alert" size="13" /> ${render.error}</p>`}
        <input type="file" accept="video/*" class="hide" id="original-file" onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) sendOriginal(f); }} />
        <div class="row">${render.hasFile ? html`<${Btn} id="upload-original" icon="upload" onClick=${() => sendOriginal(null)}>Upload original and export<//>` : html`<${Btn} id="pick-original" icon="laptop" onClick=${() => document.getElementById("original-file").click()}>Pick the original file<//>`}<${Btn} kind="ghost" onClick=${() => setRender(null)}>Not now<//></div></div>`}
    <//>`}
    ${share && html`<${CreateLinkModal} projectId=${project.id} onClose=${() => setShare(false)} onCreated=${() => setStatus("In review")} />`}
    ${help && html`<${Modal} title="Keyboard shortcuts" onClose=${() => setHelp(false)}><div class="list">${SHORTCUTS.map(([k, d]) => html`<div key=${k} class="row between" style="padding:6px 4px"><span>${d}</span><span class="kbd">${k}</span></div>`)}</div><//>`}
  </div>`;
}
export { EditorPage };
