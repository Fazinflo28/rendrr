// Is this file the original of local footage? Asked when the user gives the original for a full-quality final.
// The same name and size is enough. A renamed or re-saved copy (or the uncompressed file the footage came from) is the
// same video when its length matches: the edit's times line up with it. The worker checks the length again on the
// file itself before it renders.

export type OriginalWant = { originalName?: string | null; originalSize?: number | null; seconds?: number | null };
export type OriginalGiven = { name: string; size: number; seconds?: number | null };

/** Names compared as people see them: Unicode form, case, spaces (a no-break space included). */
export const sameFileName = (a: string, b: string) => {
  const n = (s: string) => s.normalize("NFC").replace(/[\s  ]+/g, " ").trim().toLowerCase();
  return n(a) === n(b);
};

/** How far two lengths of the same video may be apart (containers round their durations differently). */
export const lengthTolerance = (seconds: number) => Math.max(1, seconds * 0.005);

export function sameOriginal(given: OriginalGiven, want: OriginalWant): { ok: boolean; by?: "name" | "length" } {
  const nameOk = !want.originalName || sameFileName(given.name, want.originalName);
  const sizeOk = !want.originalSize || Number(want.originalSize) === given.size;
  if (nameOk && sizeOk) return { ok: true, by: "name" };
  if (given.seconds != null && want.seconds && Math.abs(given.seconds - want.seconds) <= lengthTolerance(want.seconds)) return { ok: true, by: "length" };
  return { ok: false };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

/** What to tell the user when the file is not the original: what they gave next to what we need. */
export function notOriginalMessage(given: OriginalGiven, want: OriginalWant) {
  const g = [mb(given.size), given.seconds != null ? clock(given.seconds) : null].filter(Boolean).join(", ");
  const w = [want.originalSize ? mb(Number(want.originalSize)) : null, want.seconds ? clock(want.seconds) : null].filter(Boolean).join(", ");
  return `That is a different video. You picked '${given.name}' (${g}); we need '${want.originalName || "the original"}'${w ? ` (${w})` : ""}.`;
}
