/* ===================== /editor/:id ===================== */
// Ported from ui/rendrr-ui.html (editor script). Changes: real footage in the player, live reload when an AI
// edits, autosave conflicts, real undo/restore, the rendered preview plays in the player, real downloads.
// Phase 2: the edit is a sequence (clips of any video, in any order, J/L cuts) with Premiere's tools.
// The editor's parts live in ./editor/ (layers, the Text, Clip and Audio tools, panels); this file holds the page.
// The timeline logic and the render plan are shared with the server: the editor edits with the connector's own ops,
// draws and plays the edit exactly as the connector changes it and the renderer renders it.
import { Async, Btn, Icon, Modal, MoreMenu, Player, fmtAgo, fmtTime, html, initials, useApp, useAsync, useCallback, useEffect, useMemo, useNav, usePlayback, useRef, useState, useToast } from "./ui";
import { api } from "./api";
import { isSortedByTime, lastWordAtOrBefore, lineOfWord, wordIndexById } from "./words";
import { ASPECT_RATIO, StyleRulesSchema, aiName, applyOp, areaAt, asSequence, audioSettings, elementKeys, findTemplate, handoffTarget, isCaptionMarker, layoutTimeline, liveFrame, lookTags, objectBoxAt, sequenceClock, sequenceView } from "@rendrr/shared";
import { MediaBin, SourceMonitor, useLibrary } from "./media";
import { ColorTab, MaskOverlay, pickColor, useLutData } from "./color";
import { usePlan } from "./editor/plan";
import { ExportModal, QualityMenu, qualityChip, timeLeft } from "./export";
import { MulticamTab } from "./multicam";
import { OpSlider } from "./controls";
import { Filmstrip } from "./filmstrip";
import { SamplesWindow } from "./samples";
import { StoryboardWindow } from "./storyboard";
import { CreateLinkModal } from "./screens";
import { ASPECT_NAMES, EMOJI, PANEL_TOOLS, PENS, RAIL, SHORTCUTS, TOOLS, TOOL_ICON, TRACKS, TRACK_H, TRACK_HINT, ZMAX, ZMIN, clamp, drawingPng, linkified, r2, railTab, readCommentImage, useHistory } from "./editor/common";
import { LiveOverlays, MARK_COLORS, PersonLayer, SeqMedia, WaveLayer, loadPeaks, markNote, readFlag, useMattes, writeFlag } from "./editor/layers";
import { AudioTab, ClipTab, dB } from "./editor/clipTab";
import { AddClipModal, TranscriptLine } from "./editor/panels";
import { TextTab } from "./editor/textTab";

function EditorPage({ id }) {
  const q = useAsync(() => api.getProject(id), [id]);
  const { go } = useNav();
  // When your AI changes this edit, load its new version (the editor remounts on the new version, and on more
  // changes folded into the same version: the project's time tells them apart).
  useEffect(() => api.watchProject(id, (m) => { if (m && m.by !== "user") q.reload(); }), [id]);
  // The AI tab's messages live here, not in EditorInner: an AI's change remounts EditorInner on the new version.
  const [chat, setChat] = useState(null);
  const keep = useRef({ tab: "media", time: 0 }); // the open tool and the playhead survive that remount too
  useEffect(() => { setChat(null); keep.current = { tab: "media", time: 0 }; }, [id]);
  // A new version from the AI brings its new messages with it.
  useEffect(() => { if (q.data?.aiChat) setChat(null); }, [q.data?.version]);
  // The editor's own frame while it loads (top bar, tool rail, player, side panel, timeline), so nothing jumps; an
  // edit that is gone offers the way back.
  const sk = html`<div class="editor" aria-busy="true"><div class="ed-top" style="height:56px"><div class="skeleton sk-pill" style="width:220px;height:36px" /><div class="grow" /><div class="skeleton sk-pill" style="width:200px;height:36px" /></div>
    <div class="ed-body"><div class="ed-work lib-closed"><div class="skeleton" style="border-radius:16px" /><div class="skeleton" style="border-radius:16px;min-height:300px" /><div class="skeleton" style="border-radius:16px" /></div><div class="skeleton" style="border-radius:16px" /></div></div>`;
  return html`<${Async} q=${q} skeleton=${sk} errorBack=${{ label: "Projects", onClick: () => go("/projects") }}>${(p) => html`<${EditorInner} key=${p.id + ":" + p.version + ":" + (p.updated || 0)} project=${p} reload=${q.reload} keep=${keep} ai=${{ chat: chat || p.aiChat || [], setChat: (f) => setChat((c) => f(c || p.aiChat || [])) }} />`}<//>`;
}

function EditorInner({ project, reload, ai, keep }) {
  const { go } = useNav(); const toast = useToast(); const { refreshUsage } = useApp();
  // Every word needs an end time for the plan (stored transcripts have them; the UI demo's do not).
  const transcript = useMemo(() => {
    const all = project.transcript.flatMap((l) => l.words); let i = 0;
    return project.transcript.map((l) => { const ws = l.words.map((w) => { const nx = all[++i]; return w.end != null ? w : { ...w, end: r2(Math.min(nx ? nx.t : w.t + 0.6, w.t + 0.6)) }; }); return { ...l, words: ws, end: l.end ?? (ws.length ? ws[ws.length - 1].end : l.start) }; });
  }, [project]);
  const words = useMemo(() => transcript.flatMap((l) => l.words), [transcript]);
  // Looked up once per transcript, not once per word on every frame: a word's place by its id, which line it is on,
  // and whether the words run in time order (then the word playing is found by halving, not by scanning them all).
  const wordIndex = useMemo(() => wordIndexById(words), [words]);
  const wordLine = useMemo(() => lineOfWord(project.transcript), [project]);
  const wordsInOrder = useMemo(() => isSortedByTime(words), [words]);
  const footDur = project.timeline.duration;
  // The edit is a sequence. A project stored before Phase 2 is shown converted (the server stores it so at the next save).
  const tl = useMemo(() => asSequence(project.timeline, words, project.videoId, project.video?.seconds || footDur), [project, words]);
  const H = useHistory({ name: project.name, styleId: project.styleId, aspect: project.aspect, cut: tl.cut, tracks: tl.tracks, captionsOn: tl.captionsOn, captionLook: tl.captionLook, captionText: tl.captionText, captionStyle: tl.captionStyle, audio: tl.audio, export: tl.export, media: tl.media, voice: tl.voice ?? null, background: tl.background ?? null, multicam: tl.multicam ?? null });
  const S = H.state;
  // The edit as the server and the renderer see it, the place of every clip in it, and the render plan the live
  // player draws from. Times on the timeline and in the player are EDIT seconds.
  const initial = useRef(S).current;
  const tlOf = (s) => ({ ...tl, cut: s.cut, tracks: s.tracks, captionsOn: s.captionsOn, captionLook: s.captionLook, captionText: s.captionText, captionStyle: s.captionStyle, audio: s.audio, export: s.export, media: s.media, voice: s.voice ?? null, background: s.background ?? undefined, multicam: s.multicam ?? undefined });
  const timeline = useMemo(() => tlOf(S), [S]);
  const lay = useMemo(() => layoutTimeline(timeline, words), [timeline, words]);
  // What the timeline shows on a track: V3 without the caption lines (captions are set in the Captions panel).
  const onTrack = (k) => (project.waiting ? [] : k === "v3" ? lay.tracks.v3.filter((c) => c.kind !== "caption") : lay.tracks[k]);
  const view = useMemo(() => sequenceView(lay, words), [lay, words]);
  const main = view.mainVideoId;
  // The other videos on V1: sent with the project, plus any added here (their preview copy is fetched then).
  const [added, setAdded] = useState({});
  const others = useMemo(() => ({ ...(project.videos || {}), ...added }), [project, added]);
  // Custom graphics by clip: a placement with its own params plays its own recording (g.t includes add_graphic from).
  // Phase 2b: a library video put inside a text's letters here plays at once (the saved edit lists it after a reload).
  const [insideMedia, setInsideMedia] = useState({});
  const insideIds = S.tracks.v3.map((c) => c.inside?.videoId).filter(Boolean).join(",");
  useEffect(() => {
    for (const id of insideIds ? insideIds.split(",") : []) if (!project.brollMedia?.[id] && !insideMedia[id])
      api.getVideo(id).then((v) => v?.proxyUrl && setInsideMedia((m) => ({ ...m, [id]: { url: v.proxyUrl, seconds: v.seconds } }))).catch(() => {});
  }, [insideIds]);
  // Elements (Assets page: logos, overlays) put on the edit here play at once (the saved edit lists them after a reload).
  const [elementMedia, setElementMedia] = useState({});
  const [elements, setElements] = useState(null);
  useEffect(() => { let live = true; api.listElements?.().then((xs) => live && setElements(Array.isArray(xs) ? xs : [])).catch(() => live && setElements([])); return () => { live = false; }; }, []);
  const media = useMemo(() => ({ broll: { ...(project.brollMedia || {}), ...insideMedia }, graphicClips: { ...(project.graphicClipMedia || {}), ...elementMedia }, audio: project.audioMedia || {} }), [project, insideMedia, elementMedia]);
  const urls = useMemo(() => ({ ...Object.fromEntries(Object.entries(others).map(([id, v]) => [id, v.url || null])), [main]: project.video?.proxyUrl || null }), [others, main, project]);
  const [sel, setSel] = useState(null); // {track,id}
  // The right panel's tab: comments (first), what your AI did, or the selected clip's settings.
  const [side, setSide] = useState("comments");
  const [voiceAt, setVoiceAt] = useState(null); // the voice clip's start while it is dragged
  const [wsel, setWsel] = useState(null); // {a,b} word indexes
  // rtab: the tool open in the left panel (null: closed by its X).
  const [rtab, setRtabNow] = useState(railTab(keep.current.tab)); const setRtab = (t) => { const k = railTab(t); keep.current.tab = k; setRtabNow(k); }; const [verMenu, setVerMenu] = useState(false);
  // The top bar's menus (aspect, quality, tool search: one open at a time) and the tool search's words.
  const [topMenu, setTopMenu] = useState(null); const [toolQ, setToolQ] = useState("");
  useEffect(() => { const k = () => { setVerMenu(false); setTopMenu(null); }; window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const [zoom, setZoom] = useState(36);
  // Engine Part 6: the waveform's peaks and the marks.
  const [peaks, setPeaks] = useState({});
  useEffect(() => {
    let live = true;
    const want = [...Object.entries(project.peaks || {}).map(([vid, url]) => ["v:" + vid, url, false]), ...Object.entries(project.audioMedia || {}).map(([k, url]) => ["a:" + k, url, true])];
    for (const [k, url, dec] of want) loadPeaks(k, url, dec).then((p) => { if (live && p) setPeaks((x) => (x[k] ? x : { ...x, [k]: p })); });
    return () => { live = false; };
  }, [project]);
  const [marks, setMarks] = useState([]); const [showMarks, setShowMarksNow] = useState(() => readFlag("rendrr.marks", true));
  const setShowMarks = (v) => { writeFlag("rendrr.marks", v); setShowMarksNow(v); };
  useEffect(() => { let live = true; api.getProjectMarks(project.id).then((m) => live && setMarks(Array.isArray(m) ? m : [])).catch(() => {}); return () => { live = false; }; }, [project.id, project.version]);
  const [tool, setTool] = useState("select"); const [snapOn, setSnapOn] = useState(true); const [addOpen, setAddOpen] = useState(false);
  const [render, setRender] = useState(null);
  const [share, setShare] = useState(false); const [help, setHelp] = useState(false); const [exportOpen, setExportOpen] = useState(false); const [samplesOpen, setSamplesOpen] = useState(false);
  // Storyboard mode: open on a board (Claude's link carries ?storyboard=<its id>), or on the latest.
  const [board, setBoard] = useState(() => { try { const q = new URLSearchParams(location.search).get("storyboard"); return q ? { id: q } : null; } catch { return null; } });
  const [viewVer, setViewVer] = useState(null);
  const [comments, setComments] = useState(project.comments);
  const [saved, setSaved] = useState("Saved");
  const [status, setStatus] = useState(project.status);
  const cutSet = useMemo(() => new Set(S.cut), [S.cut]);
  // The reference the user attached for their AI (when the edit was made, or by the AI): never applied to the edit.
  const reference = project.reference || null;
  // The left column: the library (bin), the reference or a bin video playing in the monitor.
  const lib = useLibrary([project.id]); const [source, setSource] = useState(null); const { openAdd } = useApp();
  const usedIds = useMemo(() => Array.from(new Set([...S.tracks.v1.map((c) => c.sourceVideoId).filter(Boolean), ...S.tracks.v2.filter((b) => b.kind === "broll" && b.videoId).map((b) => b.videoId)])).filter((x) => x !== project.videoId), [S.tracks]);
  // The style the AI applied (its caption rules shape the captions).
  const sq = useAsync(() => api.listStyles(), []);
  const style = (sq.data || []).find((x) => x.id === S.styleId) || project.style;
  const captionRules = useMemo(() => { const r = StyleRulesSchema.safeParse(style?.rules); return r.success ? r.data.captions : undefined; }, [style]);
  // Phase 6: the user's LUTs, and the numbers of the ones this edit's grades use (the plan needs them, as the render).
  const lutQ = useAsync(() => api.listLuts().catch(() => []), []);
  const lutIds = Array.from(new Set([...S.tracks.v1, ...S.tracks.v2].map((c) => c.grade?.lut?.id).filter(Boolean)));
  const luts = useLutData(lutIds);
  const [colorMode, setColorMode] = useState(null); const [pathDraft, setPathDraft] = useState([]); const [boxDraft, setBoxDraft] = useState(null);
  // What the plan is made from; usePlan makes it here, or in the background once planning this edit gets slow (#19).
  const planInput = useMemo(() => {
    try {
      const v = project.video || {};
      return ({ kind: "preview", snapshot: { timeline, name: S.name, aspect: S.aspect, styleId: S.styleId }, transcript, videoId: project.videoId,
        source: { width: v.width || 1920, height: v.height || 1080, fps: v.fps || 30, seconds: v.seconds || footDur, hasAudio: true }, captionRules,
        sources: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, { width: o.width || 1920, height: o.height || 1080, fps: 30, seconds: o.seconds || 0, hasAudio: true }])),
        transcripts: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, o.transcript || []])),
        brollSeconds: Object.fromEntries(Object.entries(media.broll).map(([id, b]) => [id, b.seconds])),
        // Templates draw live; a custom graphic shows once its recorded file is there (as in the render).
        graphicsReady: Object.fromEntries(lay.tracks.v3.filter((c) => c.kind === "graphic").map((c) => [c.id, !!findTemplate(c.graphicId) || !!media.graphicClips[c.id]])), luts,
        // The user's own audio files (own music, the voice in place of the clips' sound), as the render reads them.
        sounds: project.sounds || {} });
    } catch { return null; } // no plan: everything is cut
  }, [timeline, S.aspect, captionRules, media, others, luts]);
  const plan = usePlan(planInput);
  const clock = useMemo(() => sequenceClock(plan || { parts: [], sound: [], outputSeconds: 0 }), [plan]);
  const mattes = useMattes(project.id, plan);
  const dur = plan ? plan.outputSeconds : 0;
  // The rendered preview plays instead when it is of this version and nothing changed since: exactly the file.
  const fresh = !!project.previewUrl && project.previewVersion === project.version && S === initial;
  const pb = usePlayback(dur, { seq: !fresh });
  useEffect(() => { if (keep.current.time > 0) pb.seek(Math.min(keep.current.time, dur)); }, []);
  useEffect(() => { keep.current.time = pb.time; }, [pb.time]);
  // For the browser tests: where the playhead is, and moving it.
  const pbNow = useRef(pb); pbNow.current = pb;
  useEffect(() => { if (typeof window === "undefined") return; window.__rendrrPlayhead = () => pbNow.current.time; window.__rendrrSeek = (t) => pbNow.current.seek(t); }, []);
  // "Watch preview": the rendered file plays in the same player, without the live overlays.
  const [watch, setWatch] = useState(null);
  const wpb = usePlayback(watch?.seconds || 1);

  // Autosave after each change.
  const first = useRef(true);
  // One save at a time (audit #5): a change made while a save is on its way is sent right after it, never alongside it,
  // so an older save can never land last and undo the newer one. saveNow is remade each render, so it sends the latest.
  const saveQ = useRef({ busy: false, again: false });
  const saveNow = useRef(null);
  saveNow.current = () => {
    const q = saveQ.current;
    if (q.busy) { q.again = true; return; }
    q.busy = true; q.again = false;
    api.updateProject(project.id, { name: S.name, styleId: S.styleId, aspect: S.aspect, timeline: tlOf(S) })
      .then(() => { if (!q.again) setSaved("Saved"); })
      .catch((e) => { if (e.code === "stale") { q.again = false; toast(e.message, { icon: "spark" }); reload(); } else { setSaved("Not saved"); } })
      .finally(() => { q.busy = false; if (q.again) saveNow.current(); });
  };
  useEffect(() => { if (first.current) { first.current = false; return; } setSaved("Saving…"); const t = setTimeout(() => saveNow.current(), 600); return () => clearTimeout(t); }, [S]);

  // Derived playback bits: what the render shows at this moment of the edit.
  const frame = plan && !fresh ? liveFrame(plan, pb.time, clock) : null;
  const picNow = fresh ? (clock.picture(pb.time)?.videoId === main ? clock.picture(pb.time).src : null) : frame && frame.videoId === main ? frame.src : null;
  const curWord = picNow == null ? null : lastWordAtOrBefore(words, picNow, wordsInOrder);
  // The main video's parts in the edit, worked out once per plan (each word asks whether it is inside one).
  const mainParts = useMemo(() => (plan ? plan.parts.filter((p) => p.videoId === main) : []), [plan, main]);
  const inEdit = (w) => mainParts.some((p) => w.t >= p.srcIn && w.t < p.srcOut);
  const wordAt = (w) => view.videoToEdit(main, w.t) ?? 0; // where a word first plays

  // ---- editing: every change is one of the connector's ops, run here on the editor's state ----
  const ectx = useMemo(() => ({ videoId: project.videoId, transcript, silences: project.silences || [], sceneCuts: [], duration: footDur, getStyle: () => undefined,
    getVideo: (id) => { if (others[id]) return { id, name: others[id].name, seconds: others[id].seconds || 0, ready: true }; const v = (lib.library || []).find((x) => x.id === id); return v ? { id, name: v.name, seconds: v.seconds || 0, ready: v.status === "ready" } : undefined; },
    getGraphic: (id) => { const g = findTemplate(id); if (g) return { id, name: g.name, durationSec: g.durationSec }; const el = (elements || []).find((x) => x.id === id); return el ? { id, name: el.name, durationSec: 1 } : undefined; },
    getSound: (id) => { const x = (project.sounds || {})[id]; return x ? { id, name: x.name, seconds: x.seconds, ready: true } : undefined; },
    sources: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, { transcript: o.transcript || [], silences: [] }])) }), [project, transcript, others, lib.library, elements]);
  const snapOf = (s) => ({ timeline: tlOf(s), name: s.name, aspect: s.aspect, styleId: s.styleId });
  const opOn = (s, op) => { const r = applyOp(snapOf(s), op, ectx); const t = r.snap.timeline; return { state: { ...s, cut: t.cut, tracks: t.tracks, audio: t.audio, captionsOn: t.captionsOn, captionLook: t.captionLook, captionText: t.captionText, captionStyle: t.captionStyle, export: t.export, media: t.media, voice: t.voice ?? null, background: t.background ?? null, multicam: t.multicam ?? null, aspect: r.snap.aspect, name: r.snap.name }, summary: r.summary }; };
  const say = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const doOp = (op, tell = true) => { try { const r = opOn(H.state, op); H.commit(r.state); if (tell) toast(say(r.summary), { icon: "scissors" }); return r; } catch (e) { toast(e.message); return null; } };
  // An element from the Assets page: on V3 at the playhead for 5 s, at the top right at about a fifth of the frame
  // (a graphic fills the frame by itself), then moved and sized like any graphic.
  const addElement = (el) => {
    const total = Math.max(0.5, dur || 0), at = Math.max(0, Math.min(pb.time, total - 0.5)), end = Math.min(total, at + 5);
    const had = new Set(H.state.tracks.v3.map((c) => c.id));
    const r = doOp({ op: "add_graphic", graphicId: el.id, start: at, end, label: el.name, params: {} }, false);
    const made = r && r.state.tracks.v3.find((c) => c.kind === "graphic" && !had.has(c.id));
    if (!made) return;
    const ratio = ASPECT_RATIO[H.state.aspect] || 16 / 9, frame = ratio >= 1 ? { width: 1920, height: Math.round(1920 / ratio) } : { width: Math.round(1920 * ratio), height: 1920 };
    doOp({ op: "set_keyframes", track: "v3", clipId: made.id, keys: elementKeys(el, frame) }, false);
    if (el.url) setElementMedia((m) => ({ ...m, [made.id]: { url: el.url, width: el.width, height: el.height, seconds: 1 } }));
    setSel({ track: "v3", id: made.id });
    toast(`Added "${el.name}" at the top right`, { icon: "spark", tone: "brand" });
  };
  const liveOp = (base, op) => { try { H.replace(opOn(base, op).state); return true; } catch { return false; } };
  const cutWords = (ids) => { if (!ids.length) return; H.commit((s) => ({ ...s, cut: Array.from(new Set([...s.cut, ...ids])) })); toast(ids.length + (ids.length === 1 ? " word cut" : " words cut"), { icon: "scissors" }); };
  const restoreWord = (wid) => H.commit((s) => ({ ...s, cut: s.cut.filter((x) => x !== wid) }));
  const selWords = () => { if (!wsel) return []; const [a, b] = [Math.min(wsel.a, wsel.b), Math.max(wsel.a, wsel.b)]; return words.slice(a, b + 1).filter((w) => !cutSet.has(w.id)).map((w) => w.id); };
  const isV1 = (k) => k === "v1" || k === "a1"; // a V1 clip and its dialogue share an id and edit together
  // Split at the playhead: the selected clip if the playhead is in it, else the V1 clip playing.
  const split = () => {
    const t = pb.time; const inside = (c) => t > c.start + .05 && t < c.end - .05;
    let target = sel && lay.tracks[sel.track]?.find((c) => c.id === sel.id && inside(c)) ? sel : null;
    if (!target) { const c = lay.tracks.v1.find(inside); if (c) target = { track: "v1", id: c.id }; }
    if (!target) { toast("Move the playhead inside a clip to split it"); return; }
    doOp({ op: "split_clip", track: isV1(target.track) ? "v1" : target.track, clipId: target.id, at: r2(t), edit: true });
  };
  const removeSel = () => {
    if (!sel) return;
    const op = sel.track === "vo" ? { op: "set_voice", soundId: null } : sel.track === "bg" ? { op: "set_background", none: true } : { op: "delete_clip", track: sel.track, clipId: sel.id };
    if (doOp(op)) setSel(null);
  };
  const [frameOpen, setFrameOpen] = useState(false); const frameBase = useRef(null);
  const selClip = sel ? lay.tracks[sel.track]?.find((c) => c.id === sel.id) : null;
  const selV1 = sel && isV1(sel.track) ? lay.tracks.v1.find((c) => c.id === sel.id) : null;
  const isOn = (k, c) => !!sel && c.id === sel.id && (k === sel.track || (isV1(k) && isV1(sel.track)));
  // The Color tab's clip (V1 or b-roll), its shapes on the picture, and a click there: a path point or the key colour.
  const colorClip = selV1 || (sel?.track === "v2" && selClip?.kind === "broll" ? selClip : null);
  // Phase 16: a selected adjustment layer's masks are outlined too (where they are at the playhead).
  const adjSel = !colorClip && sel?.track === "v3" ? lay.tracks.v3.find((c) => c.id === sel.id && c.kind === "adjust") : null;
  const shapeClip = colorClip || adjSel;
  // A clip's moving shapes (keys, a path's shape keys) are outlined where they are at the playhead: the clip's footage
  // second there (b-roll: from its start).
  const clipFoot = colorClip ? (colorClip.kind === "broll" ? (pb.time >= colorClip.start && pb.time < colorClip.end ? (colorClip.sourceStart || 0) + (pb.time - colorClip.start) : null) : (view.editToSource(colorClip.id, pb.time) ?? null)) : null;
  const shapeAt = (a) => (adjSel ? areaAt(a, Math.max(0, pb.time - adjSel.start)) : clipFoot != null ? areaAt(a, clipFoot) : a);
  // Object tracking: each tracked object's box where it is at the playhead (dotted where it was lost).
  const objectShapes = colorClip && clipFoot != null ? (colorClip.objects || []).map((o) => { const b = objectBoxAt(o, clipFoot); return b && { shape: "rect", x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1], kind: "object", lost: (o.lost || []).some(([a, z]) => clipFoot >= a && clipFoot < z) }; }).filter(Boolean) : [];
  const colorShapes = shapeClip ? [...(shapeClip.masks || []).map((m) => ({ ...shapeAt(m), kind: "mask" })), ...(shapeClip.effects || []).filter((e) => e.area).map((e) => ({ ...shapeAt(e.area), kind: "area" })), ...objectShapes] : [];
  const onColorPoint = (pt) => {
    if (colorMode === "path") { setPathDraft((d) => [...d, pt]); return; }
    if (colorMode !== "pick" || !colorClip || !plan) return;
    const el = colorClip.sourceVideoId ? document.querySelector(`video[data-video="${colorClip.sourceVideoId}"][data-on="1"]`) : media.broll[colorClip.videoId] && document.querySelector(`video[src="${media.broll[colorClip.videoId].url}"]`);
    let c = null; try { c = el && pickColor(el, plan.width, plan.height, colorClip.rotate || 0, colorClip.sourceVideoId ? 0.4 : 0.5, pt[0], pt[1], colorClip.sourceVideoId ? colorClip.framing?.focus : null); } catch (e) { toast("Could not read the picture here: " + e.message); }
    if (c) { doOp({ op: "set_key", clipId: colorClip.id, color: c }); setColorMode(null); }
  };
  const toggleMute = () => selV1 && doOp({ op: "set_audio_offset", clipId: selV1.id, muted: !selV1.audioMuted });
  // Turn and framing: the selected V1 clip, else every clip of the footage (as the connector's ops do).
  const lookIds = selV1 ? [selV1.id] : undefined;
  // Footage Rendrr measured as filmed sideways (faces upright when turned) and not turned yet in this edit: offered,
  // never done by itself.
  const [sideDismissed, setSideDismissed] = useState(false);
  const sideways = Object.entries(project.sideways || {}).map(([vid, turn]) => ({ vid, turn, clips: S.tracks.v1.filter((c) => (c.sourceVideoId || main) === vid && (c.rotate || 0) !== turn) })).filter((x) => x.clips.length);
  const lookClip = selV1 || lay.tracks.v1.find((c) => c.sourceVideoId === main) || null;
  const rotNow = lookClip?.rotate || 0; const frNow = lookClip?.framing || { scale: 1, x: 0, y: 0 };
  // Auto reframe: the speaker's face in each clip (from the faces Rendrr measured), kept in the frame's shape.
  const [reframing, setReframing] = useState(false);
  const reframeFace = async (all = false) => {
    const ids = all ? S.tracks.v1.map((c) => c.id) : lookIds || S.tracks.v1.filter((c) => (c.sourceVideoId || main) === main).map((c) => c.id);
    const clips = S.tracks.v1.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, videoId: c.sourceVideoId || main, srcIn: c.sourceIn, srcOut: c.freeze ? c.sourceIn + 0.04 : c.sourceOut, rotate: c.rotate || 0 }));
    if (!clips.length) return;
    setReframing(true);
    try {
      const { centers } = await api.speakerCentres(project.id, clips);
      const found = Object.values(centers).filter(Boolean).length;
      if (!found) toast("No face found here yet. Rendrr measures faces when a video comes in; try again once it is ready.");
      else { doOp({ op: "set_framing", focus: "face", centers, clipIds: ids }); if (found < clips.length) toast(`Reframed ${found} of ${clips.length} clips: no face in the others.`); }
    } catch (e) { toast(e.message); } finally { setReframing(false); }
  };
  // The footage just came in (Recreate): when its shape is not the edit's, follow the speaker so it fills the frame.
  useEffect(() => {
    if (!keep.current.autoFrame || project.waiting) return; keep.current.autoFrame = false;
    const v = project.video || {}, r = v.width && v.height ? v.width / v.height : { Landscape: 16 / 9, Portrait: 9 / 16, Square: 1 }[v.orientation] || 0, want = ASPECT_RATIO[S.aspect];
    if (r && want && Math.abs(r - want) / want > 0.05) { toast(`Framing it for ${S.aspect}: it follows the speaker`, { icon: "spark", tone: "brand" }); setTimeout(() => reframeFace(true), 300); }
  }, []);
  const onDelete = () => { const ids = selWords(); if (ids.length) { cutWords(ids); setWsel(null); } else if (sel) removeSel(); };
  const fit = () => setZoom(Math.max(ZMIN, Math.min(ZMAX, Math.floor(((canvasRef.current?.parentElement?.clientWidth || 900) - 40) / Math.max(1, dur)))));
  // Clips of other videos: their preview copies, so they play here at once. Several go in one after another, from the
  // playhead (or the end), as one change.
  // Phase 10: a camera's preview copy, so its monitor and the player can show it.
  const addVideo = async (id) => { if (id === main || others[id]) return; const v = await api.getVideo(id); setAdded((a) => ({ ...a, [id]: { name: v.name, seconds: v.seconds, width: v.width, height: v.height, url: v.proxyUrl || null, transcript: [] } })); };
  // Recreate: the edit waits for its footage; the first videos added become it, and the editor opens on them (then
  // frames them for the edit's shape by itself).
  const waiting = !!project.waiting;
  const [adopting, setAdopting] = useState(false);
  const adoptFootage = async (ids) => {
    if (!ids.length || adopting) return; setAdopting(true);
    try { await api.useFootage(project.id, ids); keep.current.autoFrame = true; reload(); }
    catch (e) { toast(e.message); setAdopting(false); }
  };
  const addClip = async ({ items, at }) => {
    setAddOpen(false);
    if (waiting) return adoptFootage(items.map(({ video }) => video.id));
    for (const { video } of items) {
      if (video.id === main || others[video.id]) continue;
      try { const v = await api.getVideo(video.id); setAdded((a) => ({ ...a, [video.id]: { name: v.name, seconds: v.seconds, width: v.width, height: v.height, url: v.proxyUrl || null, transcript: [] } })); }
      catch (e) { toast(e.message); return; }
    }
    // The ops need to know the videos: run them with these videos known.
    try {
      const known = Object.fromEntries(items.map(({ video }) => [video.id, video]));
      const ctx2 = { ...ectx, getVideo: (id) => (known[id] ? { id, name: known[id].name, seconds: known[id].seconds || 0, ready: true } : ectx.getVideo(id)) };
      let snap = snapOf(H.state), index; const said = [];
      for (const [k, { video, from, to }] of items.entries()) {
        const before = new Set(snap.timeline.tracks.v1.map((c) => c.id));
        const place = k > 0 ? { index } : at != null ? { at: r2(at) } : {};
        const r = applyOp(snap, { op: "add_clip", videoId: video.id === main ? undefined : video.id, from, to, ...place, label: video.id === main ? undefined : video.name }, ctx2);
        snap = r.snap; said.push(r.summary);
        index = snap.timeline.tracks.v1.findIndex((c) => !before.has(c.id)) + 1; // right after the clip just added
      }
      H.commit((s) => ({ ...s, cut: snap.timeline.cut, tracks: snap.timeline.tracks }));
      toast(items.length === 1 ? say(said[0]) : "Added " + items.length + " videos, one after another", { icon: "plus" });
    } catch (e) { toast(e.message); }
  };

  // ---- keyboard ----
  // The handler is made on each render (it reads the latest state); the window listener is added once and calls it
  // (it was taken off and put back on every frame while a video played).
  const keyRef = useRef(null);
  keyRef.current = (e) => {
      const tag = e.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
      if (render || share || addOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? H.redo() : H.undo(); return; }
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); split(); return; }
      if (mod) return;
      if (e.shiftKey && e.key.toLowerCase() === "z") { fit(); return; }
      const t = TOOLS.find(([, key]) => key.toLowerCase() === e.key.toLowerCase());
      if (t && !e.shiftKey) { setTool(t[0]); return; }
      switch (e.key) {
        case " ": e.preventDefault(); pb.toggle(); break;
        case "j": case "J": pb.seek(pb.time - 5); break; // edit time
        case "k": case "K": pb.setPlaying(false); break;
        case "l": case "L": pb.seek(pb.time + 5); break;
        case "ArrowLeft": e.preventDefault(); pb.seek(pb.time - (e.shiftKey ? 1 : 1 / 30)); break;
        case "ArrowRight": e.preventDefault(); pb.seek(pb.time + (e.shiftKey ? 1 : 1 / 30)); break;
        case "Home": e.preventDefault(); pb.seek(0); break;
        case "End": e.preventDefault(); pb.seek(dur); break;
        case "=": case "+": setZoom((z) => Math.min(ZMAX, Math.round(z * 1.4))); break;
        case "-": case "_": setZoom((z) => Math.max(ZMIN, Math.round(z / 1.4))); break;
        case "s": case "S": setSnapOn((x) => { toast(x ? "Snapping off" : "Snapping on"); return !x; }); break;
        case "Delete": case "Backspace": e.preventDefault(); onDelete(); break;
        case "?": setHelp((h) => !h); break;
        case "Escape": setHelp(false); setWsel(null); setSel(null); break;
      }
    };
  useEffect(() => { const k = (ev) => keyRef.current && keyRef.current(ev); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);

  // ---- render flow ----
  const startRender = async (kind, opts = {}) => {
    pb.setPlaying(false);
    setRender({ kind, status: "running", progress: { step: 0, steps: [], percent: 0 } });
    try {
      const fn = kind === "preview" ? api.renderPreview : api.renderFinal;
      const result = await fn(project.id, (p) => setRender((r) => r && { ...r, progress: p }), opts);
      setRender((r) => ({ ...r, status: "done", result })); setStatus(kind === "preview" ? "Preview ready" : "Final ready"); refreshUsage();
      // A new preview of this version: reload so the player plays the file itself.
      if (kind === "preview") { setRender(null); toast("Preview rendered. The player now plays the file.", { icon: "check", tone: "brand" }); reload(); return; }
      setChat((c) => [...c, { id: "r" + Date.now(), role: "ai", ai: "Rendrr", text: "Final rendered.", workflow: result.steps || ["Encoded 1080p", "Cleaned up raw file"], at: Date.now() }]);
    } catch (e) {
      // Stop export: the window just closes.
      if (e.code === "stopped") { setRender(null); toast("Export stopped", { icon: "x" }); return; }
      // Local footage: full quality needs the original once. Ask for it, then run the final.
      if (e.code === "need-original") { setRender({ kind, opts, status: "original", hasFile: api.hasLocalFile(project.videoId), error: null, progress: { step: 0, steps: [], percent: 0 } }); return; }
      setRender((r) => ({ ...r, status: "error", code: e.code, error: e.message }));
    }
  };
  const sendOriginal = async (file) => {
    const opts = render?.opts || {};
    // No file picked here: open the one this browser remembers (Chrome may ask to allow it), else a file picker.
    // Asked first, inside the click, so the browser lets it ask.
    if (!file) {
      try { file = await api.ensureLocalFile(project.videoId); }
      catch (e) { setRender((r) => ({ ...r, status: "original", hasFile: false, error: e.message })); return; }
    }
    const upload = new AbortController();
    setRender((r) => ({ ...r, status: "running", upload, progress: { step: 0, steps: ["Uploading original"], percent: 0 } }));
    try { await api.uploadOriginalForExport(project.id, file, (p) => setRender((r) => r && { ...r, progress: p }), upload.signal); }
    catch (e) {
      if (e.code === "stopped") { setRender(null); toast("Export stopped", { icon: "x" }); return; }
      setRender((r) => ({ ...r, status: "original", hasFile: api.hasLocalFile(project.videoId), error: e.message })); return;
    }
    startRender("final", opts);
  };
  // Stop export: the upload of the original stops here; a render on the server is stopped there (its window closes when
  // the server says it stopped). Until then the button says it is stopping.
  const stopExport = async () => {
    const r = render;
    if (!r || r.stopping) return;
    setRender((x) => x && { ...x, stopping: true, stopSent: !!x.progress?.renderId });
    if (r.upload && !r.progress?.renderId) { r.upload.abort(); return; }
    if (!r.progress?.renderId) return; // not started on the server yet: it is stopped as soon as it has an id (below)
    try { await api.stopRender(r.progress.renderId); }
    catch (e) { setRender((x) => x && { ...x, stopping: false }); toast(e.message); }
  };
  // Stop pressed before the server gave the render an id: stop it the moment it has one.
  useEffect(() => { if (render?.stopping && render.progress?.renderId && !render.stopSent) { setRender((x) => x && { ...x, stopSent: true }); api.stopRender(render.progress.renderId).catch(() => {}); } }, [render?.stopping, render?.progress?.renderId]);
  const reconnectDrive = async () => { try { await api.reconnectDriveFile(project.videoId, project.video?.driveFileId); toast("Drive file reconnected", { icon: "drive", tone: "brand" }); startRender("final"); } catch (e) { toast(e.message); } };

  // ---- transcript selection (drag over words) ----
  const dragRef = useRef(null);
  const onWordDown = (i) => (e) => { e.preventDefault(); dragRef.current = { a: i, moved: false }; setWsel({ a: i, b: i }); };
  const onWordEnter = (i) => () => { if (dragRef.current) { dragRef.current.moved = dragRef.current.moved || i !== dragRef.current.a; setWsel({ a: dragRef.current.a, b: i }); } };
  // The same two handlers, kept the same from one render to the next, so a transcript line is not drawn again on
  // every frame of playback only because its handlers were made anew.
  const wordFns = useRef(null); wordFns.current = { onWordDown, onWordEnter };
  const stableWordDown = useCallback((i) => (ev) => wordFns.current.onWordDown(i)(ev), []);
  const stableWordEnter = useCallback((i) => () => wordFns.current.onWordEnter(i)(), []);
  useEffect(() => { const up = () => { if (!dragRef.current) return; const d = dragRef.current; dragRef.current = null; if (!d.moved) { const w = words[d.a]; if (cutSet.has(w.id)) { restoreWord(w.id); setWsel(null); } else if (inEdit(w)) { pb.seek(wordAt(w)); } else toast("This word's clip is out of the edit. Undo, or trim the clip back, to bring it back."); } }; window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, [words, cutSet, view, plan]);
  const inWsel = (i) => wsel && i >= Math.min(wsel.a, wsel.b) && i <= Math.max(wsel.a, wsel.b);

  // ---- timeline pointer logic ----
  const canvasRef = useRef();
  const PAD = 12; const px = (t) => PAD + t * zoom;
  // The page is drawn at a CSS zoom (#root, 0.8 on desktop): pointer positions and rects are screen pixels, the
  // timeline's px are CSS pixels. uiScale converts (without it a click landed at 0.8x the time under the pointer).
  const uiScale = () => { const el = canvasRef.current; const w = el?.offsetWidth; return w ? el.getBoundingClientRect().width / w || 1 : 1; };
  const tAt = (clientX) => { const r = canvasRef.current.getBoundingClientRect(); return Math.min(dur, Math.max(0, ((clientX - r.left) / uiScale() - PAD) / zoom)); };
  const scrubTimeline = (e) => { pb.seek(tAt(e.clientX)); const mv = (ev) => pb.seek(tAt(ev.clientX)); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); };
  // Snapping: an edge or a cut dragged within 8 px of the playhead or another clip's edge lands on it.
  const snapT = (t, skip = []) => {
    if (!snapOn) return t;
    let best = t, bd = 8 / zoom;
    for (const p of [0, dur, pb.time, ...TRACKS.flatMap(([k]) => onTrack(k).flatMap((c) => [c.start, c.end]))]) {
      if (skip.some((x) => Math.abs(x - p) < 1e-6)) continue;
      const d = Math.abs(p - t); if (d < bd) { best = p; bd = d; }
    }
    return best;
  };
  // A drag: each move shows the result of the op on the state before the drag; letting go makes it one undo step.
  const drag = (e, onMove, onUp) => {
    const x0 = e.clientX; const base = H.state; const k = uiScale() * zoom;
    const mv = (ev) => onMove((ev.clientX - x0) / k, base, ev);
    const up = (ev) => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); if (onUp) onUp((ev.clientX - x0) / k, base); else H.commitFrom(base); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const [drop, setDrop] = useState(null); // reordering: the cut where the dragged clip would go
  const clipDown = (k, c) => (e) => {
    e.stopPropagation(); e.preventDefault();
    setSel({ track: k, id: c.id });
    const marker = isCaptionMarker(k, c);
    if (tool === "razor") { if (!marker) doOp({ op: "split_clip", track: isV1(k) ? "v1" : k, clipId: c.id, at: r2(snapT(tAt(e.clientX))), edit: true }); return; }
    if (isV1(k) && tool === "slip") return drag(e, (d, base) => liveOp(base, { op: "slip_clip", clipId: c.id, by: r2(-d) }));
    if (isV1(k) && tool === "slide") return drag(e, (d, base) => { const s = snapT(c.start + d, [c.start]); liveOp(base, { op: "slide_clip", clipId: c.id, by: r2(s - c.start) }); });
    if (k === "v1" && tool === "select") {
      // Drag to reorder: the clip goes to the cut nearest the pointer.
      const t0 = tAt(e.clientX); const cuts = [...lay.tracks.v1.map((x) => x.start), dur];
      let moved = false;
      return drag(e, (d) => { if (!moved && Math.abs(d * zoom) < 5) return; moved = true; const t = t0 + d; setDrop(cuts.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), cuts[0])); },
        (d) => { setDrop(null); if (moved) doOp({ op: "move_clip", clipId: c.id, at: r2(clamp(t0 + d, 0, dur)) }); });
    }
    if (!isV1(k) && !marker && (tool === "select" || tool === "ripple")) {
      // Move a clip on another track: it hangs on the V1 clip under its new start.
      const len = c.end - c.start;
      return drag(e, (d, base) => { const s = clamp(snapT(c.start + d, [c.start]), 0, Math.max(0, dur - 0.05)); liveOp(base, { op: "trim_clip", track: k, clipId: c.id, start: r2(s), end: r2(Math.min(dur, s + len)), edit: true }); });
    }
  };
  const edgeDown = (k, c, edge) => (e) => {
    e.stopPropagation(); e.preventDefault(); setSel({ track: k, id: c.id });
    if (isCaptionMarker(k, c)) return;
    const v = isV1(k) ? lay.tracks.v1.find((x) => x.id === c.id) : null;
    const at0 = edge === "l" ? c.start : c.end;
    if (k === "a1" && e.altKey && v) {
      // J/L cut: the dialogue's edge moves on its own (the neighbour's sound gives way).
      return drag(e, (d, base) => { const t = snapT(at0 + d, [at0]); liveOp(base, edge === "l" ? { op: "set_audio_offset", clipId: c.id, start: r2(t - v.start) } : { op: "set_audio_offset", clipId: c.id, end: r2(t - v.end) }); });
    }
    if (v && tool === "roll") {
      // Rolling edit: the cut between this clip and its neighbour moves; the edit keeps its length.
      const i = lay.tracks.v1.findIndex((x) => x.id === c.id); const left = edge === "l" ? lay.tracks.v1[i - 1] : v;
      if (!left) return;
      const cut = edge === "l" ? v.start : v.end;
      return drag(e, (d, base) => { const t = snapT(cut + d, [cut]); liveOp(base, { op: "roll_edit", clipId: left.id, by: r2(t - cut) }); });
    }
    if (v) {
      // Ripple trim: the clip's footage edge moves; the edit grows or closes up after it.
      const vEdge = edge === "l" ? v.start : v.end;
      return drag(e, (d, base) => { const dd = snapT(vEdge + d, [vEdge]) - vEdge; liveOp(base, { op: "trim_clip", track: "v1", clipId: c.id, start: r2(edge === "l" ? v.sourceIn + dd : v.sourceIn), end: r2(edge === "r" ? v.sourceOut + dd : v.sourceOut) }); });
    }
    // Another track: the edge moves in the edit.
    return drag(e, (d, base) => {
      const s = edge === "l" ? clamp(snapT(c.start + d, [c.start]), 0, c.end - 0.1) : c.start;
      const en = edge === "r" ? clamp(snapT(c.end + d, [c.end]), c.start + 0.1, dur) : c.end;
      liveOp(base, { op: "trim_clip", track: k, clipId: c.id, start: r2(s), end: r2(en), edit: true });
    });
  };
  const canvasW = Math.max(900, px(dur) + 40);
  const tickStep = zoom < 8 ? 30 : zoom < 14 ? 10 : zoom < 30 ? 5 : zoom < 60 ? 2 : zoom < 150 ? 1 : zoom < 400 ? 0.5 : 0.2;
  const ticks = []; for (let k = 0; k * tickStep <= dur; k++) ticks.push(r2(k * tickStep));
  // Layers that are not clips of a track, shown like Premiere's: what is behind V1 (a row under it) and your own sound
  // file in place of the clips' sound (a row under the dialogue). Each can be selected and changed.
  const bgClip = S.background ? { id: "background", start: 0, end: dur, label: "Background: " + (S.background.videoId ? (others[S.background.videoId]?.name || "a video") : S.background.color ? S.background.color : S.background.blur != null ? "the picture blurred" : S.background.gradient ? "gradient" : S.background.pattern ? S.background.pattern.kind : "black") } : null;
  const voiceSound = S.voice ? (project.sounds || {})[S.voice.soundId] : null;
  const voiceStart = voiceAt ?? (S.voice?.start || 0);
  const voiceClip = S.voice ? { id: "voice", start: voiceStart, end: r2(voiceStart + (voiceSound?.seconds || S.voice.editSeconds || dur)), label: "Voice: " + (voiceSound?.name || "your sound file") + (S.voice.gainDb ? " · " + dB(S.voice.gainDb) : "") } : null;
  const rows = [...TRACKS.slice(0, 3), ...(bgClip ? [["bg", "BG"]] : []), TRACKS[3], ...(voiceClip ? [["vo", "VO"]] : []), ...TRACKS.slice(4)];
  const layerOf = (k) => (k === "bg" ? (bgClip ? [bgClip] : []) : k === "vo" ? (voiceClip ? [voiceClip] : []) : onTrack(k));
  // Drag the voice clip to move where it starts; click to select it.
  const voiceDown = (e) => {
    e.stopPropagation(); setSel({ track: "vo", id: "voice" });
    const x0 = e.clientX, s0 = S.voice.start || 0; let to = s0;
    const move = (ev) => { to = Math.max(0, r2(s0 + (ev.clientX - x0) / zoom)); setVoiceAt(to); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setVoiceAt(null); if (Math.abs(to - s0) > 0.01) doOp({ op: "set_voice", soundId: S.voice.soundId, start: to, ...(S.voice.gainDb != null ? { gainDb: S.voice.gainDb } : {}) }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  // The effects on a clip (grade, masks, key, blur…): an fx badge, as in Premiere; it opens the Color panel.
  const fxOf = (k, c) => (k === "v1" || (k === "v2" && c.kind === "broll") ? [lookTags(c).replace(/^look: /, ""), c.stabilize ? "stabilize" : ""].filter(Boolean).join(", ") : "");
  const v1ById = useMemo(() => new Map(lay.tracks.v1.map((c) => [c.id, c])), [lay]);
  const clipText = (k, c) => {
    if (k === "v1") { const vn = c.sourceVideoId !== main ? others[c.sourceVideoId]?.name || "Other video" : ""; const sp = c.freeze ? " · freeze" : c.ramp?.length ? " · ramp" : (c.speed && c.speed !== 1 ? ` · ${c.speed}x` : "") + (c.reverse ? " · reversed" : ""); const ang = c.angle && S.multicam?.angles?.find((a) => a.videoId === c.angle); const an = ang ? " · " + (ang.name || others[ang.videoId]?.name || "Angle") : ""; return (vn && vn !== c.label ? vn + " · " : "") + (c.label || vn) + an + (c.rotate ? ` ↻${c.rotate}°` : "") + sp; }
    if (k === "a1") { const v = v1ById.get(c.id); const j = v && c.start < v.start - 0.005, l = v && v.end < c.end - 0.005; return "Dialogue" + (j ? " · J" : "") + (l ? " · L" : "") + (c.audioMuted ? " · muted" : "") + (v?.audioGain ? " · " + dB(v.audioGain) : ""); }
    if (k === "a2" || k === "a3") { const a = planAudio.get(c.id); return c.label + (a ? " · " + dB(a.gainDb) : ""); }
    return c.label;
  };
  // Sound fades drawn on the clips, as they render (music without its own fades gets the automatic ones).
  const planAudio = useMemo(() => new Map((plan?.audio || []).map((a) => [a.clipId, a])), [plan]);
  // What each sound track plays, for its waveform: the dialogue parts (their videos' measured peaks), music and effects.
  const waveParts = useMemo(() => ({
    a1: (plan?.sound || []).filter((x) => !x.silent).map((x) => ({ ...x, key: "v:" + x.videoId })),
    a2: (plan?.audio || []).filter((a) => a.kind === "music").map((a) => ({ start: a.start, end: a.end, srcIn: 0, srcOut: a.end - a.start, key: "a:" + a.assetKey })),
    a3: (plan?.audio || []).filter((a) => a.kind === "sfx").map((a) => ({ start: a.start, end: a.end, srcIn: 0, srcOut: a.end - a.start, key: "a:" + a.assetKey })),
  }), [plan]);
  // Phase 5 marks: the transition on the cut before a V1 clip, and keyframes as diamonds where they sit in the clip.
  const marksOf = (k, c) => {
    if (k !== "v1" && k !== "v2" && k !== "v3") return null;
    const keys = k === "v1" ? plan?.clipMotion?.[c.id]?.keys : c.keys;
    const t = k === "v1" && c.transition ? plan?.transitions?.find((x) => x.clipId === c.id) : null;
    return html`${t && t.end > t.start && html`<span class="trm" data-transition=${t.type} title=${`${t.type} ${(t.end - t.start).toFixed(2)}s`} style=${{ left: -((t.at - t.start) * zoom) + "px", width: (t.end - t.start) * zoom + "px" }} />`}${(keys || []).map((x, i) => html`<i key=${i} class="kf" style=${{ left: x.t * zoom + "px" }} />`)}`;
  };
  const fadesOf = (k, c) => {
    const f = k === "a1" ? { i: v1ById.get(c.id)?.audioFadeIn, o: v1ById.get(c.id)?.audioFadeOut } : k === "a2" || k === "a3" ? { i: planAudio.get(c.id)?.fadeIn, o: planAudio.get(c.id)?.fadeOut } : null;
    return f && html`${f.i > 0 && html`<i class="fd in" data-fade="in" style=${{ width: f.i * zoom }} />`}${f.o > 0 && html`<i class="fd out" data-fade="out" style=${{ width: f.o * zoom }} />`}`;
  };
  const soundSel = sel && ["v1", "a1", "a2", "a3"].includes(sel.track) ? (isV1(sel.track) ? selV1 : selClip) : null;
  const soundLen = !soundSel ? 0 : isV1(sel.track) ? (() => { const a = lay.tracks.a1.find((x) => x.id === soundSel.id); return a ? a.end - a.start : 0; })() : soundSel.end - soundSel.start;
  // Phase 6: where the playhead is in the selected clip's sound (for a volume key there).
  const soundStart = !soundSel ? 0 : isV1(sel.track) ? lay.tracks.a1.find((x) => x.id === soundSel.id)?.start ?? 0 : soundSel.start;

  const { chat, setChat } = ai;
  useEffect(() => { const el = document.getElementById("ai-thread"); if (el) el.scrollTop = el.scrollHeight; }, [chat, side]);
  useEffect(() => { const el = document.getElementById("comment-list"); if (el) el.scrollTop = el.scrollHeight; }, [comments.length, side]);
  // What each tool in the Edit list has going on, in a word or two.
  const toolHint = { transcript: S.cut.length ? `${S.cut.length} cut` : "", clip: sel ? sel.track.toUpperCase() + " clip" : "", captions: S.captionsOn ? "On" : "Off", audio: S.voice ? "Your voice file" : "", multicam: S.multicam?.angles?.length ? `${S.multicam.angles.length + 1} cameras` : "" };
  const [draft, setDraft] = useState(""); const [posting, setPosting] = useState(false);
  // The composer (as Higgsfield's): the moment, a drawing on the picture, emoji, pictures, a round send button.
  const [cDraw, setCDraw] = useState(false), [cStrokes, setCStrokes] = useState([]), [cPen, setCPen] = useState(PENS[0]), [cImgs, setCImgs] = useState([]), [cEmoji, setCEmoji] = useState(false);
  const cFile = useRef(null), cLive = useRef(null), cText = useRef(null), cAt = useRef(null);
  useEffect(() => { if (!cStrokes.length && !cLive.current) cAt.current = null; }, [cStrokes]);
  const canPost = !!draft.trim() || cStrokes.length > 0 || cImgs.length > 0;
  const postComment = async () => {
    if (!canPost) return;
    setPosting(true);
    try {
      // A drawing belongs to the frame it was drawn on (the player may have moved since); it goes with a PNG of itself
      // so the AI can see it on that frame (get_comments images), as the Claude app's drawings do.
      const d = cStrokes.length ? { w: plan?.width || 1280, h: plan?.height || 720, strokes: cStrokes } : null;
      const c = await api.addProjectComment(project.id, { time: d && cAt.current != null ? cAt.current : pb.time, text: draft, drawing: d ? { ...d, png: drawingPng(d) || undefined } : undefined, images: cImgs.map(({ type, data, name, w, h }) => ({ type, data, name: name || undefined, w, h })) });
      setComments((x) => [...x, c].sort((a, b) => a.time - b.time));
      setDraft(""); setCStrokes([]); setCImgs([]); setCDraw(false); setCEmoji(false);
      toast("Comment added at " + fmtTime(c.time), { icon: "comment" });
    } catch (e) { toast(e.message); } finally { setPosting(false); }
  };
  const addCImages = async (files) => {
    const list = Array.from(files || []).filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    if (!list.length) { if (files?.length) toast("Add a JPEG, PNG or WebP picture."); return; }
    if (cImgs.length + list.length > 4) toast("Up to 4 pictures on a comment.");
    const got = [];
    for (const f of list.slice(0, Math.max(0, 4 - cImgs.length))) { try { got.push(await readCommentImage(f)); } catch { toast("Could not read " + (f.name || "that picture") + "."); } }
    setCImgs((x) => [...x, ...got].slice(0, 4));
    if (cFile.current) cFile.current.value = "";
  };
  const addEmoji = (em) => { const el = cText.current, at = el ? el.selectionStart ?? draft.length : draft.length; setDraft(draft.slice(0, at) + em + draft.slice(at)); setCEmoji(false); setTimeout(() => { el?.focus(); el?.setSelectionRange(at + em.length, at + em.length); }, 0); };
  // Drawing on the picture: strokes in shares of the frame, at the comment's moment (the player paused there).
  const drawDown = (e) => {
    if (!cDraw) return;
    e.preventDefault();
    // One stroke at a time: a second finger does not start another over it.
    if (cLive.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (cAt.current == null) cAt.current = pb.time;
    const id = e.pointerId, r = e.currentTarget.getBoundingClientRect(), pt = (ev) => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))].map((v) => Math.round(v * 1000) / 1000);
    cLive.current = { c: cPen, w: 0.004, p: pt(e) };
    const move = (ev) => { if (ev.pointerId !== id || !cLive.current) return; cLive.current = { ...cLive.current, p: [...cLive.current.p, ...pt(ev)].slice(0, 4000) }; setCStrokes((x) => [...x]); };
    // Lifted, or taken over by the system (a scroll, a call): the stroke ends and nothing stays listening.
    const up = (ev) => {
      if (ev && ev.pointerId !== id) return;
      const st = cLive.current; cLive.current = null;
      for (const [n, f] of [["pointermove", move], ["pointerup", up], ["pointercancel", up]]) window.removeEventListener(n, f);
      if (st && st.p.length >= 4) setCStrokes((x) => [...x, st].slice(0, 80)); else setCStrokes((x) => [...x]);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };
  const poly = (st, i) => html`<polyline key=${i} points=${st.p.reduce((a, v, k) => (k % 2 ? a + "," + v : a + (k ? " " : "") + v), "")} fill="none" stroke=${st.c} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`;
  const drawOverlay = (cDraw || cStrokes.length) && !pb.playing ? html`<svg class=${"cmt-ink" + (cDraw ? " drawing" : "")} id="comment-draw-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Your drawing for this comment" onPointerDown=${drawDown}>${cStrokes.map(poly)}${cLive.current ? poly(cLive.current, "live") : null}</svg>` : null;
  const resolve = async (c) => { try { const u = await api.resolveComment(c.id, !c.resolved); setComments((x) => x.map((i) => (i.id === c.id ? { ...i, resolved: u.resolved } : i))); } catch (e) { toast(e.message); } };
  // "Send to Claude": the open comments go to the AI the user connected. MCP cannot push into a chat, so the AI's chat
  // opens with them ready, and Rendrr tells that AI on its next tool call too.
  const [aiConn, setAiConn] = useState(null); // { claude, chatgpt }: connected or not; null while loading
  useEffect(() => { let live = true; api.getConnectStatus().then((s) => live && setAiConn({ claude: s?.claude === "connected", chatgpt: s?.chatgpt === "connected" })).catch(() => live && setAiConn({ claude: false, chatgpt: false })); return () => { live = false; }; }, []);
  const [aiPick, setAiPick] = useState(() => { try { return localStorage.getItem("rendrr.sendAi"); } catch { return null; } });
  const sendTo = aiConn ? handoffTarget(aiConn, aiPick) : null;
  const [aiMenu, setAiMenu] = useState(false); const [aiSending, setAiSending] = useState(false);
  const openCount = comments.filter((c) => !c.resolved).length;
  const sendToAi = async (which = sendTo) => {
    if (!which || aiSending) return;
    setAiMenu(false); setAiPick(which);
    try { localStorage.setItem("rendrr.sendAi", which); } catch {}
    // A browser lets a page open a tab only during the click: open it now and fill it when Rendrr answers. The Mac
    // app sends such links to the browser itself.
    const tab = window.rendrrDesktop ? null : window.open("", "_blank");
    if (tab) { try { tab.opener = null; } catch {} }
    setAiSending(true);
    try {
      const r = await api.sendComments(project.id, which, comments.filter((c) => !c.resolved).map((c) => c.id)); // what the button counted
      if (tab) tab.location.href = r.url; else window.open(r.url, "_blank", "noopener");
      const ids = new Set(r.commentIds), sent = { to: which, at: r.at };
      setComments((x) => x.map((c) => (ids.has(c.id) ? { ...c, sent } : c)));
      toast(`Sent ${r.count} ${r.count === 1 ? "comment" : "comments"} to ${r.name}. Its chat opened with them.`, { icon: "spark" });
    } catch (e) { try { tab?.close(); } catch {} toast(e.message); }
    finally { setAiSending(false); }
  };
  // Comments from the Rendrr app in Claude can carry a drawing and pictures; the user's own notes can be edited, any deleted.
  const [cEdit, setCEdit] = useState(null); // { id, text }
  const [cDel, setCDel] = useState(null);
  const [cFilter, setCFilter] = useState(() => (comments.some((c) => !c.resolved) || !comments.length ? "open" : "all"));
  const shownComments = cFilter === "open" ? comments.filter((c) => !c.resolved) : cFilter === "done" ? comments.filter((c) => c.resolved) : comments;
  const [ink, setInk] = useState(null); // { time, strokes }: a comment's drawing, shown on the picture at its moment
  const saveCEdit = async () => { try { const u = await api.editComment(cEdit.id, cEdit.text); setComments((x) => x.map((i) => (i.id === u.id ? { ...i, ...u } : i))); setCEdit(null); } catch (e) { toast(e.message); } };
  const delComment = async (c) => {
    if (cDel !== c.id) { setCDel(c.id); setTimeout(() => setCDel((v) => (v === c.id ? null : v)), 3000); return; }
    try { await api.deleteComment(c.id); setComments((x) => x.filter((i) => i.id !== c.id)); setCDel(null); toast("Comment deleted.", { icon: "trash" }); } catch (e) { toast(e.message); }
  };
  const showInk = (c) => { pb.setPlaying(false); pb.seek(c.time); setInk({ time: c.time, strokes: c.drawing.strokes }); };
  const inkOverlay = ink && !pb.playing && Math.abs(pb.time - ink.time) < 0.06 ? html`<svg class="cmt-ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Drawing from a comment">${ink.strokes.map((st, i) => html`<polyline key=${i} points=${st.p.reduce((a, v, k) => (k % 2 ? a + "," + v : a + (k ? " " : "") + v), "")} fill="none" stroke=${st.c} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`)}</svg>` : null;

  // The inspector (right): the settings of what is selected on the timeline.
  const insp = sel?.track === "vo" && S.voice ? { kind: "voice", title: "Your sound file", icon: "wave" }
    : sel?.track === "bg" && S.background ? { kind: "background", title: "Background", icon: "image" }
    : !sel || (!selClip && !selV1) ? { kind: null, title: "Inspector", icon: "edit" }
    : isV1(sel.track) ? { kind: "clip", title: selV1?.label || "Clip", icon: "film" }
    : sel.track === "v2" ? (selClip?.kind === "broll" ? { kind: "broll", title: selClip.label || "B-roll", icon: "film" } : { kind: "other", title: selClip?.label || "Effect", icon: "zap" })
    : sel.track === "v3" ? (selClip?.kind === "text" ? { kind: "text", title: "Text", icon: "type" } : selClip?.kind === "graphic" ? { kind: "graphic", title: selClip.label || "Graphic", icon: "layers" } : selClip?.kind === "adjust" ? { kind: "adjust", title: "Adjustment layer", icon: "drop" } : { kind: "other", title: selClip?.label || "Title", icon: "type" })
    : { kind: "sound", title: selClip?.label || (sel.track === "a2" ? "Music" : "Sound effect"), icon: "wave" };
  useEffect(() => { if (insp.kind) setSide("clip"); else setSide((t) => (t === "clip" ? "comments" : t)); }, [sel?.track, sel?.id, !!insp.kind]);
  // Search tools (top bar): every panel, the inspector's groups and the editor's actions, by name.
  const selAtPlayhead = () => { const c = lay.tracks.v1.find((x) => pb.time >= x.start && pb.time < x.end) || lay.tracks.v1[0]; if (c) setSel({ track: "v1", id: c.id }); };
  const later = (f) => () => setTimeout(f, 0);
  const allTools = [
    ...RAIL.map(([k, l, ic]) => ({ label: l, icon: ic, where: "Panel", run: () => setRtab(k) })),
    { label: "Comments", icon: "rComments", where: "Right panel", run: () => setSide("comments") },
    { label: "Your AI", icon: "rAI", where: "Right panel", run: () => setSide("ai") },
    { label: "Speed, motion and transitions", icon: "gauge", where: "Inspector", run: selAtPlayhead },
    { label: "Clip sound: level and fades", icon: "wave", where: "Inspector", run: selAtPlayhead },
    { label: "Split at the playhead", icon: "scissors", where: "⌘K", run: split },
    { label: "Add videos", icon: "plus", where: "Timeline", run: () => setAddOpen(true) },
    ...TOOLS.map(([k, key, label]) => ({ label: label + " tool", icon: k, where: key, run: () => setTool(k) })),
    { label: "Aspect ratio", icon: "monitor", where: S.aspect, run: later(() => setTopMenu("aspect")) },
    { label: "Quality", icon: "quality", where: qualityChip({ timeline, aspect: S.aspect }), run: later(() => setTopMenu("quality")) },
    { label: "Samples", icon: "image", where: "Frames", run: () => setSamplesOpen(true) },
    { label: "Storyboard", icon: "film", where: "Review", run: () => setBoard({ id: null }) },
    { label: "Share for review", icon: "link", where: "Link", run: () => setShare(true) },
    { label: "Export", icon: "download", where: "Final", run: () => setExportOpen(true) },
    { label: "Keyboard shortcuts", icon: "help", where: "?", run: () => setHelp(true) },
  ];
  const foundTools = toolQ.trim() ? allTools.filter((t) => t.label.toLowerCase().includes(toolQ.trim().toLowerCase())) : allTools;

  return html`<div class=${"editor" + (cDraw ? " drawing" : "")}>
    <div class="ed-top">
      <${Btn} kind="quiet" icon="back" aria-label="Back to projects" onClick=${() => go("/projects/" + project.folderId)} />
      <input id="project-name" class="name" value=${S.name} aria-label="Project name" onInput=${(e) => H.replace((s) => ({ ...s, name: e.target.value }))} onBlur=${(e) => { if (e.target.value !== project.name) H.commitFrom({ ...S, name: project.name }); }} />
      <div style="position:relative" onClick=${(e) => e.stopPropagation()}>
        <button class="btn secondary sm" id="version-btn" aria-haspopup="menu" aria-expanded=${verMenu} onClick=${() => setVerMenu((m) => !m)}>V${viewVer || project.versions.length}<${Icon} name="down" size="14" /></button>
        ${verMenu && html`<div class="menu" style="left:0;right:auto;top:40px;min-width:200px" role="menu">${[...project.versions].reverse().map((v) => { const latest = v.v === project.versions.length; const on = (viewVer || project.versions.length) === v.v; return html`<button key=${v.v} role="menuitemradio" aria-checked=${on} class=${"item" + (on ? " on" : "")} data-version=${v.v} onClick=${() => { setViewVer(latest ? null : v.v); setVerMenu(false); }}><${Icon} name=${on ? "check" : "film"} />V${v.v}<span class="muted t-small" style="margin-left:auto">${latest ? "Latest" : fmtAgo(v.at)}</span></button>`; })}</div>`}
      </div>
      <span class="t-small muted" id="saved" title=${saved} style="display:inline-flex;align-items:center;gap:4px;opacity:.7">${saved === "Saved" ? "" : saved}</span>
      <div class="grow" />
      ${fresh && html`<span class="t-small muted" id="auto-preview" title="The player plays the rendered preview file of this version.">Rendered preview</span>`}
      <div class="tb-pop" onClick=${(e) => e.stopPropagation()}>
        <button class="tb-chip" id="aspect-btn" aria-haspopup="menu" aria-expanded=${topMenu === "aspect"} title="Aspect ratio" onClick=${() => setTopMenu((m) => (m === "aspect" ? null : "aspect"))}><i class="ar-ico" style=${{ aspectRatio: S.aspect.replace(":", "/") }} />${S.aspect}<${Icon} name="down" size="12" /></button>
        ${topMenu === "aspect" && html`<div class="menu tb-menu" id="aspect-menu" role="menu"><span class="t-small muted tb-menu-h">Aspect ratio</span>${["9:16", "16:9", "4:5", "1:1"].map((a) => html`<button key=${a} role="menuitemradio" aria-checked=${S.aspect === a} class=${"ar-row" + (S.aspect === a ? " on" : "")} data-aspect=${a} onClick=${() => { setTopMenu(null); if (a !== S.aspect) doOp({ op: "set_aspect", aspect: a }); }}><i class="ar-ico" style=${{ aspectRatio: a.replace(":", "/") }} /><span class="col"><b>${a}</b><small class="muted">${ASPECT_NAMES[a]}</small></span></button>`)}</div>`}
      </div>
      <div class="tb-pop" onClick=${(e) => e.stopPropagation()}>
        <button class="tb-chip" id="quality-btn" aria-haspopup="dialog" aria-expanded=${topMenu === "quality"} title="Quality" onClick=${() => setTopMenu((m) => (m === "quality" ? null : "quality"))}><${Icon} name="quality" size="14" />${qualityChip({ timeline, aspect: S.aspect })}<${Icon} name="down" size="12" /></button>
        ${topMenu === "quality" && html`<div class="menu tb-menu wide" role="dialog" aria-label="Quality"><${QualityMenu} snap=${{ timeline, aspect: S.aspect }} video=${project.video} doOp=${doOp} onMore=${() => { setTopMenu(null); setExportOpen(true); }} /></div>`}
      </div>
      <div class="tb-pop tb-search" onClick=${(e) => e.stopPropagation()}>
        <label class="tb-search-box"><${Icon} name="search" size="14" /><input id="tool-search" placeholder="Search tools" aria-label="Search tools" value=${toolQ} onFocus=${() => setTopMenu("search")} onInput=${(e) => { setToolQ(e.target.value); setTopMenu("search"); }} onKeyDown=${(e) => { if (e.key === "Enter" && foundTools[0]) { foundTools[0].run(); setToolQ(""); setTopMenu(null); e.target.blur(); } if (e.key === "Escape") { setToolQ(""); setTopMenu(null); e.target.blur(); } }} /></label>
        ${topMenu === "search" && html`<div class="menu tb-menu" id="tool-search-menu" role="menu">${foundTools.length ? foundTools.slice(0, 9).map((t) => html`<button key=${t.label} role="menuitem" class="tb-found" onClick=${() => { t.run(); setToolQ(""); setTopMenu(null); }}><${Icon} name=${t.icon} size="15" /><span class="grow">${t.label}</span><small class="muted">${t.where}</small></button>`) : html`<span class="t-small muted tb-menu-h">No tool called "${toolQ}"</span>`}</div>`}
      </div>
      <${MoreMenu} id="editor-more" label="More" items=${[
        !fresh && { id: "render-preview", label: "Export preview", icon: "play", disabled: waiting || saved !== "Saved" || !plan, onClick: () => startRender("preview") },
        { id: "samples-btn", label: "Samples", icon: "image", title: "A few frames and short clips, drawn as the export draws them", disabled: saved !== "Saved" || !plan, onClick: () => { pb.setPlaying(false); setSamplesOpen(true); } },
        { id: "storyboard-btn", label: "Storyboard", icon: "film", title: "A board of the key moments and the style sheet, to review before the whole video", disabled: saved !== "Saved" || !plan, onClick: () => { pb.setPlaying(false); setBoard({ id: null }); } },
      ]} />
      <${Btn} kind="secondary" size="sm" id="share" icon="link" onClick=${() => setShare(true)}>Share<//>
      <${Btn} size="sm" id="render-final" icon="download" disabled=${waiting} onClick=${() => setExportOpen(true)}>Export<//>
    </div>

    <div class="ed-body">
      <div class=${"ed-work" + (rtab ? "" : " lib-closed")}>
        <nav class="ed-rail" id="edit-tools" role="tablist" aria-label="Tools" aria-orientation="vertical">
          ${[RAIL].map((group, gi) => html`<div key=${gi} class="rail-group">${group.map(([k, l, ic]) => html`<button key=${k} role="tab" id=${"tab-" + k} aria-selected=${rtab === k} aria-label=${l} title=${l + (toolHint[k] ? " · " + toolHint[k] : "")} class=${"rail-btn" + (rtab === k ? " on" : "")} onClick=${() => setRtab(k)}><${Icon} name=${ic} size="19" /><span class="rail-l">${l}</span></button>`)}</div>`)}
        </nav>
        ${rtab && html`<section class="panel ed-lib" id="lib-panel" aria-label=${PANEL_TOOLS[rtab][0]}>
          <div class="rp-head" id="tool-head"><span class="rp-ico"><${Icon} name=${PANEL_TOOLS[rtab][1]} size="15" /></span><b class="grow">${PANEL_TOOLS[rtab][0]}</b><button class="rp-back" id="tool-back" aria-label="Close" title="Close" onClick=${() => setRtab(null)}><${Icon} name="x" size="14" /></button></div>
          ${rtab === "media" && html`<div class="pb lib-media" id="media-panel">
          <${SourceMonitor} reference=${reference} source=${source} onCloseSource=${() => setSource(null)}
            onInsert=${(v) => addClip({ items: [{ video: v, from: 0, to: v.seconds }], at: pb.time })} onAppend=${(v) => addClip({ items: [{ video: v, from: 0, to: v.seconds }] })} />
          <${MediaBin} onAddClips=${() => setAddOpen(true)} library=${lib.library} used=${waiting ? [] : usedIds} bin=${S.media || []} mainId=${waiting ? null : project.videoId} previewing=${source?.id} onPreview=${(v) => setSource(v)}
            onAppend=${(v) => addClip({ items: [{ video: v, from: 0, to: v.seconds }] })} onAddToBin=${(v) => doOp({ op: "add_media", videoIds: [v.id] })} onRemoveFromBin=${(v) => doOp({ op: "remove_media", videoIds: [v.id] })}
            onImport=${() => openAdd("footage")} elements=${elements} onAddElement=${addElement} />
          </div>`}
          ${rtab === "transcript" && html`<div class="pb words" id="transcript" style="padding-top:12px">
            <div class="row between" style="margin-bottom:8px"><span class="t-small muted">Drag over words and press <span class="kbd">Delete</span> to cut them.</span><span class="t-small muted" style="white-space:nowrap">${S.cut.length} cut</span></div>
            ${project.transcript.map((l) => html`<${TranscriptLine} key=${l.id} l=${l} index=${wordIndex} cutSet=${cutSet} mainParts=${mainParts} selA=${wsel ? Math.min(wsel.a, wsel.b) : -1} selB=${wsel ? Math.max(wsel.a, wsel.b) : -2} nowId=${curWord && wordLine.get(curWord.id) === l.id ? curWord.id : null} onDown=${stableWordDown} onEnter=${stableWordEnter} />`)}
            ${selWords().length > 0 && html`<div class="selpop" id="cut-pop"><span class="t-small">${selWords().length} ${selWords().length === 1 ? "word" : "words"}</span><${Btn} size="xs" icon="scissors" id="cut-selected" onClick=${() => { cutWords(selWords()); setWsel(null); }}>Remove from video<//><${Btn} kind="quiet" size="xs" icon="play" aria-label="Play selection" onClick=${() => { const ids = selWords(); const w = words.find((x) => x.id === ids[0]); if (w) { pb.seek(wordAt(w)); pb.setPlaying(true); } }} /><${Btn} kind="quiet" size="xs" icon="x" aria-label="Clear selection" onClick=${() => setWsel(null)} /></div>`}
          </div>`}
          ${rtab === "multicam" && html`<${MulticamTab} projectId=${project.id} timeline=${timeline} lay=${lay} view=${view} main=${main} mainName=${project.video?.name} library=${(lib.library || []).filter((v) => v.status === "ready" && v.kind !== "reference")} at=${pb.time} playing=${pb.playing} urls=${urls} doOp=${doOp} addVideo=${addVideo} toast=${toast} />`}
          ${rtab === "color" && html`<${ColorTab} footAt=${clipFoot} boxDraft=${boxDraft} setBoxDraft=${setBoxDraft} clip=${colorClip} track=${sel?.track} projectId=${project.id} mainVideo=${main} aspect=${S.aspect} clips=${[...lay.tracks.v1, ...lay.tracks.v2.filter((b) => b.kind === "broll")]} lutList=${lutQ.data || []} reloadLuts=${() => lutQ.reload()} timeline=${timeline} doOp=${doOp} H=${H} liveOp=${liveOp} mode=${colorMode} setMode=${setColorMode} draft=${pathDraft} setDraft=${setPathDraft} toast=${toast} mattes=${mattes} adjust=${{ clips: lay.tracks.v3.filter((c) => c.kind === "adjust"), sel: sel?.track === "v3" ? lay.tracks.v3.find((c) => c.id === sel.id && c.kind === "adjust") || null : null, at: pb.time, dur, select: (id) => setSel(id ? { track: "v3", id } : null) }} />`}
          ${rtab === "audio" && html`<${AudioTab} a=${audioSettings(timeline)} clip=${soundSel} track=${sel?.track} len=${soundLen} here=${Math.max(0, Math.min(soundLen, pb.time - soundStart))} planned=${soundSel ? planAudio.get(soundSel.id) : null} doOp=${doOp} H=${H} liveOp=${liveOp} voice=${S.voice ? { ...S.voice, name: (project.sounds || {})[S.voice.soundId]?.name } : null} part="edit" />`}
          ${rtab === "text" && html`<${TextTab} timeline=${timeline} aspect=${S.aspect} captionRules=${captionRules} textClips=${lay.tracks.v3.filter((c) => c.kind === "text")} selText=${sel?.track === "v3" ? lay.tracks.v3.find((c) => c.id === sel.id && c.kind === "text") : null} onSelect=${(id) => setSel({ track: "v3", id })} at=${pb.time} dur=${dur} doOp=${doOp} H=${H} liveOp=${liveOp} videos=${(lib.library || []).filter((v) => v.status === "ready" && v.kind !== "reference")} objects=${[...lay.tracks.v1, ...lay.tracks.v2.filter((b) => b.kind === "broll")].flatMap((c) => (c.objects || []).map((o) => ({ clipId: c.id, clipName: c.label || c.id, id: o.id, label: o.label })))} part="text" />`}
          ${rtab === "captions" && html`<${TextTab} timeline=${timeline} aspect=${S.aspect} captionRules=${captionRules} textClips=${lay.tracks.v3.filter((c) => c.kind === "text")} selText=${sel?.track === "v3" ? lay.tracks.v3.find((c) => c.id === sel.id && c.kind === "text") : null} onSelect=${(id) => setSel({ track: "v3", id })} at=${pb.time} dur=${dur} doOp=${doOp} H=${H} liveOp=${liveOp} videos=${(lib.library || []).filter((v) => v.status === "ready" && v.kind !== "reference")} objects=${[...lay.tracks.v1, ...lay.tracks.v2.filter((b) => b.kind === "broll")].flatMap((c) => (c.objects || []).map((o) => ({ clipId: c.id, clipName: c.label || c.id, id: o.id, label: o.label })))} part="captions" />`}
        </section>`}
        <div class="center">
          ${viewVer && viewVer !== project.versions.length && html`<div class="ver-banner"><span>Viewing V${viewVer} of ${S.name} (read only)</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" onClick=${async () => { try { await api.restoreVersion(project.id, viewVer); toast("V" + viewVer + " restored as a new version"); setViewVer(null); reload(); } catch (e) { toast(e.message); } }}>Restore this version<//><${Btn} kind="ghost" size="xs" id="back-latest" onClick=${() => setViewVer(null)}>Back to latest<//></div></div>`}
          ${!viewVer && !watch && !sideDismissed && sideways.length > 0 && html`<div class="ver-banner" id="sideways"><span>${sideways.length === 1 && sideways[0].vid === main ? "This footage looks" : "Some footage looks"} filmed sideways: faces are upright when it is turned ${sideways[0].turn}° clockwise.</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" id="turn-upright" onClick=${() => { const ok = sideways.every((x) => doOp({ op: "set_rotation", degrees: x.turn, clipIds: x.clips.map((c) => c.id) }, false)); if (ok) toast("Turned upright", { icon: "refresh" }); }}>Turn it upright<//><${Btn} kind="ghost" size="xs" onClick=${() => setSideDismissed(true)}>Keep as is<//></div></div>`}
          ${watch && html`<div class="ver-banner"><span>Watching the rendered preview (V${watch.version || project.version})</span><div class="row" style="gap:8px"><${Btn} kind="ghost" size="xs" id="back-editing" onClick=${() => { wpb.setPlaying(false); setWatch(null); }}>Back to editing<//></div></div>`}
          <div style="flex:1;min-height:0;display:flex;justify-content:center">${waiting
            ? html`<div class="waiting-footage" id="waiting-footage"><div class="wf-ico"><${Icon} name="film" size="28" /></div>
                <b class="t-heading">Add your footage</b>
                <p class="t-small muted">${reference ? `Recreating "${reference.name}". ` : ""}Pick your raw video: it is framed for this ${S.aspect} edit by itself.</p>
                <${Btn} id="add-footage-first" icon="plus" disabled=${adopting} onClick=${() => setAddOpen(true)}>${adopting ? "Adding your footage…" : "Add your footage"}<//></div>`
            : watch
            ? html`<${Player} tools key="watch" style=${{ height: "100%", maxWidth: "100%" }} pb=${wpb} duration=${watch.seconds || 1} aspect=${S.aspect} src=${watch.url} />`
            : !plan ? html`<div class="state" style="margin:auto"><div class="ico"><${Icon} name="scissors" /></div><b class="t-label">Everything is cut</b><p class="t-small">Undo, or restore some words or clips.</p></div>`
            : fresh ? html`<${Player} tools key="preview" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} src=${project.previewUrl} overlay=${drawOverlay || inkOverlay} marks=${comments.filter((c) => c.time > 0 && !c.resolved)} onMark=${(c) => { pb.seek(c.time); setSide("comments"); }} />`
            : html`<${Player} tools key="edit" style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} aspect=${S.aspect} media=${Object.values(urls).some(Boolean) && html`<${SeqMedia} plan=${plan} clock=${clock} time=${pb.time} playing=${pb.playing} urls=${urls} sounds=${media.audio} aspect=${S.aspect} pb=${pb} broll=${media.broll} luts=${luts} mattes=${mattes} />`} caption=${frame?.caption} captionLook=${S.captionLook} zoom=${frame?.zoom || 1} zoomTransition=${false} captionDrawn=${!!plan?.styledCaptions} overlay=${html`<${LiveOverlays} frame=${frame} clips=${lay.tracks.v3} media=${media} aspect=${S.aspect} playing=${pb.playing} plan=${plan} luts=${luts} mattes=${mattes} person=${plan?.person ? html`<${PersonLayer} plan=${plan} frame=${frame} mattes=${mattes} zoom=${frame?.zoom || 1} luts=${luts} />` : null} />${rtab === "color" && shapeClip ? html`<${MaskOverlay} shapes=${colorShapes} mode=${colorMode} draft=${pathDraft} onPoint=${onColorPoint} onBox=${(b) => { setColorMode(null); setBoxDraft(b); }} />` : null}${drawOverlay || inkOverlay}`} marks=${comments.filter((c) => c.time > 0 && !c.resolved)} onMark=${(c) => { pb.seek(c.time); setSide("comments"); }} />`}</div>
        </div>
        <aside class="panel ed-insp" id="inspector" aria-label="Comments, your AI and the selected clip">
          <div class="side-tabs" role="tablist" aria-label="Right panel">
            <button role="tab" id="side-comments" aria-selected=${side === "comments"} class=${side === "comments" ? "on" : ""} onClick=${() => setSide("comments")}><${Icon} name="rComments" size="15" />Comments${comments.some((c) => !c.resolved) ? html`<span class="n">${comments.filter((c) => !c.resolved).length}</span>` : ""}</button>
            <button role="tab" id="side-ai" aria-selected=${side === "ai"} class=${side === "ai" ? "on" : ""} onClick=${() => setSide("ai")}><${Icon} name="rAI" size="15" />Your AI</button>
            ${insp.kind && html`<button role="tab" id="side-clip" aria-selected=${side === "clip"} class=${side === "clip" ? "on" : ""} onClick=${() => setSide("clip")} title=${insp.title}><${Icon} name=${insp.icon} size="15" /><span class="ell">${insp.title}</span></button>`}
          </div>
          ${side === "ai" && html`<div class="pb cmts" id="ai-panel" style="padding-top:12px">
            <div class="col" style="gap:10px;flex:1;min-height:0;overflow:auto" id="ai-thread">
              ${chat.length === 0 ? html`<div class="state" style="padding:28px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="spark" /></div><b class="t-label">What your AI did shows here</b><p class="t-small">When Claude or ChatGPT edits this video through the connector, every step and its notes to you appear here.</p></div>`
              : chat.map((m) => html`<div key=${m.id} class=${"msg " + m.role} data-msg=${m.id}>
                  ${m.role === "ai" && html`<span class="who"><${Icon} name="spark" size="12" /> ${m.ai}</span>`}
                  <p>${m.text}</p>
                  ${m.workflow && html`<div class="wf"><span class="t-small muted">Workflow</span>${m.workflow.map((w, i) => html`<div key=${i} class="wf-step"><span class="n">${i + 1}</span>${w}</div>`)}</div>`}
                  <span class="t-small muted when">${fmtAgo(m.at)}</span>
                </div>`)}
            </div>
            <p class="t-small muted" style="margin:0">Ask for changes in Claude or ChatGPT. This page only shows what they did.</p>
          </div>`}
          ${side === "comments" && html`<div class="pb cmts" id="comments-panel">
            <div class="cm-head"><div class="seg sm" role="tablist" aria-label="Which comments">${[["open", "Open", comments.filter((c) => !c.resolved).length], ["all", "All", comments.length], ["done", "Done", comments.filter((c) => c.resolved).length]].map(([k, l, n]) => html`<button key=${k} role="tab" aria-selected=${cFilter === k} class=${cFilter === k ? "on" : ""} id=${"cm-filter-" + k} onClick=${() => setCFilter(k)}>${l} <span class="muted">${n}</span></button>`)}</div></div>
            ${openCount > 0 && html`<div class="cm-send" id="ai-send">
              ${aiConn && !sendTo ? html`<button class="cm-send-btn off" id="ai-send-connect" onClick=${() => go("/connect")}><${Icon} name="spark" size="15" />Connect Claude to send comments</button>`
              : html`<button class="cm-send-btn" id="ai-send-btn" disabled=${!sendTo || aiSending} title=${"Opens " + aiName(sendTo) + " with your open comments; it fixes them through Rendrr"} onClick=${() => sendToAi()}>${aiSending ? html`<span class="spin" />` : html`<${Icon} name="spark" size="15" />`}Send ${openCount} ${openCount === 1 ? "comment" : "comments"} to ${aiName(sendTo)}</button>
                ${aiConn?.claude && aiConn?.chatgpt && html`<span class="cm-send-wrap"><button class="cm-send-more" id="ai-send-pick" aria-label="Send to another AI" aria-haspopup="menu" aria-expanded=${aiMenu} onClick=${() => setAiMenu(!aiMenu)}><${Icon} name="down" size="14" /></button>
                  ${aiMenu && html`<div class="cm-send-pop" role="menu" id="ai-send-menu">${["claude", "chatgpt"].map((k) => html`<button key=${k} role="menuitem" class="cm-send-opt" id=${"ai-send-" + k} onClick=${() => sendToAi(k)}>Send to ${aiName(k)}${k === sendTo ? html`<${Icon} name="check" size="12" />` : null}</button>`)}</div>`}</span>`}`}
            </div>`}
            <div class="col cm-list" id="comment-list">
              ${comments.length === 0 ? html`<div class="cm-empty" id="comments-empty"><span class="cm-empty-ico"><${Icon} name="comment" size="22" /></span><b>No comments yet</b><p class="t-small muted">Pause where something should change and leave a note: write, draw on the picture or add a picture. Clients can comment too, from a review link.</p></div>`
              : shownComments.length === 0 ? html`<p class="t-small muted" style="padding:16px 4px">${cFilter === "open" ? "Every comment is resolved." : "No resolved comments yet."}</p>`
              : shownComments.map((c) => html`<div key=${c.id} class=${"cmt" + (c.resolved ? " done" : "") + (Math.abs(pb.time - c.time) < 0.05 && c.time > 0 ? " now" : "")} data-comment=${c.id} onClick=${(e) => { if (!e.target.closest("button, a, input, form") && c.time > 0) { pb.setPlaying(false); pb.seek(c.time); } }}>
                  <span class=${"gava" + (c.mine ? "" : " client")}>${initials(c.author)}</span>
                  <div class="grow" style="min-width:0">
                    <div class="cmt-top"><b>${c.author}${c.mine ? " (you)" : ""}</b><span class="muted">${fmtAgo(c.at)}${c.edited ? " · edited" : ""}</span><div class="grow" />
                      <span class="cmt-acts">${c.mine && html`<button class="cmt-act" onClick=${() => setCEdit({ id: c.id, text: c.text })}>Edit</button>`}
                      <button class=${"cmt-act" + (cDel === c.id ? " warn" : "")} aria-label="Delete comment" onClick=${() => delComment(c)}>${cDel === c.id ? "Delete?" : html`<${Icon} name="trash" />`}</button></span>
                      <button class=${"cmt-check" + (c.resolved ? " on" : "")} aria-label=${c.resolved ? "Reopen" : "Resolve"} title=${c.resolved ? "Reopen" : "Mark as done"} onClick=${() => resolve(c)}><${Icon} name="check" size="12" /></button></div>
                    ${cEdit?.id === c.id ? html`<form class="row" style="gap:6px;margin-top:6px" onSubmit=${(e) => { e.preventDefault(); saveCEdit(); }}><input class="input sm grow" aria-label="Edit comment" value=${cEdit.text} onInput=${(e) => setCEdit({ ...cEdit, text: e.target.value })} onKeyDown=${(e) => e.key === "Escape" && setCEdit(null)} autoFocus /><${Btn} size="sm" type="submit">Save<//><${Btn} size="sm" kind="quiet" type="button" onClick=${() => setCEdit(null)}>Cancel<//></form>`
                    : html`<p class="cmt-body">${c.time > 0 && html`<button class="tc" onClick=${() => pb.seek(c.time)}>${fmtTime(c.time)}</button>`}${linkified(c.text)}</p>`}
                    ${c.sent && html`<div class="cmt-sent" title=${"Sent " + fmtAgo(c.sent.at)}><${Icon} name="spark" size="11" />Sent to ${aiName(c.sent.to)} · ${fmtAgo(c.sent.at)}</div>`}
                    ${(c.drawing || c.images?.length) ? html`<div class="row cmt-media">${c.drawing && html`<button class="cmt-badge" onClick=${() => showInk(c)}>✎ Drawing</button>`}${(c.images || []).map((im) => html`<a key=${im.id} href=${im.url} target="_blank" rel="noopener noreferrer" title=${im.name || "Picture"}><img class="cmt-img" src=${im.url} alt=${im.name || "Picture"} /></a>`)}</div>` : null}</div>
                </div>`)}
            </div>
            <form class="cbox" id="comment-box" onSubmit=${(e) => { e.preventDefault(); postComment(); }} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); addCImages(e.dataTransfer?.files); }} onPaste=${(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addCImages(fs); } }}>
              ${cDraw && html`<div class="cbox-draw" id="comment-draw-bar"><span class="t-small muted">Draw on the picture</span>
                <span class="row" style="gap:4px">${PENS.map((col) => html`<button key=${col} type="button" class=${"cbox-pen" + (cPen === col ? " on" : "")} style=${{ background: col }} aria-label=${"Pen colour " + col} onClick=${() => setCPen(col)} />`)}</span><div class="grow" />
                <button type="button" class="cmt-act" id="comment-draw-undo" disabled=${!cStrokes.length} onClick=${() => setCStrokes((x) => x.slice(0, -1))}>Undo</button>
                <button type="button" class="cmt-act" id="comment-draw-clear" disabled=${!cStrokes.length} onClick=${() => setCStrokes([])}>Clear</button>
                <button type="button" class="cmt-act strong" id="comment-draw-done" onClick=${() => setCDraw(false)}>Done</button></div>`}
              ${(cImgs.length > 0 || (cStrokes.length > 0 && !cDraw)) && html`<div class="cbox-media" id="comment-attached">
                ${cStrokes.length > 0 && !cDraw && html`<span class="cmt-badge">✎ Drawing<button type="button" class="cbox-x" aria-label="Remove the drawing" onClick=${() => setCStrokes([])}><${Icon} name="x" size="10" /></button></span>`}
                ${cImgs.map((im) => html`<span key=${im.local} class="cbox-thumb"><img src=${im.thumb} alt=${im.name || "Picture"} /><button type="button" class="cbox-x" aria-label="Remove this picture" onClick=${() => setCImgs((x) => x.filter((y) => y.local !== im.local))}><${Icon} name="x" size="10" /></button></span>`)}</div>`}
              <textarea id="comment-input" ref=${cText} class="cbox-text" rows="2" placeholder="Leave a comment at this moment…" value=${draft} onInput=${(e) => setDraft(e.target.value)} onFocus=${() => pb.setPlaying(false)} onKeyDown=${(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); } }} />
              <div class="cbox-bar">
                <button type="button" class="cbox-time" id="comment-time" title="The comment goes at this moment" onClick=${() => pb.setPlaying(false)}><${Icon} name="clock" size="13" />${fmtTime(pb.time, true)}</button>
                <button type="button" class=${"cbox-icon" + (cDraw ? " on" : "")} id="comment-draw" aria-label="Draw on the picture" aria-pressed=${cDraw} title="Draw on the picture" onClick=${() => { pb.setPlaying(false); setCDraw(!cDraw); setCEmoji(false); if (!cDraw) setTimeout(() => document.getElementById("comment-draw-layer")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60); }}><${Icon} name="edit" size="16" /></button>
                <span class="cbox-pop-wrap"><button type="button" class=${"cbox-icon" + (cEmoji ? " on" : "")} id="comment-emoji" aria-label="Add an emoji" aria-expanded=${cEmoji} title="Emoji" onClick=${() => setCEmoji(!cEmoji)}><${Icon} name="smile" size="16" /></button>
                  ${cEmoji && html`<div class="cbox-pop" id="comment-emoji-pop" role="menu">${EMOJI.map((em) => html`<button key=${em} type="button" role="menuitem" class="cbox-em" onClick=${() => addEmoji(em)}>${em}</button>`)}</div>`}</span>
                <button type="button" class="cbox-icon" id="comment-picture" aria-label="Add a picture" title="Add a picture (or paste or drop one)" disabled=${cImgs.length >= 4} onClick=${() => cFile.current?.click()}><${Icon} name="image" size="16" /></button>
                <input ref=${cFile} type="file" accept="image/jpeg,image/png,image/webp" multiple id="comment-file" style="display:none" onChange=${(e) => addCImages(e.target.files)} />
                <div class="grow" />
                <button type="submit" class="cbox-send" id="comment-post" aria-label="Post the comment" title="Post (Ctrl+Enter)" disabled=${!canPost || posting}>${posting ? html`<span class="spin" />` : html`<${Icon} name="send" size="16" />`}</button>
              </div>
            </form>
          </div>`}
          ${side === "clip" && insp.kind && html`<div class="rp-head" id="inspector-head"><span class="rp-ico"><${Icon} name=${insp.icon} size="15" /></span><b class="grow ell">${insp.title}</b>${sel && html`<button class="rp-back" id="inspector-clear" aria-label="Clear the selection" title="Clear the selection" onClick=${() => setSel(null)}><${Icon} name="x" size="14" /></button>`}</div>`}
          ${side === "clip" && insp.kind && html`<div class="insp-body">
          ${insp.kind === "text" && html`<${TextTab} timeline=${timeline} aspect=${S.aspect} captionRules=${captionRules} textClips=${lay.tracks.v3.filter((c) => c.kind === "text")} selText=${sel?.track === "v3" ? lay.tracks.v3.find((c) => c.id === sel.id && c.kind === "text") : null} onSelect=${(id) => setSel({ track: "v3", id })} at=${pb.time} dur=${dur} doOp=${doOp} H=${H} liveOp=${liveOp} videos=${(lib.library || []).filter((v) => v.status === "ready" && v.kind !== "reference")} objects=${[...lay.tracks.v1, ...lay.tracks.v2.filter((b) => b.kind === "broll")].flatMap((c) => (c.objects || []).map((o) => ({ clipId: c.id, clipName: c.label || c.id, id: o.id, label: o.label })))} part="selected" />`}
          ${(insp.kind === "clip" || insp.kind === "broll" || insp.kind === "text" || insp.kind === "graphic" || insp.kind === "adjust") && html`<${ClipTab} clip=${sel && isV1(sel.track) ? selV1 : selClip} track=${sel?.track} plan=${plan} first=${!!selV1 && lay.tracks.v1.find((c) => c.end - c.start > 0.01)?.id === selV1.id} at=${pb.time} srcAt=${(id, t) => view.editToSource(id, t)} onSeek=${(t) => pb.seek(t)} doOp=${doOp} H=${H} liveOp=${liveOp} />`}
          ${insp.kind === "adjust" && html`<div class="pb" style="padding-top:0"><${Btn} kind="secondary" size="sm" icon="drop" id="inspector-open-color" onClick=${() => setRtab("color")}>Open Color<//></div>`}
          ${(insp.kind === "clip" || insp.kind === "sound") && html`<${AudioTab} a=${audioSettings(timeline)} clip=${soundSel} track=${sel?.track} len=${soundLen} here=${Math.max(0, Math.min(soundLen, pb.time - soundStart))} planned=${soundSel ? planAudio.get(soundSel.id) : null} doOp=${doOp} H=${H} liveOp=${liveOp} part="clip" />`}
          ${insp.kind === "voice" && html`<div class="pb" id="voice-inspector" style="padding-top:16px"><div class="col" style="gap:12px">
            <p class="t-small muted">"${voiceSound?.name || "Your sound file"}" plays in place of every clip's own sound. Drag it on the timeline to move it.</p>
            <${OpSlider} id="voice-gain" label="Level" value=${S.voice.gainDb ?? 0} min=${-30} max=${12} step=${0.5} show=${(x) => dB(x)} opFor=${(x) => ({ op: "set_voice", soundId: S.voice.soundId, start: S.voice.start || 0, gainDb: x })} H=${H} liveOp=${liveOp} />
            <label class="t-small" style="display:grid;gap:4px">Starts at (seconds of the edit)<input class="input sm" id="voice-start" type="number" min="0" step="0.1" value=${S.voice.start || 0} onChange=${(e) => doOp({ op: "set_voice", soundId: S.voice.soundId, start: Math.max(0, +e.target.value || 0), ...(S.voice.gainDb != null ? { gainDb: S.voice.gainDb } : {}) })} /></label>
            <${Btn} kind="secondary" size="sm" id="voice-off" icon="x" onClick=${() => { if (doOp({ op: "set_voice", soundId: null })) setSel(null); }}>Use the clips' own sound<//>
          </div></div>`}
          ${insp.kind === "background" && html`<div class="pb" id="background-inspector" style="padding-top:16px"><div class="col" style="gap:12px">
            <p class="t-small muted">${bgClip?.label}. It shows where the picture is smaller, cropped, keyed or has its background removed.</p>
            <div class="row" style="gap:8px"><${Btn} kind="secondary" size="sm" id="background-edit" icon="drop" onClick=${() => setRtab("color")}>Change it in Color<//><${Btn} kind="ghost" size="sm" id="background-off" onClick=${removeSel}>Remove<//></div>
          </div></div>`}
          ${insp.kind === "other" && html`<p class="t-small muted pb" style="padding-top:16px">${selClip?.label || "This clip"}: drag it on the timeline to move it, or its edges to trim it.</p>`}
          </div>`}
        </aside>
      </div>
      <div class="tl">
      <div class="tl-bar">
        <div class="row" style="gap:6px"><${Btn} kind="quiet" size="xs" icon=${pb.playing ? "pause" : "play"} aria-label=${pb.playing ? "Pause" : "Play"} onClick=${pb.toggle} />
          <span class="mono t-small tc-ro"><b>${fmtTime(pb.time, true)}</b><span class="muted"> / ${fmtTime(dur, true)}</span></span></div>
        <div class="tl-acts">
          <span class="tool-set" role="radiogroup" aria-label="Tool">${TOOLS.map(([k, key, label, hint]) => html`<button key=${k} class=${"tool icon" + (tool === k ? " on" : "")} id=${"tool-" + k} role="radio" aria-checked=${tool === k} aria-label=${label} data-tip=${label + " (" + key + "): " + hint} onClick=${() => setTool(k)}><${Icon} name=${TOOL_ICON[k]} size="16" /></button>`)}</span>
          <i class="tbar-sep" />
          <button class="tool icon" id="split" data-tip="Split at the playhead (⌘K)" aria-label="Split at the playhead" onClick=${split}><${Icon} name="scissors" size="16" /></button>
          <button class="tool icon" id="add-clip" data-tip="Add videos to the sequence" aria-label="Add videos" onClick=${() => setAddOpen(true)}><${Icon} name="plus" size="16" /></button>
          <button class="tool icon" id="rotate" data-tip=${"Turn " + (selV1 ? "this clip" : "the footage") + " 90° clockwise" + (rotNow ? " (now " + rotNow + "°)" : "")} aria-label="Rotate" onClick=${() => doOp({ op: "set_rotation", degrees: (rotNow + 90) % 360, clipIds: lookIds })}><${Icon} name="refresh" size="16" /></button>
          <span style="position:relative"><button class="tool icon" id="frame-btn" data-tip=${"Position and scale of " + (selV1 ? "this clip" : "the footage")} aria-label="Frame" onClick=${() => setFrameOpen((o) => !o)}><${Icon} name="image" size="16" /></button>
            ${frameOpen && html`<div class="menu" id="frame-pop" style="left:0;right:auto;top:36px;min-width:240px;padding:12px;display:grid;gap:8px"><span class="t-small muted">${selV1 ? "This clip" : "Every clip of the footage"}</span>${[["scale", "Scale", 0.5, 2, 0.01], ["x", "Left / right", -0.5, 0.5, 0.01], ["y", "Up / down", -0.5, 0.5, 0.01]].map(([k, l, lo, hi, st]) => html`<label key=${k} class="t-small" style="display:grid;gap:2px">${l} <span class="muted">${frNow[k]}</span><input type="range" data-frame=${k} min=${lo} max=${hi} step=${st} value=${frNow[k]} onPointerDown=${() => { frameBase.current = H.state; }} onInput=${(e) => liveOp(H.state, { op: "set_framing", [k]: +e.target.value, clipIds: lookIds })} onChange=${() => frameBase.current && H.commitFrom(frameBase.current)} /></label>`)}<${Btn} kind="ghost" size="xs" onClick=${() => doOp({ op: "set_framing", scale: 1, x: 0, y: 0, focus: null, clipIds: lookIds }, false)}>Reset<//>
              <span class="t-small muted" style="margin-top:6px">Reframe: what the ${S.aspect} frame keeps of the footage</span>
              <${Btn} kind="secondary" size="xs" icon="spark" id="reframe-face" disabled=${reframing} onClick=${() => reframeFace()}>${reframing ? "Finding the speaker…" : "Follow the speaker"}<//>
              ${[["x", "Pan across", 0.5], ["y", "Pan up / down", 0.4]].map(([k, l, d]) => html`<label key=${"f" + k} class="t-small" style="display:grid;gap:2px">${l} <span class="muted">${frNow.focus ? frNow.focus[k] : "middle"}</span><input type="range" data-focus=${k} min="0" max="1" step="0.01" value=${frNow.focus ? frNow.focus[k] : d} onPointerDown=${() => { frameBase.current = H.state; }} onInput=${(e) => liveOp(H.state, { op: "set_framing", focus: { x: frNow.focus?.x ?? 0.5, y: frNow.focus?.y ?? 0.4, [k]: +e.target.value }, clipIds: lookIds })} onChange=${() => frameBase.current && H.commitFrom(frameBase.current)} /></label>`)}</div>`}</span>
          <button class="tool icon" id="delete-clip" data-tip="Delete the selected clip (⌫)" aria-label="Delete" disabled=${!sel} onClick=${removeSel}><${Icon} name="trash" size="16" /></button>
          ${selV1 && html`<button class="tool icon" id="mute-clip" data-tip=${selV1.audioMuted ? "Bring this clip's dialogue back" : "Silence this clip's dialogue"} aria-label=${selV1.audioMuted ? "Unmute" : "Mute"} onClick=${toggleMute}><${Icon} name="mic" size="16" /></button>`}
          <i class="tbar-sep" />
          <button class=${"tool icon" + (snapOn ? " on" : "")} id="snap" aria-pressed=${snapOn} aria-label=${snapOn ? "Snapping on" : "Snapping off"} data-tip=${"Snapping (S): " + (snapOn ? "on" : "off") + ". Edges land on the playhead and on other clips' edges"} onClick=${() => setSnapOn((x) => !x)}><${Icon} name="magnet" size="16" /></button>
          <button class=${"tool icon" + (showMarks ? " on" : "")} id="marks-toggle" aria-pressed=${showMarks} aria-label=${showMarks ? "Marks on" : "Marks off"} data-tip=${(showMarks ? "Hide" : "Show") + " the marks on the ruler (" + marks.length + "): silences, fillers, retakes, notes"} onClick=${() => setShowMarks(!showMarks)}><${Icon} name="flag" size="16" /></button>
          <i class="tbar-sep" />
          <button class="tool icon" id="undo" data-tip="Undo (⌘Z)" aria-label="Undo" disabled=${!H.canUndo} onClick=${() => H.undo()}><${Icon} name="undo" size="16" /></button>
          <button class="tool icon" id="redo" data-tip="Redo (⌘⇧Z)" aria-label="Redo" disabled=${!H.canRedo} onClick=${() => H.redo()}><${Icon} name="redo" size="16" /></button>
        </div>
        <div class="zoom"><button class="tool icon" aria-label="Zoom out" onClick=${() => setZoom((z) => Math.max(ZMIN, Math.round(z / 1.4)))}><${Icon} name="more" size="14" /></button><input id="tl-zoom" type="range" min="0" max="1000" value=${Math.round((1000 * Math.log(zoom / ZMIN)) / Math.log(ZMAX / ZMIN))} onInput=${(e) => setZoom(Math.round(ZMIN * Math.pow(ZMAX / ZMIN, +e.target.value / 1000)))} aria-label="Timeline zoom" /><button class="tool icon" aria-label="Zoom in" onClick=${() => setZoom((z) => Math.min(ZMAX, Math.round(z * 1.4)))}><${Icon} name="plus" size="14" /></button><button class="tool" id="zoom-fit" title="Zoom to fit (Shift Z)" onClick=${fit}>Fit</button></div>
      </div>
      <div class="tl-body">
        <div class="tl-labels">${rows.map(([k, l]) => html`<div key=${k} class=${k[0]} style=${TRACK_H[k] ? { height: TRACK_H[k] + "px" } : null} title=${TRACK_HINT[k]}><b>${l}</b></div>`)}</div>
        <div class="tl-scroll"><div class=${"tl-canvas tool-" + tool} ref=${canvasRef} style=${{ width: canvasW }} id="timeline">
          <div class="ruler" onPointerDown=${scrubTimeline}>${ticks.map((t) => html`<span key=${t} style=${{ left: px(t) }}>${tickStep < 1 ? fmtTime(t, true) : fmtTime(t)}</span>`)}${zoom >= 8 ? Array.from({ length: Math.floor(dur) + 1 }).map((_, t) => html`<i key=${"m" + t} class="mt" style=${{ left: px(t) }} />`) : null}
            ${showMarks && marks.filter((m) => m.end > m.start + 0.05).map((m) => html`<i key=${"r" + m.id} class="tl-mrange" style=${{ left: px(m.start), width: Math.max(2, (m.end - m.start) * zoom), background: MARK_COLORS[m.source === "ai" ? "custom" : m.kind] }} />`)}
            ${showMarks && marks.map((m) => html`<i key=${"p" + m.id} class="tl-mark" data-kind=${m.kind} title=${markNote(m)} style=${{ left: px(m.start) - 3, "--mk": MARK_COLORS[m.source === "ai" ? "custom" : m.kind] }} onPointerDown=${(e) => { e.stopPropagation(); pb.seek(m.start); }} />`)}
            ${comments.filter((c) => c.time > 0 && !c.resolved).map((c) => html`<div key=${c.id} class="cm" title=${c.text} onPointerDown=${(e) => { e.stopPropagation(); pb.seek(c.time); setSide("comments"); }} style=${{ left: px(c.time) }} />`)}</div>
          ${rows.map(([k]) => html`<div key=${k} class=${"track " + (k === "vo" ? "a" : k === "bg" ? "v" : k[0]) + " " + k + (k === "v1" ? " v1main" : "")} style=${TRACK_H[k] ? { height: TRACK_H[k] + "px" } : null} onPointerDown=${(e) => { setSel(null); scrubTimeline(e); }}>
            ${k[0] === "a" && waveParts[k]?.length > 0 && html`<${WaveLayer} parts=${waveParts[k]} peaks=${peaks} zoom=${zoom} pad=${PAD} canvasRef=${canvasRef} height=${(TRACK_H[k] || 34) - 1} />`}
            ${k === "vo" && voiceClip && html`<div class=${"clip audio voice" + (isOn("vo", voiceClip) ? " on" : "")} data-clip="voice" data-track="vo" title=${voiceClip.label + " · drag to move it"} style=${{ left: px(voiceClip.start), width: Math.max(8, (voiceClip.end - voiceClip.start) * zoom) }} onPointerDown=${voiceDown}><span class="cl">${voiceClip.label}</span></div>`}
            ${k === "bg" && bgClip && html`<div class=${"clip title bg" + (isOn("bg", bgClip) ? " on" : "")} data-clip="background" data-track="bg" title=${bgClip.label} style=${{ left: px(0), width: Math.max(8, dur * zoom) }} onPointerDown=${(e) => { e.stopPropagation(); setSel({ track: "bg", id: "background" }); }}><span class="cl">${bgClip.label}</span></div>`}
            ${(k === "vo" || k === "bg" ? [] : onTrack(k)).map((c) => { const gone = c.end - c.start < 0.01; const other = k === "v1" && c.sourceVideoId !== main; const fx = !gone && fxOf(k, c);
              return html`<div key=${c.id} class=${"clip " + (k === "v1" ? "video" : k[0] === "a" ? "audio" : c.kind === "zoom" ? "fx" : c.kind === "adjust" ? "adjust" : "title") + (isOn(k, c) ? " on" : "") + (gone ? " gone" : "") + (other ? " other" : "") + (c.audioMuted || (k === "a1" && S.voice) ? " muted" : "")} data-clip=${c.id} data-track=${k}
                title=${gone ? "Not in the edit: its footage is cut" : k === "a1" ? "Its V1 clip's dialogue. Alt-drag an edge for a J or L cut." : k === "v1" ? `${clipText(k, c)} · footage ${c.sourceIn.toFixed(2)}-${c.sourceOut.toFixed(2)}s` : c.label}
                style=${{ left: px(c.start), width: Math.max(gone ? 4 : 8, (c.end - c.start) * zoom) }}
                onPointerDown=${clipDown(k, c)}>${k === "v1" && !gone && html`<${Filmstrip} url=${urls[c.sourceVideoId || main]} from=${c.sourceIn} to=${c.sourceOut} width=${(c.end - c.start) * zoom} rotate=${c.rotate || 0} />`}${fadesOf(k, c)}${marksOf(k, c)}<span class="h l" onPointerDown=${edgeDown(k, c, "l")} /><span class="cl">${clipText(k, c)}</span>${fx && (c.end - c.start) * zoom > 44 && html`<button class="fxb" data-fx=${c.id} title=${"Effects: " + fx + " (opens Color)"} aria-label=${"Effects on this clip: " + fx} onPointerDown=${(e) => { e.stopPropagation(); setSel({ track: k, id: c.id }); setRtab("color"); }}>fx</button>`}<span class="h r" onPointerDown=${edgeDown(k, c, "r")} /></div>`; })}
            ${k === "v1" && drop != null && html`<div class="tl-drop" id="drop-marker" style=${{ left: px(drop) - 1 }} />`}
          </div>`)}
          <div class="playhead" id="playhead" style=${{ left: px(pb.time) - 1 }}><i /></div>
        </div></div>
      </div>
    </div>
    </div>

    ${render && html`<${Modal} title=${render.kind === "preview" ? "Exporting preview" : "Exporting final"} onClose=${render.status !== "running" ? () => setRender(null) : undefined}>
      ${render.status === "running" && html`<div class="col export-run" id="export-run" style="gap:14px"><div class="bar big"><i style=${{ width: render.progress.percent + "%" }} /></div>
        <div class="row between"><span class="t-small mono muted" id="render-eta">${render.stopping ? "Stopping…" : render.progress.ahead > 0 && !render.progress.percent ? `Waiting its turn: ${render.progress.ahead} ${render.progress.ahead === 1 ? "render" : "renders"} ahead` : html`${render.progress.percent}% · ${timeLeft(render.progress.etaSec)}`}</span><${Btn} kind="secondary" size="sm" id="stop-export" disabled=${!!render.stopping} onClick=${stopExport}>${render.stopping ? "Stopping…" : "Stop export"}<//></div>
        <span class="t-small muted where-line" id="render-where"><i class="dot on" />${render.progress.on === "mac" ? `Rendering on ${render.progress.device || `your ${render.progress.platform === "windows" ? "PC" : "Mac"}`} by the Rendrr ${render.progress.platform === "windows" ? "Windows" : "Mac"} app` : render.progress.next ? `Getting it ready on Rendrr's server; ${render.progress.next.device || `your ${render.progress.next.platform === "windows" ? "PC" : "Mac"}`} makes the video next` : "Rendering on Rendrr's cloud server, not on this computer"}</span></div>`}
      ${render.status === "done" && html`<div class="state" style="padding:24px 0;box-shadow:none;background:none"><div class="ico"><${Icon} name="check" /></div><h3 class="t-heading" id="render-done">Final is ready</h3><p id="render-note">${render.result.note + " · " + (render.result.quality || "1080p") + " · " + render.result.size}</p><p class="t-small muted" id="render-made">${render.result.where?.renders === "mac" ? `Made on ${render.result.where.device || `your ${render.result.where.platform === "windows" ? "PC" : "Mac"}`} · saved to Downloads` : "Made on Rendrr's cloud server"}</p>
        <div class="row"><${Btn} icon="laptop" id="download" onClick=${() => { if (render.result.downloadUrl) { window.open(render.result.downloadUrl, "_blank", "noopener"); toast("Saving " + (render.result.fileName || "the final") + " to this computer", { icon: "download", tone: "brand" }); } }}>Save to this computer<//><${Btn} kind="secondary" icon="drive" id="save-drive" onClick=${async () => { try { const r = await api.saveFinalToDrive(render.result.renderId); toast(r.message, { icon: "drive", tone: "brand" }); } catch (e) { toast(e.message); } }}>Save to Google Drive<//><${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
      ${render.status === "error" && html`<div class="state" role="alert" style="padding:24px 0;box-shadow:none;background:none"><div class="ico err"><${Icon} name="alert" /></div><h3 class="t-heading" id="render-error">${render.code === "drive" ? "Drive file out of reach" : "Render did not finish"}</h3><p>${render.error}</p><div class="row">${render.code === "drive" && html`<${Btn} id="render-reconnect" icon="drive" onClick=${reconnectDrive}>Reconnect<//>`}<${Btn} kind=${render.code === "drive" ? "secondary" : "primary"} id="render-retry" icon="refresh" onClick=${() => startRender(render.kind)}>Try again<//><${Btn} kind="ghost" onClick=${() => setRender(null)}>Close<//></div></div>`}
      ${render.status === "original" && html`<div class="col" style="gap:16px" id="need-original"><div class="card flat row" style="gap:12px;align-items:flex-start"><${Icon} name="laptop" size="18" /><div><b class="t-label">Full quality needs your original file once.</b><p class="t-small muted">We delete it within 24 hours of the export. Your preview copy stays.</p></div></div>
        ${project.video && html`<p class="t-small muted">Looking for <b style="color:var(--ink)">${project.video.originalName}</b> · ${project.video.size}</p>`}
        ${render.error && html`<p class="t-small" role="alert" id="original-error" style="color:var(--ink)"><${Icon} name="alert" size="13" /> ${render.error}</p>`}
        <input type="file" accept="video/*" class="hide" id="original-file" onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) sendOriginal(f); }} />
        <div class="row wrap">${render.hasFile ? html`<${Btn} id="upload-original" icon="upload" onClick=${() => sendOriginal(null)}>Upload original and export<//><${Btn} kind="secondary" id="pick-other" icon="laptop" onClick=${() => document.getElementById("original-file").click()}>Pick the file<//>` : html`<${Btn} id="pick-original" icon="laptop" onClick=${() => document.getElementById("original-file").click()}>Pick the original file<//>`}<${Btn} kind="ghost" onClick=${() => setRender(null)}>Not now<//></div></div>`}
    <//>`}
    ${samplesOpen && html`<${SamplesWindow} projectId=${project.id} time=${pb.time} duration=${dur} aspect=${S.aspect} toast=${toast} onSeek=${(t) => pb.seek(t)} onClose=${() => setSamplesOpen(false)} />`}
    ${board && html`<${StoryboardWindow} projectId=${project.id} initialId=${board.id} toast=${toast} onSeek=${(t) => pb.seek(t)} onRenderVideo=${() => startRender("preview")}
      onClose=${() => { setBoard(null); try { const u = new URL(location.href); if (u.searchParams.has("storyboard")) { u.searchParams.delete("storyboard"); history.replaceState(history.state, "", u.pathname + u.search + u.hash); } } catch {} }} />`}
    ${exportOpen && html`<${ExportModal} snap=${{ timeline, aspect: S.aspect }} plan=${plan} name=${(S.name || "edit").replace(/[^\w\- ]+/g, "").trim() || "edit"} video=${project.video} doOp=${doOp} onReframe=${() => reframeFace(true)} reframing=${reframing} onRender=${(o) => { setExportOpen(false); startRender("final", o); }} onClose=${() => setExportOpen(false)} />`}
    ${share && html`<${CreateLinkModal} projectId=${project.id} onClose=${() => setShare(false)} onCreated=${() => setStatus("In review")} />`}
    ${addOpen && html`<${AddClipModal} waiting=${waiting} main=${{ id: main, name: project.video?.name || "Footage", seconds: footDur }} at=${pb.time} onAdd=${addClip} onClose=${() => setAddOpen(false)} />`}
    ${help && html`<${Modal} title="Keyboard shortcuts" onClose=${() => setHelp(false)}><div class="list">${SHORTCUTS.map(([k, d]) => html`<div key=${k} class="row between" style="padding:6px 4px"><span>${d}</span><span class="kbd">${k}</span></div>`)}</div><//>`}
  </div>`;
}

export { EditorPage };
export { TextLayers, SeqMedia, LiveOverlays, PersonLayer } from "./editor/layers";
