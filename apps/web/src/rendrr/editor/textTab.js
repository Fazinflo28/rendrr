// The Text tool: text and caption styles, text inside the footage, and the text layers list.
// Moved out of editor.js unchanged (audit #30): the editor imports it from here.
import { CAPTION_FONTS, FONT_WEIGHTS, TEXT_ANIMS, TEXT_PRESETS, captionStyleOf, textPreset } from "@rendrr/shared";
import { Btn, fmtTime, html, useEffect, useState } from "../ui";
import { OpColor, OpSlider } from "../controls";
// Style controls shared by the caption style and a text layer: font, weight, size, colour, box, stroke, shadow,
// position, case (and for captions the active word and the word counts; for text the alignment, animation, card).
function StyleControls({ kind, style, card, anim, opFor, doOp, H, liveOp, idp }) {
  const sl = { H, liveOp };
  const set = (patch) => doOp(opFor(patch), false);
  const ws = FONT_WEIGHTS[style.font] || [400];
  const toggle = (on, def, key) => html`<input type="checkbox" checked=${on} id=${idp + "-" + key} onChange=${(e) => set({ [key]: e.target.checked ? def : null })} />`;
  return html`<div class="col" style="gap:8px">
    <div class="row" style="gap:8px">
      <label class="t-small grow" style="display:grid;gap:4px">Font<select class="input sm" id=${idp + "-font"} value=${style.font} onChange=${(e) => { const f = e.target.value; const fw = FONT_WEIGHTS[f] || [400]; set({ font: f, weight: fw.reduce((b, x) => (Math.abs(x - style.weight) < Math.abs(b - style.weight) ? x : b), fw[0]) }); }}>${CAPTION_FONTS.map((f) => html`<option key=${f} value=${f}>${f}</option>`)}</select></label>
      <label class="t-small" style="display:grid;gap:4px">Weight<select class="input sm" id=${idp + "-weight"} value=${String(style.weight)} onChange=${(e) => set({ weight: +e.target.value })}>${ws.map((w) => html`<option key=${w} value=${String(w)}>${w}</option>`)}</select></label>
      <label class="t-small" style="display:grid;gap:4px">Colour<${OpColor} id=${idp + "-color"} value=${style.color} opFor=${(c) => opFor({ color: c })} ...${sl} /></label>
    </div>
    <${OpSlider} id=${idp + "-size"} label="Size" value=${style.size} min=${2} max=${kind === "text" ? 20 : 14} step=${0.1} show=${(x) => x + "% of the frame"} opFor=${(x) => opFor({ size: x })} ...${sl} />
    <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id=${idp + "-x"} label="Across" value=${style.x} min=${0} max=${1} step=${0.01} show=${(x) => Math.round(x * 100) + "%"} opFor=${(x) => opFor({ x })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-y"} label="Down" value=${style.y} min=${0} max=${1} step=${0.01} show=${(x) => Math.round(x * 100) + "%"} opFor=${(y) => opFor({ y })} ...${sl} /></div></div>
    <div class="row wrap" style="gap:12px">
      <label class="t-small row" style="gap:6px">${toggle(!!style.box, { color: "#000000", opacity: 0.6, padding: 25 }, "box")}Box</label>
      ${!style.box && html`<label class="t-small row" style="gap:6px">${toggle(!!style.stroke, { color: "#000000", width: 8 }, "stroke")}Stroke</label>`}
      <label class="t-small row" style="gap:6px">${toggle(!!style.shadow, { color: "#000000", opacity: 0.6, x: 0, y: 6 }, "shadow")}Shadow</label>
      <label class="t-small row" style="gap:6px">Case<select class="input sm" id=${idp + "-case"} value=${style.case} onChange=${(e) => set({ case: e.target.value })}>${["none", "upper", "lower"].map((c) => html`<option key=${c} value=${c}>${c === "none" ? "As typed" : c === "upper" ? "UPPER" : "lower"}</option>`)}</select></label>
    </div>
    ${style.box && html`<div class="row" style="gap:12px;align-items:flex-end"><${OpColor} id=${idp + "-box-color"} value=${style.box.color} opFor=${(c) => opFor({ box: { ...style.box, color: c } })} ...${sl} />
      <div class="grow"><${OpSlider} id=${idp + "-box-opacity"} label="Box opacity" value=${style.box.opacity} min=${0} max=${1} step=${0.05} show=${(x) => Math.round(x * 100) + "%"} opFor=${(x) => opFor({ box: { ...style.box, opacity: x } })} ...${sl} /></div>
      <div class="grow"><${OpSlider} id=${idp + "-box-padding"} label="Padding" value=${style.box.padding} min=${0} max=${80} step=${1} show=${(x) => x + "%"} opFor=${(x) => opFor({ box: { ...style.box, padding: x } })} ...${sl} /></div></div>`}
    ${!style.box && style.stroke && html`<div class="row" style="gap:12px;align-items:flex-end"><${OpColor} id=${idp + "-stroke-color"} value=${style.stroke.color} opFor=${(c) => opFor({ stroke: { ...style.stroke, color: c } })} ...${sl} />
      <div class="grow"><${OpSlider} id=${idp + "-stroke-width"} label="Stroke" value=${style.stroke.width} min=${0} max=${30} step=${0.5} show=${(x) => x + "%"} opFor=${(x) => opFor({ stroke: { ...style.stroke, width: x } })} ...${sl} /></div></div>`}
    ${style.shadow && html`<div class="row" style="gap:12px;align-items:flex-end"><${OpColor} id=${idp + "-shadow-color"} value=${style.shadow.color} opFor=${(c) => opFor({ shadow: { ...style.shadow, color: c } })} ...${sl} />
      <div class="grow"><${OpSlider} id=${idp + "-shadow-y"} label="Shadow distance" value=${style.shadow.y} min=${-30} max=${30} step=${1} show=${(x) => x + "%"} opFor=${(x) => opFor({ shadow: { ...style.shadow, y: x } })} ...${sl} /></div></div>`}
    ${kind === "caption" && html`<div class="col" style="gap:8px">
      <div class="row" style="gap:8px;align-items:center"><label class="t-small row" style="gap:6px">${toggle(!!style.highlight, "#FFD400", "highlight")}Colour the spoken word</label>${style.highlight && html`<${OpColor} id=${idp + "-highlight-color"} value=${style.highlight} opFor=${(c) => opFor({ highlight: c })} ...${sl} />`}</div>
      <${OpSlider} id=${idp + "-words"} label="Words at once" value=${style.wordsAtOnce} min=${1} max=${12} step=${1} show=${(x) => String(x)} opFor=${(x) => opFor({ wordsAtOnce: x })} ...${sl} />
        <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id=${idp + "-perline"} label="Words a line" value=${style.wordsPerLine} min=${1} max=${12} step=${1} show=${(x) => String(x)} opFor=${(x) => opFor({ wordsPerLine: x })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id=${idp + "-lines"} label="Lines" value=${style.lines} min=${1} max=${3} step=${1} show=${(x) => String(x)} opFor=${(x) => opFor({ lines: x })} ...${sl} /></div></div></div>`}
    ${kind === "text" && html`<div class="row wrap" style="gap:12px;align-items:center">
      <label class="t-small row" style="gap:6px">Align<select class="input sm" id=${idp + "-align"} value=${style.align} onChange=${(e) => set({ align: e.target.value })}>${["left", "center", "right"].map((a) => html`<option key=${a} value=${a}>${a}</option>`)}</select></label>
      <label class="t-small row" style="gap:6px">Animation<select class="input sm" id=${idp + "-anim"} value=${anim} onChange=${(e) => set({ anim: e.target.value })}>${TEXT_ANIMS.map((a) => html`<option key=${a} value=${a}>${a}</option>`)}</select></label>
      <label class="t-small row" style="gap:6px"><input type="checkbox" id=${idp + "-card"} checked=${!!card} onChange=${(e) => set({ card: e.target.checked ? { color: "#0A0A0C", opacity: 1 } : null })} />Card behind</label>
      ${card && html`<${OpColor} id=${idp + "-card-color"} value=${card.color} opFor=${(c) => opFor({ card: { ...card, color: c } })} ...${sl} />`}</div>`}
  </div>`;
}

// Phase 2b: what shows inside a text layer's letters: its colour, a library video (a track matte), or the picture under
// its card (the letters cut out of the card).
function InsideControls({ selText, videos, doOp }) {
  const mode = selText.inside ? "video" : selText.cutout ? "cutout" : "color";
  const first = videos[0];
  const pick = (m) => m === "video" ? first && doOp({ inside: { videoId: first.id, from: 0 } }) : m === "cutout" ? doOp({ cutout: true }) : doOp(selText.inside ? { inside: null } : { cutout: false });
  return html`<div class="col" style="gap:6px" id="text-inside">
    <label class="t-small" style="display:grid;gap:4px" title="A video inside the letters, or the letters cut out of the card so the picture shows through">Inside the letters<select class="input sm" id="text-inside-mode" value=${mode} onChange=${(e) => pick(e.target.value)}>
      <option value="color">Their colour</option><option value="video" disabled=${!first}>${first ? "A video" : "A video (none ready in your library)"}</option><option value="cutout">Cut out of the card (the picture shows)</option></select></label>
    ${selText.inside && html`<div class="row" style="gap:8px;align-items:flex-end">
      <label class="t-small grow" style="display:grid;gap:4px">Video<select class="input sm" id="text-inside-video" value=${selText.inside.videoId} onChange=${(e) => doOp({ inside: { videoId: e.target.value, from: 0 } })}>${videos.map((v) => html`<option key=${v.id} value=${v.id}>${v.name}</option>`)}${!videos.some((v) => v.id === selText.inside.videoId) && html`<option value=${selText.inside.videoId}>${selText.inside.videoId}</option>`}</select></label>
      <label class="t-small" style="display:grid;gap:4px;width:84px">From (s)<input class="input sm" id="text-inside-from" type="number" min="0" step="0.1" value=${selText.inside.from ?? 0} onChange=${(e) => doOp({ inside: { videoId: selText.inside.videoId, from: Math.max(0, +e.target.value || 0) } })} /></label></div>`}
  </div>`;
}

// The Text tab: the caption style and the text layers (title cards, callouts).
// part: "captions" (the caption style, for the Captions tool), "text" (add and list text layers, for the Text tool),
// "selected" (the selected text's own settings, for the inspector), "all" (everything, as before).
function TextTab({ timeline, aspect, captionRules, textClips, selText, onSelect, at, dur, doOp, H, liveOp, videos = [], objects = [], part = "all" }) {
  const style = captionStyleOf(timeline, aspect, captionRules);
  const cap = (patch) => ({ op: "set_caption_style", ...patch });
  const [draft, setDraft] = useState(selText?.text || "");
  useEffect(() => { setDraft(selText?.text || ""); }, [selText?.id]);
  const txt = (patch) => ({ op: "set_text", clipId: selText.id, ...patch });
  const showCap = part === "all" || part === "captions", showText = part === "all" || part === "text", showEdit = part === "all" || part === "selected";
  if (part === "selected" && !selText) return null;
  return html`<div class="pb" id=${part === "selected" ? "text-inspector" : "text-panel"} style="padding-top:16px"><div class="col" style="gap:16px">
    ${showCap && html`<div class="col" style="gap:10px">
      <div class="row between"><b class="t-label">Captions</b><label class="t-small row" style="gap:6px"><input type="checkbox" id="captions-on" checked=${timeline.captionsOn} onChange=${(e) => doOp({ op: "set_captions", on: e.target.checked })} />On</label></div>
      <label class="t-small" style="display:grid;gap:4px">Start from<select class="input sm" id="caption-look" value=${timeline.captionStyle ? "own" : timeline.captionLook} onChange=${(e) => e.target.value !== "own" && doOp({ op: "set_captions", on: timeline.captionsOn, look: e.target.value })}>${timeline.captionStyle && html`<option value="own">Own style</option>`}${["clean", "bold", "outline"].map((l) => html`<option key=${l} value=${l}>${l[0].toUpperCase() + l.slice(1)} look</option>`)}</select></label>
      <${StyleControls} kind="caption" idp="cap" style=${style} opFor=${cap} doOp=${doOp} H=${H} liveOp=${liveOp} />
    </div>`}
    <div class="col" style="gap:10px" id=${showText ? "text-layers" : "text-selected"}>
      ${showText && html`<div class="row between" style="flex-wrap:wrap;gap:4px 8px"><b class="t-label">Text layers</b><span class="row" style="gap:4px;flex-wrap:wrap">${TEXT_PRESETS.map((p) => html`<${Btn} key=${p} kind="ghost" size="xs" id=${"add-text-" + p} onClick=${() => { const had = new Set(textClips.map((c) => c.id)); const r = doOp({ op: "add_text", text: p === "title" ? "Your title" : p === "callout" ? "Look here" : p === "lower-third" ? "Name, role" : "Text", start: Math.max(0, Math.min(at, dur - 0.5)), end: Math.min(dur, at + 3), edit: true, preset: p }); const made = r && r.state.tracks.v3.find((c) => c.kind === "text" && !had.has(c.id)); if (made) onSelect(made.id); }}>+ ${p}<//>`)}</span></div>
      ${textClips.length === 0 ? html`<p class="t-small muted">No text layers. Add one at the playhead, or select a text clip on V3.</p>`
        : html`<div class="col" style="gap:4px">${textClips.map((c) => html`<button key=${c.id} class=${"tlist" + (selText?.id === c.id ? " on" : "")} data-text-clip=${c.id} onClick=${() => onSelect(c.id)}><span class="mono t-small muted">${fmtTime(c.start)}</span> ${c.text.split("\n")[0]}</button>`)}</div>`}`}
      ${showEdit && selText && html`<div class="col card flat" style="gap:8px;padding:12px" id="text-edit">
        <textarea class="input" id="text-content" rows="2" value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${() => draft.trim() && draft !== selText.text && doOp(txt({ text: draft }), false)} />
        <div class="row" style="gap:4px">${TEXT_PRESETS.map((p) => html`<${Btn} key=${p} kind="ghost" size="xs" onClick=${() => doOp(txt({ preset: p }), false)}>${p}<//>`)}</div>
        <${StyleControls} kind="text" idp="txt" style=${selText.style || textPreset("plain").style} card=${selText.card} anim=${selText.anim || "fade"} opFor=${txt} doOp=${doOp} H=${H} liveOp=${liveOp} />
        <label class="t-small row" style="gap:6px" title="The person is drawn over it from an AI matte of the footage (people only), like a title behind the speaker"><input type="checkbox" id="text-behind" checked=${!!selText.behind} onChange=${(e) => doOp(txt({ behind: e.target.checked }))} />Behind the person</label>
        <${InsideControls} selText=${selText} videos=${videos} doOp=${(op) => doOp(txt(op))} />
        ${(objects.length > 0 || selText.pin) && html`<div class="col" style="gap:4px" id="text-pin">
          <label class="t-small" style="display:grid;gap:4px" title="It moves with the object (tracked in the Color tab), keeping where it is against it now">Pin to a tracked object<select class="input sm" id="text-pin-object" value=${selText.pin ? selText.pin.clipId + "|" + selText.pin.object : ""} onChange=${(e) => { const [clipId, object] = e.target.value.split("|"); doOp(e.target.value ? { op: "pin_layer", clipId: selText.id, to: { clipId, object } } : { op: "pin_layer", clipId: selText.id, off: true }); }}>
            <option value="">Not pinned</option>${objects.map((o) => html`<option key=${o.clipId + o.id} value=${o.clipId + "|" + o.id}>${(o.label || o.id) + " (" + o.clipName + ")"}</option>`)}</select></label>
          ${selText.pin && html`<label class="t-small row" style="gap:6px"><input type="checkbox" id="text-pin-scale" checked=${!!selText.pin.scale} onChange=${(e) => doOp({ op: "pin_layer", clipId: selText.id, scale: e.target.checked })} />Grow and shrink with it</label>`}</div>`}
        <${Btn} kind="ghost" size="xs" icon="trash" onClick=${() => doOp({ op: "delete_clip", track: "v3", clipId: selText.id })}>Remove this text<//>
      </div>`}
    </div>
    ${part !== "selected" && html`<p class="t-small muted" id="text-note">Captions and text are drawn here exactly as the render lays them out: same fonts, same lines, same sizes.</p>`}
  </div></div>`;
}

export { TextTab };
