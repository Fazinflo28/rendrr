// Phase 10: the Multicam page, like Premiere's multicam monitor. The other cameras of the take (library videos), each
// synced to the main video by their sound on the server; a small monitor per camera that follows the playhead; click
// one to cut to it from the playhead to the next change of camera (switch_angle at). Every control sends the
// connector's own ops (multicam, switch_angle).
import { useState, useEffect, useRef, html, Btn } from "./ui";
import { api } from "./api";

const signed = (x) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(3)} s`;

/** One camera's small monitor: muted, kept on the moment the playhead is at (main time + its offset). */
function Monitor({ id, url, name, t, playing, on, rotate, onPick, keyNo }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el || t == null) return;
    const want = Math.max(0, t);
    if (playing) { if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want; if (el.paused) el.play().catch(() => {}); }
    else { if (!el.paused) el.pause(); if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want; }
  }, [t, playing]);
  const out = t == null || t < 0;
  return html`<button class=${"mc-mon" + (on ? " on" : "")} data-angle=${id} title=${`Cut to ${name} here`} onClick=${onPick}>
    <div class="mc-pic">${url ? html`<video ref=${ref} src=${url} muted playsinline preload="auto" crossorigin="anonymous" style=${rotate ? { transform: `rotate(${rotate}deg)` } : null} />` : html`<span class="t-small muted">No preview</span>`}
      ${out && html`<span class="mc-out t-small">No footage here</span>`}</div>
    <span class="mc-name">${keyNo ? html`<kbd class="mc-key">${keyNo}</kbd>` : null}${name}</span></button>`;
}

export function MulticamTab({ projectId, timeline, lay, view, main, mainName, library, at, playing, urls, doOp, addVideo, toast }) {
  const mc = timeline.multicam || { angles: [] };
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState("");
  const nameOf = (a) => a.name || library.find((v) => v.id === a.videoId)?.name || a.videoId;
  // The main video's moment at the playhead (the V1 clip there, if it plays the main video).
  const clip = lay.tracks.v1.find((c) => at >= c.start - 1e-6 && at < c.end - 1e-6);
  const mainT = clip && clip.sourceVideoId === main ? view.editToSource(clip.id, at) : null;
  const showing = clip && clip.sourceVideoId === main ? clip.angle || "main" : null;
  const sync = async (videoId, name) => {
    setBusy(videoId);
    try {
      await addVideo(videoId);
      const s = await api.multicamSync(projectId, videoId);
      doOp({ op: "multicam", angles: [{ videoId, offset: s.offset, score: s.score, name: (name || s.name || "").slice(0, 40) || undefined, ...(s.rotate ? { rotate: s.rotate } : {}) }] });
      if (!s.sure) toast(`The sync of ${s.name} is unsure (their sound barely matches): check it, or set its offset by hand.`);
    } catch (e) { toast(e.message); } finally { setBusy(""); }
  };
  const cut = (angle) => { if (mainT == null) { toast("The playhead is on a clip of another video: angles replace the main video's picture."); return; } doOp({ op: "switch_angle", angle, at: Math.round(at * 1000) / 1000, edit: true }); };
  const choices = library.filter((v) => v.id !== main && !mc.angles.some((a) => a.videoId === v.id));
  // Phase 13: number keys cut live (1 = main, 2 = the first other camera...), as in Premiere's multicam monitor.
  const order = ["main", ...mc.angles.map((a) => a.videoId)];
  const cutRef = useRef(cut); cutRef.current = cut;
  useEffect(() => {
    if (!mc.angles.length) return;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "") || e.target?.isContentEditable) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= order.length) { e.preventDefault(); cutRef.current(order[n - 1]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order.join("|")]);
  // Phase 13: cut to whoever speaks, from each camera's own sound (worked out on the server).
  const [wide, setWide] = useState(""); const [minShot, setMinShot] = useState("2");
  const auto = async () => {
    setBusy("auto");
    try {
      const o = { ...(wide ? { wide } : {}), minShot: Number(minShot) };
      const { plan } = await api.multicamAuto(projectId, o);
      doOp({ op: "multicam_auto", ...o, plan });
    } catch (e) { toast(e.message); } finally { setBusy(""); }
  };
  return html`<div class="pb" id="multicam-panel" style="padding-top:16px"><div class="col" style="gap:16px">
    <p class="t-small muted" style="margin:0">Other cameras of the same take, synced to the main video by their sound. Click a camera to cut to it from the playhead to the next change, as you would live in Premiere's multicam monitor. The words, cuts and timing stay the main video's.</p>
    ${mc.angles.length > 0 && html`<div class="mc-grid" id="multicam-monitors">
      <${Monitor} id="main" keyNo=${1} url=${urls[main]} name=${"Main · " + (mainName || "camera 1")} t=${mainT} playing=${playing} on=${showing === "main"} onPick=${() => cut("main")} />
      ${mc.angles.map((a, i) => html`<${Monitor} key=${a.videoId} id=${a.videoId} keyNo=${i + 2 <= 9 ? i + 2 : null} url=${urls[a.videoId]} name=${nameOf(a)} t=${mainT == null ? null : mainT + a.offset} playing=${playing} on=${showing === a.videoId} rotate=${a.rotate} onPick=${() => cut(a.videoId)} />`)}
    </div>
    <p class="t-small muted" style="margin:0" id="multicam-keys-hint">Keys 1 to ${Math.min(9, order.length)} cut to a camera at the playhead, while it plays too.</p>
    <div class="card flat col" id="multicam-auto-box" style="gap:10px;padding:12px">
      <div><b class="t-label">Cut to whoever speaks</b><p class="t-small muted" style="margin:2px 0 0">Rendrr listens to each camera's own sound: the person loudest on their mic gets the shot. Then fix any cut with the keys.</p></div>
      <div class="row wrap" style="gap:8px;align-items:flex-end">
        <label class="t-small" style="display:grid;gap:4px;min-width:150px">When both speak<select class="input sm" id="multicam-auto-wide" value=${wide} onChange=${(e) => setWide(e.target.value)}>
          <option value="">Keep the shot</option><option value="main">${"Main · " + (mainName || "camera 1")}</option>${mc.angles.map((a) => html`<option key=${a.videoId} value=${a.videoId}>${nameOf(a)}</option>`)}</select></label>
        <label class="t-small" style="display:grid;gap:4px">Shortest shot<select class="input sm" id="multicam-auto-min" value=${minShot} onChange=${(e) => setMinShot(e.target.value)}>${["1", "2", "3", "5"].map((v) => html`<option key=${v} value=${v}>${v} s</option>`)}</select></label>
        <${Btn} size="sm" icon="spark" id="multicam-auto" disabled=${!!busy} onClick=${auto}>${busy === "auto" ? "Listening…" : "Cut to whoever speaks"}<//>
      </div>
    </div>`}
    <div class="col" style="gap:8px" id="multicam-angles">
      <b class="t-label">Cameras</b>
      ${mc.angles.length === 0 && html`<span class="t-small muted">No other cameras yet. Add the other recordings of this take: Rendrr syncs them by their sound.</span>`}
      ${mc.angles.map((a) => html`<div key=${a.videoId} class="mc-row" data-angle-row=${a.videoId}>
        <div class="row between" style="gap:8px;min-width:0"><b class="t-small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title=${nameOf(a)}>${nameOf(a)}</b>
          <${Btn} kind="ghost" size="xs" icon="trash" aria-label=${"Remove " + nameOf(a)} onClick=${() => doOp({ op: "multicam", remove: [a.videoId] })} /></div>
        <div class="row" style="gap:8px;align-items:flex-end">
          <label class="t-small" style="display:grid;gap:2px;width:96px">Offset (s)<input class="input sm mono" type="number" step="0.001" value=${a.offset} id=${"mc-offset-" + a.videoId} onChange=${(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) doOp({ op: "multicam", angles: [{ videoId: a.videoId, offset: v }] }); }} /></label>
          <span class="t-small muted grow" style="padding-bottom:6px" data-sync=${a.videoId}>${signed(a.offset)}${a.score != null ? ` · sync ${Math.round(a.score * 100)}%` : " · set by hand"}${a.score != null && a.score < 0.3 ? " · unsure" : ""}</span>
          <${Btn} kind="ghost" size="xs" disabled=${!!busy} onClick=${() => sync(a.videoId, a.name)}>${busy === a.videoId ? "Syncing…" : "Sync again"}<//></div>
      </div>`)}
      <div class="row" style="gap:8px;align-items:flex-end">
        <label class="t-small grow" style="display:grid;gap:4px">Add a camera<select class="input sm" id="multicam-add-select" value=${pick} onChange=${(e) => setPick(e.target.value)}>
          <option value="">${choices.length ? "Pick a video from your library" : "No other videos in your library"}</option>${choices.map((v) => html`<option key=${v.id} value=${v.id}>${v.name}</option>`)}</select></label>
        <${Btn} size="sm" id="multicam-add" disabled=${!pick || !!busy || mc.angles.length >= 8} onClick=${() => { const v = choices.find((x) => x.id === pick); setPick(""); sync(pick, v?.name); }}>${busy && busy === pick ? "Syncing…" : "Add and sync"}<//>
      </div>
    </div>
    ${mc.angles.length > 0 && html`<label class="t-small" style="display:grid;gap:4px" id="multicam-audio-row">Sound<select class="input sm" id="multicam-audio" value=${mc.audio || "main"} onChange=${(e) => doOp({ op: "multicam", audio: e.target.value })}>
      <option value="main">Main video's sound throughout</option><option value="follow">Each camera's own sound</option></select></label>`}
    ${mc.angles.length > 0 && html`<${Btn} kind="ghost" size="xs" id="multicam-off" onClick=${() => doOp({ op: "multicam", off: true })}>Turn multicam off (every clip back on the main camera)<//>`}
  </div></div>`;
}
