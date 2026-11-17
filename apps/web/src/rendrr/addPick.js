// The page the user opens from their AI's link (/add/<pick>): add the videos and pictures the AI asked for, from this
// computer (any size: a video stays here, its preview is made in this tab). What arrives is told to the AI (it reads it
// with add_footage pickId) and goes in the edit it asked for. A link made for another account says so and takes nothing.
import { useState, useEffect, useRef, html, Icon, Btn, StatusChip, EmptyState, useToast } from "./ui";
import { api } from "./api";
import { DropboxPanel } from "./cloudSources";

const isImage = (f) => /^image\//.test(f.type || "") || /\.(png|jpe?g|webp|gif)$/i.test(f.name || "");
const isVideo = (f) => /^video\//.test(f.type || "") || /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|3gp|wmv|mpg|mpeg)$/i.test(f.name || "");
const aiOf = (v) => v?.aiName || (v?.ai === "chatgpt" ? "ChatGPT" : "Claude");

export function AddPickPage({ id }) {
  const toast = useToast(); const fileRef = useRef();
  const [view, setView] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const [over, setOver] = useState(false);
  const load = () => api.getPick(id).then((v) => { setView(v); setError(null); return v; }).catch((e) => { setError(e); return null; });
  useEffect(() => { load(); }, [id]);
  // Previews of videos from this computer are made here: their state is looked at again until each is ready.
  useEffect(() => {
    if (!view?.videos?.some((v) => !["ready", "failed", "missing"].includes(v.status))) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [view]);

  const add = async (list) => {
    const files = Array.from(list || []);
    const videos = files.filter(isVideo), images = files.filter((f) => !isVideo(f) && isImage(f)), other = files.length - videos.length - images.length;
    if (!videos.length && !images.length) { toast("Those are not videos or pictures."); return; }
    setBusy(true);
    const ids = [];
    try {
      if (videos.length) for (const v of await api.addFromComputer(videos, undefined, view?.kind || undefined)) ids.push(v.id);
      for (const f of images) { const r = await api.uploadAsset(f, "image"); if (r?.videoId) ids.push(r.videoId); }
      if (ids.length) setView(await api.reportPick(id, ids));
      if (other) toast(`${other} ${other === 1 ? "file was" : "files were"} left out: only videos and pictures come in.`);
    } catch (e) {
      toast(e.message);
      if (ids.length) setView(await api.reportPick(id, ids).catch(() => view));
    }
    setBusy(false);
  };
  const finish = async () => { try { setView(await api.finishPick(id)); } catch (e) { toast(e.message); } };

  if (error) return html`<div class="page"><${EmptyState} icon=${error.code === "pick-other-account" ? "user" : "clock"} title=${error.code === "pick-other-account" ? "This link is for another account" : error.code === "pick-expired" || error.status === 404 ? "This link has expired" : "This link did not open"} text=${error.message} /></div>`;
  if (!view) return html`<div class="page" aria-busy="true"><div class="skeleton sk-pill" style="width:240px;height:28px" /><div class="skeleton" style="height:220px;border-radius:16px;margin-top:20px" /></div>`;
  const ai = aiOf(view), making = view.videos.some((v) => !["ready", "failed", "missing"].includes(v.status));
  if (view.expired && !view.videos.length) return html`<div class="page"><${EmptyState} icon="clock" title="This link has expired" text=${`Ask ${ai} for a new one.`} /></div>`;
  return html`<div class="page add-pick" id="add-pick">
    <h1 class="t-title">Add files for ${ai}</h1>
    <p class="muted" id="pick-for">${ai} asked for videos or pictures from ${view.source === "dropbox" ? "your Dropbox" : "this computer"}${view.project ? html`, for the edit <b>${view.project.name}</b>` : ""}.</p>
    ${!view.expired && !view.done && view.source === "dropbox" && html`<div style="margin-top:16px"><${DropboxPanel} pickId=${id} onArrived=${() => load()} /></div>`}
    ${!view.expired && !view.done && view.source === "computer" && html`
      <input type="file" accept="video/*,image/*" multiple ref=${fileRef} class="hide" id="pick-input" onChange=${(e) => { add(e.target.files); e.target.value = ""; }} />
      <div class=${"drop" + (over ? " over" : "")} id="pick-drop" style="padding:40px 24px;margin-top:16px" onClick=${() => !busy && fileRef.current.click()}
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); if (!busy) add(e.dataTransfer.files); }}>
        <div class="ico"><${Icon} name="laptop" /></div><b class="t-heading">${busy ? "Adding..." : "Drop videos or pictures here"}</b>
        <p class="t-small muted">Any size. A video stays on this computer: Rendrr makes a light preview here.</p>
        <div class="row" style="gap:8px"><${Btn} id="pick-choose" disabled=${busy} onClick=${(e) => { e.stopPropagation(); fileRef.current.click(); }}>Choose files<//></div>
      </div>`}
    ${view.videos.length > 0 && view.source !== "dropbox" && html`<div class="col" id="pick-list" style="gap:8px;margin-top:20px">
      <b class="t-label">${view.videos.length} ${view.videos.length === 1 ? "file" : "files"} added</b>
      ${view.videos.map((v) => html`<div key=${v.id} class="row between card flat" data-pick-video=${v.id} style="gap:10px;padding:10px 14px"><span class="row" style="gap:8px;min-width:0"><${Icon} name=${v.still ? "image" : "film"} size="16" /><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.name}</span></span><${StatusChip} status=${v.status} /></div>`)}
    </div>`}
    ${view.videos.length > 0 && !view.done && !view.expired && html`<div class="row" style="gap:8px;margin-top:16px"><${Btn} id="pick-done" icon="check" onClick=${finish}>Done<//><span class="t-small muted">${making ? "Keep this page open until each video says Ready." : ""}</span></div>`}
    ${view.done && html`<div class="card flat" id="pick-finished" style="margin-top:16px;padding:14px"><b>${ai} can see them now.</b> <span class="muted">${making ? "Keep this page open until each video says Ready, then go back to the chat." : "You can go back to the chat."}</span></div>`}
  </div>`;
}
