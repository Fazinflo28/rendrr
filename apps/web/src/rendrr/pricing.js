/* ===================== /pricing ===================== */
// The plans page, laid out like Higgsfield's: three plan cards side by side (the middle-priced one lit up as the pick),
// a big price, one button, the minutes with what they buy under them, then what each plan includes. Under the cards:
// a quick "which plan fits" slider, what uses minutes, a full comparison and short answers.
// Public: anyone can read it. It takes no payments: paid plans say "Coming soon" until Rendrr turns payments on
// (billing overview's payments.enabled), then their button opens Usage & billing, where checkout already lives.
// The numbers are the plan Ronnii set on Nov 27 (Claude Doc "Rendrr pricing"). Keep them in step with the billing code
// when the new minutes plan goes live there.
import { useState, useEffect, html, Icon, Btn, useNav, useApp } from "./ui";
import { api } from "./api";
import { BrandLogo } from "./brandLogos";

// One short video = 1 minute long, 4 previews and 1 export = 5 render minutes (the doc's example).
const PER_VIDEO = 5;

export const PLANS = [
  {
    id: "free", name: "Free", tag: "Try Rendrr on real videos", price: 0, minutes: 25, storageGB: 5, extra: null,
    watermark: true, priority: false, tone: "free",
  },
  {
    id: "editor", name: "Editor Pro", tag: "For editors and creators posting every week", price: 5, minutes: 100, storageGB: 10, extra: 0.05,
    watermark: false, priority: false, tone: "starter", checkout: true,
  },
  {
    id: "agency", name: "Agency Pro", tag: "For agencies and daily posting", price: 24, minutes: 600, storageGB: 100, extra: 0.04,
    watermark: false, priority: true, tone: "pro", badge: "Best value",
  },
];

const money = (n) => (n < 1 ? "$" + n.toFixed(2) : "$" + (Number.isInteger(n) ? n : n.toFixed(2)));
const num = (n) => n.toLocaleString("en-US");

/** What a month of `minutes` cloud minutes costs on a plan (extra minutes added; null when the plan cannot cover it). */
function costOf(p, minutes) {
  if (minutes <= p.minutes) return p.price;
  return p.extra == null ? null : p.price + (minutes - p.minutes) * p.extra;
}

function Line({ ok = true, children }) {
  return html`<li class=${"pr-line" + (ok ? "" : " off")}><${Icon} name=${ok ? "check" : "x"} size="16" /><span>${children}</span></li>`;
}

function PlanCard({ p, cta, picked }) {
  return html`<article class=${"pr-card " + p.tone + (picked ? " picked" : "")} data-plan=${p.id} id=${"plan-" + p.id}>
    <div class="pr-top">
      <div class="row" style="gap:10px"><h2 class="pr-name">${p.name}</h2>${p.badge && html`<span class="pr-badge"><${Icon} name="spark" size="12" />${p.badge}</span>`}</div>
      <p class="pr-tag">${p.tag}</p>
      <div class="pr-price"><b>${p.price === 0 ? "$0" : "$" + p.price}</b><span>${p.price === 0 ? "forever" : "/month"}</span></div>
      ${cta}
    </div>
    <div class="pr-mins">
      <p class="pr-big"><${Icon} name="zap" size="16" /><b>${num(p.minutes)} cloud minutes</b><span class="muted"> / month</span></p>
      <p class="pr-tree"><span>About <b>${num(Math.floor(p.minutes / PER_VIDEO))} short videos</b></span><span>or <b>${num(p.minutes * 2)} min</b> of Google Drive footage</span></p>
    </div>
    <div class="pr-group">
      <p class="pr-glabel">Free on every plan</p>
      <ul class="pr-list">
        <${Line}>Renders on your own Mac or PC<//>
        <${Line}>Footage from your computer<//>
        <${Line}>AI edits with Claude or ChatGPT<//>
      </ul>
    </div>
    <div class="pr-group">
      <p class="pr-glabel">In this plan</p>
      <ul class="pr-list">
        <${Line}>${p.storageGB} GB storage<//>
        <${Line} ok=${!p.watermark}>${p.watermark ? "Rendrr watermark on exports" : "No watermark"}<//>
        <${Line} ok=${p.priority}>Faster cloud renders, front of the line<//>
        <${Line} ok=${p.extra != null}>${p.extra != null ? `Extra minutes ${money(p.extra)} each` : "No extra minutes"}<//>
      </ul>
    </div>
  </article>`;
}

/** Slide to how many short videos a month; the cheapest plan for it lights up. */
function Picker({ onPick }) {
  const [videos, setVideos] = useState(20);
  const minutes = videos * PER_VIDEO;
  const ranked = PLANS.map((p) => ({ p, cost: costOf(p, minutes) })).filter((x) => x.cost != null).sort((a, b) => a.cost - b.cost || b.p.minutes - a.p.minutes);
  const best = ranked[0];
  useEffect(() => { onPick(best.p.id); }, [best.p.id]);
  return html`<section class="card pr-pick" id="plan-picker">
    <div class="col" style="gap:4px"><b class="t-heading">Which plan fits?</b><p class="t-small muted">How many short videos do you make on our cloud each month?</p></div>
    <div class="pr-slide">
      <input type="range" min="1" max="150" step="1" value=${videos} aria-label="Short videos a month" id="pick-videos" onInput=${(e) => setVideos(+e.target.value)} />
      <b class="pr-count" id="pick-count">${videos} ${videos === 1 ? "video" : "videos"}</b>
    </div>
    <p class="pr-answer" id="pick-answer"><b>${best.p.name}</b> · ${best.cost === 0 ? "free" : money(best.cost) + " a month"}<span class="muted"> for ${num(minutes)} cloud minutes. Render on your own computer and it is free.</span></p>
  </section>`;
}

const USES = [
  ["1 minute of preview", "1 minute", "eye"],
  ["1 minute of export", "1 minute", "download"],
  ["1 minute in 4K or heavy effects", "4 minutes", "layers"],
  ["2 minutes of Google Drive footage", "1 minute", "drive"],
  ["Anything rendered on your Mac or PC", "Free", "laptop"],
  ["Footage uploaded from your computer", "Free", "folder"],
];

const yes = html`<${Icon} name="check" size="16" />`;
const no = html`<span class="muted">-</span>`;
const ROWS = [
  ["Price", (p) => (p.price ? `$${p.price} / month` : "$0")],
  ["Cloud render minutes", (p) => `${num(p.minutes)} / month`],
  ["Storage", (p) => `${p.storageGB} GB`],
  ["Extra minutes", (p) => (p.extra != null ? `${money(p.extra)} each` : no)],
  ["No watermark", (p) => (p.watermark ? no : yes)],
  ["Faster cloud renders", (p) => (p.priority ? yes : no)],
  ["Renders on your Mac or PC", () => "Free"],
  ["Footage from your computer", () => "Free"],
  ["Footage from Google Drive", () => "2 min = 1 minute"],
  ["4K or heavy effects", () => "1 min = 4 minutes"],
  ["AI edits with Claude or ChatGPT", () => "Free"],
];

const FAQ = [
  ["What is a render minute?", "One minute of video that our cloud makes for you. A preview counts, and so does an export."],
  ["Why is my own computer free?", "Your Mac or PC does the work, not ours. Keep the Rendrr app open and renders run there for free."],
  ["What if I use up my minutes?", "On Editor Pro and Agency Pro, each extra minute is added to the same monthly bill. On Free, keep rendering on your own computer or pick a plan."],
  ["Does the AI cost extra?", "No. Your own Claude or ChatGPT does the thinking, so Rendrr charges nothing for AI edits."],
  ["What counts more?", "4K and heavy effects (slow motion, stabilizing, cutting out a person) count 4 times. Footage from Google Drive or other cloud storage counts half: 2 minutes of footage is 1 render minute."],
  ["Is there a watermark?", "Free exports carry a small Rendrr mark. Editor Pro and Agency Pro have none."],
];

export function PricingPage() {
  const { go } = useNav(); const { user, openLogin } = useApp();
  const [payments, setPayments] = useState(false); const [picked, setPicked] = useState(null);
  useEffect(() => { if (!user) return; let on = true; api.getBillingOverview().then((b) => on && setPayments(!!b?.payments?.enabled)).catch(() => {}); return () => { on = false; }; }, [user]);
  const ctaFor = (p) => {
    if (p.id === "free") return user
      ? html`<${Btn} kind="white" className="pr-cta" id="cta-free" onClick=${() => go("/projects")}>Go to my projects<//>`
      : html`<${Btn} kind="white" className="pr-cta" id="cta-free" onClick=${() => openLogin(null, "signup")}>Start free<//>`;
    if (!payments) return html`<${Btn} kind="white" className="pr-cta" id=${"cta-" + p.id} disabled=${true}>Coming soon<//>`;
    return html`<${Btn} kind="white" className="pr-cta" id=${"cta-" + p.id} onClick=${() => go("/billing")}>Get ${p.name}<//>`;
  };
  return html`<div class="page pricing" id="pricing-page">
    <header class="pr-head">
      <h1 class="t-display">Plans</h1>
      <p class="pr-sub">Pay only for cloud renders. <b>Your own computer renders free.</b></p>
      <div class="pr-works"><span class="muted t-small">Edit with</span><${BrandLogo} brand="claude" size=${28} /><${BrandLogo} brand="chatgpt" size=${28} /><span class="muted t-small" style="margin-left:8px">Bring footage from</span><${BrandLogo} brand="drive" size=${28} /><${BrandLogo} brand="photos" size=${28} /><${BrandLogo} brand="dropbox" size=${28} /></div>
    </header>
    <div class="pr-cards">${PLANS.map((p) => html`<${PlanCard} key=${p.id} p=${p} cta=${ctaFor(p)} picked=${picked === p.id} />`)}</div>
    <p class="t-small muted pr-note">A short video here is 1 minute long, with 4 previews and 1 export. ${!payments && "Paid plans open soon."}</p>
    <${Picker} onPick=${setPicked} />
    <section class="pr-section" id="what-uses-minutes">
      <h2 class="t-title">What uses minutes</h2>
      <div class="pr-uses">${USES.map(([what, counts, ic]) => html`<div key=${what} class=${"pr-use" + (counts === "Free" ? " free" : "")}><span class="ico sm"><${Icon} name=${ic} size="18" /></span><span class="grow">${what}</span><b>${counts}</b></div>`)}</div>
    </section>
    <section class="pr-section" id="compare-plans">
      <h2 class="t-title">Compare plans</h2>
      <div class="pr-table-wrap"><table class="pr-table">
        <thead><tr><th scope="col">What you get</th>${PLANS.map((p) => html`<th key=${p.id} scope="col" class=${p.tone}>${p.name}</th>`)}</tr></thead>
        <tbody>${ROWS.map(([label, f]) => html`<tr key=${label}><th scope="row">${label}</th>${PLANS.map((p) => html`<td key=${p.id}>${f(p)}</td>`)}</tr>`)}</tbody>
      </table></div>
    </section>
    <section class="pr-section" id="pricing-faq">
      <h2 class="t-title">Questions</h2>
      <div class="pr-faq">${FAQ.map(([q, a]) => html`<details key=${q} class="pr-q"><summary>${q}<${Icon} name="down" size="16" /></summary><p>${a}</p></details>`)}</div>
    </section>
  </div>`;
}
