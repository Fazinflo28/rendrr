/* ===================== motion templates ===================== */
// A motion-graphic video kept as a template: its design (colours, type, cards), its motion (word timing, easings,
// morphs) and its camera, with a slot for every word, picture and colour. /templates lists Rendrr's and yours;
// /templates/:id shows how it is built and Recreate makes an edit from it with your words, pictures and colours.
// A whole new video in the same design and motion is made by your AI (the prompt to send is on the page).
import { useState, useEffect, html, Icon, Btn, Field, useToast, useAsync, Async, EmptyState, Skeleton, copyText, useNav, useApp } from "./ui";
import { api } from "./api";

const IMG_MAX_W = 1280;
// A picture the user picks, made small enough for the template (about 1280 px wide JPEG; PNG kept for a logo).
function readPicture(file, keepAlpha) {
  return new Promise((ok, fail) => {
    if (!/^image\//.test(file.type)) { fail(new Error("Pick a picture (PNG, JPEG or WebP).")); return; }
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => {
      const s = Math.min(1, IMG_MAX_W / im.naturalWidth); const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(im.naturalWidth * s)); c.height = Math.max(1, Math.round(im.naturalHeight * s));
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      ok(keepAlpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.8));
    };
    im.onerror = () => { URL.revokeObjectURL(url); fail(new Error("That picture could not be read.")); };
    im.src = url;
  });
}

const swatches = (spec) => {
  const d = spec.design || {}; const acc = Array.isArray(d.accent) ? d.accent : [];
  return [d.bg, d.ink, d.muted, ...acc, d.brand].filter((c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c));
};

function TemplateCard({ t, onOpen }) {
  const sw = swatches(t.spec);
  return html`<button class="mt-card" data-template=${t.id} onClick=${() => onOpen(t)}>
    <div class="mt-art" style=${{ background: `linear-gradient(135deg, ${sw[3] || "#EE4F8C"}, ${sw[4] || "#B13FD9"})` }}>
      <span class="mt-len">${Math.round(t.seconds)}s</span>
      <span class="mt-name-big">${t.name}</span>
    </div>
    <div class="mt-meta"><b>${t.name}</b><span class="t-small muted">${t.builtin ? "Rendrr" : "Yours"} · ${t.spec.scenes?.length || 0} scenes · ${t.spec.slots.length} things to swap</span></div>
  </button>`;
}

/** The strip on Explore's Rendrr presets side. */
export function MotionTemplatesStrip() {
  const { go } = useNav();
  const q = useAsync(() => api.listTemplates(), []);
  if (!q.data?.length) return null;
  return html`<section class="mt-strip" id="motion-templates">
    <div class="row between"><div><h2 class="t-h3">Motion templates</h2><p class="t-small muted">Swap the words, pictures and colours, or make a new video with the same animations.</p></div>
      <${Btn} size="sm" kind="secondary" onClick=${() => go("/templates")}>See all<//></div>
    <div class="mt-row">${q.data.slice(0, 6).map((t) => html`<${TemplateCard} key=${t.id} t=${t} onOpen=${() => go("/templates/" + t.id)} />`)}</div>
  </section>`;
}

export function TemplatesPage() {
  const { go } = useNav();
  const q = useAsync(() => api.listTemplates(), []);
  return html`<div class="page wide">
    <div class="page-head"><div><h1 class="t-title">Motion templates</h1><p class="muted">Each one keeps a video's design, animations and camera moves. Swap in your own words, pictures and colours, or have your AI make a new video in the same style.</p></div></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} h=${220} />`} whenEmpty=${html`<${EmptyState} icon="sparkles" title="No templates yet" text="Ask your AI to make a template from a motion-graphic video you like." />`}>${(list) => html`<div class="mt-grid">${list.map((t) => html`<${TemplateCard} key=${t.id} t=${t} onOpen=${() => go("/templates/" + t.id)} />`)}</div>`}<//>
  </div>`;
}

function SlotInput({ s, value, onChange }) {
  const toast = useToast();
  const id = "slot-" + s.id;
  if (s.type === "color") return html`<${Field} id=${id} label=${s.label}><div class="row" style="gap:8px"><input id=${id} type="color" class="mt-color" value=${value || s.default || "#000000"} onInput=${(e) => onChange(e.target.value.toUpperCase())} /><span class="t-small muted">${(value || s.default || "").toUpperCase()}</span></div><//>`;
  if (s.type === "image") {
    const pick = async (e) => { const f = e.target.files?.[0]; if (!f) return; try { onChange(await readPicture(f, s.id === "logo")); } catch (er) { toast(er.message); } };
    const shown = value && value.startsWith("data:image/") ? value : null;
    return html`<${Field} id=${id} label=${s.label} hint=${s.video ? "A picture, or the id of a video in your library (it plays full screen)." : "A picture from your computer, a link to one, or a library picture's id."}>
      <div class="mt-pic">${shown ? html`<img src=${shown} alt="" />` : html`<span class="mt-pic-empty"><${Icon} name="image" size="18" /></span>`}
        <div class="col" style="gap:6px;flex:1"><input id=${id} class="input sm" placeholder="https://… or a library id" value=${shown ? "" : value || ""} onInput=${(e) => onChange(e.target.value.trim())} />
          <div class="row" style="gap:8px"><label class="btn sm secondary mt-file">Upload<input type="file" accept="image/*" onChange=${pick} hidden /></label>${value ? html`<button class="btn sm ghost" onClick=${() => onChange("")}>Clear</button>` : null}</div></div></div><//>`;
  }
  const long = (s.maxChars || 0) > 44;
  return html`<${Field} id=${id} label=${s.label} hint=${s.maxChars ? `${(value ?? s.default ?? "").length}/${s.maxChars}` : null}>
    ${long ? html`<textarea id=${id} class="input" rows="2" maxlength=${s.maxChars} placeholder=${s.default || ""} value=${value ?? ""} onInput=${(e) => onChange(e.target.value)} />`
      : html`<input id=${id} class="input" maxlength=${s.maxChars} placeholder=${s.default || ""} value=${value ?? ""} onInput=${(e) => onChange(e.target.value)} />`}<//>`;
}

export function TemplatePage({ id }) {
  const { go } = useNav(); const toast = useToast(); const { requireUser } = useApp();
  const q = useAsync(() => api.getTemplate(id), [id]);
  const [vals, setVals] = useState({}); const [busy, setBusy] = useState(false); const [about, setAbout] = useState("");
  useEffect(() => { setVals({}); }, [id]);
  const set = (k, v) => setVals((o) => ({ ...o, [k]: v }));
  const recreate = () => requireUser(async () => {
    if (busy) return; setBusy(true);
    try {
      const slots = Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== "" && v != null));
      const r = await api.recreateTemplate(id, { slots });
      toast("Made your edit. Render it to see the video."); go("/editor/" + r.projectId);
    } catch (e) { toast(e.message); setBusy(false); }
  });
  const prompt = (t) => `Make a new motion-graphic video with the Rendrr template ${t.id} ("${t.name}"): keep its design, animations and camera moves (create_graphic with template and templateFrom "${t.id}"), then recreate it (create_project templateId). The video is about: ${about || "<what it is about>"}.`;
  return html`<div class="page wide">
    <${Async} q=${q} skeleton=${html`<${Skeleton} h=${300} />`}>${(t) => {
      const groups = { text: t.spec.slots.filter((s) => s.type === "text"), image: t.spec.slots.filter((s) => s.type === "image"), color: t.spec.slots.filter((s) => s.type === "color") };
      const sw = swatches(t.spec);
      return html`<div class="col" style="gap:20px">
        <div class="page-head"><div><button class="btn ghost sm" onClick=${() => go("/templates")}><${Icon} name="arrow-left" size="14" />Templates</button>
          <h1 class="t-title">${t.name}</h1><p class="muted">${t.description}</p></div>
          <${Btn} kind="primary" id="template-recreate" disabled=${busy} onClick=${recreate}>${busy ? "Making your edit…" : "Recreate"}<//></div>
        <div class="mt-detail">
          <div class="col" style="gap:16px">
            <section class="card mt-sec"><h2 class="t-h3">Design</h2>
              <div class="row" style="gap:8px;flex-wrap:wrap">${sw.map((c) => html`<span class="mt-sw" title=${c} style=${{ background: c }} />`)}</div>
              <p class="t-small muted">${t.text.split("\n").find((l) => l.startsWith("DESIGN:"))?.slice(8) || ""}</p></section>
            <section class="card mt-sec"><h2 class="t-h3">Motion and camera</h2>
              <ul class="mt-list">${t.text.split("\n").filter((l) => /^(WORDS|MOTION|CAMERA|SOUND):/.test(l)).map((l) => html`<li>${l.replace(/^(\w+):\s*/, "")}</li>`)}</ul></section>
            <section class="card mt-sec"><h2 class="t-h3">Scenes</h2>
              <ol class="mt-scenes">${(t.spec.scenes || []).map((s) => html`<li><span class="mt-at">${s.start.toFixed(1)}s</span><span>${s.what}</span></li>`)}</ol></section>
            ${t.spec.elements?.length ? html`<section class="card mt-sec"><h2 class="t-h3">Elements</h2>
              <ul class="mt-list">${t.spec.elements.map((l) => html`<li>${l}</li>`)}</ul></section>` : null}
            <section class="card mt-sec" id="template-code"><div class="row between"><h2 class="t-h3">Code</h2>
              <${Btn} size="sm" kind="secondary" icon="copy" onClick=${() => { copyText(JSON.stringify(t.spec, null, 2)); toast("Code copied"); }}>Copy the code<//></div>
              <p class="t-small muted">Every element, keyframe, ease, colour and timing of this video as code. Anyone can read and copy it, and any AI can recreate the video from it.${t.source === "reference" ? " Broken down from a reference video." : ""}</p>
              <details><summary class="t-small">Show the code</summary><pre class="mt-code">${JSON.stringify(t.spec, null, 2)}</pre></details></section>
            <section class="card mt-sec"><h2 class="t-h3">A new video in this style</h2>
              <p class="t-small muted">Your AI writes new scenes that keep this template's design, animations and camera. Say what the video is about, then send the prompt to Claude or ChatGPT with Rendrr connected.</p>
              <textarea class="input" rows="2" id="template-about" placeholder="What the new video is about" value=${about} onInput=${(e) => setAbout(e.target.value)} />
              <div class="row"><${Btn} size="sm" kind="secondary" icon="copy" onClick=${() => { copyText(prompt(t)); toast("Prompt copied"); }}>Copy the prompt<//></div></section>
          </div>
          <section class="card mt-sec mt-form"><h2 class="t-h3">Swap the assets</h2><p class="t-small muted">Leave a field empty to keep the template's.</p>
            ${groups.text.length ? html`<h3 class="t-small mt-group">Words</h3>${groups.text.map((s) => html`<${SlotInput} key=${s.id} s=${s} value=${vals[s.id]} onChange=${(v) => set(s.id, v)} />`)}` : null}
            ${groups.image.length ? html`<h3 class="t-small mt-group">Pictures and videos</h3>${groups.image.map((s) => html`<${SlotInput} key=${s.id} s=${s} value=${vals[s.id]} onChange=${(v) => set(s.id, v)} />`)}` : null}
            ${groups.color.length ? html`<h3 class="t-small mt-group">Colours</h3>${groups.color.map((s) => html`<${SlotInput} key=${s.id} s=${s} value=${vals[s.id]} onChange=${(v) => set(s.id, v)} />`)}` : null}
            <${Btn} kind="primary" disabled=${busy} onClick=${recreate}>${busy ? "Making your edit…" : "Recreate"}<//>
          </section>
        </div>
      </div>`; }}<//>
  </div>`;
}
