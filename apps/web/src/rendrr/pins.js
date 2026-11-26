// Pins: comments left on the picture itself. Click the video and a box opens at that spot (the video pauses); the
// comment keeps the moment and the spot (x, y in shares of the frame). Each pinned comment shows as a dot with its
// author's initials on the picture around its moment, and as a lime marker on the seek bar; clicking either goes to
// the moment and opens the comment over the picture. The boxes spread open from the dot and fold back into it.
// PinLayer sits inside the Player's screen (its `children`) and listens to clicks on the screen itself, so the
// player and the editor need no other change.
import { html, useState, useEffect, useRef, fmtTime, initials, useToast } from "./ui";

const OPEN_EVENT = "rendrr:pin-open";
/** Opens a pinned comment over the picture (from the seek bar's marker or the comment list). */
export const openPin = (c) => { if (c && c.x != null && c.y != null) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { id: c.id } })); };
export const isPinned = (c) => !!c && c.x != null && c.y != null;
const NEAR = 1.2; // seconds either side of its moment a dot shows
const CLOSE_MS = 170;
const TEXT_MAX = 160; // px the box's text grows to before it scrolls
/** Grows a text box with its words, up to TEXT_MAX, then it scrolls. */
const fit = (el) => { if (!el) return; el.style.height = "auto"; const h = Math.min(TEXT_MAX, el.scrollHeight); el.style.height = h + "px"; el.style.overflowY = el.scrollHeight > TEXT_MAX ? "auto" : "hidden"; };
const SEND = html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const r4 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

// Which way a box opens from its dot: away from the nearest edges, so it stays on the picture.
const side = (x, y) => ({ h: x > 0.58 ? "l" : "r", v: y > 0.55 ? "u" : "d" });

function Bubble({ x, y, closing, children, label, id }) {
  const s = side(x, y);
  return html`<div id=${id} class=${`pin-box pin-${s.h}${s.v}` + (closing ? " closing" : "")} role="dialog" aria-label=${label} style=${{ left: x * 100 + "%", top: y * 100 + "%" }} onClick=${(e) => e.stopPropagation()} onPointerDown=${(e) => e.stopPropagation()}>${children}</div>`;
}

export function PinLayer({ comments = [], pb, off = false, me = "You", onAdd, onResolve, label = "Comment on this spot" }) {
  const ref = useRef(null);
  const toast = useToast();
  const [draft, setDraft] = useState(null); // { x, y, time }
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [closing, setClosing] = useState(null); // "draft" | "open"
  const st = useRef({}); st.current = { draft, text, openId, off, pb };
  const textRef = useRef(null);
  useEffect(() => { fit(textRef.current); }, [draft, text]);
  const pins = comments.filter(isPinned);

  const close = (which, after) => {
    setClosing(which);
    setTimeout(() => { setClosing(null); if (which === "draft") { setDraft(null); setText(""); } else setOpenId(null); after?.(); }, CLOSE_MS);
  };

  // Clicks on the screen (not on its buttons, a drawing being made or the boxes) drop a pin there.
  useEffect(() => {
    const screen = ref.current?.parentElement;
    if (!screen) return;
    const onClick = (e) => {
      const s = st.current;
      if (s.off || e.defaultPrevented || e.button !== 0) return;
      if (e.target.closest("button, a, input, textarea, select, .pin-box, .pin-dot, .cmt-ink.drawing, [data-nopin]")) return;
      if (s.openId) { close("open"); return; } // the first click away closes the comment being read
      if (s.draft && s.text.trim()) return; // words written: keep the box where it is
      const r = screen.getBoundingClientRect();
      if (!r.width || !r.height) return;
      s.pb.setPlaying(false);
      setDraft({ x: r4((e.clientX - r.left) / r.width), y: r4((e.clientY - r.top) / r.height), time: s.pb.time });
    };
    screen.addEventListener("click", onClick);
    screen.classList.add("pin-screen");
    return () => { screen.removeEventListener("click", onClick); screen.classList.remove("pin-screen"); };
  }, []);
  useEffect(() => { if (off && draft && !text.trim()) setDraft(null); }, [off]);
  // The seek bar's markers and the comment list open a pin here.
  useEffect(() => {
    const on = (e) => { const id = e.detail?.id; if (!id) return; setDraft((d) => (d && !st.current.text.trim() ? null : d)); setOpenId(id); };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  // Playing on closes the comment being read; Escape closes either box.
  useEffect(() => { if (pb.playing && openId && !closing) close("open"); }, [pb.playing]);
  useEffect(() => {
    const k = (e) => { if (e.key !== "Escape") return; if (st.current.draft) close("draft"); else if (st.current.openId) close("open"); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const post = async () => {
    if (!draft || !text.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd?.({ time: draft.time, x: draft.x, y: draft.y, text: text.trim() });
      close("draft");
      toast("Comment pinned at " + fmtTime(draft.time), { icon: "comment" });
    } catch (e) { toast(e.message || "Could not add the comment."); } finally { setBusy(false); }
  };
  const go = (c) => { pb.setPlaying(false); pb.seek(c.time); if (draft && !text.trim()) setDraft(null); setOpenId(c.id); };

  const opened = pins.find((c) => c.id === openId);
  const shown = pins.filter((c) => c.id === openId || (!c.resolved && Math.abs(pb.time - c.time) <= NEAR));
  return html`<div class="pin-layer" ref=${ref} aria-hidden=${off ? "true" : null}>
    ${shown.map((c) => {
      const d = Math.abs(pb.time - c.time), fade = c.id === openId ? 1 : Math.max(0.35, 1 - d / NEAR);
      return html`<button key=${c.id} type="button" class=${"pin-dot" + (c.id === openId ? " on" : "") + (c.mine === false ? " client" : "")} data-pin=${c.id} style=${{ left: c.x * 100 + "%", top: c.y * 100 + "%", opacity: fade }} title=${(c.author || "") + ": " + c.text} aria-label=${"Comment by " + (c.author || "someone") + " at " + fmtTime(c.time)} onClick=${(e) => { e.stopPropagation(); go(c); }}>${initials(c.author || me)}</button>`;
    })}
    ${draft && html`<span class="pin-dot new" style=${{ left: draft.x * 100 + "%", top: draft.y * 100 + "%" }}>${initials(me)}</span>`}
    ${draft && html`<${Bubble} id="pin-compose" x=${draft.x} y=${draft.y} closing=${closing === "draft"} label=${label}>
      <form class="pin-compose" onSubmit=${(e) => { e.preventDefault(); post(); }}>
        <textarea id="pin-text" ref=${textRef} class="pin-text" rows="1" placeholder="Leave a comment…" value=${text} autoFocus onInput=${(e) => { setText(e.target.value); fit(e.target); }} onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); } }} />
        <div class="pin-foot"><span class="pin-when">${fmtTime(draft.time)}</span><button type="button" class="pin-btn quiet" id="pin-cancel" onClick=${() => close("draft")}>Cancel</button><button type="submit" class="pin-send" id="pin-post" aria-label="Post comment" title="Post (Enter)" disabled=${!text.trim() || busy}>${busy ? html`<span class="pin-spin" />` : SEND}</button></div>
      </form>
    <//>`}
    ${opened && html`<${Bubble} id="pin-view" x=${opened.x} y=${opened.y} closing=${closing === "open"} label=${"Comment by " + (opened.author || "someone")}>
      <div class="pin-head"><span class="pin-av">${initials(opened.author || me)}</span><span class="pin-who">${opened.author || "You"}</span><span class="pin-when">${fmtTime(opened.time, true)}</span><button type="button" class="pin-x" aria-label="Close" onClick=${() => close("open")}>×</button></div>
      <p class="pin-body">${opened.text || "(no words)"}</p>
      ${onResolve && html`<div class="pin-acts"><button type="button" class="pin-btn quiet" id="pin-resolve" onClick=${() => { onResolve(opened); close("open"); }}>${opened.resolved ? "Open again" : "Mark done"}</button></div>`}
    <//>`}
  </div>`;
}
