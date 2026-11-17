// Videos and pictures from the user's cloud storage, used by the Library's Add footage window, the editor's Add clips
// window and the page an AI's link opens. Dropbox: paste a share link (works for anyone), or choose files in Dropbox's
// own window (Dropbox Chooser, once the Dropbox app key is set on Rendrr; not inside the Mac or Windows app, whose
// popups open in the browser). Google Photos: the user chooses in Google Photos' own page (the Photos Picker; Rendrr
// sees only what they choose), after allowing it once. Rendrr brings the files in in the background; each panel shows
// what is coming in, what arrived and what could not be brought in.
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

// The pick a panel tracks its files with: the AI's (its page), or one made for this window on first use.
function usePick({ given, source, projectId, kind, onArrived }) {
  const [pickId, setPickId] = useState(given); const [view, setView] = useState(null);
  const seen = useRef(new Set());
  const take = (v) => {
    setView(v);
    const fresh = (v?.videos || []).filter((x) => !seen.current.has(x.id));
    fresh.forEach((x) => seen.current.add(x.id));
    if (fresh.length) onArrived?.(fresh);
  };
  useEffect(() => { if (given) api.getPick(given).then((v) => { (v.videos || []).forEach((x) => seen.current.add(x.id)); setView(v); }).catch(() => {}); }, [given]);
  const ensure = async () => { if (pickId) return pickId; const p = await api.createPick(source, projectId, kind); setPickId(p.id); setView(p); return p.id; };
  return { pickId, view, take, ensure };
}
const busyVideo = (v) => (v?.videos || []).some((x) => !["ready", "failed", "missing"].includes(x.status));
// While something is coming in (or what came is still being prepared), the pick is looked at again.
function usePoll(pickId, working, take, ms = 2000) {
  useEffect(() => {
    if (!pickId || !working) return;
    const t = setInterval(() => api.getPick(pickId).then(take).catch(() => {}), ms);
    return () => clearInterval(t);
  }, [pickId, working, ms]);
}
/** What is coming in, what could not be brought in, and what arrived (with its state). */
function Progress({ view, prefix }) {
  const pending = view?.pending || 0, errors = view?.errors || [], arrived = view?.videos || [];
  return html`
    ${pending > 0 && html`<p class="t-small row" id=${prefix + "-pending"} style="gap:6px"><i class="dot brand pulse" />Bringing in ${pending} ${pending === 1 ? "file" : "files"}. A big video takes a while.</p>`}
    ${errors.length > 0 && html`<div class="col" id=${prefix + "-errors"} style="gap:4px">${errors.map((x, i) => html`<p key=${i} class="t-small"><b>${x.name}</b>: ${x.message}</p>`)}</div>`}
    ${arrived.length > 0 && html`<div class="col" id=${prefix + "-arrived"} style="gap:6px">${arrived.map((v) => html`<div key=${v.id} class="row between card flat" ...${{ ["data-" + prefix + "-video"]: v.id }} style="gap:10px;padding:8px 12px"><span class="row" style="gap:8px;min-width:0"><${Icon} name=${v.still ? "image" : "film"} size="16" /><span class="ell">${v.name}</span></span><${StatusChip} status=${v.status} /></div>`)}</div>`}`;
}

/** pickId: the AI's pick (its page); without one, a pick is made for this window to track its files. onArrived: new videos. */
export function DropboxPanel({ pickId: given = null, projectId = null, kind = null, onArrived }) {
  const toast = useToast();
  const { pickId, view, take, ensure } = usePick({ given, source: "dropbox", projectId, kind, onArrived });
  const [link, setLink] = useState(""); const [busy, setBusy] = useState(false);
  const chooser = dropboxChooser();
  useEffect(() => { if (chooser) loadDropins().catch(() => {}); }, [chooser]);
  usePoll(pickId, view?.pending > 0 || busyVideo(view), take);
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
  return html`<div class="col dbx" id="dbx-panel" style="gap:12px">
    ${chooser && html`<${Btn} id="dbx-choose" icon="folder" disabled=${busy} onClick=${choose}>Choose from Dropbox<//>`}
    <form class="row" style="gap:8px" onSubmit=${(e) => { e.preventDefault(); if (link.trim()) send([link.trim()]); }}>
      <input class="input" id="dbx-link" type="url" inputmode="url" placeholder="Paste a Dropbox link (Copy link in Dropbox)" value=${link} onInput=${(e) => setLink(e.target.value)} aria-label="Dropbox link" />
      <${Btn} id="dbx-add" type="submit" disabled=${busy || !link.trim()}>${busy ? "Adding..." : "Add"}<//>
    </form>
    <p class="t-small muted">A link to a file works (a video or a picture). For a folder, share each file, or choose them${chooser ? " above" : " in Dropbox"}.</p>
    <${Progress} view=${view} prefix="dbx" />
  </div>`;
}

const pickerPage = (uri) => uri.replace(/\/+$/, "") + "/autoclose"; // Google Photos closes its window once they are done

/** Google Photos: allowed once (Connect), then the user chooses in Google Photos' own window; Rendrr asks Google whether
 *  they are done and brings in what they chose. Same props as DropboxPanel. */
export function GooglePhotosPanel({ pickId: given = null, projectId = null, kind = null, onArrived }) {
  const toast = useToast();
  const { pickId, view, take, ensure } = usePick({ given, source: "google_photos", projectId, kind, onArrived });
  const [ready, setReady] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (view && "photosReady" in view) setReady(!!view.photosReady); }, [view?.photosReady]);
  useEffect(() => { if (!given) api.getDriveStatus().then((s) => setReady(!!s.photos)).catch(() => setReady(false)); }, [given]);
  const ph = view?.photos, choosing = !!ph && !ph.imported && !ph.error;
  usePoll(pickId, choosing || view?.pending > 0 || busyVideo(view), take, choosing ? 3000 : 2000);
  const desk = typeof window !== "undefined" ? window.rendrrDesktop : null;
  const connect = async () => {
    setBusy(true);
    try { const s = await api.connectDrive(false, true); setReady(!!s.photos); if (!s.photos) toast("Google did not allow Google Photos. Try again and tick Google Photos."); }
    catch (e) { toast(e.message); }
    setBusy(false);
  };
  const choose = async () => {
    // Opened now, while the click still counts: a window opened after waiting for Rendrr is blocked by the browser.
    const w = desk?.openInBrowser ? null : window.open("about:blank", "rendrr-gphotos", "width=1000,height=760");
    setBusy(true);
    try {
      const v = await api.startPhotos(await ensure());
      take(v);
      const uri = pickerPage(v.photos.pickerUri);
      if (desk?.openInBrowser) desk.openInBrowser(uri); else if (w) w.location.href = uri; else window.open(uri, "_blank", "noopener");
    } catch (e) { w?.close(); if (e.code === "photos-connect") setReady(false); toast(e.message); }
    setBusy(false);
  };
  const some = (view?.videos || []).length > 0;
  return html`<div class="col gph" id="gph-panel" style="gap:12px">
    ${ready === false ? html`
      <p class="t-small muted">Allow Rendrr to open Google Photos once. It only sees the photos and videos you choose.</p>
      <div class="row"><${Btn} id="gph-connect" icon="image" disabled=${busy} onClick=${connect}>${busy ? "Connecting..." : "Connect Google Photos"}<//></div>`
    : html`
      ${!choosing && html`<div class="row"><${Btn} id="gph-choose" icon="image" disabled=${busy || ready === null} onClick=${choose}>${busy ? "Opening..." : ph?.error ? "Choose again" : some ? "Choose more" : "Choose from Google Photos"}<//></div>`}
      ${choosing && html`<p class="t-small row" id="gph-waiting" style="gap:6px;flex-wrap:wrap"><i class="dot brand pulse" />Choose in the Google Photos window, then press Done there.<a id="gph-again" class="link" href=${pickerPage(ph.pickerUri)} target="_blank" rel="noopener">Open it again</a></p>`}
      ${ph?.error && html`<p class="t-small" id="gph-error">${ph.error}</p>`}
      <p class="t-small muted">Photos and videos up to 50 at a time. A video Google Photos is still processing comes later.</p>`}
    <${Progress} view=${view} prefix="gph" />
  </div>`;
}
