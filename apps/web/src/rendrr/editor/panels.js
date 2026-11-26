// The Add clip window and one line of the Transcript tab.
// Moved out of editor.js unchanged (audit #30): the editor imports it from here.
import { Btn, Icon, Modal, Thumb, fmtTime, html, useAsync, useEffect, useRef, useState, useToast } from "../ui";
import { api } from "../api";
import { DropboxPanel, GooglePhotosPanel } from "../cloudSources";
import { DrivePicker } from "../screens";
import { memo } from "react";
import { r2 } from "./common";
// Puts whole videos (the parts of a video filmed in parts, in order) or a part of one video into the sequence (the
// connector's add_clip).
// Add clips: the Library as it is (its folders and videos), or new footage from Google Drive or this computer. Videos
// are picked in the order they play; new ones are picked at once and added once they are prepared. "A part of a video"
// adds one range. Waiting (Recreate): the picked videos become the edit's footage.
const byClipName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
function AddClipModal({ main, at, onAdd, onClose, waiting = false }) {
  const toast = useToast();
  const q = useAsync(() => api.listVideos(), []); const fq = useAsync(() => api.listLibraryFolders().catch(() => []), []);
  const usable = (x) => x.status === "ready" && x.kind !== "reference";
  const list = [...(waiting ? [] : [main]), ...(Array.isArray(q.data) ? q.data : []).filter((x) => (waiting || x.id !== main.id) && usable(x))];
  const [extra, setExtra] = useState([]); // added here from Drive or this computer: picked at once, still being prepared
  const all = [...list, ...extra.filter((x) => !list.some((y) => y.id === x.id))];
  const [mode, setMode] = useState("whole"); const [ids, setIds] = useState([]);
  const [src, setSrc] = useState("library"); const [cur, setCur] = useState(null); const [busy, setBusy] = useState(false); const [wait, setWait] = useState(null); const [over, setOver] = useState(false);
  const fileRef = useRef(); const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const [vid, setVid] = useState(main.id);
  const v = list.find((x) => x.id === vid) || main;
  const [from, setFrom] = useState(0); const [to, setTo] = useState(main.seconds || 5); const [where, setWhere] = useState("end");
  const ok = mode === "whole" ? ids.length > 0 : to - from >= 0.1 && from >= 0 && to <= (v.seconds || 0) + 0.05;
  // The Library's folders: the one open (cur), its folders, and its videos (at the top: those in no folder).
  const folders = Array.isArray(fq.data) ? fq.data : [];
  const known = new Set(folders.map((f) => f.id));
  const here = (x) => (cur ? x.libraryFolderId === cur : !x.libraryFolderId || !known.has(x.libraryFolderId));
  const subtree = (id) => [id, ...folders.filter((f) => f.parentId === id).flatMap((f) => subtree(f.id))];
  const inFolder = (id) => subtree(id).flatMap((fid) => list.filter((x) => x.libraryFolderId === fid).sort(byClipName));
  const trail = []; for (let f = folders.find((x) => x.id === cur); f; f = folders.find((x) => x.id === f.parentId)) trail.unshift(f);
  const toggle = (id) => setIds((xs) => (xs.includes(id) ? xs.filter((i) => i !== id) : [...xs, id]));
  const pickAll = (vs) => setIds((xs) => [...xs, ...vs.map((x) => x.id).filter((id) => !xs.includes(id))]);
  // New footage: picked at once, and the Library shows it while it is prepared.
  // From Dropbox or Google Photos: picked as they arrive, without leaving the tab (more may still be coming).
  const cloudArrived = (vs) => { setExtra((e) => [...e, ...vs]); pickAll(vs); window.dispatchEvent(new Event("rendrr:library")); };
  const added = (vs) => { if (!vs?.length) return; setExtra((e) => [...e, ...vs]); pickAll(vs); setSrc("library"); setCur(null); window.dispatchEvent(new Event("rendrr:library")); };
  const fromDrive = async (fileIds) => { setBusy(true); try { added(await api.addFromDrive(fileIds)); } catch (e) { toast(e.message, { icon: "alert" }); } finally { setBusy(false); } };
  const fromFiles = async (files) => { if (!files?.length) return; setBusy(true); try { added(await api.addFromComputer(files)); } catch (e) { toast(e.message, { icon: "alert" }); } finally { setBusy(false); } };
  // Adding waits for new footage to be prepared (an edit needs its transcript and silences).
  const go_ = async () => {
    if (mode !== "whole") return onAdd({ items: [{ video: v, from: r2(from), to: r2(to) }], at: where === "playhead" ? at : undefined });
    setBusy(true);
    try {
      const vids = [];
      for (const id of ids) {
        let x = all.find((y) => y.id === id);
        while (x && x.status !== "ready") {
          if (["failed", "missing", "expired"].includes(x.status)) throw new Error(x.error || `"${x.name}" could not be prepared. Pick another video.`);
          setWait(`Preparing "${x.name}"${x.stepName ? ": " + x.stepName : ""}`);
          await new Promise((r) => setTimeout(r, 2000));
          if (!alive.current) return;
          x = await api.getVideo(id);
        }
        if (x) vids.push(x);
      }
      setWait(null);
      onAdd({ items: vids.map((x) => ({ video: x, from: 0, to: r2(x.seconds || 0) })), at: where === "playhead" ? at : undefined });
    } catch (e) { if (alive.current) { toast(e.message); setBusy(false); setWait(null); } }
  };
  const card = (x) => { const n = ids.indexOf(x.id), prep = x.status && x.status !== "ready"; return html`<button key=${x.id} type="button" class=${"clip-card" + (n >= 0 ? " on" : "")} data-video=${x.id} aria-pressed=${n >= 0} title=${x.name} onClick=${() => toggle(x.id)}>
    <div class="clip-thumb"><${Thumb} src=${x.thumb} art=${x.art} />${prep ? html`<span class="clip-prep">Preparing…</span>` : html`<span class="clip-len">${fmtTime(x.seconds || 0)}</span>`}${n >= 0 && html`<span class="clip-num">${n + 1}</span>`}${!waiting && x.id === main.id && html`<span class="badge-in">This edit</span>`}</div>
    <span class="clip-name ell">${x.name}</span></button>`; };
  const label = busy && wait ? "Waiting for footage…" : waiting ? (ids.length > 1 ? "Use " + ids.length + " videos" : "Use this video") : mode === "whole" && ids.length > 1 ? "Add " + ids.length + " videos" : mode === "whole" ? "Add video" : "Add clip";
  return html`<${Modal} title=${waiting ? "Add your footage" : "Add clips"} sub=${waiting ? "Pick your raw video. It is framed for this edit by itself." : "Pick them in the order they play."} onClose=${onClose} wide
    footer=${html`${wait && html`<span class="t-small muted grow" id="add-wait">${wait}</span>`}<${Btn} kind="ghost" onClick=${onClose}>Cancel<//><${Btn} id="add-clip-go" icon="plus" disabled=${!ok || busy} onClick=${go_}>${label}<//>`}>
    <div class="col" style="gap:12px" id="add-clip-form">
      ${!waiting && html`<div class="row" style="gap:12px">${[["whole", "Whole videos"], ["part", "A part of a video"]].map(([k, l]) => html`<label key=${k} class="t-small row" style="gap:6px"><input type="radio" name="add-mode" data-mode=${k} checked=${mode === k} onChange=${() => setMode(k)} />${l}</label>`)}</div>`}
      ${mode === "whole" ? html`
      <div class="add-tabs" role="tablist" aria-label="Where from">${[["library", "Library", "library"], ["drive", "Google Drive", "drive"], ["local", "This computer", "laptop"], ["dropbox", "Dropbox", "folder"], ["gphotos", "Google Photos", "image"]].map(([k, l, ic]) => html`<button key=${k} type="button" role="tab" id=${"add-src-" + k} aria-selected=${src === k} class=${src === k ? "on" : ""} onClick=${() => setSrc(k)}><${Icon} name=${ic} size="15" />${l}</button>`)}</div>
      ${src === "dropbox" ? html`<div id="add-dropbox"><${DropboxPanel} onArrived=${cloudArrived} /></div>`
      : src === "gphotos" ? html`<div id="add-gphotos"><${GooglePhotosPanel} onArrived=${cloudArrived} /></div>`
      : src === "drive" ? html`<div id="add-drive"><${DrivePicker} addLabel="Add these videos" onAdd=${fromDrive} onLocal=${() => setSrc("local")} /></div>`
      : src === "local" ? html`<div class="col" style="gap:12px" id="add-local">
          <input type="file" accept="video/*" multiple ref=${fileRef} class="hide" onChange=${(e) => { const fs = e.target.files; if (fs?.length) fromFiles(Array.from(fs)); e.target.value = ""; }} />
          <div class=${"drop" + (over ? " over" : "")} id="add-drop" style="padding:44px 24px" onClick=${() => fileRef.current.click()} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); const fs = e.dataTransfer.files; if (fs?.length) fromFiles(Array.from(fs)); }}>
            <div class="ico"><${Icon} name="laptop" /></div><b class="t-heading">Drop videos here</b>
            <div class="row"><${Btn} disabled=${busy} onClick=${(e) => { e.stopPropagation(); fileRef.current.click(); }}>${busy ? "Adding…" : "Choose files"}<//></div></div></div>`
      : html`
        ${cur && html`<div class="row between add-trail" id="add-trail"><div class="row" style="gap:6px;min-width:0"><button type="button" class="tc" id="add-up" onClick=${() => setCur(trail.length > 1 ? trail[trail.length - 2].id : null)}>‹ Back</button>
          <span class="t-small muted ell"><button type="button" class="link" onClick=${() => setCur(null)}>Library</button>${trail.map((f) => html`<span key=${f.id}> › <button type="button" class="link" onClick=${() => setCur(f.id)}>${f.name}</button></span>`)}</span></div>
          ${inFolder(cur).length > 0 && html`<${Btn} kind="secondary" size="sm" id="add-folder-all" icon="plus" onClick=${() => pickAll(inFolder(cur))}>Pick the whole folder (${inFolder(cur).length})<//>`}</div>`}
        <div class="clip-grid" id="add-videos">${q.status === "loading" || fq.status === "loading" ? Array.from({ length: 6 }).map((_, i) => html`<div key=${i} class="clip-card clip-sk" aria-busy="true"><div class="clip-thumb skeleton" /><div class="skeleton sk-line" style="width:70%" /></div>`)
          : html`${!cur && extra.filter((x) => !list.some((y) => y.id === x.id)).map(card)}
            ${folders.filter((f) => (f.parentId || null) === cur).sort(byClipName).map((f) => html`<button key=${f.id} type="button" class="clip-card clip-folder" data-folder=${f.id} title=${f.name} onClick=${() => setCur(f.id)}>
              <div class="clip-thumb folder"><${Icon} name="folder" size="34" /><span class="clip-len">${f.total ?? f.count ?? 0} ${(f.total ?? f.count) === 1 ? "video" : "videos"}</span></div><span class="clip-name ell">${f.name}</span></button>`)}
            ${list.filter(here).sort((x, y) => (x.id === main.id ? -1 : y.id === main.id ? 1 : 0)).map(card)}
            ${cur && !folders.some((f) => f.parentId === cur) && !list.some(here) && html`<p class="t-small muted" style="grid-column:1/-1">Nothing ready in this folder yet.</p>`}
            ${!cur && !folders.length && !list.length && !extra.length && html`<p class="t-small muted" style="grid-column:1/-1">Your Library is empty. Add footage from Google Drive or this computer.</p>`}`}</div>`}`
      : html`<label class="t-small" style="display:grid;gap:4px">Video<select class="input sm" id="add-clip-video" value=${vid} onChange=${(e) => { setVid(e.target.value); const nv = list.find((x) => x.id === e.target.value); if (nv) { setFrom(0); setTo(nv.seconds || 5); } }}>${list.map((x) => html`<option key=${x.id} value=${x.id}>${x.id === main.id ? x.name + " (this edit's footage)" : x.name} · ${fmtTime(x.seconds || 0)}</option>`)}</select></label>
      <div class="row" style="gap:8px"><label class="t-small grow" style="display:grid;gap:4px">From (s)<input class="input sm" id="add-clip-from" type="number" min="0" step="0.1" value=${from} onInput=${(e) => setFrom(+e.target.value)} /></label><label class="t-small grow" style="display:grid;gap:4px">To (s)<input class="input sm" id="add-clip-to" type="number" min="0" step="0.1" value=${to} onInput=${(e) => setTo(+e.target.value)} /></label></div>
      ${!ok && html`<p class="t-small muted" role="alert">Pick a part at least 0.1 s long inside the video (${fmtTime(v.seconds || 0)}).</p>`}`}
      ${!waiting && html`<div class="row" style="gap:12px">${[["end", "At the end"], ["playhead", "At the playhead (" + fmtTime(at) + ")"]].map(([k, l]) => html`<label key=${k} class="t-small row" style="gap:6px"><input type="radio" name="add-where" data-where=${k} checked=${where === k} onChange=${() => setWhere(k)} />${l}</label>`)}</div>`}
    </div>
  <//>`;
}

// One line of the Transcript tab. It is drawn again only when its own words change (cut, picked, the one playing),
// not on every frame of playback: a 20 minute video has about 3,000 words.
const TranscriptLine = memo(function TranscriptLine({ l, index, cutSet, mainParts, selA, selB, nowId, onDown, onEnter }) {
  return html`<p>${l.gapBefore ? html`<span class="gap">${l.gapBefore}s silence</span>` : null}<span class="ts">${fmtTime(l.start)}</span>${l.words.map((w) => { const i = index.get(w.id) ?? -1; const out = !mainParts.some((p) => w.t >= p.srcIn && w.t < p.srcOut); return html`<span key=${w.id} data-w=${w.id} class=${"w" + (cutSet.has(w.id) || out ? " cut" : "") + (i >= selA && i <= selB ? " sel" : "") + (w.id === nowId ? " now" : "") + (w.filler ? " filler" : "")} onPointerDown=${onDown(i)} onPointerEnter=${onEnter(i)}>${w.text}</span>${" "}`; })}</p>`;
});

export { AddClipModal, TranscriptLine };
