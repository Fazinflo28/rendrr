/**
 * A video's thumbnail keeps the link it was first given while that link is good (5 minutes to spare): the Library
 * refreshes its list every few seconds while a video is being prepared, and a new link for the same picture made the
 * browser fetch every thumbnail again each time.
 */
const thumbLinks: Record<string, { url: string; until: number }> = {};

/** When a signed link stops working (from its X-Amz-Date and X-Amz-Expires); 10 minutes from now when it does not say. */
export function linkUntil(url: string, now = Date.now()): number {
  try {
    const q = new URL(url).searchParams, d = q.get("X-Amz-Date"), e = Number(q.get("X-Amz-Expires"));
    if (!d || !e) return now + 10 * 60_000;
    return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15)) + e * 1000;
  } catch { return 0; }
}

export function keepThumb<T extends { thumb?: unknown }>(v: T, now = Date.now()): T {
  if (!v || typeof v.thumb !== "string" || !v.thumb) return v;
  const path = v.thumb.split("?")[0], had = thumbLinks[path];
  if (had && had.until > now + 5 * 60_000) (v as { thumb: string }).thumb = had.url;
  else thumbLinks[path] = { url: v.thumb, until: linkUntil(v.thumb, now) };
  return v;
}
