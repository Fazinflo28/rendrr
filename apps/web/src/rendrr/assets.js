// The Assets page (once "Library"), like Higgsfield's: a side bar with All assets, Favorites, Trash and the types
// (Videos, Images, Elements, Audio). Videos is the library as it was (folders, Drive sync, references); Images are
// pictures; Elements are logos and overlays kept transparent (placed in edits like graphics); Audio is the user's own
// music and voice files. Deleting moves to the Trash: restored from there, gone for good TRASH_DAYS later.
import { useState, useEffect, useRef, useMemo, html, fmtLen, fmtAgo, Icon, Btn, useToast, Modal, useAsync, useNav, useApp, Thumb, EmptyState, Async } from "./ui";
import { api } from "./api";
import { ASSET_SECTIONS, ELEMENT_ACCEPT, TRASH_DAYS, fmtBytes } from "@rendrr/shared";
import { LibraryPage, DeleteVideoModal } from "./screens";
import { BrandLogo } from "./brandLogos";

const SEC = Object.fromEntries(ASSET_SECTIONS.map((s) => [s.id, s]));
const TYPE_LABEL = { video: "Video", image: "Image", element: "Element", audio: "Audio" };
const TYPE_ICON = { video: "film", image: "image", element: "spark", audio: "wave" };
const BUSY = ["linking", "preview", "previewing", "uploading", "processing", "rendering", "queued"];
const ACCEPT = { images: "image/png,image/jpeg,image/webp,image/gif", elements: ELEMENT_ACCEPT, audio: "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" };
const UPLOAD_AS = { images: "image", elements: "element", audio: "audio" };
const pathOf = (id) => (id === "all" ? "/assets" : "/assets/" + id);

/** Videos, pictures, elements and audio as one shape for the grids. */
const fromVideo = (v) => ({ type: v.still ? "image" : "video", id: v.id, name: v.name, thumb: v.thumb, art: v.art, at: v.date, favorite: !!v.favorite, status: v.status, seconds: v.seconds, size: v.size, daysLeft: v.daysLeft, deletedAt: v.deletedAt, raw: v });
const fromElement = (g) => ({ type: "element", id: g.id, name: g.name, thumb: g.thumb, at: g.at, favorite: !!g.favorite, status: g.status, error: g.error, width: g.width, height: g.height, size: g.sizeBytes ? fmtBytes(g.sizeBytes) : "", daysLeft: g.daysLeft, deletedAt: g.deletedAt, raw: g });
const fromSound = (s) => ({ type: "audio", id: s.id, name: s.name, url: s.url, at: s.at, favorite: !!s.favorite, status: s.status, error: s.error, seconds: s.seconds, size: s.sizeBytes ? fmtBytes(s.sizeBytes) : "", daysLeft: s.daysLeft, deletedAt: s.deletedAt, raw: s });
const fromAny = (x) => (x.type === "element" ? fromElement(x) : x.type === "audio" ? fromSound(x) : fromVideo(x));

/** Which kind of upload a file is, from its type and name. */
const kindOfFile = (f) => (/^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name) ? "audio" : /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name) ? "image" : /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name) ? "video" : null);

// Where footage can come from, shown with each service's real logo at the foot of the side bar (each opens Add footage).
const SOURCES = [["drive", "Google Drive"], ["photos", "Google Photos"], ["dropbox", "Dropbox"]];

export function AssetsPage({ section = "all" }) {
  const { go } = useNav(); const { openAdd } = useApp();
  const bq = useAsync(() => api.getBillingOverview().catch(() => null), []);
  const gb = bq.data?.storage?.totalGB;
  const sq = useAsync(() => api.assetsSummary(), []);
  const n = sq.data || {};
  useEffect(() => { const k = () => sq.reload(); window.addEventListener("rendrr:library", k); window.addEventListener("rendrr:assets", k); return () => { window.removeEventListener("rendrr:library", k); window.removeEventListener("rendrr:assets", k); }; }, []);
  const item = (id) => { const s = SEC[id]; return html`<button key=${id} class=${"as-nav" + (section === id ? " on" : "")} data-section=${id} aria-current=${section === id ? "page" : undefined} onClick=${() => go(pathOf(id))}>
      <${Icon} name=${s.icon} size="16" /><span class="grow">${s.label}</span>${n[id] != null && html`<span class="as-count" data-count=${id}>${n[id] > 999 ? "999+" : n[id]}</span>`}</button>`; };
  return html`<div class="assets" id="assets-page">
    <aside class="as-side" aria-label="Assets">
      ${["all", "favorites", "trash"].map(item)}
      <div class="as-label">Types</div>
      ${["videos", "images", "elements", "audio"].map(item)}
      <div class="as-foot" id="assets-foot">
        <div class="as-label" style="margin:0 8px">Bring in from</div>
        <div class="as-sources" style="padding:0 8px">${SOURCES.map(([b, name]) => html`<button key=${b} type="button" title=${"Add from " + name} aria-label=${"Add from " + name} data-source=${b} onClick=${() => openAdd()}><${BrandLogo} brand=${b} size=${36} /></button>`)}<button type="button" class="btn quiet sm icon" title="Add from this computer" aria-label="Add from this computer" onClick=${() => openAdd()}><${Icon} name="laptop" size="18" /></button></div>
        ${gb != null && html`<div class="as-store" id="assets-storage"><span><b>${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB</b><span class="muted"> stored with Rendrr</span></span><span class="muted">Free has 5 GB, Editor Pro 10 GB, Agency Pro 100 GB.</span><button type="button" class="link" style="text-align:left" onClick=${() => go("/pricing")}>See plans</button></div>`}
      </div>
    </aside>
    <section class="as-main">${section === "videos"
      ? html`<${LibraryPage} embedded only="videos" />`
      : html`<${AssetGrid} key=${section} section=${section} onChange=${() => sq.reload()} />`}</section>
  </div>`;
}

function AssetGrid({ section, onChange }) {
  const { go } = useNav(); const toast = useToast(); const { startUpload } = useApp();
  const q = useAsync(async () => {
    if (section === "trash") return (await api.listTrash()).map(fromAny);
    const want = (k) => section === "all" || section === "favorites" || section === k;
    const [vs, es, ss] = await Promise.all([
      want("images") || want("videos") ? api.listVideos() : [],
      want("elements") ? api.listElements() : [],
      want("audio") ? api.listSounds() : [],
    ]);
    let items = [...(vs || []).map(fromVideo), ...(es || []).map(fromElement), ...(ss || []).map(fromSound)];
    if (section === "images") items = items.filter((x) => x.type === "image");
    if (section === "favorites") items = items.filter((x) => x.favorite);
    return items.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [section]);
  const [search, setSearch] = useState(""); const [over, setOver] = useState(false); const [uploading, setUploading] = useState(0);
  const [open, setOpen] = useState(null); const [forever, setForever] = useState(null); const [emptyAsk, setEmptyAsk] = useState(false);
  const file = useRef(null);
  const items = (q.data || []).filter((x) => x.name.toLowerCase().includes(search.trim().toLowerCase()));
  const refresh = () => { q.reload(); onChange?.(); };
  // Pictures and elements being prepared: asked for again every 2.5 s until they are ready.
  useEffect(() => { if (!(q.data || []).some((x) => BUSY.includes(x.status))) return; const t = setTimeout(q.reload, 2500); return () => clearTimeout(t); }, [q.data]);
  const setItem = (id, f) => q.setData((xs) => (xs || []).map((x) => (x.id === id ? f(x) : x)));

  const upload = async (files) => {
    const list = Array.from(files || []); if (!list.length) return;
    const videos = [];
    setUploading((u) => u + list.length);
    let ok = 0;
    for (const f of list) {
      const k = kindOfFile(f);
      const as = UPLOAD_AS[section] || (k === "audio" ? "audio" : k === "image" ? "image" : null);
      try {
        if (!as && k === "video") { videos.push(f); continue; }
        if (!as) throw new Error(`"${f.name}" is not a picture, a video or a sound file.`);
        if (as === "audio" && k !== "audio") throw new Error(`"${f.name}" is not a sound file.`);
        if ((as === "image" || as === "element") && k !== "image") throw new Error(`"${f.name}" is not a picture.`);
        await api.uploadAsset(f, as); ok++;
      } catch (e) { toast(e.message, { icon: "alert" }); }
      finally { setUploading((u) => u - 1); }
    }
    if (videos.length) { setUploading((u) => Math.max(0, u - videos.length)); startUpload(videos); }
    if (ok) { toast(`${ok} ${ok === 1 ? "file" : "files"} added`, { icon: "check", tone: "brand" }); refresh(); }
  };
  const dropProps = section === "trash" ? {} : {
    onDragOver: (e) => { if (Array.from(e.dataTransfer?.types || []).includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => { if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return; e.preventDefault(); setOver(false); upload(e.dataTransfer.files); },
  };

  const fav = async (x) => { setItem(x.id, (y) => ({ ...y, favorite: !x.favorite })); try { await api.favoriteAsset(x.type, x.id, !x.favorite); onChange?.(); if (section === "favorites" && x.favorite) q.setData((xs) => xs.filter((y) => y.id !== x.id)); } catch (e) { setItem(x.id, (y) => ({ ...y, favorite: x.favorite })); toast(e.message); } };
  const trash = async (x) => {
    try {
      await api.trashAsset(x.type, x.id);
      q.setData((xs) => (xs || []).filter((y) => y.id !== x.id)); setOpen(null); onChange?.();
      toast(`"${x.name}" moved to the Trash`, { icon: "trash", ms: 6000, action: { label: "Undo", onClick: async () => { try { await api.restoreTrashed(x.type, x.id); refresh(); } catch (e) { toast(e.message); } } } });
    } catch (e) { toast(e.message); }
  };
  const restore = async (x) => { try { await api.restoreTrashed(x.type, x.id); q.setData((xs) => xs.filter((y) => y.id !== x.id)); onChange?.(); toast(`"${x.name}" restored`, { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } };
  const deleteForever = async (x, keep = false) => {
    if (x.type === "video" || x.type === "image") { setForever(x); return; }
    try { await api.deleteAssetForever(x.type, x.id, keep); q.setData((xs) => xs.filter((y) => y.id !== x.id)); onChange?.(); toast(`"${x.name}" deleted for good`, { icon: "trash" }); setForever(null); }
    catch (e) { if (e.code === "in-use" && !keep) setForever({ ...x, inUse: e.message }); else toast(e.message); }
  };
  const emptyTrash = async () => {
    try { const r = await api.emptyTrash(); setEmptyAsk(false); refresh(); toast(r.kept?.length ? `${r.deleted} deleted for good. ${r.kept.length} kept: ${r.kept.length === 1 ? "an edit still uses it" : "edits still use them"}.` : `${r.deleted} deleted for good`, { icon: "trash", ms: r.kept?.length ? 6000 : 2600 }); }
    catch (e) { toast(e.message); }
  };
  const openItem = (x) => { if (section === "trash") return; if (x.type === "video") { if (x.status === "ready") go("/library/" + x.id); return; } setOpen(x); };

  const s = SEC[section];
  const canUpload = section !== "trash" && section !== "favorites";
  const uploadLabel = section === "images" ? "Upload images" : section === "elements" ? "Upload elements" : section === "audio" ? "Upload audio" : "Upload";
  const empty = {
    all: ["layers", "No assets yet", "Videos, pictures, logos and music you add show up here."],
    images: ["image", "No images yet", "Photos, screenshots and product shots for b-roll."],
    elements: ["spark", "No elements yet", "Logos, stickers and overlays. A PNG keeps its transparency."],
    audio: ["wave", "No audio yet", "Your music, voice-overs and sound effects."],
    favorites: ["heart", "No favorites yet", "Press the heart on anything to keep it here."],
    trash: ["trash", "The Trash is empty", `Deleted assets wait here ${TRASH_DAYS} days, then go for good.`],
  }[section];
  return html`<div class=${"as-pane" + (over ? " over" : "")} id=${"assets-" + section} ...${dropProps}>
    <div class="as-head">
      <div class="col" style="gap:2px"><h1 class="t-title" id="assets-title">${s.label}</h1>
        <p class="t-small muted" id="assets-sub">${section === "trash" ? `Deleted assets go for good after ${TRASH_DAYS} days.` : section === "elements" ? "Logos and overlays for your edits. Your AI can place them too." : q.data ? `${q.data.length} ${q.data.length === 1 ? "item" : "items"}` : " "}</p></div>
      <div class="row wrap" style="gap:8px">
        <div class="search" style="width:220px"><${Icon} name="search" /><input class="input sm" id="assets-search" placeholder="Search" value=${search} onInput=${(e) => setSearch(e.target.value)} aria-label="Search assets" /></div>
        ${section === "trash" && (q.data || []).length > 0 && html`<${Btn} kind="ghost" size="sm" icon="trash" id="empty-trash" onClick=${() => setEmptyAsk(true)}>Empty trash<//>`}
        ${canUpload && html`<${Btn} size="sm" icon=${uploading ? undefined : "upload"} id="assets-upload" disabled=${uploading > 0} onClick=${() => file.current?.click()}>${uploading ? html`<span class="spin" /> Uploading ${uploading}…` : uploadLabel}<//>
          <input ref=${file} type="file" multiple id="assets-file" accept=${ACCEPT[section] || "image/*,audio/*,video/*"} style="display:none" onChange=${(e) => { upload(e.target.files); e.target.value = ""; }} />`}
      </div>
    </div>
    ${over && html`<div class="as-drop" id="assets-drop"><${Icon} name="upload" size="22" /><b>Drop to add ${section === "elements" ? "elements" : section === "audio" ? "audio" : section === "images" ? "images" : "files"}</b></div>`}
    <${Async} q=${q} skeleton=${html`<div class="as-grid">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => html`<div key=${i} class="skeleton" style="aspect-ratio:4/3;border-radius:14px" />`)}</div>`}
      whenEmpty=${html`<${EmptyState} icon=${empty[0]} title=${empty[1]} text=${empty[2]} action=${canUpload ? html`<${Btn} size="sm" icon="upload" onClick=${() => file.current?.click()}>${uploadLabel}<//>` : null} />`}>
      ${() => items.length === 0 ? html`<${EmptyState} icon="search" title="Nothing matches" action=${html`<${Btn} kind="secondary" size="sm" onClick=${() => setSearch("")}>Clear search<//>`} />`
        : section === "trash" ? html`<div class="col as-trash" id="trash-list">${items.map((x) => html`<${TrashRow} key=${x.id} x=${x} onRestore=${() => restore(x)} onDelete=${() => deleteForever(x)} />`)}</div>`
        : section === "audio" ? html`<div class="col as-audio" id="audio-list">${items.map((x) => html`<${AudioRow} key=${x.id} x=${x} onFav=${() => fav(x)} onTrash=${() => trash(x)} onRename=${(name) => api.renameAsset("audio", x.id, name).then(() => setItem(x.id, (y) => ({ ...y, name }))).catch((e) => toast(e.message))} />`)}</div>`
        : html`<div class="as-grid" id="assets-grid">${items.map((x) => html`<${AssetCard} key=${x.type + x.id} x=${x} onOpen=${() => openItem(x)} onFav=${() => fav(x)} onTrash=${() => trash(x)} />`)}</div>`}
    <//>
    ${open && html`<${AssetViewer} x=${(q.data || []).find((y) => y.id === open.id) || open} onClose=${() => setOpen(null)} onFav=${fav} onTrash=${trash} onRename=${async (name) => { try { await api.renameAsset(open.type, open.id, name); setItem(open.id, (y) => ({ ...y, name })); } catch (e) { toast(e.message); } }} />`}
    ${forever && (forever.type === "video" || forever.type === "image") && html`<${DeleteVideoModal} video=${forever.raw} onClose=${() => setForever(null)} onDeleted=${() => { setForever(null); refresh(); }} />`}
    ${forever && forever.inUse && html`<${Modal} title=${`Delete "${forever.name}" for good?`} sub=${forever.inUse} onClose=${() => setForever(null)} footer=${html`<${Btn} kind="ghost" onClick=${() => setForever(null)}>Keep it<//><${Btn} icon="trash" id="confirm-forever" onClick=${() => deleteForever(forever, true)}>Delete for good<//>`} />`}
    ${emptyAsk && html`<${Modal} title="Empty the Trash?" sub=${`Everything in the Trash goes for good. Anything an edit still uses stays.`} onClose=${() => setEmptyAsk(false)} footer=${html`<${Btn} kind="ghost" onClick=${() => setEmptyAsk(false)}>Cancel<//><${Btn} icon="trash" id="confirm-empty-trash" onClick=${emptyTrash}>Empty trash<//>`} />`}
  </div>`;
}

/** The picture of an asset: a video's or picture's frame, an element on a see-through checkerboard, a sound's wave. */
function AssetThumb({ x }) {
  if (x.type === "audio") return html`<div class="as-thumb audio"><${Icon} name="wave" size="30" /><span class="as-len">${fmtLen(x.seconds || 0)}</span></div>`;
  if (x.type === "element") return html`<div class="as-thumb checker">${x.thumb ? html`<img src=${x.thumb} alt="" loading="lazy" />` : html`<${Icon} name="spark" size="26" />`}</div>`;
  return html`<div class=${"as-thumb" + (x.type === "image" ? " image" : "")}><${Thumb} src=${x.thumb} art=${x.art} />${x.type === "video" && x.seconds ? html`<span class="as-len">${fmtLen(x.seconds)}</span>` : null}</div>`;
}

function AssetCard({ x, onOpen, onFav, onTrash }) {
  const busy = BUSY.includes(x.status), failed = x.status === "failed";
  return html`<div class=${"as-card" + (busy ? " busy" : "")} data-asset=${x.id} data-type=${x.type} role="button" tabindex="0" aria-label=${x.name} onClick=${onOpen} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
    <${AssetThumb} x=${x} />
    ${busy && html`<div class="as-veil"><span class="spin" /><span class="t-small">Preparing…</span></div>`}
    ${failed && html`<div class="as-veil"><${Icon} name="alert" size="18" /><span class="t-small">${x.error || "Could not be read"}</span></div>`}
    <span class="as-type"><${Icon} name=${TYPE_ICON[x.type]} size="11" />${TYPE_LABEL[x.type]}</span>
    <div class="as-acts" onClick=${(e) => e.stopPropagation()}>
      <button class=${"as-act" + (x.favorite ? " on" : "")} data-fav=${x.id} aria-pressed=${x.favorite} aria-label=${x.favorite ? "Remove from favorites" : "Add to favorites"} title=${x.favorite ? "Favorite" : "Add to favorites"} onClick=${onFav}><${Icon} name="heart" size="14" /></button>
      <button class="as-act" data-trash=${x.id} aria-label=${"Delete " + x.name} title="Move to the Trash" onClick=${onTrash}><${Icon} name="trash" size="14" /></button>
    </div>
    <div class="as-meta"><b class="ell">${x.name}</b><span class="t-small muted">${fmtAgo(x.at)}${x.size ? " · " + x.size : ""}</span></div>
  </div>`;
}

/** One shared player for the audio list: one plays at a time. */
let player = null; const listeners = new Set();
const playing = () => (player && !player.paused ? player.dataset.id : null);
function playSound(x) {
  if (!x.url) return;
  if (player && player.dataset.id === x.id && !player.paused) { player.pause(); listeners.forEach((f) => f()); return; }
  if (!player) { player = new Audio(); ["play", "pause", "ended"].forEach((ev) => player.addEventListener(ev, () => listeners.forEach((f) => f()))); }
  player.dataset.id = x.id; player.src = x.url; player.play().catch(() => {}); listeners.forEach((f) => f());
}
function usePlaying() { const [, set] = useState(0); useEffect(() => { const f = () => set((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []); return playing(); }

function AudioRow({ x, onFav, onTrash, onRename }) {
  const now = usePlaying(); const on = now === x.id; const busy = BUSY.includes(x.status);
  const [edit, setEdit] = useState(null);
  return html`<div class=${"as-row" + (on ? " on" : "")} data-asset=${x.id} data-type="audio">
    <button class="as-play" data-play=${x.id} aria-label=${on ? "Pause " + x.name : "Play " + x.name} disabled=${!x.url} onClick=${() => playSound(x)}>${busy ? html`<span class="spin" />` : html`<${Icon} name=${on ? "pause" : "play"} size="16" />`}</button>
    <div class="grow col" style="gap:2px;min-width:0">${edit != null
      ? html`<form onSubmit=${(e) => { e.preventDefault(); onRename(edit); setEdit(null); }}><input class="input sm" value=${edit} aria-label="Name" autoFocus onInput=${(e) => setEdit(e.target.value)} onBlur=${() => setEdit(null)} onKeyDown=${(e) => e.key === "Escape" && setEdit(null)} /></form>`
      : html`<b class="ell" onDblClick=${() => setEdit(x.name)} title="Double-click to rename">${x.name}</b>`}
      <span class="t-small muted">${x.status === "failed" ? x.error || "Could not be read" : busy ? "Preparing…" : `${fmtLen(x.seconds || 0)} · ${fmtAgo(x.at)}${x.size ? " · " + x.size : ""}`}</span></div>
    <button class=${"as-act" + (x.favorite ? " on" : "")} data-fav=${x.id} aria-pressed=${x.favorite} aria-label=${x.favorite ? "Remove from favorites" : "Add to favorites"} onClick=${onFav}><${Icon} name="heart" size="14" /></button>
    <button class="as-act" data-trash=${x.id} aria-label=${"Delete " + x.name} title="Move to the Trash" onClick=${onTrash}><${Icon} name="trash" size="14" /></button>
  </div>`;
}

function TrashRow({ x, onRestore, onDelete }) {
  return html`<div class="as-row trash" data-asset=${x.id} data-type=${x.type}>
    <div class="as-mini"><${AssetThumb} x=${x} /></div>
    <div class="grow col" style="gap:2px;min-width:0"><b class="ell">${x.name}</b>
      <span class="t-small muted"><span class="as-tag">${TYPE_LABEL[x.type]}</span> ${x.daysLeft != null ? (x.daysLeft <= 1 ? "Goes for good today" : `${x.daysLeft} days left`) : ""}</span></div>
    <${Btn} kind="ghost" size="sm" icon="undo" data-restore=${x.id} onClick=${onRestore}>Restore<//>
    <${Btn} kind="quiet" size="sm" icon="trash" data-forever=${x.id} aria-label=${"Delete " + x.name + " for good"} title="Delete for good" onClick=${onDelete} />
  </div>`;
}

/** A picture or element, big: rename, favorite, delete. */
function AssetViewer({ x, onClose, onFav, onTrash, onRename }) {
  const [name, setName] = useState(x.name);
  useEffect(() => setName(x.name), [x.name]);
  const save = () => { if (name.trim() && name.trim() !== x.name) onRename(name.trim()); };
  return html`<${Modal} title=${TYPE_LABEL[x.type]} onClose=${onClose} wide footer=${html`
      <${Btn} kind="ghost" icon="trash" id="viewer-trash" onClick=${() => onTrash(x)}>Delete<//>
      <div class="grow" />
      <${Btn} kind=${x.favorite ? "secondary" : "ghost"} icon="heart" id="viewer-fav" onClick=${() => onFav(x)}>${x.favorite ? "Favorite" : "Add to favorites"}<//>`}>
    <div class="col" style="gap:12px">
      <div class=${"as-view" + (x.type === "element" ? " checker" : "")} id="asset-view">${x.thumb ? html`<img src=${x.type === "element" ? x.thumb : x.thumb} alt=${x.name} />` : html`<${Icon} name=${TYPE_ICON[x.type]} size="40" />`}</div>
      <form class="row" style="gap:8px" onSubmit=${(e) => { e.preventDefault(); save(); }}><input class="input grow" id="asset-name" aria-label="Name" value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${save} /></form>
      <p class="t-small muted" id="asset-info">${[x.width && x.height ? `${x.width} x ${x.height}` : "", x.size, fmtAgo(x.at)].filter(Boolean).join(" · ")}</p>
      ${x.type === "element" && html`<p class="t-small muted">Add it in the editor's Media panel, or ask your AI: "put my ${x.name} logo in the corner".</p>`}
    </div>
  <//>`;
}
