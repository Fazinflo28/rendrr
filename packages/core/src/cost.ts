// What a job used besides CPU and memory, noted from deep inside the code that does the work: seconds of audio sent to
// transcription, bytes sent out of this service (uploads to the storage bucket and to Google Drive count: Railway
// bills a service for data it sends over the public network, buckets included), and the render's output size. The
// worker runs each job inside costScope(); outside one, noteCost does nothing.
import { AsyncLocalStorage } from "node:async_hooks";

export type CostNotes = { transcribeSeconds: number; egressBytes: number; outputBytes: number; kind?: string; refId?: string };
const store = new AsyncLocalStorage<CostNotes>();

export function costScope<T>(notes: CostNotes, fn: () => Promise<T>): Promise<T> {
  return store.run(notes, fn);
}
export function noteCost(n: Partial<Omit<CostNotes, "kind" | "refId">> & { kind?: string; refId?: string }) {
  const s = store.getStore();
  if (!s) return;
  s.transcribeSeconds += Math.max(0, n.transcribeSeconds ?? 0);
  s.egressBytes += Math.max(0, n.egressBytes ?? 0);
  s.outputBytes += Math.max(0, n.outputBytes ?? 0);
  if (n.kind) s.kind = n.kind;
  if (n.refId) s.refId = n.refId;
}
export const newCostNotes = (): CostNotes => ({ transcribeSeconds: 0, egressBytes: 0, outputBytes: 0 });
