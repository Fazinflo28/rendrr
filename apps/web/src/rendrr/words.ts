// Words of a transcript, looked up fast: the editor asks these on every frame while a video plays.

/** Each word's place in the list, by its id. */
export function wordIndexById<W extends { id: string }>(words: W[]): Map<string, number> {
  const m = new Map<string, number>();
  words.forEach((w, i) => m.set(w.id, i));
  return m;
}

/** Which line each word is on (word id to line id). */
export function lineOfWord<L extends { id: string; words: { id: string }[] }>(lines: L[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines) for (const w of l.words) m.set(w.id, l.id);
  return m;
}

/** True when the words run in time order (each one starts no earlier than the one before). */
export function isSortedByTime<W extends { t: number }>(words: W[]): boolean {
  for (let i = 1; i < words.length; i++) if (words[i].t < words[i - 1].t) return false;
  return true;
}

/**
 * The last word in the list that starts at or before t: the same answer as words.filter((w) => w.t <= t).pop(),
 * found by halving when the words run in time order (sorted), else by the same scan. Null when there is none.
 */
export function lastWordAtOrBefore<W extends { t: number }>(words: W[], t: number, sorted: boolean): W | null {
  if (!sorted) {
    let hit: W | null = null;
    for (const w of words) if (w.t <= t) hit = w;
    return hit;
  }
  let lo = 0, hi = words.length; // first index whose word starts after t
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid].t <= t) lo = mid + 1; else hi = mid; }
  return lo > 0 ? words[lo - 1] : null;
}
