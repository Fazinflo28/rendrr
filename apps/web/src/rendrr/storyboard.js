// Storyboard mode in the editor (optional): one big preview card pinned at the top shows the frame picked (a frame or
// a short video frame of the edit, drawn exactly as the export draws it, in the video's own shape), with buttons (and the
// arrow keys) to step through the frames one by one; under it every frame as a small picture, and a tap on one opens it
// in the big card. The big card carries the comment box: write what should change, draw on the frame to show where (the
// comment goes with the drawing, so Claude sees what was marked), send the changes to Claude, make the board again from
// the edit, and approve it; then render the whole video. The style sheet (captions, fonts, colours, rules, look, music,
// pacing) is one tap away. A board can be picture frames only ("images"): video frames are added on request. Made by
// Claude (create_storyboard) or here ("Make storyboard": Rendrr picks the scenes, titles and graphics).
import { html, Btn, Icon, useState, useEffect, useRef } from "./ui";
import { api } from "./api";
import { panelOf, sampleClock } from "@rendrr/shared";

const PENS = ["#ff3b30", "#ffd60a", "#34c759", "#0a84ff", "#ffffff"];
const panelName = (x, k) => `${k + 1}${x.title ? ". " + x.title : ""}`;
const timeOf = (x) => (x.kind === "frame" ? sampleClock(x.at) : sampleClock(x.at) + "–" + sampleClock(x.end));

/** A drawing as a clear PNG the size of the picture (up to 1280 wide), base64: Claude sees it on the panel. */
function drawingPng(d) {
  try {
    const W = Math.min(1280, d.w), H = Math.max(1, Math.round((W * d.h) / d.w));
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d"); if (!g) return null;
    g.lineCap = "round"; g.lineJoin = "round";
    for (const st of d.strokes) {
      g.strokeStyle = st.c; g.lineWidth = Math.max(1, st.w * W); g.beginPath();
      for (let k = 0; k + 1 < st.p.length; k += 2) { const x = st.p[k] * W, y = st.p[k + 1] * H; k ? g.lineTo(x, y) : g.moveTo(x, y); }
      if (st.p.length === 2) g.lineTo(st.p[0] * W + 0.1, st.p[1] * H);
      g.stroke();
    }
    return cv.toDataURL("image/png").split(",")[1] || null;
  } catch { return null; }
}
const poly = (st, i) => html`<polyline key=${i} points=${st.p.reduce((a, v, k) => (k % 2 ? a + "," + v : a + (k ? " " : "") + v), "")} fill="none" stroke=${st.c} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`;

/** The frames' shape: the board's own size once drawn, else the edit's aspect ("9:16" gives 9 / 16). */
function shapeOf(cur) {
  const w = cur?.width, h = cur?.height;
  if (w > 0 && h > 0) return { ratio: `${w} / ${h}`, tall: h > w * 1.05, square: Math.abs(h - w) <= w * 0.05 };
  const a = String(cur?.board?.style?.aspect || cur?.project?.aspect || "16:9").split(":").map(Number);
  const aw = a[0] > 0 ? a[0] : 16, ah = a[1] > 0 ? a[1] : 9;
  return { ratio: `${aw} / ${ah}`, tall: ah > aw * 1.05, square: aw === ah };
}

/** The style sheet: captions as they look, the fonts, the colours, the rules and the rest of the edit's look. */
function StyleSheet({ b }) {
  const st = b.style, c = st?.captions;
  const fam = (f) => `"${f}", Inter, system-ui, sans-serif`;
  return html`<section class="sb-style" id="sb-style" aria-label="Style sheet">
    <div class="sb-style-card" id="sb-captions"><div class="sb-k">Captions</div>
      ${c ? html`<div class="sb-cap" style=${{ fontFamily: fam(c.font), fontWeight: c.weight, color: c.color, textTransform: c.case === "upper" ? "uppercase" : c.case === "lower" ? "lowercase" : "none", background: c.box || "transparent", WebkitTextStroke: c.stroke ? `1px ${c.stroke}` : undefined }}>
          The <span style=${{ color: c.highlight || c.color }}>spoken</span> word</div>
        <div class="t-small muted">${c.font} ${c.weight} · ${c.size}% · ${c.lines} ${c.lines === 1 ? "line" : "lines"}, ${c.position}</div>
        <div class="t-small" id="sb-cap-anim">${c.animation}</div>`
      : html`<div class="t-small muted">${st ? "Off" : "Read from the edit once the board is drawn."}</div>`}</div>
    <div class="sb-style-card" id="sb-fonts"><div class="sb-k">Fonts</div>
      ${st?.fonts?.length ? st.fonts.map((f) => html`<div key=${f.font + f.weight} class="sb-font"><span style=${{ fontFamily: fam(f.font), fontWeight: f.weight }}>Aa</span><div><b>${f.font} ${f.weight}</b><div class="t-small muted">${f.use}</div></div></div>`) : html`<div class="t-small muted">None on screen</div>`}
      ${st?.texts?.count ? html`<div class="t-small muted">${st.texts.count} text ${st.texts.count === 1 ? "layer" : "layers"}${st.texts.animations.length ? ": " + st.texts.animations.join(", ") : ""}</div>` : null}</div>
    <div class="sb-style-card" id="sb-colors"><div class="sb-k">Colours</div>
      <div class="sb-swatches">${(st?.colors?.length ? st.colors : b.palette || []).map((x) => html`<div key=${x.hex} class="sb-sw" title=${x.hex + " · " + x.name}><i style=${{ background: x.hex }} /><span><b>${x.hex}</b><small>${x.name}</small></span></div>`)}</div>
      ${!(st?.colors?.length || b.palette?.length) && html`<div class="t-small muted">None set</div>`}</div>
    <div class="sb-style-card" id="sb-rules"><div class="sb-k">Visual rules</div>
      ${b.rules?.length ? html`<ul>${b.rules.map((r, i) => html`<li key=${i}>${r}</li>`)}</ul>` : html`<div class="t-small muted">None written. Ask Claude to set them.</div>`}</div>
    ${st && html`<div class="sb-style-card sb-facts" id="sb-facts"><div class="sb-k">The rest</div>
      <dl><dt>Format</dt><dd>${st.aspect} · ${sampleClock(st.seconds)}</dd><dt>Look</dt><dd>${st.look}</dd>${st.background ? html`<dt>Behind</dt><dd>${st.background}</dd>` : null}<dt>Transitions</dt><dd>${st.transitions.length ? st.transitions.join(", ") : "cuts only"}</dd><dt>Music</dt><dd>${st.music}</dd><dt>Sound</dt><dd>${st.sound}</dd><dt>Pacing</dt><dd>${st.pacing}</dd></dl></div>`}
  </section>`;
}

/** One frame in the strip under the big card: a small picture in the video's shape, its number, a video frame's length
 *  and how many changes are asked on it. A tap opens it in the big card. */
function Thumb({ x, k, ratio, on, changes, onOpen }) {
  return html`<button class=${"sb-thumb" + (on ? " on" : "")} data-panel=${k} aria-label=${`Frame ${k + 1}${x.title ? ", " + x.title : ""}`} aria-current=${on ? "true" : undefined} title=${(x.title ? x.title + " · " : "") + timeOf(x)} onClick=${onOpen}>
    <div class="sb-pic" style=${{ aspectRatio: ratio }}>
      ${x.still ? html`<img src=${x.still} alt="" loading="lazy" />` : html`<span class="sb-wait">…</span>`}
      <span class="sb-n">${k + 1}</span>
      ${x.kind === "clip" && html`<span class="sb-len">▶ ${Math.round((x.end - x.at) * 10) / 10}s</span>`}
      ${changes > 0 && html`<span class="sb-cm" title=${changes + (changes === 1 ? " change asked" : " changes asked")}><${Icon} name="comment" size="10" /> ${changes}</span>`}
    </div>
    <div class="sb-tl">${x.title || timeOf(x)}</div>
  </button>`;
}

export function StoryboardWindow({ projectId, initialId, onClose, onSeek, onRenderVideo, toast }) {
  const [boards, setBoards] = useState(null);
  const [cur, setCur] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(0); // the frame in the big card
  const [draft, setDraft] = useState("");
  const [drawing, setDrawing] = useState(false), [strokes, setStrokes] = useState([]), [pen, setPen] = useState(PENS[0]);
  const [ink, setInk] = useState(null); // a comment's drawing shown on the frame
  const [posting, setPosting] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  const live = useRef(null), media = useRef(null), box = useRef(null);
  const [, tick] = useState(0);

  const load = async (id) => {
    try {
      const list = await api.listStoryboards(projectId);
      setBoards(list);
      const want = id ? (list.find((b) => b.renderId === id) || (await api.getStoryboard(id).catch(() => null))) : list[0];
      setCur(want || null);
    } catch (e) { setError(e.message); setBoards([]); }
  };
  useEffect(() => { load(initialId); }, [projectId, initialId]);
  // A board still being drawn (Claude's, or one made here and left) is watched until it is done.
  useEffect(() => {
    if (!cur || (cur.status !== "queued" && cur.status !== "running")) return;
    const t = setTimeout(async () => { try { const nv = await api.getStoryboard(cur.renderId); setCur((c) => (c && c.renderId === nv.renderId ? nv : c)); } catch {} }, 2500);
    return () => clearTimeout(t);
  }, [cur]);
  // Opens frame k in the big card (a draft or drawing in progress stays with the frame it was for: it is cleared).
  const openSel = (k) => { setSel(k); setDraft(""); setStrokes([]); setDrawing(false); setInk(null); };
  // Escape closes the board (or stops drawing); the arrow keys step through the frames, unless the comment is being typed.
  useEffect(() => {
    const k = (e) => {
      if (busy) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "") || e.target?.isContentEditable;
      if (e.key === "Escape") { if (drawing) { setDrawing(false); setStrokes([]); } else onClose(); }
      else if (!typing && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { const n = cur?.items?.length || 0; if (n) { e.preventDefault(); openSel(Math.min(n - 1, Math.max(0, (sel || 0) + (e.key === "ArrowRight" ? 1 : -1)))); } }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [sel, busy, drawing, cur]);

  const refresh = async () => { if (!cur) return; try { const nv = await api.getStoryboard(cur.renderId); setCur(nv); setBoards((bs) => (bs || []).map((b) => (b.renderId === nv.renderId ? nv : b))); } catch (e) { toast?.(e.message); } };
  // Made from the edit as it is now: Claude's panels and words again when the board was Claude's, else Rendrr's own.
  // frames: "images" draws picture frames only; "video" pictures and short video frames (left out: as the board was).
  const make = async (again, frames) => {
    setError(null); setBusy({ percent: 0, step: "Starting" });
    const b = again && cur?.board, own = b && cur.items.some((x) => x.title || x.caption || x.shot || x.note);
    const want = frames || (b?.frames === "images" ? "images" : undefined);
    // A picture frame that was asked as a clip (video) is asked as that clip again: a video frame, or once more a picture.
    const req = own ? { title: b.title, rules: b.rules, palette: b.palette, panels: cur.items.map((x) => ({ ...(x.video ? { at: x.video[0], end: x.video[1] } : { at: x.at, ...(x.kind === "clip" ? { end: x.end } : {}) }), ...(x.title ? { title: x.title } : {}), ...(x.caption ? { caption: x.caption } : {}), ...(x.shot ? { shot: x.shot } : {}), ...(x.note ? { note: x.note } : {}) })) }
      : b ? { title: b.title, rules: b.rules, palette: b.palette } : {};
    if (want) req.frames = want;
    try {
      const nv = await api.renderStoryboard(projectId, req, (p) => setBusy({ percent: p.percent ?? 0, step: (p.steps || [])[p.step] || null }));
      setBusy(null);
      if (nv) { setCur(nv); setBoards((bs) => [nv, ...(bs || []).filter((x) => x.renderId !== nv.renderId)].slice(0, 4)); openSel(0); }
    } catch (e) { setBusy(null); setError(e.message); }
  };
  // Video frames for a board of pictures: each panel asked as a clip becomes its video frame (Rendrr picks them when
  // the board was its own).
  const addVideo = () => make(true, "video");
  const approve = async (yes) => {
    try { const nv = await api.approveStoryboard(cur.renderId, yes); setCur(nv); toast?.(yes ? "Storyboard approved" : "Back in review", { icon: "check", tone: yes ? "brand" : undefined }); }
    catch (e) { toast?.(e.message); }
  };
  const renderVideo = () => { onClose(); onRenderVideo?.(); };

  const b = cur?.board, items = cur?.items || [];
  const shape = shapeOf(cur);
  const openComments = (cur?.comments || []).filter((c) => !c.resolved);
  const changesOn = (k) => (cur?.comments || []).filter((c) => !c.resolved && panelOf(items, c.time) === k);
  const si = items.length ? Math.min(Math.max(0, sel || 0), items.length - 1) : -1, x = si >= 0 ? items[si] : null;
  const pics = b?.frames === "images";

  // Drawing on the open frame: strokes in shares of its picture.
  const drawDown = (e) => {
    if (!drawing || live.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const id = e.pointerId, r = e.currentTarget.getBoundingClientRect(), pt = (ev) => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))].map((v) => Math.round(v * 1000) / 1000);
    live.current = { c: pen, w: 0.004, p: pt(e) };
    const move = (ev) => { if (ev.pointerId !== id || !live.current) return; live.current = { ...live.current, p: [...live.current.p, ...pt(ev)].slice(0, 4000) }; tick((n) => n + 1); };
    const up = (ev) => {
      if (ev && ev.pointerId !== id) return;
      const st = live.current; live.current = null;
      for (const [n, f] of [["pointermove", move], ["pointerup", up], ["pointercancel", up]]) window.removeEventListener(n, f);
      if (st && st.p.length >= 4) setStrokes((s) => [...s, st].slice(0, 80)); else tick((n) => n + 1);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };
  const canPost = !!draft.trim() || strokes.length > 0;
  const post = async () => {
    if (!canPost || !x) return;
    setPosting(true);
    try {
      // A video frame's change at the moment it is paused on; a picture's at the picture.
      const t = x.kind === "clip" && media.current && isFinite(media.current.currentTime) ? Math.min(x.end - 1 / 30, x.at + media.current.currentTime) : x.at;
      const d = strokes.length ? { w: cur.width || 1280, h: cur.height || 720, strokes } : null;
      await api.addProjectComment(projectId, { time: Math.round(t * 1000) / 1000, text: draft, renderId: cur.renderId, drawing: d ? { ...d, png: drawingPng(d) || undefined } : undefined });
      setDraft(""); setStrokes([]); setDrawing(false);
      toast?.(`Comment added to frame ${si + 1}`, { icon: "comment" });
      await refresh();
    } catch (e) { toast?.(e.message); } finally { setPosting(false); }
  };
  const resolve = async (c) => { try { await api.resolveComment(c.id, !c.resolved); await refresh(); } catch (e) { toast?.(e.message); } };
  const sendToClaude = async () => {
    const tab = window.rendrrDesktop ? null : window.open("", "_blank");
    try {
      const r = await api.sendComments(projectId, "claude", openComments.map((c) => c.id));
      if (tab) tab.location.href = r.url; else window.open(r.url, "_blank", "noopener");
      toast?.(`Sent ${r.count} ${r.count === 1 ? "change" : "changes"} to Claude. Its chat opened with them.`, { icon: "spark" });
    } catch (e) { try { tab?.close(); } catch {} toast?.(e.message); }
  };

  const stale = b && b.latestVersion > cur.version;
  const nClips = items.filter((i) => i.kind === "clip").length;
  const head = html`<header class="sb-head">
    <button class="btn icon quiet" id="sb-close" aria-label="Close the storyboard" onClick=${onClose}><${Icon} name="x" size="16" /></button>
    <div class="grow">
      <div class="sb-title" id="sb-title">${b ? b.title : "Storyboard"}</div>
      ${cur && html`<div class="t-small muted" id="sb-meta">v${cur.version} · ${items.length} ${items.length === 1 ? "frame" : "frames"}${nClips ? ` (${nClips} video)` : pics ? " (pictures)" : ""} · <span class=${"sb-state" + (b?.status === "approved" ? " ok" : "")} id="sb-state">${b?.status === "approved" ? "Approved" : "In review"}</span>${openComments.length ? ` · ${openComments.length} ${openComments.length === 1 ? "change" : "changes"} asked` : ""}</div>`}
    </div>
    <div class="row sb-acts">
      ${boards?.length > 1 && html`<select class="input sm" id="sb-pick" aria-label="Earlier boards" value=${cur?.renderId} onChange=${(e) => { openSel(0); setCur(boards.find((x) => x.renderId === e.target.value)); }}>${boards.map((x, i) => html`<option key=${x.renderId} value=${x.renderId}>${i === 0 ? "Latest" : "Earlier"} · v${x.version} · ${x.board?.title || ""}</option>`)}</select>`}
      ${b && html`<${Btn} kind="ghost" size="sm" id="sb-style-toggle" aria-expanded=${showStyle ? "true" : "false"} onClick=${() => setShowStyle((s) => !s)}>${showStyle ? "Hide style sheet" : "Style sheet"}<//>`}
      ${openComments.length > 0 && html`<${Btn} kind="secondary" size="sm" id="sb-send" icon="send" onClick=${sendToClaude}>Send ${openComments.length} to Claude<//>`}
      ${cur && pics && html`<${Btn} kind="secondary" size="sm" id="sb-video" icon="film" disabled=${!!busy} onClick=${addVideo}>Add video frames<//>`}
      ${cur && html`<${Btn} kind="ghost" size="sm" id="sb-again" icon="refresh" disabled=${!!busy} onClick=${() => make(true)}>Make again<//>`}
      ${cur?.status === "done" && (b?.status === "approved"
        ? html`<${Btn} kind="ghost" size="sm" id="sb-unapprove" onClick=${() => approve(false)}>Back to review<//><${Btn} size="sm" id="sb-render" icon="play" onClick=${renderVideo}>Render the video<//>`
        : html`<${Btn} size="sm" id="sb-approve" icon="check" onClick=${() => approve(true)}>Approve<//>`)}
    </div>
  </header>`;

  // The big card, pinned at the top: the frame picked, big (a video frame plays; draw on it to show where), buttons to
  // step to the previous and next frame, and beside it (under it on a phone) its comment box, the changes asked on it
  // and its words.
  const stage = x && html`<section class="sb-stage" id="sb-stage" aria-label=${"Frame " + (si + 1) + " of " + items.length}>
    <div class="sb-stage-main">
      <div class=${"sb-big" + (shape.tall || shape.square ? " tall" : "")} id="sb-one"><div class="sb-frame">
        ${x.clip ? html`<video ref=${media} key=${x.clip} src=${x.clip} poster=${x.still || undefined} controls=${!drawing} playsinline loop preload="metadata" />` : x.still ? html`<img key=${x.still} src=${x.still} alt=${panelName(x, si)} />` : html`<div class="sb-wait" style=${{ position: "static", aspectRatio: shape.ratio, width: "100%" }}>Drawing…</div>`}
        ${(drawing || strokes.length || ink) && html`<svg class=${"sb-ink" + (drawing ? " drawing" : "")} id="sb-draw-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Your drawing on this frame" onPointerDown=${drawDown}>${(ink || []).map(poly)}${strokes.map(poly)}${live.current ? poly(live.current, "live") : null}</svg>`}
        <span class="sb-n big">${si + 1}</span>
      </div>
      ${items.length > 1 && html`<button class="sb-nav prev" id="sb-prev" aria-label="Previous frame" disabled=${si === 0} onClick=${() => openSel(si - 1)}><${Icon} name="back" size="16" /></button>
        <button class="sb-nav next" id="sb-next" aria-label="Next frame" disabled=${si >= items.length - 1} onClick=${() => openSel(si + 1)}><${Icon} name="chev" size="16" /></button>`}</div>
    </div>
    <div class="sb-side sb-stage-side">
      <div class="row" style="gap:8px;align-items:baseline;justify-content:space-between">
        <div style="min-width:0"><div class="sb-k" id="sb-count">${si + 1} / ${items.length} · ${timeOf(x)}${x.kind === "clip" ? " · video frame" : ""}</div><div class="sb-h3" id="sb-one-title">${x.title || "Frame " + (si + 1)}</div></div>
        <${Btn} kind="ghost" size="xs" id="sb-go" icon="play" onClick=${() => { onSeek?.(x.at); onClose(); }}>Go to ${sampleClock(x.at)}<//>
      </div>
      <div class="sb-ask">
        <textarea ref=${box} class="input" id="sb-comment" rows="2" maxlength="2000" placeholder=${`Your comment on frame ${si + 1}: what should change?`} value=${draft} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }} />
        <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
          <${Btn} id="sb-add" icon="comment" disabled=${!canPost || posting || cur.status !== "done"} onClick=${post}>${posting ? "Saving…" : strokes.length ? "Add comment with drawing" : "Add comment"}<//>
          <${Btn} kind=${drawing ? "primary" : "ghost"} size="xs" id="sb-draw" onClick=${() => { media.current?.pause?.(); setInk(null); setDrawing((d) => !d); }}>${drawing ? "Drawing: on" : "✎ Draw on it"}<//>
          ${drawing && PENS.map((p) => html`<button key=${p} class=${"sb-pen" + (pen === p ? " on" : "")} style=${{ background: p }} aria-label=${"Pen " + p} onClick=${() => setPen(p)} />`)}
          ${strokes.length > 0 && html`<button class="btn sm quiet" id="sb-undo" onClick=${() => setStrokes((s) => s.slice(0, -1))}>Undo</button><button class="btn sm quiet" onClick=${() => setStrokes([])}>Clear</button>`}
        </div>
      </div>
      <div class="sb-chgs" id="sb-changes">${(cur.comments || []).filter((c) => panelOf(items, c.time) === si).map((c) => html`<div key=${c.id} class=${"sb-chg" + (c.resolved ? " done" : "")} data-comment=${c.id}>
        <span class="grow">${c.text || "(a drawing)"}</span>
        ${c.drawing && html`<button class="cmt-badge" onClick=${() => setInk(ink === c.drawing.strokes ? null : c.drawing.strokes)}>✎ ${ink === c.drawing.strokes ? "Hide" : "Show"}</button>`}
        <button class="btn icon sm quiet" aria-label=${c.resolved ? "Open again" : "Resolve"} title=${c.resolved ? "Open again" : "Resolve"} onClick=${() => resolve(c)}><${Icon} name="check" size="12" /></button></div>`)}</div>
      ${x.caption && html`<div><div class="sb-k">Says</div><div id="sb-one-caption">“${x.caption}”</div></div>`}
      ${x.onScreen && html`<div><div class="sb-k">On screen</div><div class="t-small">${x.onScreen}</div></div>`}
      ${x.shot && html`<div><div class="sb-k">Shows</div><div class="t-small">${x.shot}</div></div>`}
      ${x.note && html`<div><div class="sb-k">Claude's note</div><div class="t-small">${x.note}</div></div>`}
    </div>
  </section>`;

  let body;
  if (boards === null) body = html`<div class="skeleton" style="height:240px" />`;
  else if (!cur) body = html`<div class="sb-empty" id="sb-empty">
      <div class="sb-h3">Storyboard the video first</div>
      <p class="muted">The video's key frames, drawn exactly as the export draws them: step through them in a big preview, comment on any frame, approve it, then render the whole video. Or skip it and edit straight away.</p>
      <p class="t-small muted">Ask Claude to storyboard it (its own beats, script lines and rules), or let Rendrr pick the scenes, titles and graphics:</p>
      <div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap">
        <${Btn} id="sb-make" icon="film" disabled=${!!busy} onClick=${() => make(false)}>Make storyboard<//>
        <${Btn} kind="secondary" id="sb-make-pics" disabled=${!!busy} onClick=${() => make(false, "images")}>Picture frames only<//>
      </div></div>`;
  else body = html`<div class="sb-board">
      ${stale && html`<div class="sb-note" role="status" id="sb-stale">The edit changed since this board (v${cur.version} → v${b.latestVersion}). Make it again to see the changes.</div>`}
      ${cur.status === "failed" && html`<div class="sb-note err" role="alert">The storyboard did not draw: ${cur.error}</div>`}
      ${(cur.status === "queued" || cur.status === "running") && html`<div class="sb-note" role="status">${cur.status === "queued" ? "Waiting to draw the storyboard" : `Drawing the storyboard · ${cur.percent}%${cur.step ? " · " + cur.step : ""}`}</div>`}
      ${b && showStyle && html`<${StyleSheet} b=${b} />`}
      ${stage}
      <div class="sb-k sb-strip-k">All frames · tap one to open it above</div>
      <div class=${"sb-grid sb-strip" + (shape.tall ? " tall" : shape.square ? " square" : "")} id="sb-grid">${items.map((it, k) => html`<${Thumb} key=${k} x=${it} k=${k} ratio=${shape.ratio} on=${k === si} changes=${changesOn(k).length} onOpen=${() => openSel(k)} />`)}</div>
    </div>`;

  return html`<div class="sb" role="dialog" aria-label="Storyboard" id="storyboard" data-render=${cur?.renderId || ""}>
    ${head}
    ${busy && html`<div class="sb-busy" role="status" id="sb-busy"><div class="t-small">${busy.step || "Drawing"} · ${busy.percent}%</div><div class="bar"><i style=${{ width: Math.max(3, busy.percent) + "%" }} /></div></div>`}
    ${error && html`<div class="sb-note err" role="alert" id="sb-error">${error}</div>`}
    <div class="sb-body">${body}</div>
  </div>`;
}
