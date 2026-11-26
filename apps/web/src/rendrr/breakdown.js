// Explore: the style breakdown beside a published video (in the viewer's side panel). Anyone can read how the video
// was edited: plain words first, then shot by shot, fonts, colours, b-roll, camera, animations, transitions, music,
// sound effects and what a new video in this style needs. It comes from the publisher's style file of the edit's
// footage (GET /gallery/:id/breakdown, nothing private in it). A video with none yet: the publisher can make it here.
import { html, useState, useEffect, Btn, Skeleton } from "./ui";
import { api } from "./api";

const t1 = (s) => `${Math.round(s * 10) / 10}s`;
/** "Pace: something new..." shows its label in bold. */
const split = (line) => { const m = /^([A-Z][A-Za-z -]{1,24}):\s(.+)$/.exec(line); return m ? [m[1], m[2]] : [null, line]; };

function Section({ title, count, open, children }) {
  return html`<details class="bd-sec" open=${!!open}>
    <summary><span>${title}</span>${count != null && html`<em>${count}</em>`}</summary>
    <div class="bd-body">${children}</div>
  </details>`;
}

export function Breakdown({ g }) {
  const [d, setD] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(false), [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true, timer = null;
    if (!tick) { setD(null); setErr(null); }
    const load = async () => {
      try {
        const r = await api.galleryBreakdown(g.id); if (!alive) return;
        setD(r); setErr(null);
        if (r.status === "measuring" || r.updating) timer = setTimeout(load, 5000);
      } catch (e) { if (alive) setErr(e.message || "The breakdown did not load."); }
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [g.id, tick]);
  const make = async () => {
    setBusy(true); setErr(null);
    try { setD(await api.makeGalleryBreakdown(g.id)); setTick((n) => n + 1); } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const head = html`<div class="bd-head"><b>Style breakdown</b><span>How this video was edited</span></div>`;
  if (err && !d) return html`<section class="bd">${head}<p class="t-small muted">${err}</p></section>`;
  if (!d) return html`<section class="bd">${head}<${Skeleton} rows=${4} card=${false} /></section>`;
  if (d.status === "measuring") return html`<section class="bd">${head}
    <div class="bd-wait"><p class="t-small">Breaking the video down, shot by shot…</p><div class="bar bd-bar"><i style=${{ width: Math.max(4, d.progress || 0) + "%" }} /></div></div></section>`;
  if (d.status !== "ready") return html`<section class="bd">${head}
    <div class="bd-wait">
      <p class="t-small muted">${d.status === "failed" ? "The breakdown could not be made." : d.mine ? "No breakdown yet. Make one and everyone can see how this video was edited." : "The creator has not added a breakdown for this video yet."}</p>
      ${d.mine && d.canMake && html`<${Btn} kind="lime" icon="refresh" disabled=${busy} onClick=${make}>${busy ? "Starting…" : d.status === "failed" ? "Try again" : "Make the breakdown"}<//>`}
      ${err && html`<p class="t-small muted">${err}</p>`}
    </div></section>`;

  const b = d.breakdown;
  return html`<section class="bd">${head}
    ${b.summary && html`<p class="bd-sum">${b.summary}</p>`}
    ${b.facts.length > 0 && html`<dl class="bd-facts">${b.facts.map((f) => html`<div key=${f.label}><dt>${f.label}</dt><dd>${f.value}</dd></div>`)}</dl>`}
    ${b.plain.length > 0 && html`<${Section} title="In plain words" open=${true}><ul class="bd-list">${b.plain.map((x, i) => { const [k, v] = split(x); return html`<li key=${i}>${k ? html`<b>${k}:</b> ${v}` : v}</li>`; })}</ul><//>`}
    ${b.shots.length > 0 && html`<${Section} title="Shot by shot" count=${b.shots.length}>
      <ol class="bd-shots">${b.shots.map((s, i) => html`<li key=${i}>
        <div class="bd-shot-top"><span class="bd-time">${t1(s.start)} to ${t1(s.end)}</span><span class="bd-tag">${s.kind}</span></div>
        ${s.what && html`<p>${s.what}</p>`}
        ${s.says && html`<q>${s.says}</q>`}
      </li>`)}</ol><//>`}
    ${(b.fonts.length > 0 || b.palette.length > 0) && html`<${Section} title="Fonts and colours" open=${b.fonts.length > 0}>
      ${b.fonts.map((f, i) => html`<div key=${i} class="bd-font"><b>${f.family}${f.weight ? ` · ${f.weight}` : ""}</b><span>${f.use}${f.color ? `, ${f.color}` : ""}</span></div>`)}
      ${b.palette.length > 0 && html`<div class="bd-pal">${b.palette.map((c) => html`<span key=${c} title=${c}><i style=${{ background: c }} />${c}</span>`)}</div>`}
    <//>`}
    ${b.sections.map((s) => html`<${Section} key=${s.title} title=${s.title} count=${s.lines.length > 2 ? s.lines.length : null}><ul class="bd-list">${s.lines.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul><//>`)}
    ${b.needs.length > 0 && html`<${Section} title="What you need to recreate it" count=${b.needs.length}><ul class="bd-list">${b.needs.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul><//>`}
    <p class="bd-note">Measured by Rendrr from the video. Music style and sound effect kinds are best guesses.</p>
  </section>`;
}
