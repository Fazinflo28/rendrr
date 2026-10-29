// Phase 7: the Export window before a final. Shape, resolution, codec and (for HDR footage) HDR; the frame rate is the
// footage's and is shown, not chosen. Every control sends the connector's own op (set_aspect, set_export), so the
// choice is part of the edit, undoable, and what the AI sees in get_project.
import { html, Btn, Modal } from "./ui";
import { outputRate, outputSize, rateText } from "@rendrr/shared/renderPlan";

const SHAPES = [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"], ["4:5", "4:5"]];
const SIZES = [["720p", "720p"], ["1080p", "1080p"], ["4k", "4K"]];
const CODECS = [["h264", "H.264"], ["hevc", "HEVC"]];

function Seg({ id, value, options, onPick }) {
  return html`<div class="seg sm" role="group" id=${id}>${options.map(([v, label]) => html`<button key=${v} type="button" class=${value === v ? "on" : ""} aria-pressed=${value === v} data-v=${v} onClick=${() => value !== v && onPick(v)}>${label}</button>`)}</div>`;
}

/** What the final will be, in one line: "1920x1080 · H.264 · 29.97 fps, kept from your footage". */
export function exportSummary(snap, video) {
  const ex = snap.timeline.export || {};
  const { width, height } = outputSize(snap.aspect, "final", ex.resolution);
  const hdr = !!video?.hdr && (ex.hdr || "keep") === "keep";
  const r = video?.fps ? outputRate("final", video.fps) : null;
  const short = Math.min(video?.width || 0, video?.height || 0);
  return [
    `${width}x${height}`,
    hdr ? "HEVC 10-bit HDR" : ex.codec === "hevc" ? "HEVC" : "H.264",
    !r ? "your footage's frame rate" : r.capped ? `60 fps (your footage is ${rateText(video.fps)})` : `${rateText(r.fps)} fps, kept from your footage`,
    short && Math.min(width, height) > short * 1.05 ? `scaled up from ${video.width}x${video.height}` : null,
  ].filter(Boolean).join(" · ");
}

export function ExportModal({ snap, video, doOp, onRender, onClose }) {
  const ex = snap.timeline.export || {};
  const hdrFootage = !!video?.hdr;
  const row = (label, child) => html`<div class="row between" style="gap:12px;align-items:center"><span class="t-label">${label}</span>${child}</div>`;
  return html`<${Modal} title="Export" sub="The final is made from your original at these settings." onClose=${onClose}>
    <div class="col" style="gap:14px" id="export-panel">
      ${row("Shape", html`<${Seg} id="export-aspect" value=${snap.aspect} options=${SHAPES} onPick=${(v) => doOp({ op: "set_aspect", aspect: v })} />`)}
      ${row("Resolution", html`<${Seg} id="export-res" value=${ex.resolution || "1080p"} options=${SIZES} onPick=${(v) => doOp({ op: "set_export", resolution: v })} />`)}
      ${row("Codec", hdrFootage && (ex.hdr || "keep") === "keep"
        ? html`<span class="t-small muted" id="export-codec-hdr">HEVC 10-bit (HDR kept)</span>`
        : html`<${Seg} id="export-codec" value=${ex.codec || "h264"} options=${CODECS} onPick=${(v) => doOp({ op: "set_export", codec: v })} />`)}
      ${hdrFootage && row("HDR", html`<${Seg} id="export-hdr" value=${ex.hdr || "keep"} options=${[["keep", "Keep HDR"], ["sdr", "Convert to SDR"]]} onPick=${(v) => doOp({ op: "set_export", hdr: v })} />`)}
      <p class="t-small muted" id="export-summary">${exportSummary(snap, video)}</p>
      <p class="t-small muted">${(ex.resolution === "4k" || ex.codec === "hevc") ? "4K and HEVC take longer to render; the window shows the time left." : "Frame rate: the final keeps your footage's. Previews are 30 fps."}</p>
      <div class="row"><${Btn} icon="film" id="export-render" onClick=${onRender}>Export final<//><${Btn} kind="ghost" onClick=${onClose}>Cancel<//></div>
    </div>
  <//>`;
}

/** "About 3 min left", "About 40 s left"; null: still estimating. */
export function timeLeft(sec) {
  if (sec == null) return "Estimating the time left…";
  if (sec < 60) return `About ${Math.max(5, Math.round(sec / 5) * 5)} s left`;
  if (sec < 3600) return `About ${Math.round(sec / 60)} min left`;
  return `About ${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, "0")} min left`;
}
