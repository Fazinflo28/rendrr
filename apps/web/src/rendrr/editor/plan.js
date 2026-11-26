// The render plan for the live player (audit #19). Planning a long edit can take long enough that typing and
// dragging wait for it. While planning this edit is quick, the plan is made right here, exactly as before. Once one
// plan takes longer than SLOW_MS, the next ones are made in a background worker: the player keeps the last plan until
// the new one arrives, and only the newest change waits its turn (the ones in between are skipped). If the browser
// has no worker, or the worker fails for any reason, planning goes back to running here.
import { useEffect, useMemo, useRef, useState } from "../ui";
import { planRender } from "@rendrr/shared/renderPlan";

const SLOW_MS = 24;
const NOT_HERE = Symbol("in the worker");
// A plan that cannot be made (everything is cut) is null, as in the editor before.
const planOf = (input) => { try { return planRender(input); } catch { return null; } };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

let worker = null, broken = false, seq = 0;
const waiting = new Map();
function stopWorker() {
  broken = true;
  for (const done of waiting.values()) done(null);
  waiting.clear();
  try { worker?.terminate(); } catch {}
  worker = null;
}
function getWorker() {
  if (broken || typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./planWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, ok, plan } = e.data || {}; const done = waiting.get(id);
      if (!done) return;
      waiting.delete(id);
      if (ok) done({ plan }); else { done(null); stopWorker(); }
    };
    worker.onerror = () => stopWorker();
    worker.onmessageerror = () => stopWorker();
    return worker;
  } catch { stopWorker(); return null; }
}
function planInWorker(input) {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    try { w.postMessage({ id, input }); } catch { waiting.delete(id); resolve(null); stopWorker(); }
  });
}

function usePlan(input) {
  const st = useRef({ slow: false, busy: false, next: null, done: null, shown: undefined }).current;
  const [, bump] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const here = useMemo(() => {
    if (st.slow && getWorker()) return NOT_HERE;
    const t0 = now(); const plan = planOf(input);
    if (now() - t0 > SLOW_MS) st.slow = true;
    return plan;
  }, [input]);
  useEffect(() => {
    if (here !== NOT_HERE) return;
    st.next = { input };
    if (st.busy) return;
    const pump = () => {
      const job = st.next; st.next = null;
      if (!job) return;
      st.busy = true;
      planInWorker(job.input).then((r) => {
        st.busy = false;
        if (!alive.current) return;
        st.done = { plan: r ? r.plan : planOf(job.input) }; // the worker failed: made here instead
        bump((n) => n + 1);
        pump();
      });
    };
    pump();
  }, [here, input]);
  const plan = here !== NOT_HERE ? here : st.done ? st.done.plan : st.shown ?? null;
  st.shown = plan;
  return plan;
}

export { usePlan, planOf, SLOW_MS };
