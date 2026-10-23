/* ===================== /editor/:id ===================== */
// Ported from ui/rendrr-ui.html (editor script). Changes: real footage in the player, live reload when an AI
// edits, autosave conflicts, real undo/restore, the rendered preview plays in the player, real downloads.
import { useState, useEffect, useRef, useMemo, useCallback, html, fmtTime, fmtAgo, initials, Icon, Btn, Toggle, Chip, useToast, Modal, useAsync, Async, usePlayback, Player, Art, useNav, useApp } from "./ui";
import { StyleArt, CreateLinkModal } from "./screens";
import { api } from "./api";
// The timeline logic and the render plan are shared with the server: the editor edits, draws and plays the edit
// exactly as the connector changes it and the renderer renders it.
import { applyOp, deleteClip, GRAPHIC_TEMPLATES, keptClock, layoutTimeline, liveFrame, playerGraphicHtml, setLink, splitClip, stripLayout, StyleRulesSchema, templateSize, trimClip } from "@rendrr/shared";
import { outputSize, planRender } from "@rendrr/shared/renderPlan";
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
// The style, broken down like a recipe. Keys muted, values plain, nested with two spaces.
const styleCode = (st, S) => [
  "style: " + st.name,
  "type: " + st.type,
  "shape: " + (S?.aspect || st.ori[0]),
  "cuts:",
  "  pace: " + st.cutPace,
  "zooms: " + st.zoomRules,
  "captions:",
  "  look: " + (S?.captionLook || st.captionLook),
  "  rule: " + st.captionRule,
  "  on: " + (S?.captionsOn === false ? "false" : "true"),
  "music: " + st.musicVibe,
  "export:",
  "  shapes: " + st.ori.join(", "),
  "  best_on: " + st.platforms.join(", "),
].join("\n");
const SHORTCUTS = [["Space", "Play or pause"], ["J", "Back 5 seconds"], ["K", "Pause"], ["L", "Forward 5 seconds"], ["S", "Split at playhead"], ["Delete", "Cut selected words or clip"], ["Alt click", "Unlink or link a clip's picture and dialogue"], ["Alt drag", "Trim one side of a linked clip"], ["Cmd Z", "Undo"], ["Cmd Shift Z", "Redo"], ["?", "Show shortcuts"]];
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// A video laid over the player (b-roll, a custom graphic), kept on the time it should show.
function SyncedVideo({ src, time, playing, fit = "cover" }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (playing) { if (Math.abs(el.currentTime - time) > 0.25) { try { el.currentTime = time; } catch {} } el.play().catch(() => {}); }
    else { el.pause(); if (Math.abs(el.currentTime - time) > 0.04) { try { el.currentTime = time; } catch {} } }
  }, [time, playing]);
  return html`<video ref=${ref} src=${src} muted playsInline preload="auto" style=${{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: fit, pointerEvents: "none" }} />`;
}

// A built-in graphic template drawn live with the recorder's own HTML and clock, at the size the render draws it.
function TemplateFrame({ graphicId, params, start, end, t, aspect }) {
  const out = outputSize(aspect, "preview"); const { width: w, height: h } = templateSize(out.width, out.height);
  const dur = Math.min(15, Math.max(0.5, end - start));
  const doc = useMemo(() => playerGraphicHtml(graphicId, params || {}, w, h, dur), [graphicId, JSON.stringify(params || {}), w, h, dur]);
  const box = useRef(null); const fr = useRef(null); const [k, setK] = useState(0);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setK(el.clientWidth / w)); ro.observe(el); setK(el.clientWidth / w); return () => ro.disconnect(); }, [w]);
  const post = () => fr.current?.contentWindow?.postMessage({ rendrrT: t }, "*");
  useEffect(post, [t, doc]);
  return html`<div ref=${box} style="position:absolute;inset:0;overflow:hidden;pointer-events:none"><iframe ref=${fr} title="graphic" sandbox="allow-scripts" srcDoc=${doc} onLoad=${post} style=${{ width: w, height: h, border: 0, background: "transparent", colorScheme: "light", transform: `scale(${k})`, transformOrigin: "0 0" }} /></div>`;
}

// What the render lays over the footage at this moment: b-roll, then graphics (captions come on top, in Player).
function LiveOverlays({ frame, clips, media, aspect, playing }) {
  if (!frame) return null;
  const b = frame.broll && media.broll[frame.broll.videoId];
  return html`${b && html`<${SyncedVideo} key=${frame.broll.clipId} src=${b.url} time=${frame.broll.src} playing=${playing} />`}
    ${frame.graphics.map((g) => { const m = media.graphics[g.graphicId]; const c = clips.find((x) => x.id === g.clipId);
      return m ? html`<${SyncedVideo} key=${g.clipId} src=${m.url} time=${g.t} playing=${playing} fit="contain" />` : html`<${TemplateFrame} key=${g.clipId} graphicId=${g.graphicId} params=${c?.params} start=${g.start} end=${g.end} t=${g.t} aspect=${aspect} />`; })}`;
}

function EditorPage({ id }) {
  const q = useAsync(() => api.getProject(id), [id]);
  const { go } = useNav();
  // When your AI changes this edit, load its new version (the editor remounts on the new version).
  useEffect(() => api.watchProject(id, (m) => { if (m && m.by !== "user") q.reload(); }), [id]);
  // The AI tab's messages live here, not in EditorInner: an AI's change remounts EditorInner on the new version.
  const [chat, setChat] = useState(null);
  const keep = useRef({ tab: "comments", time: 0 }); // the open tab and the playhead survive that remount too
  useEffect(() => { setChat(null); keep.current = { tab: "comments", time: 0 }; }, [id]);
  // A new version from the AI brings its new messages with it.
  useEffect(() => { if (q.data?.aiChat) setChat(null); }, [q.data?.version]);
  return html`<${Async} q=${q} skeleton=${html`<div style="padding:24px" class="col"><div class="skeleton sk-pill" style="width:40%" /><div class="skeleton" style="height:60vh;border-radius:20px" /></div>`}>${(p) => html`<${EditorInner} key=${p.id + ":" + p.version} project=${p} reload=${q.reload} keep=${keep} ai=${{ chat: chat || p.aiChat || [], setChat: (f) => setChat((c) => f(c || p.aiChat || [])) }} />`}<//>`;
}

function EditorInner({ project, reload, ai, keep }) {
  const { go } = useNav(); const toast = useToast(); const { refreshUsage } = useApp();
  const sq = useAsync(() => api.listStyles(), []);
  // Every word needs an end time for the plan (stored transcripts have them; the UI demo's do not).
  const transcript = useMemo(() => {
    const all = project.transcript.flatMap((l) => l.words); let i = 0;
    return project.transcript.map((l) => { const ws = l.words.map((w) => { const nx = all[++i]; return w.end != null ? w : { ...w, end: r2(Math.min(nx ? nx.t : w.t + 0.6, w.t + 0.6)) }; }); return { ...l, words: ws, end: l.end ?? (ws.length ? ws[ws.length - 1].end : l.start) }; });
  }, [project]);
  const tl = project.timeline; const words = useMemo(() => transcript.flatMap((l) => l.words), [transcript]);
  const H = useHistory({ name: project.name, styleId: project.styleId, aspect: project.aspect, rotate: tl.rotate || 0, cut: tl.cut, tracks: tl.tracks, captionsOn: tl.captionsOn, captionLook: tl.captionLook, captionText: tl.captionText });
  const S = H.state; const footDur = tl.duration;
  // The edit as the server and the renderer see it, the place of every clip in it, and the render plan the live
  // player draws from. Times on the timeline and in the player are EDIT seconds (gaps closed: what renders).
  const initial = useRef(S).current;
  const tlOf = (s) => { const { rotate: _r, ...base } = tl; return { ...base, ...(s.rotate ? { rotate: s.rotate } : {}), cut: s.cut, tracks: s.tracks, captionsOn: s.captionsOn, captionLook: s.captionLook, captionText: s.captionText }; };
  const timeline = useMemo(() => tlOf(S), [S]);
  const lay = useMemo(() => layoutTimeline(timeline, words, project.videoId), [timeline, words]);
  const media = useMemo(() => ({ broll: project.brollMedia || {}, graphics: project.graphicMedia || {} }), [project]);
  const [sel, setSel] = useState(null); // {track,id}
  const [wsel, setWsel] = useState(null); // {a,b} word indexes
  const [rtab, setRtabNow] = useState(keep.current.tab); const setRtab = (t) => { keep.current.tab = t; setRtabNow(t); }; const [verMenu, setVerMenu] = useState(false);
  useEffect(() => { const k = () => setVerMenu(false); window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const [zoom, setZoom] = useState(36);
  const [render, setRender] = useState(null);
  const [share, setShare] = useState(false); const [help, setHelp] = useState(false);
  const [viewVer, setViewVer] = useState(null);
  const [comments, setComments] = useState(project.comments);
  const [saved, setSaved] = useState("Saved");
  const [status, setStatus] = useState(project.status);
  const cutSet = useMemo(() => new Set(S.cut), [S.cut]);
  const style = (sq.data || []).find((s) => s.id === S.styleId) || project.style;
  const captionRules = useMemo(() => { const r = StyleRulesSchema.safeParse(style?.rules); return r.success ? r.data.captions : undefined; }, [style]);
  const plan = useMemo(() => {
    try {
      const v = project.video || {};
      return planRender({ kind: "preview", snapshot: { timeline, name: S.name, aspect: S.aspect, styleId: S.styleId }, transcript,
        source: { width: v.width || 1920, height: v.height || 1080, fps: v.fps || 30, seconds: v.seconds || footDur, hasAudio: true }, captionRules,
        brollSeconds: Object.fromEntries(Object.entries(media.broll).map(([id, b]) => [id, b.seconds])),
        // Templates draw live; a custom graphic shows once its recorded file is there (as in the render).
        graphicsReady: Object.fromEntries(lay.tracks.v3.filter((c) => c.kind === "graphic").map((c) => [c.id, GRAPHIC_TEMPLATES.some((g) => g.id === c.graphicId) || !!media.graphics[c.graphicId]])) });
    } catch { return null; } // everything is cut
  }, [timeline, S.aspect, captionRules, media]);
  const clock = useMemo(() => keptClock(plan ? plan.kept : []), [plan]);
  const dur = plan ? plan.outputSeconds : 0;
  // The rendered preview plays instead when it is of this version and nothing changed since: exactly the file.
  const fresh = !!project.previewUrl && project.previewVersion === project.version && S === initial;
  const pb = usePlayback(dur, { clock: fresh ? null : clock });
  useEffect(() => { if (keep.current.time > 0) pb.seek(Math.min(keep.current.time, dur)); }, []);
  useEffect(() => { keep.current.time = pb.time; }, [pb.time]);
  // "Watch preview": the rendered file plays in the same player, without the live overlays.
  const [watch, setWatch] = useState(null);
  const wpb = usePlayback(watch?.seconds || 1);

  // Autosave after each change.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setSaved("Saving…"); const t = setTimeout(() => api.updateProject(project.id, { name: S.name, styleId: S.styleId, aspect: S.aspect, timeline: tlOf(S) }).then(() => { setSaved("Saved"); }).catch((e) => { if (e.code === "stale") { toast(e.message, { icon: "spark" }); reload(); } else { setSaved("Not saved"); } }), 600); return () => clearTimeout(t); }, [S]);

  // Derived playback bits: what the render shows at this moment of the edit.
  const frame = plan && !fresh ? liveFrame(plan, pb.time, clock) : null;
  const srcNow = clock.toSource(pb.time);
  const curWord = words.filter((w) => w.t <= srcNow).pop();
  const inEdit = (w) => !!plan && plan.kept.some((k) => w.t >= k.start && w.t < k.end);

  // ---- editing actions ----
  const cutWords = (ids) => { if (!ids.length) return; H.commit((s) => ({ ...s, cut: Array.from(new Set([...s.cut, ...ids])) })); toast(ids.length + (ids.length === 1 ? " word cut" : " words cut"), { icon: "scissors" }); };
  const restoreWord = (wid) => H.commit((s) => ({ ...s, cut: s.cut.filter((x) => x !== wid) }));
  const selWords = () => { if (!wsel) return []; const [a, b] = [Math.min(wsel.a, wsel.b), Math.max(wsel.a, wsel.b)]; return words.slice(a, b + 1).filter((w) => !cutSet.has(w.id)).map((w) => w.id); };
  // Clip edits go through the shared timeline module: linked picture and dialogue change together, and the edit
  // closes up (ripple) because V1 plays back to back.
  const commitTl = (next) => H.commit((s) => ({ ...s, tracks: stripLayout(next).tracks, cut: next.cut }));
  const tryEdit = (fn, done) => { try { const r = fn(); commitTl(r.tl); if (done) toast(done(r), { icon: "scissors" }); return r; } catch (e) { toast(e.message); return null; } };
  const split = () => {
    const t = r2(clock.toSource(pb.time)); const inside = (c) => t > c.start + .05 && t < c.end - .05;
    let target = sel && S.tracks[sel.track].find((c) => c.id === sel.id && inside(c)) ? sel : null;
    if (!target) { const c = S.tracks.v1.find(inside); if (c) target = { track: "v1", id: c.id }; }
    if (!target) { toast("Move the playhead inside a clip to split it"); return; }
    tryEdit(() => splitClip(timeline, target.track, target.id, t), () => "Split at " + fmtTime(pb.time));
  };
  const removeSel = () => { if (!sel) return; if (tryEdit(() => deleteClip(timeline, sel.track, sel.id), (r) => r.summary.charAt(0).toUpperCase() + r.summary.slice(1))) setSel(null); };
  // Cut silences: the connector's own op, run here on the editor's state (same rules: pauses over the limit, the
  // silence at each clip's start and end, linked dialogue with its picture).
  const [silOver, setSilOver] = useState(0.5);
  const cutSilences = () => {
    try {
      const r = applyOp({ timeline, name: S.name, aspect: S.aspect, styleId: S.styleId }, { op: "cut_silences", overSeconds: silOver }, { videoId: project.videoId, transcript, silences: project.silences || [], sceneCuts: [], duration: footDur, getStyle: () => undefined });
      commitTl(r.snap.timeline); toast(r.summary.charAt(0).toUpperCase() + r.summary.slice(1), { icon: "scissors" });
    } catch (e) { toast(e.message); }
  };
  const toggleLink = (track, clipId) => { const c = lay.tracks[track].find((x) => x.id === clipId); if (c) tryEdit(() => setLink(timeline, track, clipId, !c.linkId), (r) => r.summary.charAt(0).toUpperCase() + r.summary.slice(1)); };
  const selClip = sel ? lay.tracks[sel.track].find((c) => c.id === sel.id) : null;
  const isOn = (k, c) => (sel?.track === k && sel?.id === c.id) || (!!selClip?.linkId && c.linkId === selClip.linkId);
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
        case "j": case "J": pb.seek(pb.time - 5); break; // edit time
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
      // A new preview of this version: reload so the player plays the file itself.
      if (kind === "preview") { setRender(null); toast("Preview rendered. The player now plays the file.", { icon: "check", tone: "brand" }); reload(); return; }
      setChat((c) => [...c, { id: "r" + Date.now(), role: "ai", ai: "Rendrr", text: "Final rendered.", workflow: result.steps || ["Encoded 1080p", "Cleaned up raw file"], at: Date.now() }]);
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
  useEffect(() => { const up = () => { if (!dragRef.current) return; const d = dragRef.current; dragRef.current = null; if (!d.moved) { const w = words[d.a]; if (cutSet.has(w.id)) { restoreWord(w.id); setWsel(null); } else if (inEdit(w)) { pb.seek(clock.toOutput(w.t)); } else toast("This word's clip is out of the edit. Undo, or trim the clip back, to bring it back."); } }; window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, [words, cutSet, clock, plan]);
  const inWsel = (i) => wsel && i >= Math.min(wsel.a, wsel.b) && i <= Math.max(wsel.a, wsel.b);

  // ---- timeline pointer logic ----
  const canvasRef = useRef();
  const PAD = 12; const px = (t) => PAD + t * zoom; const tAt = (clientX) => { const r = canvasRef.current.getBoundingClientRect(); return Math.min(dur, Math.max(0, (clientX - r.left - PAD) / zoom)); };
  const scrubTimeline = (e) => { pb.seek(tAt(e.clientX)); const mv = (ev) => pb.seek(tAt(ev.clientX)); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); };
  // Trim an edge. V1/A1 edges move in the footage (the edit grows or closes up after them); other clips keep their
  // place in the edit and pin to the footage under it. A linked pair trims together; Alt-drag trims one side.
  const trim = (track, clip, edge) => (e) => {
    e.stopPropagation(); e.preventDefault(); setSel({ track, id: clip.id });
    const base = H.state; const baseTl = tlOf(base); const ck0 = clock; const solo = e.altKey; const x0 = e.clientX;
    const list = baseTl.tracks[track]; const i = list.findIndex((c) => c.id === clip.id); const raw = list[i]; const prev = list[i - 1], next = list[i + 1];
    const main = track === "v1" || track === "a1";
    const mv = (ev) => {
      const d = (ev.clientX - x0) / zoom; let start = raw.start, end = raw.end;
      if (edge === "l") start = clamp(main ? raw.start + d : ck0.toSource(clip.timelineStart + d), prev ? prev.end : 0, raw.end - .2);
      else end = clamp(main ? raw.end + d : ck0.toSource(clip.timelineEnd + d), raw.start + .2, next ? next.start : footDur);
      try { const r = trimClip(baseTl, track, raw.id, r2(start), r2(end), { linked: !solo }); H.replace((s) => ({ ...s, tracks: stripLayout(r.tl).tracks })); } catch {}
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); H.commitFrom(base); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const canvasW = Math.max(900, px(dur) + 40);
  const ticks = []; for (let t = 0; t <= dur; t += zoom < 30 ? 5 : zoom < 60 ? 2 : 1) ticks.push(t);

  const { chat, setChat } = ai;
  useEffect(() => { const el = document.getElementById("ai-thread"); if (el) el.scrollTop = el.scrollHeight; }, [chat, rtab]);
  useEffect(() => { const el = document.getElementById("comment-list"); if (el) el.scrollTop = el.scrollHeight; }, [comments.length, rtab]);
  const [draft, setDraft] = useState(""); const [posting, setPosting] = useState(false);
  const postComment = async () => { if (!draft.trim()) return; setPosting(true); try { const c = await api.addProjectComment(project.id, { time: pb.time, text: draft }); setComments((x) => [...x, c].sort((a, b) => a.time - b.time)); setDraft(""); toast("Comment added at " + fmtTime(c.time), { icon: "comment" }); } catch (e) { toast(e.message); } finally { setPosting(false); } };
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
      <span class="t-small muted" id="auto-preview" title=${fresh ? "The player plays the rendered preview file of this version." : "The player plays the edit as it will render: cuts closed, captions, zooms, b-roll and graphics. Music plays in the rendered preview."}>${fresh ? `Playing the rendered preview (V${project.version})` : "Live edit"}</span>
      ${!fresh && html`<${Btn} kind="ghost" size="sm" id="render-preview" icon="play" disabled=${saved !== "Saved" || !plan} onClick=${() => startRender("preview")}>Render preview<//>`}
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
          : !plan ? html`<div class="state" style="margin:auto"><div class="ico"><${Icon} name="scissors" /></div><b class="t-label">Everything is cut</b><p class="t-small">Undo, or restore some words or clips.</p></div>`
          : fresh ? html`<${Player} key="preview" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} src=${project.previewUrl} marks=${comments.filter((c) => c.time > 0)} onMark=${(c) => { pb.seek(c.time); setRtab("comments"); }} />`
          : html`<${Player} key="edit" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} src=${project.video?.proxyUrl || undefined} videoFit="cover" rotate=${S.rotate || 0} caption=${frame?.caption} captionLook=${S.captionLook} zoom=${frame?.zoom || 1} zoomTransition=${false} muted=${!!frame?.muted} overlay=${html`<${LiveOverlays} frame=${frame} clips=${lay.tracks.v3} media=${media} aspect=${S.aspect} playing=${pb.playing} />`} marks=${comments.filter((c) => c.time > 0)} onMark=${(c) => { pb.seek(c.time); setRtab("comments"); }} />`}</div>
      </div>
      <div class="tl">
      <div class="tl-bar">
        <div class="row" style="gap:6px"><${Btn} kind="quiet" size="xs" icon=${pb.playing ? "pause" : "play"} aria-label=${pb.playing ? "Pause" : "Play"} onClick=${pb.toggle} />
          <span class="mono t-small tc-ro"><b>${fmtTime(pb.time, true)}</b><span class="muted"> / ${fmtTime(dur, true)}</span></span></div>
        <div class="tl-tools">
          <button class="tool" id="split" onClick=${split}><${Icon} name="scissors" size="15" />Split<span class="kbd">S</span></button>
          <button class="tool" id="rotate" title="Turn the footage 90° clockwise (footage filmed sideways)" onClick=${() => H.commit((s) => ({ ...s, rotate: ((s.rotate || 0) + 90) % 360 }))}><${Icon} name="refresh" size="15" />Rotate${S.rotate ? " " + S.rotate + "°" : ""}</button>
          <span class="row" style="gap:2px"><button class="tool" id="cut-silences" title="Cut pauses longer than the limit, and the silence at the start and end of every clip" onClick=${cutSilences}><${Icon} name="scissors" size="15" />Cut silences</button><select class="tool" id="silence-over" aria-label="Pauses longer than" value=${silOver} onChange=${(e) => setSilOver(+e.target.value)}>${[0.3, 0.5, 0.8, 1, 1.5].map((x) => html`<option key=${x} value=${x}>over ${x}s</option>`)}</select></span>
          <button class="tool" id="delete-clip" disabled=${!sel} onClick=${removeSel}><${Icon} name="trash" size="15" />Delete<span class="kbd">⌫</span></button>
          ${selClip && (sel.track === "v1" || sel.track === "a1") && html`<button class="tool" id="link-clip" title="Alt-click a clip does the same" onClick=${() => toggleLink(sel.track, sel.id)}><${Icon} name="link" size="15" />${selClip.linkId ? "Unlink" : "Link"}</button>`}
          ${selClip && html`<span class="t-small muted" style="margin-left:4px">${selClip.label}</span>`}
        </div>
        <div class="zoom"><button class="tool icon" aria-label="Zoom out" onClick=${() => setZoom((z) => Math.max(16, z - 8))}><${Icon} name="more" size="14" /></button><input id="tl-zoom" type="range" min="16" max="90" value=${zoom} onInput=${(e) => setZoom(+e.target.value)} aria-label="Timeline zoom" /><button class="tool icon" aria-label="Zoom in" onClick=${() => setZoom((z) => Math.min(90, z + 8))}><${Icon} name="plus" size="14" /></button><button class="tool" onClick=${() => setZoom(Math.max(16, Math.min(90, Math.floor(((canvasRef.current?.parentElement?.clientWidth || 900) - 40) / dur))))}>Fit</button></div>
      </div>
      <div class="tl-body">
        <div class="tl-labels">${TRACKS.map(([k, l]) => html`<div key=${k} class=${k[0]} title=${TRACK_HINT[k]}><b>${l}</b><span>${TRACK_HINT[k]}</span></div>`)}</div>
        <div class="tl-scroll"><div class="tl-canvas" ref=${canvasRef} style=${{ width: canvasW }} id="timeline">
          <div class="ruler" onPointerDown=${scrubTimeline}>${ticks.map((t) => html`<span key=${t} style=${{ left: px(t) }}>${fmtTime(t)}</span>`)}${Array.from({ length: Math.floor(dur) + 1 }).map((_, t) => html`<i key=${"m" + t} class="mt" style=${{ left: px(t) }} />`)}
            ${comments.filter((c) => c.time > 0).map((c) => html`<div key=${c.id} class="cm" title=${c.text} onPointerDown=${(e) => { e.stopPropagation(); pb.seek(c.time); setRtab("comments"); }} style=${{ left: px(c.time) }} />`)}</div>
          ${TRACKS.map(([k]) => html`<div key=${k} class=${"track " + k[0] + (k === "v1" ? " v1main" : "")} onPointerDown=${(e) => { setSel(null); scrubTimeline(e); }}>
            ${lay.tracks[k].map((c) => { const gone = c.timelineEnd - c.timelineStart < 0.01; const main = k === "v1" || k === "a1";
              return html`<div key=${c.id} class=${"clip " + (k === "v1" ? "video" : k[0] === "a" ? "audio" : c.kind === "zoom" ? "fx" : "title") + (isOn(k, c) ? " on" : "") + (gone ? " gone" : "") + (main ? (c.linkId ? " linked" : " unlinked") : "")} data-clip=${c.id} data-link=${c.linkId || undefined}
                title=${gone ? "Not in the edit: its footage is cut" : main ? (c.linkId ? "Linked to its " + (k === "v1" ? "dialogue" : "picture") + ". Alt-click to unlink." : "Not linked. Alt-click to link.") : c.label}
                style=${{ left: px(c.timelineStart), width: Math.max(gone ? 4 : 8, (c.timelineEnd - c.timelineStart) * zoom) }}
                onPointerDown=${(e) => { e.stopPropagation(); if (e.altKey && main) toggleLink(k, c.id); else setSel({ track: k, id: c.id }); }}><span class="h l" onPointerDown=${trim(k, c, "l")} /><span class="cl">${main && c.linkId ? "⛓ " : ""}${c.label}</span><span class="h r" onPointerDown=${trim(k, c, "r")} /></div>`; })}
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
          ${project.transcript.map((l) => html`<p key=${l.id}>${l.gapBefore ? html`<span class="gap">${l.gapBefore}s silence</span>` : null}<span class="ts">${fmtTime(l.start)}</span>${l.words.map((w) => { const i = words.indexOf(w); return html`<span key=${w.id} data-w=${w.id} class=${"w" + (cutSet.has(w.id) || !inEdit(w) ? " cut" : "") + (inWsel(i) ? " sel" : "") + (w === curWord ? " now" : "") + (w.filler ? " filler" : "")} onPointerDown=${onWordDown(i)} onPointerEnter=${onWordEnter(i)}>${w.text}</span>${" "}`; })}</p>`)}
          ${selWords().length > 0 && html`<div class="selpop" id="cut-pop"><span class="t-small">${selWords().length} ${selWords().length === 1 ? "word" : "words"}</span><${Btn} size="xs" icon="scissors" id="cut-selected" onClick=${() => { cutWords(selWords()); setWsel(null); }}>Remove from video<//><${Btn} kind="quiet" size="xs" icon="play" aria-label="Play selection" onClick=${() => { const ids = selWords(); const w = words.find((x) => x.id === ids[0]); if (w) { pb.seek(clock.toOutput(w.t)); pb.setPlaying(true); } }} /><${Btn} kind="quiet" size="xs" icon="x" aria-label="Clear selection" onClick=${() => setWsel(null)} /></div>`}
        </div>`}
        ${rtab === "ai" && html`<div class="pb cmts" style="padding-top:12px">
          <div class="col" style="gap:10px;flex:1;min-height:0;overflow:auto" id="ai-thread">
            ${chat.length === 0 ? html`<div class="state" style="padding:28px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="spark" /></div><b class="t-label">What your AI did shows here</b><p class="t-small">When Claude or ChatGPT edits this video through the connector, every step and its notes to you appear here.</p></div>`
            : chat.map((m) => html`<div key=${m.id} class=${"msg " + m.role} data-msg=${m.id}>
                ${m.role === "ai" && html`<span class="who"><${Icon} name="spark" size="12" /> ${m.ai}</span>`}
                <p>${m.text}</p>
                ${m.workflow && html`<div class="wf"><span class="t-small muted">Workflow</span>${m.workflow.map((w, i) => html`<div key=${i} class="wf-step"><span class="n">${i + 1}</span>${w}</div>`)}</div>`}
                <span class="t-small muted when">${fmtAgo(m.at)}</span>
              </div>`)}
          </div>
          <p class="t-small muted" style="margin:0">Ask for changes in Claude or ChatGPT. This tab only shows what they did.</p>
        </div>`}
        ${rtab === "comments" && html`<div class="pb cmts" style="padding-top:12px">
          <div class="col" style="gap:8px;flex:1;min-height:0;overflow:auto" id="comment-list">
            ${comments.length === 0 ? html`<div class="state" style="padding:28px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="comment" /></div><b class="t-label">No comments yet</b><p class="t-small">Leave a note at any moment of the video. Clients can too, from a review link.</p></div>`
            : comments.map((c) => html`<div key=${c.id} class=${"cmt" + (c.resolved ? " done" : "")} data-comment=${c.id}>
                <span class="gava" style="width:26px;height:26px;font-size:10px">${initials(c.author)}</span>
                <div class="grow" style="min-width:0"><div class="row" style="gap:8px"><b class="t-label">${c.author}${c.mine ? " (you)" : ""}</b><span class="t-small muted">${fmtAgo(c.at)}</span><div class="grow" /><${Btn} kind="quiet" size="xs" class="act" icon=${c.resolved ? "refresh" : "check"} aria-label=${c.resolved ? "Reopen" : "Resolve"} onClick=${() => resolve(c)} /></div>
                  <p class="t-small" style="margin-top:2px">${c.time > 0 && html`<button class="tc" onClick=${() => pb.seek(c.time)}>${fmtTime(c.time)}</button>`}${c.text}</p></div>
              </div>`)}
          </div>
          <form class="cbox" onSubmit=${(e) => { e.preventDefault(); postComment(); }}>
            <button type="button" class="tc big" title="Comment at this moment" onClick=${() => pb.setPlaying(false)}>${fmtTime(pb.time)}</button>
            <input id="comment-input" class="input sm grow" placeholder="Leave a comment at this moment…" value=${draft} onInput=${(e) => setDraft(e.target.value)} onFocus=${() => pb.setPlaying(false)} />
            <${Btn} size="sm" type="submit" id="comment-post" disabled=${!draft.trim() || posting}>${posting ? "…" : "Post"}<//>
          </form>
        </div>`}
        ${rtab === "style" && html`<div class="pb" style="padding-top:16px">
          ${style && html`<div class="col" style="gap:12px">
            <${StyleArt} s=${style} />
            <pre class="code" id="style-code">${styleCode(style, S).split("\n").map((ln, i) => { const m = ln.match(/^(\s*)([a-z_]+):(.*)$/); return html`<div key=${i}>${m ? html`${m[1]}<span class="k">${m[2]}:</span>${m[3]}` : ln}</div>`; })}</pre>
          </div>`}
        </div>`}
      </div>
    </div>

    ${render && html`<${Modal} title=${render.kind === "preview" ? "Rendering preview" : "Rendering final"} sub=${render.status === "running" && render.kind === "preview" ? "540p, everything burned in." : render.status === "running" ? (project.video?.source === "drive" ? "Full quality. We fetch the raw file from your Drive, then delete it." : "Full quality. This one takes a little longer.") : null} onClose=${render.status !== "running" ? () => setRender(null) : undefined}>
      ${render.status === "running" && html`<div class="col" style="gap:16px"><div class="bar big"><i style=${{ width: render.progress.percent + "%" }} /></div><div class="row between"><span class="t-small muted" id="render-step">${render.progress.steps[render.progress.step] || "Starting…"}</span><span class="t-small mono muted">${render.progress.percent}%</span></div>
        <div class="steps">${render.progress.steps.map((s, i) => html`<div key=${s} class=${"step" + (i < render.progress.step ? " done" : i === render.progress.step ? " now" : "")}><span class="ck">${i < render.progress.step && html`<${Icon} name="check" />`}</span>${s}</div>`)}</div></div>`}
      ${render.status === "done" && html`<div class="state" style="padding:24px 0;box-shadow:none;background:none"><div class="ico"><${Icon} name="check" /></div><h3 class="t-heading" id="render-done">Final is ready</h3><p id="render-note">${render.result.note + " · 1080p · " + render.result.size}</p>
        <div class="row"><${Btn} icon="laptop" id="download" onClick=${() => { if (render.result.downloadUrl) { window.open(render.result.downloadUrl, "_blank", "noopener"); toast("Saving " + (render.result.fileName || "the final") + " to this computer", { icon: "download", tone: "brand" }); } }}>Save to this computer<//><${Btn} kind="secondary" icon="drive" id="save-drive" onClick=${async () => { try { const r = await api.saveFinalToDrive(render.result.renderId); toast(r.message, { icon: "drive", tone: "brand" }); } catch (e) { toast(e.message); } }}>Save to Google Drive<//><${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
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
