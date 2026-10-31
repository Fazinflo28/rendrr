// Samples: a few frames and short clips of the edit, rendered on their own and drawn exactly as the export draws them,
// to agree the look on key moments before a whole preview (what render_samples does for Claude, and shows in the chat).
// Pick moments at the playhead (a frame, or a 4 s clip from it), render them, look at each one big; "Go there" moves
// the player to it. The edit's latest sets are listed too, Claude's included.
import { html, Btn, Modal, useState, useEffect } from "./ui";
import { api } from "./api";
import { SAMPLE_CLIP_DEFAULT, SAMPLE_MAX_CLIPS, SAMPLE_MAX_FRAMES, sampleClock } from "@rendrr/shared";

const nameOf = (x) => (x.kind === "frame" ? "Frame " + sampleClock(x.at) : "Clip " + sampleClock(x.at) + "-" + sampleClock(x.end));

export function SamplesWindow({ projectId, time, duration, aspect, onSeek, onClose, toast }) {
  const [ask, setAsk] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [sets, setSets] = useState(null);
  const [pick, setPick] = useState({ set: 0, k: 0 });
  useEffect(() => { let on = true; api.listSamples(projectId).then((s) => on && setSets(s)).catch(() => on && setSets([])); return () => { on = false; }; }, [projectId]);
  const at = Math.round(Math.max(0, Math.min(time, Math.max(0, duration - 1 / 30))) * 30) / 30;
  const frames = ask.filter((x) => x.kind === "frame"), clips = ask.filter((x) => x.kind === "clip");
  const has = (x) => ask.some((y) => y.kind === x.kind && Math.abs(y.at - x.at) < 1e-6);
  const add = (x) => { if (has(x)) return toast?.("That moment is already in the list."); setAsk((a) => [...a, x].sort((p, q) => p.at - q.at)); };
  const addFrame = () => add({ kind: "frame", at });
  const addClip = () => add({ kind: "clip", at, end: Math.min(duration, at + SAMPLE_CLIP_DEFAULT) });
  const go = async () => {
    setError(null); setBusy({ percent: 0, step: "Starting" });
    try {
      const set = await api.renderSamples(projectId, { frames: frames.map((x) => ({ at: x.at })), clips: clips.map((x) => ({ start: x.at, end: x.end })) }, (p) => setBusy({ percent: p.percent ?? 0, step: (p.steps || [])[p.step] || null }));
      setBusy(null); setAsk([]);
      if (set) { setSets((s) => [set, ...(s || []).filter((x) => x.renderId !== set.renderId)].slice(0, 4)); setPick({ set: 0, k: 0 }); }
    } catch (e) { setBusy(null); setError(e.message); }
  };
  const done = (sets || []).filter((s) => s.status === "done" && s.items.length);
  const cur = done[pick.set], item = cur?.items[pick.k];
  const tall = aspect === "9:16" || aspect === "4:5";
  return html`<${Modal} wide title="Samples" sub="A few frames and short clips, drawn exactly as the export draws them. Agree the look on key moments before exporting the whole preview." onClose=${busy ? undefined : onClose}>
    <div class="samples">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <${Btn} kind="secondary" size="sm" id="samples-add-frame" icon="plus" disabled=${!!busy || frames.length >= SAMPLE_MAX_FRAMES} onClick=${addFrame}>Frame at ${sampleClock(at)}<//>
        <${Btn} kind="secondary" size="sm" id="samples-add-clip" icon="plus" disabled=${!!busy || clips.length >= SAMPLE_MAX_CLIPS || at >= duration - 0.05} onClick=${addClip}>${SAMPLE_CLIP_DEFAULT} s clip from ${sampleClock(at)}<//>
        <span class="muted t-small">Move the playhead to pick a moment. Up to ${SAMPLE_MAX_FRAMES} frames and ${SAMPLE_MAX_CLIPS} clips.</span>
      </div>
      ${ask.length > 0 && html`<div class="row" style="gap:6px;flex-wrap:wrap" id="samples-ask">${ask.map((x, i) => html`<span key=${x.kind + x.at} class="chip">${nameOf(x)}<button class="x" aria-label=${"Remove " + nameOf(x)} disabled=${!!busy} onClick=${() => setAsk((a) => a.filter((_, j) => j !== i))}>×</button></span>`)}</div>`}
      <div class="row" style="gap:10px">
        <${Btn} id="samples-render" icon="play" disabled=${!ask.length || !!busy} onClick=${go}>${busy ? "Rendering…" : `Render ${ask.length || ""} ${ask.length === 1 ? "sample" : "samples"}`}<//>
        ${busy && html`<div class="grow"><div class="t-small muted">${busy.step || "Rendering"} · ${busy.percent}%</div><div class="bar"><i style=${{ width: Math.max(3, busy.percent) + "%" }} /></div></div>`}
      </div>
      ${error && html`<div class="samples-err" role="alert">${error}</div>`}
      ${sets === null ? html`<div class="skeleton" style="height:120px" />` : !done.length ? html`<div class="muted t-small" id="samples-empty">No samples yet. Pick a few moments above${" "}(the hook, a title, a graphic, a transition), or ask Claude to render samples.</div>` : html`
        <div class=${"sample-big" + (tall ? " tall" : "")} id="sample-big">
          ${item?.clip ? html`<video key=${item.clip} src=${item.clip} poster=${item.still || undefined} controls playsinline loop preload="metadata" />` : item?.still ? html`<img src=${item.still} alt=${nameOf(item)} />` : null}
          ${item && html`<span class="tag">${pick.k + 1}/${cur.items.length} · ${nameOf(item)}</span>`}
        </div>
        ${item?.note && html`<div class="t-small muted">Note: ${item.note}</div>`}
        <div class="row" style="gap:8px">
          <${Btn} kind="ghost" size="sm" id="sample-go" icon="play" onClick=${() => { onSeek(item.at); onClose(); }}>Go to ${sampleClock(item.at)}<//>
        </div>
        ${done.map((s, si) => html`<div key=${s.renderId} class="sample-set">
          <div class="t-small muted">${si === 0 ? "Latest" : "Earlier"} · v${s.version} · ${s.items.length} ${s.items.length === 1 ? "sample" : "samples"}${s.comments?.length ? ` · ${s.comments.filter((c) => !c.resolved).length} changes asked` : ""}</div>
          <div class=${"samples-strip" + (tall ? " tall" : "")}>${s.items.map((x, k) => html`<button key=${k} class=${"sample-thumb" + (si === pick.set && k === pick.k ? " on" : "")} title=${nameOf(x) + (x.note ? " · " + x.note : "")} onClick=${() => setPick({ set: si, k })}>
            ${x.still && html`<img src=${x.still} alt="" loading="lazy" />`}<span class="lab">${x.kind === "clip" ? "▶ " + Math.round((x.end - x.at) * 10) / 10 + "s" : sampleClock(x.at)}</span></button>`)}</div>
        </div>`)}`}
    </div>
  <//>`;
}
