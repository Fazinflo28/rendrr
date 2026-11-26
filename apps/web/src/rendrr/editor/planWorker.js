// The background worker that makes the live player's render plan for a long edit (audit #19, see plan.js).
import { planRender } from "@rendrr/shared/renderPlan";

self.onmessage = (e) => {
  const { id, input } = e.data || {};
  let plan = null;
  try { plan = planRender(input); } catch { plan = null; } // everything is cut, as in the editor
  try { self.postMessage({ id, ok: true, plan }); } catch { self.postMessage({ id, ok: false }); }
};
