// Controls that change the edit live while they move and make one undo step when they let go (the editor's tabs).
import { useRef, html } from "./ui";

// A slider that changes the edit live while it moves and makes one undo step when let go.
function OpSlider({ id, label, value, min, max, step, show, opFor, H, liveOp, disabled = false }) {
  const base = useRef(null);
  const start = () => { if (!base.current) base.current = H.state; };
  const end = () => { if (base.current) { H.commitFrom(base.current); base.current = null; } };
  return html`<label class="t-small" style="display:grid;gap:2px"><span class="row between"><span>${label}</span><span class="muted mono" data-val=${id}>${show(value)}</span></span>
    <input type="range" id=${id} min=${min} max=${max} step=${step} value=${value} disabled=${disabled} onPointerDown=${start} onKeyDown=${start} onInput=${(e) => { start(); liveOp(H.state, opFor(+e.target.value)); }} onPointerUp=${end} onKeyUp=${end} onBlur=${end} /></label>`;
}

// A colour field that changes the edit live while it is picked and makes one undo step when it closes.
function OpColor({ id, value, opFor, H, liveOp }) {
  const base = useRef(null);
  const start = () => { if (!base.current) base.current = H.state; };
  const end = () => { if (base.current) { H.commitFrom(base.current); base.current = null; } };
  return html`<input type="color" class="swatch" id=${id} value=${value} onFocus=${start} onInput=${(e) => { start(); liveOp(H.state, opFor(e.target.value)); }} onBlur=${end} onChange=${() => {}} />`;
}

export { OpSlider, OpColor };
