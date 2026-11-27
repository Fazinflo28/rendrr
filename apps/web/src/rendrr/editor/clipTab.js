// The Clip and Audio tools: a clip's framing, motion, speed and look, and its sound.
// Moved out of editor.js unchanged (audit #30): the editor imports it from here.
import { Btn, Icon, html, useState } from "../ui";
import { OpColor, OpSlider } from "../controls";
import { BLEND_MODES, CLEANUPS, CLEANUP_KNOBS, DIRS, EASES, KEY_PROPS, TRANSITIONS, VOICE_PRESETS, cleanupParams, keyTracks, motionAt, reverbSeconds, speedText } from "@rendrr/shared";
import { clamp, r2 } from "./common";
import { BLEND_NAME } from "./layers";
// The Clip tab (Phase 5): the selected clip's speed, the transition on the cut before it (V1) and its keyframes at the
// playhead (V1, b-roll, text, graphics). Every control sends the connector's own op: set_speed, freeze_frame,
// set_transition, set_keyframes.
const KEY_UI = [["x", "Across", -1, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["y", "Down", -1, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["scale", "Scale", 0.1, 3, 0.01, (v) => Math.round(v * 100) + "%"], ["rotation", "Rotation", -180, 180, 1, (v) => Math.round(v) + "°"], ["opacity", "Opacity", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"]];
const EASE_NAME = { linear: "Linear", in: "Ease in", out: "Ease out", "in-out": "Ease in and out" };
// After Effects keyframe types for the segment that leaves a key ("" keeps the plain easing below it).
const KEY_INTERP_UI = [["", "Plain (easing below)"], ["bezier", "Bezier (Easy Ease, influence)"], ["auto", "Auto bezier (smooth through)"], ["linear", "Linear"], ["hold", "Hold (jump at the next key)"]];
// Phase 12: the new transitions by their names in Premiere.
const TR_NAME = { flash: "Flash (overexposure)", push: "Push", wipe: "Wipe", iris: "Iris round", "cross-zoom": "Cross zoom", "film-dissolve": "Film dissolve", clock: "Clock wipe", "barn-door": "Barn doors", diamond: "Iris diamond", box: "Iris box", cross: "Iris cross", blinds: "Venetian blinds", checker: "Checker wipe", wedge: "Wedge wipe" };
// Phase 11: a clip's mirror, crop, rounded corners and drop shadow (V1 clips and b-roll; set_flip and set_card); Phase 17: a border.
function FrameLook({ clip, doOp, H, liveOp }) {
  const f = clip.flip || "", has = (a) => f === a || f === "both";
  const toggle = (a) => { const h = a === "h" ? !has("h") : has("h"), v = a === "v" ? !has("v") : has("v"); doOp({ op: "set_flip", clipIds: [clip.id], flip: h && v ? "both" : h ? "h" : v ? "v" : "none" }); };
  const card = clip.cardLook || {}, crop = card.crop || { left: 0, top: 0, right: 0, bottom: 0 };
  const cop = (patch) => ({ op: "set_card", clipIds: [clip.id], ...patch });
  const sl = { H, liveOp };
  const side = (k, label) => html`<div class="grow"><${OpSlider} id=${"crop-" + k} label=${label} value=${crop[k] || 0} min=${0} max=${0.45} step=${0.01} show=${(v) => Math.round(v * 100) + "%"} opFor=${(v) => cop({ crop: { ...crop, [k]: v } })} ...${sl} /></div>`;
  return html`<div class="col" style="gap:8px" id="frame-look">
    <div class="row between" style="align-items:center"><b class="t-label">Flip and crop</b>
      <span class="row" style="gap:4px"><${Btn} kind=${has("h") ? "primary" : "ghost"} size="xs" id="flip-h" aria-pressed=${has("h")} onClick=${() => toggle("h")}>Flip ↔<//><${Btn} kind=${has("v") ? "primary" : "ghost"} size="xs" id="flip-v" aria-pressed=${has("v")} onClick=${() => toggle("v")}>Flip ↕<//></span></div>
    <div class="row" style="gap:8px">${side("left", "Left")}${side("right", "Right")}</div>
    <div class="row" style="gap:8px">${side("top", "Top")}${side("bottom", "Bottom")}</div>
    <${OpSlider} id="card-radius" label="Rounded corners" value=${card.radius || 0} min=${0} max=${0.5} step=${0.01} show=${(v) => (v ? Math.round(v * 100) + "%" : "square")} opFor=${(v) => cop({ radius: v })} ...${sl} />
    <label class="t-small row" style="gap:6px"><input type="checkbox" id="card-shadow" checked=${!!card.shadow} onChange=${(e) => doOp(cop({ shadow: e.target.checked ? {} : null }))} />Drop shadow</label>
    ${card.shadow && html`<${OpSlider} id="card-shadow-opacity" label="Shadow strength" value=${card.shadow.opacity ?? 0.35} min=${0.05} max=${1} step=${0.05} show=${(v) => Math.round(v * 100) + "%"} opFor=${(v) => cop({ shadow: { ...card.shadow, opacity: v } })} ...${sl} />`}
    <label class="t-small row" style="gap:6px"><input type="checkbox" id="card-border" checked=${!!card.border} onChange=${(e) => doOp(cop({ border: e.target.checked ? { color: "#FFFFFF", width: 0.008 } : null }))} />Border</label>
    ${card.border && html`<div class="row" style="gap:8px;align-items:flex-end"><${OpColor} id="card-border-color" value=${card.border.color.toLowerCase()} opFor=${(c) => cop({ border: { ...card.border, color: c.toUpperCase() } })} ...${sl} />
      <div class="grow"><${OpSlider} id="card-border-width" label="Border width" value=${card.border.width} min=${0.001} max=${0.05} step=${0.001} show=${(v) => (v * 100).toFixed(1) + "%"} opFor=${(v) => cop({ border: { ...card.border, width: v } })} ...${sl} /></div></div>`}
    ${(card.crop || card.radius || card.shadow) && html`<span class="t-small muted">Cropped edges show what is under the clip.</span>`}
  </div>`;
}
function ClipTab({ clip, track, plan, first, at, srcAt, doOp, H, liveOp, onSeek }) {
  const [rampSpeed, setRampSpeed] = useState(2);
  const empty = html`<div class="pb" id="clip-panel" style="padding-top:16px"><p class="t-small muted">Select a clip on the timeline.</p></div>`;
  if (!clip) return empty;
  if (track === "v3" && clip.kind === "adjust") return html`<div class="pb" id="clip-panel" style="padding-top:16px"><p class="t-small muted" id="adjust-hint">Its grade and effects are in the Color tab.</p></div>`;
  const v1 = track === "v1" || track === "a1";
  const isBroll = track === "v2" && clip.kind === "broll";
  const keyable = v1 || isBroll || (track === "v3" && (clip.kind === "text" || clip.kind === "graphic"));
  if (!v1 && !keyable) return empty;
  const len = Math.max(0, clip.end - clip.start), local = r2(clamp(at - clip.start, 0, len));
  const keys = (v1 ? plan?.clipMotion?.[clip.id]?.keys : clip.keys) || [];
  const now = motionAt(keyTracks(keys), local);
  const here = keys.find((k) => Math.abs(k.t - local) < 0.02);
  const withKey = (patch) => [...keys.filter((k) => k !== here), { ...(here || { t: local }), ...patch }].sort((a, b) => a.t - b.t);
  const kop = (next) => ({ op: "set_keyframes", track: v1 ? "v1" : track, clipId: clip.id, keys: next });
  const sp = (patch) => ({ op: "set_speed", clipId: clip.id, ...patch });
  const tr = clip.transition, planned = plan?.transitions?.find((x) => x.clipId === clip.id);
  const trOp = (patch) => ({ op: "set_transition", clipId: clip.id, type: tr?.type || "dissolve", duration: tr?.duration, ...(tr?.dir ? { dir: tr.dir } : {}), ...patch });
  const sl = { H, liveOp };
  return html`<div class="pb" id="clip-panel" style="padding-top:16px"><div class="col" style="gap:16px">
    <div class="t-small muted" id="clip-name">${clip.label || clip.id} · ${len.toFixed(2)}s in the edit${v1 ? " · " + speedText(clip) : ""}</div>
    ${track === "v3" && (clip.kind === "text" || clip.kind === "graphic") && html`<label class="t-small row" style="gap:6px" title="The person is drawn over it from an AI matte of the footage (people only), like a title behind the speaker"><input type="checkbox" id="clip-behind" checked=${!!clip.behind} onChange=${(e) => doOp({ op: "behind_person", clipIds: [clip.id], off: !e.target.checked })} />Behind the person</label>`}
    ${((track === "v2" && clip.kind === "broll" && !clip.under) || (track === "v3" && clip.kind === "graphic")) && html`<div class="col" style="gap:8px" id="blend-panel">
      <div class="row between" style="align-items:flex-end"><b class="t-label">Blend</b>
        <select class="input sm" id="clip-blend" value=${clip.blend || "normal"} onChange=${(e) => doOp({ op: "set_blend", clipId: clip.id, blend: e.target.value })}>${BLEND_MODES.map((m) => html`<option key=${m} value=${m}>${BLEND_NAME[m]}</option>`)}</select></div>
      <${OpSlider} id="clip-opacity" label="Opacity" value=${clip.opacity ?? 1} min=${0} max=${1} step=${0.01} show=${(v) => Math.round(v * 100) + "%"} opFor=${(v) => ({ op: "set_blend", clipId: clip.id, opacity: v })} ...${sl} />
      <span class="t-small muted">Screen and Add for light leaks and glows; Multiply and Overlay for textures.</span></div>`}
    ${(v1 || isBroll) && html`<${FrameLook} clip=${clip} doOp=${doOp} H=${H} liveOp=${liveOp} />`}
    ${(v1 || (isBroll && clip.videoId)) && html`<div class="col" style="gap:8px" id="stabilize-panel">
      <div class="row between"><b class="t-label">Stabilize</b><label class="t-small row" style="gap:6px"><input type="checkbox" id="clip-stabilize" checked=${!!clip.stabilize} onChange=${(e) => doOp({ op: "stabilize", clipId: clip.id, ...(e.target.checked ? { smooth: 50 } : { off: true }) })} />Warp Stabilizer</label></div>
      ${clip.stabilize && html`<${OpSlider} id="clip-stabilize-smooth" label="Smoothness" value=${clip.stabilize.smooth} min=${5} max=${100} step=${5} show=${(v) => String(v)} opFor=${(v) => ({ op: "stabilize", clipId: clip.id, smooth: v })} ...${sl} />
        <span class="t-small muted" id="stabilize-note">Smoothed in the render${isBroll ? ", from the b-roll's own footage" : clip.speed && clip.speed !== 1 || clip.reverse || clip.ramp?.length || clip.freeze ? ", through its speed changes" : ""}: the picture zooms in a little to hide the edges. The player shows the footage as filmed.</span>`}</div>`}
    ${v1 && html`<div class="col" style="gap:10px" id="speed-panel">
      <b class="t-label">Speed</b>
      ${clip.freeze ? html`<${OpSlider} id="freeze-len" label="Freeze length" value=${clip.freeze} min=${0.1} max=${10} step=${0.1} show=${(v) => v + " s"} opFor=${(x) => sp({ freeze: x })} ...${sl} />`
        : html`<${OpSlider} id="clip-speed" label="Speed" value=${clip.speed || 1} min=${0.1} max=${4} step=${0.05} show=${(v) => v + "x"} opFor=${(x) => sp({ speed: x })} disabled=${!!clip.ramp?.length} ...${sl} />
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="t-small row" style="gap:6px"><input type="checkbox" id="clip-reverse" checked=${!!clip.reverse} onChange=${(e) => doOp(sp({ reverse: e.target.checked }))} />Reverse</label>
          ${(clip.speed && clip.speed !== 1) || clip.reverse || clip.ramp?.length ? html`<${Btn} kind="ghost" size="xs" id="speed-normal" onClick=${() => doOp(sp({ speed: 1, reverse: false, ramp: null }))}>Normal speed<//>` : null}
          <${Btn} kind="ghost" size="xs" id="freeze-here" icon="pause" onClick=${() => doOp({ op: "freeze_frame", clipId: clip.id, at: r2(at), edit: true, length: 1 })}>Freeze this frame (1 s)<//>
        </div>
        <div class="col" style="gap:6px" id="ramp">
          <span class="t-small">Speed ramp${clip.ramp?.length ? ": " + clip.ramp.map((p) => p.speed + "x").join(" → ") : ""}</span>
          <div class="row" style="gap:6px;align-items:center"><input class="input sm" id="ramp-speed" type="number" min="0.1" max="10" step="0.1" value=${rampSpeed} onInput=${(e) => setRampSpeed(+e.target.value || 1)} style="width:72px" />
            <${Btn} kind="ghost" size="xs" id="ramp-add" onClick=${() => { const src = r2(srcAt(clip.id, at)); const pts = clip.ramp?.length ? clip.ramp.filter((p) => Math.abs(p.at - src) > 0.01) : [{ at: clip.sourceIn, speed: clip.speed || 1 }]; doOp(sp({ ramp: [...pts, { at: src, speed: rampSpeed }].sort((a, b) => a.at - b.at) })); }}>Ramp to this speed here<//>
            ${clip.ramp?.length ? html`<${Btn} kind="ghost" size="xs" id="ramp-off" onClick=${() => doOp(sp({ ramp: null }))}>No ramp<//>` : null}</div>
          ${clip.ramp?.length > 1 && html`<label class="t-small" style="display:grid;gap:4px">Ramp easing<select class="input sm" id="ramp-ease" value=${Array.isArray(clip.ramp[0].ease) ? "linear" : clip.ramp[0].ease || "linear"} onChange=${(e) => doOp(sp({ ramp: clip.ramp.map((p) => (e.target.value === "linear" ? { at: p.at, speed: p.speed } : { ...p, ease: e.target.value })) }))}>${EASES.map((x) => html`<option key=${x} value=${x}>${EASE_NAME[x]}</option>`)}</select></label>`}
        </div>
        <label class="t-small" style="display:grid;gap:4px">Slow motion frames<select class="input sm" id="clip-interp" value=${clip.interp || "frames"} onChange=${(e) => doOp(sp({ interp: e.target.value }))}>
          <option value="frames">Frame sampling (each frame held)</option><option value="blend">Frame blending</option><option value="flow">Optical flow (smooth)</option></select></label>
        ${clip.interp && clip.interp !== "frames" && html`<span class="t-small muted" id="interp-note">The render makes the in-between frames where the clip plays slower than 1x; the player holds frames.</span>`}`}
      <p class="t-small muted">Sound keeps its pitch from 0.5x to 4x. Reversed, frozen and outside that range the clip is silent, here and in the render.</p>
    </div>`}
    ${v1 && html`<div class="col" style="gap:10px" id="transition-panel">
      <b class="t-label">Transition into this clip</b>
      ${first ? html`<p class="t-small muted">The first clip: a dissolve or a dip fades it in from the colour.</p>` : null}
      <label class="t-small" style="display:grid;gap:4px">Type<select class="input sm" id="transition-type" value=${tr?.type || "cut"} onChange=${(e) => doOp(trOp({ type: e.target.value }))}>${TRANSITIONS.map((t) => html`<option key=${t} value=${t}>${t === "cut" ? "Cut" : t === "dip-black" ? "Dip to black" : t === "dip-white" ? "Dip to white" : t === "morph" ? "Morph Cut (jump cuts)" : TR_NAME[t] || t[0].toUpperCase() + t.slice(1)}</option>`)}</select></label>
      ${tr && html`<${OpSlider} id="transition-duration" label="Duration" value=${tr.duration} min=${0.1} max=${2} step=${0.05} show=${(v) => v + " s"} opFor=${(x) => trOp({ duration: x })} ...${sl} />`}
      ${tr && ["whip", "slide", "push", "wipe", "barn-door", "blinds"].includes(tr.type) && html`<label class="t-small" style="display:grid;gap:4px">Direction<select class="input sm" id="transition-dir" value=${tr.dir || "left"} onChange=${(e) => doOp(trOp({ dir: e.target.value }), false)}>${DIRS.map((d) => html`<option key=${d} value=${d}>${d}</option>`)}</select></label>`}
      ${tr?.type === "morph" && html`<label class="t-small row" style="gap:6px" title="Rendrr finds the face in the frames either side of the cut and slides and scales the head into place while the room dissolves. Off: a plain morph of the whole picture."><input type="checkbox" id="transition-face" checked=${tr.face !== false} onChange=${(e) => doOp(trOp({ face: e.target.checked }), false)} />Follow the face (slides the head into place; drawn in the render)</label>`}
      ${planned?.note && html`<p class="t-small" id="transition-note" style="color:var(--warn, #b45309)">${planned.end > planned.start ? `Plays ${(planned.end - planned.start).toFixed(2)} s: ` : ""}${planned.note}</p>`}
    </div>`}
    ${keyable && html`<div class="col" style="gap:10px" id="keys-panel">
      <div class="row between"><b class="t-label">Keyframes</b><span class="t-small muted mono">${here ? "key at " : "at "}${local.toFixed(2)}s</span></div>
      ${KEY_UI.map(([p, label, min, max, step, show]) => html`<${OpSlider} key=${p} id=${"key-" + p} label=${label} value=${Math.round(now[p] / step) * step} min=${min} max=${max} step=${step} show=${show} opFor=${(x) => kop(withKey({ [p]: x }))} ...${sl} />`)}
      ${html`<div class="row" style="gap:12px;align-items:flex-end;flex-wrap:wrap" id="anchor-row">
        <div class="col" style="gap:4px"><span class="t-small">Anchor point${clip.kind === "text" ? " (of the text)" : ""}</span><div class="anchor-grid" role="radiogroup" aria-label="Anchor point">${[0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => {
          // Phase 17: a text layer's anchor is a point of its text; without one it turns about its alignment point.
          const home = clip.kind === "text" ? { x: clip.style?.align === "left" ? 0 : clip.style?.align === "right" ? 1 : 0.5, y: 0.5 } : { x: 0.5, y: 0.5 };
          const a = clip.anchor || home, on = Math.abs(a.x - x) < 0.01 && Math.abs(a.y - y) < 0.01;
          return html`<button key=${x + "," + y} role="radio" aria-checked=${on} class=${on ? "on" : ""} data-anchor=${x + "," + y} title=${`Turn and scale about ${y === 0 ? "the top" : y === 1 ? "the bottom" : "the middle"}${x === 0.5 ? "" : x === 0 ? " left" : " right"}`} onClick=${() => doOp({ op: "set_keyframes", track: v1 ? "v1" : track, clipId: clip.id, anchor: x === home.x && y === home.y ? null : { x, y } }, false)} />`; }))}</div></div>
        <div class="grow" style="min-width:140px"><${OpSlider} id="motion-blur" label="Motion blur" value=${clip.motionBlur || 0} min=${0} max=${100} step=${5} show=${(v) => (v ? v + (v === 50 ? " (180° shutter)" : "") : "off")} opFor=${(x) => ({ op: "set_keyframes", track: v1 ? "v1" : track, clipId: clip.id, motionBlur: x })} ...${sl} /></div></div>
        ${(clip.motionBlur || 0) > 0 && html`<span class="t-small muted">Motion blur is drawn in the render, on the keyframed movement.</span>`}`}
      ${here && html`<label class="t-small" style="display:grid;gap:4px">Keyframe type<select class="input sm" id="key-interp" value=${here.interp || ""} onChange=${(e) => doOp(kop(withKey({ interp: e.target.value || undefined })), false)}>${KEY_INTERP_UI.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></label>`}
      ${here && !here.interp && html`<label class="t-small" style="display:grid;gap:4px">Easing to the next key<select class="input sm" id="key-ease" value=${Array.isArray(here.ease) ? "linear" : here.ease || "linear"} onChange=${(e) => doOp(kop(withKey({ ease: e.target.value })), false)}>${EASES.map((x) => html`<option key=${x} value=${x}>${EASE_NAME[x]}</option>`)}</select></label>`}
      ${here && (here.interp === "bezier" || here.easeIn || here.easeOut) && html`<div class="col" style="gap:6px" id="key-handles">
        <${OpSlider} id="key-in-influence" label="Ease in (influence)" value=${here.easeIn?.influence ?? 33} min=${1} max=${100} step=${1} show=${(v) => v + "%"} opFor=${(x) => kop(withKey({ easeIn: { influence: x, speed: here.easeIn?.speed ?? 0 } }))} ...${sl} />
        <${OpSlider} id="key-out-influence" label="Ease out (influence)" value=${here.easeOut?.influence ?? 33} min=${1} max=${100} step=${1} show=${(v) => v + "%"} opFor=${(x) => kop(withKey({ easeOut: { influence: x, speed: here.easeOut?.speed ?? 0 } }))} ...${sl} />
        <span class="t-small muted">As in After Effects: 33% is Easy Ease; 70-90% gives a long, soft start or settle.</span></div>`}
      ${keys.length ? html`<div class="col" style="gap:4px" id="key-list">${keys.map((k, i) => html`<div key=${i} class="row between tlist${here === k ? " on" : ""}"><button class="t-small" style="all:unset;cursor:pointer" data-key=${i} onClick=${() => onSeek(clip.start + k.t)}><span class="mono">${k.t.toFixed(2)}s</span> ${KEY_PROPS.filter((p) => k[p] != null).join(", ")}${k.interp ? ` · ${k.interp}` : k.ease && k.ease !== "linear" ? ` · ${Array.isArray(k.ease) ? "bezier" : k.ease}` : ""}</button><button class="btn icon sm quiet" aria-label="Remove this key" onClick=${() => doOp(kop(keys.filter((x) => x !== k)), false)}><${Icon} name="x" size="12" /></button></div>`)}
        <${Btn} kind="ghost" size="xs" id="keys-clear" onClick=${() => doOp(kop([]))}>Remove all keyframes<//></div>` : html`<p class="t-small muted">Move a slider to set a key at the playhead.</p>`}
    </div>`}
  </div></div>`;
}


// The cleanup values the Audio tab can set by hand: key, label, range, step, unit.
// Studio voice: the AI's noise and room removal and echo removal (made on the first render, kept), leveling and crispness.
const FINE = [["enhance", "AI noise removal", 0, 100, 5, ""], ["dereverb", "Echo removal", 0, 100, 5, ""], ["level", "Leveling (even volume)", 0, 100, 5, ""], ["crisp", "Crispness", 0, 100, 5, ""],
  ["highpass", "Rumble cut (high-pass)", 0, 300, 10, " Hz"], ["denoise", "Plain noise reduction", 0, 40, 1, " dB"], ["presence", "Presence", -8, 8, 0.5, " dB"], ["deess", "De-esser", 0, 1, 0.05, ""], ["compress", "Compression", 1, 10, 0.5, ":1"]];
const CLEANUP_NAME = Object.fromEntries(VOICE_PRESETS.map((v) => [v.id, v.name]));
const LOUDNESS = [[-14, "-14 LUFS (online)"], [-16, "-16 LUFS (podcast)"], [-23, "-23 LUFS (broadcast)"]];
const dB = (x) => (x > 0 ? "+" : "") + (Math.round(x * 10) / 10) + " dB";
// Phase 6: a clip's own sound: pan, a three-band EQ, reverb and volume keys (set_clip_audio). V1 clips keep them as
// audioPan, audioEq, audioReverb, audioKeys; music and sound effects as pan, eq, reverb, gainKeys.
function ClipSound({ clip, v1, len, here, gain, clipOp, doOp, sl }) {
  const pan = (v1 ? clip.audioPan : clip.pan) || 0, eq = (v1 ? clip.audioEq : clip.eq) || {}, rv = v1 ? clip.audioReverb : clip.reverb, keys = (v1 ? clip.audioKeys : clip.gainKeys) || [];
  const db = (x) => (x > 0 ? "+" : "") + x + " dB";
  const setKeys = (ks) => clipOp("keys")(ks.length ? ks : null);
  const t = Math.round(here * 100) / 100, near = keys.findIndex((k) => Math.abs(k.t - t) < 0.05);
  return html`<div class="col" style="gap:10px" id="clip-sound">
    <${OpSlider} id="clip-pan" label="Pan" value=${pan} min=${-1} max=${1} step=${0.05} show=${(x) => (!x ? "centre" : (x < 0 ? "L " : "R ") + Math.round(Math.abs(x) * 100) + "%")} opFor=${(x) => clipOp("pan")(x || null)} ...${sl} />
    <div class="col" style="gap:4px" id="clip-eq"><span class="t-small muted">EQ</span>
      <div class="row" style="gap:8px">${[["low", "Low"], ["mid", "Mid"], ["high", "High"]].map(([k, l]) => html`<div key=${k} class="grow"><${OpSlider} id=${"clip-eq-" + k} label=${l} value=${eq[k] || 0} min=${-12} max=${12} step=${0.5} show=${db} opFor=${(x) => clipOp("eq")({ [k]: x })} ...${sl} /></div>`)}</div>
      ${(eq.bands || []).map((b, i) => { const setB = (patch) => clipOp("eq")({ bands: eq.bands.map((q, j) => (j === i ? { ...q, ...patch } : q)) }); return html`<div key=${i} class="card flat col" style="gap:4px;padding:8px" data-eq-band=${i}>
        <div class="row between"><span class="t-small">Band ${i + 1}</span><button class="btn icon sm quiet" aria-label="Remove this band" id=${"clip-eq-band-del-" + i} onClick=${() => doOp(clipOp("eq")({ bands: eq.bands.filter((_, j) => j !== i) }), false)}><${Icon} name="x" size="12" /></button></div>
        <div class="row" style="gap:8px"><div class="grow"><${OpSlider} id=${"clip-eq-band-f-" + i} label="Frequency" value=${Math.log10(b.f)} min=${Math.log10(20)} max=${Math.log10(20000)} step=${0.01} show=${(x) => { const f = Math.pow(10, x); return f >= 1000 ? (f / 1000).toFixed(1) + " kHz" : Math.round(f) + " Hz"; }} opFor=${(x) => setB({ f: Math.round(Math.pow(10, x)) })} ...${sl} /></div>
          <div class="grow"><${OpSlider} id=${"clip-eq-band-g-" + i} label="Gain" value=${b.gain} min=${-20} max=${20} step=${0.5} show=${db} opFor=${(x) => setB({ gain: x })} ...${sl} /></div>
          <div style="width:72px"><${OpSlider} id=${"clip-eq-band-q-" + i} label="Q" value=${b.q ?? 1} min=${0.3} max=${12} step=${0.1} show=${(x) => x.toFixed(1)} opFor=${(x) => setB({ q: x })} ...${sl} /></div></div></div>`; })}
      ${(eq.bands || []).length < 4 && html`<${Btn} kind="ghost" size="xs" id="clip-eq-band-add" onClick=${() => doOp(clipOp("eq")({ bands: [...(eq.bands || []), { f: 3000, gain: -3, q: 1.4 }] }))}>+ Parametric band<//>`}</div>
    <div class="row" style="gap:8px" id="clip-reverb">
      <div class="grow"><${OpSlider} id="clip-reverb-amount" label="Reverb" value=${rv?.amount || 0} min=${0} max=${100} step=${1} show=${(x) => (x ? String(x) : "off")} opFor=${(x) => clipOp("reverb")(x ? { amount: x, size: rv?.size ?? 40 } : null)} ...${sl} /></div>
      <div class="grow"><${OpSlider} id="clip-reverb-size" label="Room" value=${rv?.size ?? 40} min=${0} max=${100} step=${1} disabled=${!rv?.amount} show=${(x) => reverbSeconds(x).toFixed(1) + " s"} opFor=${(x) => clipOp("reverb")({ amount: rv?.amount || 30, size: x })} ...${sl} /></div></div>
    <div class="col" style="gap:6px" id="clip-keys"><div class="row between"><span class="t-small muted">Volume keys</span>
      <${Btn} kind="ghost" size="xs" id="clip-key-add" disabled=${near >= 0 || len <= 0} onClick=${() => doOp(setKeys([...keys, { t, gainDb: 0 }].sort((x, y) => x.t - y.t)))}>+ Key at ${t.toFixed(2)}s<//></div>
      ${keys.length ? keys.map((k, i) => html`<div key=${i} class="row" style="gap:6px;align-items:flex-end" data-key=${i}>
          <div class="grow"><${OpSlider} id=${"clip-key-" + i} label=${k.t.toFixed(2) + " s"} value=${k.gainDb} min=${-40} max=${12} step=${0.5} show=${db} opFor=${(x) => setKeys(keys.map((q, j) => (j === i ? { ...q, gainDb: x } : q)))} ...${sl} /></div>
          <button class="btn icon sm quiet" aria-label="Remove this key" id=${"clip-key-del-" + i} onClick=${() => doOp(setKeys(keys.filter((_, j) => j !== i)), false)}><${Icon} name="x" size="12" /></button></div>`)
        : html`<p class="t-small muted">Keys change the level over the clip (on top of its level), in a straight line between them.</p>`}</div>
  </div>`;
}

// The Audio tab: the whole edit's sound (set_audio) and the selected clip's level and fades (set_clip_audio).
// part: "edit" (the whole edit's sound, for the Audio tool), "clip" (the selected clip's level, fades and filters, for
// the inspector), "all" (both).
function AudioTab({ a, clip, track, len, here = 0, planned, doOp, H, liveOp, voice, part = "all" }) {
  const loud = a.loudness == null ? "off" : String(a.loudness);
  const loudOpts = LOUDNESS.some(([v]) => v === a.loudness) || a.loudness == null ? LOUDNESS : [...LOUDNESS, [a.loudness, a.loudness + " LUFS"]];
  const v1 = track === "v1" || track === "a1";
  const gain = clip ? (v1 ? clip.audioGain ?? 0 : clip.gainDb ?? (track === "a2" ? -18 : -6)) : 0;
  // A music fade the clip does not set is automatic: show what renders (the plan's), marked "auto".
  const fi = clip ? (v1 ? clip.audioFadeIn : clip.fadeIn ?? planned?.fadeIn) ?? 0 : 0, fo = clip ? (v1 ? clip.audioFadeOut : clip.fadeOut ?? planned?.fadeOut) ?? 0 : 0;
  const autoIn = !!clip && !v1 && clip.fadeIn == null && !!planned?.fadeIn, autoOut = !!clip && !v1 && clip.fadeOut == null && !!planned?.fadeOut;
  const fadeMax = Math.max(0.1, Math.min(10, Math.floor(len * 10) / 10));
  const clipOp = (k) => (x) => ({ op: "set_clip_audio", track: v1 ? "v1" : track, clipId: clip.id, [k]: x });
  const sl = { H, liveOp };
  const showEdit = part !== "clip", showClip = part !== "edit";
  if (part === "clip" && !clip) return null;
  return html`<div class="pb" id=${part === "clip" ? "audio-inspector" : "audio-panel"} style="padding-top:16px"><div class="col" style="gap:16px">
    ${showEdit && voice && html`<div class="card flat col" id="voice-file" style="gap:8px;padding:12px"><b class="t-label">Your voice file</b><p class="t-small muted">${voice.name ? `"${voice.name}"` : "Your audio file"} plays in place of every clip's own sound${voice.start ? ` from ${voice.start}s` : ""}. Cuts made after it was set are not in the file.</p><div class="row"><${Btn} kind="secondary" size="sm" id="voice-off" onClick=${() => doOp({ op: "set_voice", soundId: null })}>Use the clips' sound<//></div></div>`}
    ${showEdit && html`<div class="col" style="gap:10px">
      <b class="t-label">Whole edit</b>
      <div class="col" style="gap:6px" id="voice-presets"><span class="t-small">Voice preset <span class="muted">(Essential Sound)</span></span>
        <div class="presets" role="radiogroup" aria-label="Voice preset">${VOICE_PRESETS.map((v) => html`<button key=${v.id} role="radio" aria-checked=${a.cleanup === v.id} class=${"preset" + (a.cleanup === v.id ? " on" : "")} data-preset=${v.id} title=${v.what} onClick=${() => doOp({ op: "set_audio", cleanup: v.id })}><b>${v.name}</b><span>${v.what}</span></button>`)}</div>
        <select class="input sm hide" id="audio-cleanup" aria-hidden="true" tabindex="-1" value=${a.cleanup} onChange=${(e) => doOp({ op: "set_audio", cleanup: e.target.value })}>${CLEANUPS.map((c) => html`<option key=${c} value=${c}>${CLEANUP_NAME[c]}</option>`)}</select></div>
      <div class="row" style="gap:8px">
        <label class="t-small grow" style="display:grid;gap:4px">Loudness<select class="input sm" id="audio-loudness" value=${loud} onChange=${(e) => doOp({ op: "set_audio", loudness: e.target.value === "off" ? null : +e.target.value })}>${loudOpts.map(([v, l]) => html`<option key=${v} value=${String(v)}>${l}</option>`)}<option value="off">Off (limiter only)</option></select></label>
        <label class="t-small grow" style="display:grid;gap:4px">True-peak ceiling<select class="input sm" id="audio-peak" value=${String(a.peak)} disabled=${a.loudness == null} onChange=${(e) => doOp({ op: "set_audio", peak: +e.target.value })}>${Array.from(new Set([-1, -1.5, -2, a.peak])).map((v) => html`<option key=${v} value=${String(v)}>${v} dBTP</option>`)}</select></label>
      </div>
      <details class="fine" id="audio-fine"><summary class="t-small">Fine-tune the cleanup${CLEANUP_KNOBS.some((k) => a[k] != null) ? " (hand-set)" : ""}</summary>
        <div class="col" style="gap:8px;padding-top:8px">
          ${FINE.map(([k, l, lo, hi, st, unit]) => html`<${OpSlider} key=${k} id=${"audio-" + k} label=${l} value=${cleanupParams(a)[k]} min=${lo} max=${hi} step=${st} show=${(x) => (x === lo && k !== "deess" ? "off" : x + unit) + (a[k] == null ? " (preset)" : "")} opFor=${(x) => ({ op: "set_audio", [k]: x })} ...${sl} />`)}
          <${OpSlider} id="audio-declick" label="Fade at every cut" value=${Math.round(a.declick * 1000)} min=${0} max=${30} step=${1} show=${(x) => (x ? x + " ms" : "off")} opFor=${(x) => ({ op: "set_audio", declick: x / 1000 })} ...${sl} />
          <${OpSlider} id="audio-crossfade" label="Crossfade at every cut" value=${Math.round((a.crossfade || 0) * 1000)} min=${0} max=${200} step=${5} show=${(x) => (x ? x + " ms (in the render)" : "off")} opFor=${(x) => ({ op: "set_audio", crossfade: x / 1000 })} ...${sl} />
          ${CLEANUP_KNOBS.some((k) => a[k] != null) && html`<${Btn} kind="ghost" size="xs" id="audio-fine-reset" onClick=${() => doOp({ op: "set_audio", ...Object.fromEntries(CLEANUP_KNOBS.map((k) => [k, null])) })}>Back to the preset's values<//>`}
        </div></details>
      <${OpSlider} id="audio-duck" label="Music under speech" value=${a.duck} min=${0} max=${24} step=${1} show=${(x) => (x ? x + " dB down" : "not ducked")} opFor=${(x) => ({ op: "set_audio", duck: x })} ...${sl} />
      <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id="audio-fade-in" label="Fade in" value=${a.fadeIn} min=${0} max=${5} step=${0.1} show=${(x) => x + " s"} opFor=${(x) => ({ op: "set_audio", fadeIn: x })} ...${sl} /></div>
        <div class="grow"><${OpSlider} id="audio-fade-out" label="Fade out" value=${a.fadeOut} min=${0} max=${5} step=${0.1} show=${(x) => x + " s"} opFor=${(x) => ({ op: "set_audio", fadeOut: x })} ...${sl} /></div></div>
    </div>`}
    ${showClip && html`<div class="col" style="gap:10px" id="audio-clip">
      <b class="t-label">${clip ? (v1 ? "Dialogue of " + (clip.label || "this clip") : clip.label || "This clip") : "Selected clip"}</b>
      ${clip ? html`<${OpSlider} id="clip-gain" label="Level" value=${gain} min=${v1 ? -24 : -40} max=${12} step=${0.5} show=${dB} opFor=${clipOp("gainDb")} ...${sl} />
        <div class="row" style="gap:12px"><div class="grow"><${OpSlider} id="clip-fade-in" label="Fade in" value=${fi} min=${0} max=${fadeMax} step=${0.1} show=${(x) => x + " s" + (autoIn && x === fi ? " auto" : "")} opFor=${clipOp("fadeIn")} ...${sl} /></div>
          <div class="grow"><${OpSlider} id="clip-fade-out" label="Fade out" value=${fo} min=${0} max=${fadeMax} step=${0.1} show=${(x) => x + " s" + (autoOut && x === fo ? " auto" : "")} opFor=${clipOp("fadeOut")} ...${sl} /></div></div>
        <${ClipSound} clip=${clip} v1=${v1} len=${len} here=${here} gain=${gain} clipOp=${clipOp} doOp=${doOp} sl=${sl} />`
        : html`<p class="t-small muted">Select a clip on V1, A1, A2 or A3 to set its level and fades.</p>`}
    </div>`}
    ${showEdit && html`<p class="t-small muted" id="audio-note">Cleanup and loudness are heard in the rendered preview.${cleanupParams(a).enhance || cleanupParams(a).dereverb ? " The AI noise and echo removal is made on the first render (about a tenth of the footage's length) and kept for the next ones." : ""}</p>`}
  </div></div>`;
}

export { AudioTab, ClipTab, dB };
