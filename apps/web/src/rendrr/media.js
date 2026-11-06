// The editor's left column, like Premiere's Source monitor over its Project panel: the reference the user (or their
// AI) attached for the AI to copy, playable on top; under it the project bin, the footage this edit uses or keeps to
// use (add_media), with the library one click away. A bin video plays in the monitor (Source) and goes into the edit
// at the playhead or at the end.
import { useState, useEffect, useMemo, html, Btn, Icon, fmtTime, useAsync, Thumb } from "./ui";
import { api } from "./api";

const byName = (a, b) => a.name.localeCompare(b.name);

/** The monitor: the reference (a reference video plays here; a style is named) or, when one is picked in the bin, that
 *  video (Source), with Insert and Append. */
export function SourceMonitor({ reference, refs, styles, onReference, source, onCloseSource, onInsert, onAppend }) {
  const showing = source ? { id: source.id, name: source.name } : reference?.kind === "video" ? { id: reference.id, name: reference.name } : null;
  const [url, setUrl] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true; setUrl(null); setErr(null);
    if (showing) api.getVideo(showing.id).then((v) => { if (live) { setUrl(v.proxyUrl || null); if (!v.proxyUrl) setErr(v.status === "expired" ? "Its preview copy expired." : "Its preview copy is not ready yet."); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [showing?.id]);
  const key = reference ? reference.kind + ":" + reference.id : "";
  const pick = (k) => {
    if (!k) return onReference(null);
    const [kind, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const it = kind === "style" ? styles.find((s) => s.id === id) : refs.find((v) => v.id === id);
    onReference(it ? { kind, id, name: it.name } : null);
  };
  return html`<section class="mon" id="source-monitor" aria-label=${source ? "Source monitor" : "Reference monitor"}>
    <header class="mon-head"><div class="mon-tabs" role="tablist">
        <button role="tab" aria-selected=${!source} class=${!source ? "on" : ""} onClick=${() => source && onCloseSource()}>Reference</button>
        ${source && html`<button role="tab" aria-selected="true" class="on" title=${source.name}>Source: ${source.name}</button>`}</div>
      ${source && html`<button class="tool icon" aria-label="Back to the reference" title="Back to the reference" onClick=${onCloseSource}><${Icon} name="x" size="14" /></button>`}</header>
    <div class="mon-screen">${showing
      ? url ? html`<video key=${url} src=${url} controls playsInline preload="metadata" id=${source ? "source-video" : "reference-video"} />` : html`<div class="mon-empty"><span class="t-small muted">${err || "Loading…"}</span></div>`
      : reference?.kind === "style" ? html`<div class="mon-empty"><${Icon} name="styles" size="22" /><b class="t-label">Style: ${reference.name}</b></div>`
      : html`<div class="mon-empty" title="A video your AI copies the style of. It is never applied to the edit."><${Icon} name="film" size="22" /><span class="t-small muted">No reference</span></div>`}</div>
    ${source ? html`<div class="mon-foot row" style="gap:6px"><${Btn} size="xs" icon="plus" id="source-insert" onClick=${() => onInsert(source)}>Insert at playhead<//><${Btn} kind="quiet" size="xs" id="source-append" onClick=${() => onAppend(source)}>Add at the end<//></div>`
      : html`<div class="mon-foot"><select id="reference-pick" class="input sm" aria-label="Reference" value=${key} onChange=${(e) => pick(e.target.value)}>
          <option value="">No reference</option>
          ${refs.length > 0 && html`<optgroup label="Reference videos">${refs.map((v) => html`<option key=${v.id} value=${"video:" + v.id}>${v.name}</option>`)}</optgroup>`}
          ${styles.length > 0 && html`<optgroup label="Styles">${styles.map((s) => html`<option key=${s.id} value=${"style:" + s.id}>${s.name}</option>`)}</optgroup>`}
          ${reference && !(reference.kind === "style" ? styles : refs).some((x) => x.id === reference.id) && html`<option value=${key}>${reference.name}</option>`}
        </select></div>`}
  </section>`;
}

/** The project bin: every video the edit uses or keeps (add_media), the library to add from, Import for new footage. */
export function MediaBin({ library, used, bin, mainId, onPreview, onAppend, onAddToBin, onRemoveFromBin, onImport, previewing }) {
  const [adding, setAdding] = useState(false); const [q, setQ] = useState("");
  const all = library || [];
  const ids = useMemo(() => Array.from(new Set([mainId, ...used, ...bin])), [mainId, used, bin]);
  const items = ids.map((id) => all.find((v) => v.id === id)).filter(Boolean);
  const rest = all.filter((v) => !ids.includes(v.id) && v.status !== "expired" && (!q || v.name.toLowerCase().includes(q.toLowerCase()))).sort(byName);
  return html`<section class="bin" id="media-bin" aria-label="Project media">
    <header class="bin-head"><b>Project</b>${library != null && html`<span class="muted t-small" id="bin-count">${items.length} ${items.length === 1 ? "video" : "videos"}</span>`}<div class="grow" />
      <button class="tool icon" id="bin-library" aria-pressed=${adding} title="Add from your library" aria-label="Add from your library" onClick=${() => setAdding((a) => !a)}><${Icon} name="library" size="15" /></button>
      <button class="tool icon" id="bin-import" title="Import footage (computer or Google Drive)" aria-label="Import footage" onClick=${onImport}><${Icon} name="upload" size="15" /></button></header>
    ${adding && html`<div class="bin-add" id="bin-add">
      <input class="input sm" placeholder="Search your library" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search your library" />
      <div class="bin-list">${library == null ? html`<span class="t-small muted">Loading…</span>` : rest.length ? rest.slice(0, 60).map((v) => html`<div key=${v.id} class="bin-row" data-library=${v.id}>
          <div class="bin-thumb sm"><${Thumb} src=${v.thumb} art=${v.art} /></div><div class="grow" style="min-width:0"><b class="t-small ell">${v.name}</b><span class="muted t-small">${fmtTime(v.seconds)}${v.kind === "reference" ? " · reference" : ""}</span></div>
          <button class="tool icon" aria-label=${"Add " + v.name + " to the project"} title="Add to the project" onClick=${() => onAddToBin(v)}><${Icon} name="plus" size="14" /></button></div>`)
        : html`<span class="t-small muted">${q ? "Nothing in your library matches." : "Everything in your library is in this project."}</span>`}</div></div>`}
    <div class="bin-grid">${library == null ? ids.map((id) => html`<div key=${id} class="bin-item" aria-busy="true"><div class="bin-thumb skeleton" /><div class="skeleton sk-line" style="width:70%" /></div>`) : items.map((v) => { const inEdit = v.id === mainId || used.includes(v.id); return html`<div key=${v.id} class=${"bin-item" + (previewing === v.id ? " on" : "")} data-media=${v.id} title=${v.name}>
        <button class="bin-thumb" aria-label=${"Play " + v.name + " in the monitor"} onClick=${() => onPreview(v)}><${Thumb} src=${v.thumb} art=${v.art} /><span class="len">${fmtTime(v.seconds)}</span>${inEdit && html`<span class="badge-in">In edit</span>`}</button>
        <div class="row" style="gap:4px;min-width:0"><span class="t-small ell grow">${v.name}</span>
          <button class="tool icon xs" aria-label=${"Add " + v.name + " at the end of the edit"} title="Add at the end of the edit" onClick=${() => onAppend(v)}><${Icon} name="plus" size="13" /></button>
          ${!inEdit && bin.includes(v.id) && html`<button class="tool icon xs" aria-label=${"Take " + v.name + " out of the project"} title="Take out of the project" onClick=${() => onRemoveFromBin(v)}><${Icon} name="x" size="13" /></button>`}</div>
      </div>`; })}</div>
  </section>`;
}

/** The library, once (the bin and the monitor's picker read it). */
export function useLibrary(deps = []) {
  const q = useAsync(() => api.listVideos().catch(() => []), deps);
  const styles = useAsync(() => api.listStyles().catch(() => []), []);
  return { library: q.data || null, reload: q.reload, refs: (q.data || []).filter((v) => v.kind === "reference" && v.status !== "expired").sort(byName), styles: styles.data || [] };
}
