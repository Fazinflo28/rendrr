// Videos and pictures from the user's cloud storage, used by the Library's Add footage window, the editor's Add clips
// window and the page an AI's link opens. Dropbox: paste a share link (works for anyone), or choose files in Dropbox's
// own window (Dropbox Chooser, once the Dropbox app key is set on Rendrr; not inside the Mac or Windows app, whose
// popups open in the browser). Rendrr downloads them in the background; this panel shows what arrived and what could not.
import { useState, useEffect, useRef, html, Icon, Btn, StatusChip, useToast } from "./ui";
import { api } from "./api";

// The Dropbox app key (public, not a secret): set as NEXT_PUBLIC_DROPBOX_APP_KEY on the web service. Tests set __dropboxKey.
const DROPBOX_KEY = (() => { try { return (globalThis.__dropboxKey ?? process.env.NEXT_PUBLIC_DROPBOX_APP_KEY) || ""; } catch { return globalThis.__dropboxKey || ""; } })();
export const dropboxChooser = () => !!(globalThis.__dropboxKey || DROPBOX_KEY) && !(typeof window !== "undefined" && window.rendrrDesktop);
let dropins = null;
function loadDropins() {
  if (typeof window === "undefined") return Promise.reject(new Error("Dropbox is not available here."));
  if (window.Dropbox?.choose) return Promise.resolve(window.Dropbox);
  return (dropins ||= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "https://www.dropbox.com/static/api/2/dropins.js"; s.id = "dropboxjs"; s.async = true;
    s.setAttribute("data-app-key", globalThis.__dropboxKey || DROPBOX_KEY);
    s.onload = () => (window.Dropbox?.choose ? ok(window.Dropbox) : no(new Error("Dropbox did not load.")));
    s.onerror = () => { dropins = null; no(new Error("Dropbox did not load. Paste a share link instead.")); };
    document.head.appendChild(s);
  }));
}

/** pickId: the AI's pick (its page); without one, a pick is made for this window to track its files. onArrived: new videos. */
export function DropboxPanel({ pickId: given = null, projectId = null, kind = null, onArrived }) {
  const toast = useToast();
  const [pickId, setPickId] = useState(given); const [view, setView] = useState(null); const [link, setLink] = useState(""); const [busy, setBusy] = useState(false);
  const seen = useRef(new Set());
  const chooser = dropboxChooser();
  useEffect(() => { if (chooser) loadDropins().catch(() => {}); }, [chooser]);
  const take = (v) => {
    setView(v);
    const fresh = (v?.videos || []).filter((x) => !seen.current.has(x.id));
    fresh.forEach((x) => seen.current.add(x.id));
    if (fresh.length) onArrived?.(fresh);
  };
  useEffect(() => { if (given) api.getPick(given).then((v) => { (v.videos || []).forEach((x) => seen.current.add(x.id)); setView(v); }).catch(() => {}); }, [given]);
  // While links are still coming in (or what came is still being prepared), the pick is looked at again.
  const working = view?.pending > 0 || (view?.videos || []).some((x) => !["ready", "failed", "missing"].includes(x.status));
  useEffect(() => {
    if (!pickId || !working) return;
    const t = setInterval(() => api.getPick(pickId).then(take).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [pickId, working]);
  const ensure = async () => { if (pickId) return pickId; const p = await api.createPick("dropbox", projectId, kind); setPickId(p.id); return p.id; };
  const send = async (urls) => {
    if (!urls.length) return;
    setBusy(true);
    try { const id = await ensure(); take(await api.importLinks(id, urls)); setLink(""); }
    catch (e) { toast(e.message); }
    setBusy(false);
  };
  const choose = async () => {
    try {
      const D = await loadDropins();
      D.choose({ linkType: "direct", multiselect: true, extensions: ["video", "images"], success: (files) => send(files.map((f) => f.link)) });
    } catch (e) { toast(e.message); }
  };
  const pending = view?.pending || 0, errors = view?.errors || [], arrived = view?.videos || [];
  return html`<div class="col dbx" id="dbx-panel" style="gap:12px">
    ${chooser && html`<${Btn} id="dbx-choose" icon="folder" disabled=${busy} onClick=${choose}>Choose from Dropbox<//>`}
    <form class="row" style="gap:8px" onSubmit=${(e) => { e.preventDefault(); if (link.trim()) send([link.trim()]); }}>
      <input class="input" id="dbx-link" type="url" inputmode="url" placeholder="Paste a Dropbox link (Copy link in Dropbox)" value=${link} onInput=${(e) => setLink(e.target.value)} aria-label="Dropbox link" />
      <${Btn} id="dbx-add" type="submit" disabled=${busy || !link.trim()}>${busy ? "Adding..." : "Add"}<//>
    </form>
    <p class="t-small muted">A link to a file works (a video or a picture). For a folder, share each file, or choose them${chooser ? " above" : " in Dropbox"}.</p>
    ${pending > 0 && html`<p class="t-small row" id="dbx-pending" style="gap:6px"><i class="dot brand pulse" />Bringing in ${pending} ${pending === 1 ? "file" : "files"}. A big video takes a while.</p>`}
    ${errors.length > 0 && html`<div class="col" id="dbx-errors" style="gap:4px">${errors.map((x, i) => html`<p key=${i} class="t-small"><b>${x.name}</b>: ${x.message}</p>`)}</div>`}
    ${arrived.length > 0 && html`<div class="col" id="dbx-arrived" style="gap:6px">${arrived.map((v) => html`<div key=${v.id} class="row between card flat" data-dbx-video=${v.id} style="gap:10px;padding:8px 12px"><span class="row" style="gap:8px;min-width:0"><${Icon} name=${v.still ? "image" : "film"} size="16" /><span class="ell">${v.name}</span></span><${StatusChip} status=${v.status} /></div>`)}</div>`}
  </div>`;
}
