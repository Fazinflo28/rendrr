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

// Phase 5: a colour wheel (Lumetri's): drag the dot; its angle is the hue, its distance from the middle the amount
// (0-100). Live while dragging, one undo step when let go; double-click puts it back in the middle.
function OpWheel({ id, label, value, opFor, H, liveOp, size = 76 }) {
  const base = useRef(null), box = useRef(null);
  const start = () => { if (!base.current) base.current = H.state; };
  const end = () => { if (base.current) { H.commitFrom(base.current); base.current = null; } };
  const hue = value?.hue ?? 0, amount = value?.amount ?? 0, r = size / 2;
  const at = (e) => {
    // On-screen size: the panel may be drawn scaled.
    const b = box.current.getBoundingClientRect(), R = b.width / 2, x = e.clientX - b.left - R, y = e.clientY - b.top - b.height / 2;
    const a = Math.min(100, Math.round((Math.hypot(x, y) / R) * 100)), h = Math.round(((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360);
    liveOp(H.state, opFor({ hue: h, amount: a }));
  };
  const dx = Math.cos((hue * Math.PI) / 180) * (amount / 100) * r, dy = -Math.sin((hue * Math.PI) / 180) * (amount / 100) * r;
  return html`<div class="col" style="gap:4px;align-items:center" data-wheel=${id}>
    <div ref=${box} id=${id} role="slider" aria-label=${label} aria-valuetext=${amount ? `${hue}° ${amount}` : "none"} tabindex="0"
      style=${{ width: size + "px", height: size + "px", borderRadius: "50%", position: "relative", cursor: "crosshair", touchAction: "none",
        background: "radial-gradient(circle, rgba(128,128,128,1) 0%, rgba(128,128,128,0) 70%), conic-gradient(from 90deg, #ff0000, #ff00ff, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)" }}
      onMouseDown=${(e) => e.preventDefault()} onPointerDown=${(e) => { e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); start(); at(e); }} onPointerMove=${(e) => { if (base.current) at(e); }} onPointerUp=${end}
      onDblClick=${() => { start(); liveOp(H.state, opFor({ amount: 0 })); end(); }}>
      <span style=${{ position: "absolute", left: r + dx - 5 + "px", top: r + dy - 5 + "px", width: "10px", height: "10px", borderRadius: "50%", border: "2px solid #fff", boxShadow: "0 0 2px #000", pointerEvents: "none" }} /></div>
    <span class="t-small">${label}</span><span class="t-small muted mono" data-val=${id}>${amount ? `${hue}° ${amount}` : "none"}</span></div>`;
}

export { OpSlider, OpColor, OpWheel };
