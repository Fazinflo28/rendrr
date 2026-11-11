// Phase 7: the Export window before a final. Shape, resolution, codec and (for HDR footage) HDR; the frame rate is the
// footage's and is shown, not chosen. Every control sends the connector's own op (set_aspect, set_export), so the
// choice is part of the edit, undoable, and what the AI sees in get_project.
import { html, Btn, Modal, useState, useEffect } from "./ui";
import { api } from "./api";
import { outputRate, outputSize, rateText } from "@rendrr/shared/renderPlan";
import { ASPECT_RATIO, chapterProblems, chaptersText, srtText, vttText } from "@rendrr/shared";

const SHAPES = [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"], ["4:5", "4:5"]];
const SIZES = [["720p", "720p"], ["1080p", "1080p"], ["4k", "4K"]];
const CODECS = [["h264", "H.264"], ["hevc", "HEVC"]];
// Phase 12: what the final is made as; its frame rate.
const FORMATS = [["mp4", "MP4 video"], ["gif", "GIF (up to 10 min)"], ["audio", "Sound only (.m4a)"], ["wav", "Sound only (WAV)"], ["overlay", "Titles on transparency (ProRes 4444)"]];
const QUALITY = [["standard", "Standard"], ["best", "Best"]];
const RATES = [["", "Footage"], ["24", "24"], ["25", "25"], ["30", "30"], ["50", "50"], ["60", "60"]];
/** A text file the browser saves (captions, chapters). */
function saveText(name, text, type = "text/plain") {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

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
    ex.fps ? `${ex.fps} fps` : !r ? "your footage's frame rate" : r.capped ? `60 fps (your footage is ${rateText(video.fps)})` : `${rateText(r.fps)} fps, kept from your footage`,
    ex.bitrate ? `${ex.bitrate} Mbit/s` : null,
    ex.format && ex.format !== "mp4" ? (FORMATS.find((f) => f[0] === ex.format) || [0, ""])[1] : null,
    short && video?.kind !== "canvas" && Math.min(width, height) > short * 1.05 ? `scaled up from ${video.width}x${video.height}` : null,
  ].filter(Boolean).join(" · ");
}

/** The quality menu in the editor's top bar (like Edits' "4K 60" chip): resolution and frame rate, kept with the edit
 *  (set_export), and the rest of the export settings one click away. */
export function QualityMenu({ snap, video, doOp, onMore }) {
  const ex = snap.timeline.export || {};
  return html`<div class="col" style="gap:12px" id="quality-menu">
    <div class="col" style="gap:6px"><span class="t-small muted">Resolution</span><${Seg} id="quality-res" value=${ex.resolution || "1080p"} options=${SIZES} onPick=${(v) => doOp({ op: "set_export", resolution: v })} /></div>
    <div class="col" style="gap:6px"><span class="t-small muted">Frame rate</span><${Seg} id="quality-fps" value=${ex.fps ? String(ex.fps) : ""} options=${RATES} onPick=${(v) => doOp({ op: "set_export", fps: v ? Number(v) : null })} /></div>
    <p class="t-small muted" id="quality-summary" style="margin:0">${exportSummary(snap, video)}</p>
    <button class="dlink t-small" id="quality-more" style="justify-self:start" onClick=${onMore}>More export settings</button>
  </div>`;
}
/** The quality chip's text: "1080p · 30". */
export const qualityChip = (snap) => { const ex = snap.timeline.export || {}; return (ex.resolution === "4k" ? "4K" : ex.resolution || "1080p") + (ex.fps ? " · " + ex.fps : ""); };

export function ExportModal({ snap, video, doOp, onRender, onClose, onReframe, reframing = false, plan = null, name = "edit" }) {
  const ex = snap.timeline.export || {};
  const hdrFootage = !!video?.hdr;
  // Footage of another shape is cut to fit; Follow the speaker keeps the face in view (set_framing focus "face").
  const footAr = video?.kind === "canvas" ? 0 : video?.width && video?.height ? video.width / video.height : { Portrait: 9 / 16, Square: 1, Landscape: 16 / 9 }[video?.orientation] || 0;
  const otherShape = !!footAr && Math.abs(Math.log(footAr / (ASPECT_RATIO[snap.aspect] || 16 / 9))) > 0.05;
  const reframed = (snap.timeline.tracks?.v1 || []).some((c) => c.framing?.focus);
  const row = (label, child) => html`<div class="row between" style="gap:12px;align-items:center"><span class="t-label">${label}</span>${child}</div>`;
  // Best quality is for this export only (not kept with the edit).
  const [best, setBest] = useState(false);
  // Render on: the user's computers that can render now (the Rendrr app open on each), or Rendrr's cloud server. The
  // one picked last (here or with the AI) comes first; the pick is remembered for the next few hours.
  const [where, setWhere] = useState(null);
  useEffect(() => {
    let live = true;
    api.macStatus().then((m) => {
      const able = (m?.devices || []).filter((d) => d.renders);
      if (!live || !able.length) return;
      const value = m.choice === "cloud" ? "cloud" : (able.find((d) => d.id === m.choice) || able.find((d) => d.id === m.deviceId) || able[0]).id;
      setWhere({ able, value });
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return html`<${Modal} title="Export" sub="The final is made from your original at these settings." onClose=${onClose}>
    <div class="col" style="gap:14px" id="export-panel">
      ${row("Shape", html`<${Seg} id="export-aspect" value=${snap.aspect} options=${SHAPES} onPick=${(v) => doOp({ op: "set_aspect", aspect: v })} />`)}
      ${otherShape && onReframe && row("Reframe", html`<div class="row" style="gap:8px;align-items:center"><span class="t-small muted">${reframed ? "Reframed" : "Cut around the middle"}</span><${Btn} kind="secondary" size="xs" icon="spark" id="export-reframe" disabled=${reframing} onClick=${onReframe}>${reframing ? "Finding the speaker…" : "Follow the speaker"}<//></div>`)}
      ${row("Resolution", html`<${Seg} id="export-res" value=${ex.resolution || "1080p"} options=${SIZES} onPick=${(v) => doOp({ op: "set_export", resolution: v })} />`)}
      ${row("Codec", hdrFootage && (ex.hdr || "keep") === "keep"
        ? html`<span class="t-small muted" id="export-codec-hdr">HEVC 10-bit (HDR kept)</span>`
        : html`<${Seg} id="export-codec" value=${ex.codec || "h264"} options=${CODECS} onPick=${(v) => doOp({ op: "set_export", codec: v })} />`)}
      ${hdrFootage && row("HDR", html`<${Seg} id="export-hdr" value=${ex.hdr || "keep"} options=${[["keep", "Keep HDR"], ["sdr", "Convert to SDR"]]} onPick=${(v) => doOp({ op: "set_export", hdr: v })} />`)}
      ${row("Format", html`<select class="input sm" id="export-format" value=${ex.format || "mp4"} onChange=${(e) => doOp({ op: "set_export", format: e.target.value })}>${FORMATS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select>`)}
      ${(!ex.format || ex.format === "mp4" || ex.format === "overlay") && row("Frame rate", html`<${Seg} id="export-fps" value=${ex.fps ? String(ex.fps) : ""} options=${RATES} onPick=${(v) => doOp({ op: "set_export", fps: v ? Number(v) : null })} />`)}
      ${(!ex.format || ex.format === "mp4") && row("Quality", html`<${Seg} id="export-quality" value=${best ? "best" : "standard"} options=${QUALITY} onPick=${(v) => setBest(v === "best")} />`)}
      ${best && (!ex.format || ex.format === "mp4") && html`<p class="t-small muted" id="export-best-note">Best: the largest size your footage fills in this shape (4K from 4K footage), a slower, finer encode and 320k sound. About twice as long to render.</p>`}
      ${(!ex.format || ex.format === "mp4") && row("Bitrate", html`<label class="row t-small" style="gap:6px;align-items:center"><input class="input sm mono" type="number" min="1" max="200" step="1" id="export-bitrate" placeholder="Auto" value=${ex.bitrate ?? ""} style="width:80px" onChange=${(e) => doOp({ op: "set_export", bitrate: e.target.value ? Number(e.target.value) : null })} />Mbit/s</label>`)}
      ${ex.format === "overlay" && html`<p class="t-small muted" id="export-overlay-note">The graphics, text and captions alone, on transparency, to lay over footage in another editor. Footage, b-roll and zooms are left out.</p>`}
      ${where && row("Render on", html`<select class="input sm" id="export-device" value=${where.value} onChange=${(e) => setWhere({ ...where, value: e.target.value })}>${where.able.map((d) => html`<option key=${d.id} value=${d.id}>${(d.name || "This computer") + (d.platform === "windows" ? " (PC)" : " (Mac)") + (d.busy ? " · busy" : "")}</option>`)}<option value="cloud">Rendrr's cloud server</option></select>`)}
      <p class="t-small muted" id="export-summary">${exportSummary(snap, video)}</p>
      ${plan && html`<div class="col" style="gap:6px" id="export-files">
        <span class="t-label">Captions and chapters</span>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <${Btn} kind="secondary" size="xs" icon="download" id="export-srt" disabled=${!plan.subtitles?.length} onClick=${() => saveText(`${name}.srt`, srtText(plan.subtitles))}>SRT<//>
          <${Btn} kind="secondary" size="xs" icon="download" id="export-vtt" disabled=${!plan.subtitles?.length} onClick=${() => saveText(`${name}.vtt`, vttText(plan.subtitles), "text/vtt")}>WebVTT<//>
          <${Btn} kind="secondary" size="xs" icon="copy" id="export-chapters" disabled=${!plan.chapters?.length} onClick=${() => { const t = chaptersText(plan.chapters); navigator.clipboard?.writeText(t).catch(() => {}); saveText(`${name} chapters.txt`, t); }}>YouTube chapters<//>
        </div>
        <span class="t-small muted" id="export-chapters-note">${plan.chapters?.length ? `${plan.chapters.length} chapters from your chapter marks${chapterProblems(plan.chapters, plan.outputSeconds).length ? `. YouTube shows none until there are: ${chapterProblems(plan.chapters, plan.outputSeconds).join("; ")}` : "."}` : "Chapters come from chapter marks (your AI adds them with add_marks, kind chapter)."}</span>
      </div>`}
      <p class="t-small muted">${(ex.resolution === "4k" || ex.codec === "hevc") ? "4K and HEVC take longer to render; the window shows the time left." : "Frame rate: the final keeps your footage's. Previews are 30 fps."}</p>
      <div class="row"><${Btn} icon="film" id="export-render" onClick=${() => onRender({ best: best && (!ex.format || ex.format === "mp4"), ...(where ? { device: where.value } : {}) })}>Export final<//><${Btn} kind="ghost" onClick=${onClose}>Cancel<//></div>
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
