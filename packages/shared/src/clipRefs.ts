// Clip references: typing @ in a comment box (the editor, a pinned comment, the Rendrr app in the chat) opens the
// footage picker; the clip picked goes into the comment as @[name](clip:videoId). The comment keeps the video's real id,
// so the AI reading it (get_comments) knows exactly which library video to use, with no name to guess.

export type ClipRef = { name: string; id: string };

/** One reference in a comment's text: @[name](clip:id). */
export const CLIP_REF_RE = /@\[([^\]\n]{1,120})\]\(clip:([A-Za-z0-9_-]{1,80})\)/g;
/** The most clip references one comment keeps track of. */
export const CLIP_REFS_MAX = 12;

/** A name safe inside the brackets: no brackets, parentheses or new lines, 80 characters at most. */
export const clipRefName = (name: string) => (name || "clip").replace(/[[\]()\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "clip";

/** The text a picked clip puts into a comment. */
export const clipRef = (name: string, id: string) => `@[${clipRefName(name)}](clip:${id})`;

/** Every clip a comment names, in order, each id once. */
export function clipRefs(text: string | null | undefined): ClipRef[] {
  const out: ClipRef[] = [], seen = new Set<string>();
  for (const m of (text || "").matchAll(CLIP_REF_RE)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ name: m[1].trim(), id: m[2] });
    if (out.length >= CLIP_REFS_MAX) break;
  }
  return out;
}

/** The comment's text with each reference as @"name" (how a person reads it). */
export const clipRefsPlain = (text: string | null | undefined) => (text || "").replace(CLIP_REF_RE, (_m, n: string) => `@"${n.trim()}"`);

/** The comment's text split into plain parts and clip references, to draw the references as chips. */
export function clipRefParts(text: string | null | undefined): (string | ClipRef)[] {
  const out: (string | ClipRef)[] = [], s = text || "";
  let last = 0;
  for (const m of s.matchAll(CLIP_REF_RE)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    out.push({ name: m[1].trim(), id: m[2] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** The @ being typed just before the caret: its query (the words after it) and where it starts, or null. An @ counts at
 *  the start or after a space or a bracket, so an email address does not open the picker. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = (text || "").slice(0, Math.max(0, caret));
  const m = /(^|[\s(\[{"'])@([^@\n]{0,40})$/.exec(before);
  if (!m) return null;
  const q = m[2];
  if (/\s{2,}/.test(q) || /^\s/.test(q)) return null;
  // A reference already there (@[name](clip:..)) is not a new @.
  if (q.startsWith("[")) return null;
  return { start: before.length - q.length - 1, query: q };
}

/** The footage picker's hover preview: a tiny, silent clip of a library video (about 5 seconds, 320 px on the long
 *  side, 12 frames a second, tens of KB), kept with the video's frames (deleted with them), made once on the server
 *  from the preview copy so a hover never waits on the full file. */
export const hoverKeyOf = (framesDir: string) => `${framesDir.replace(/\/?$/, "/")}hover-v1.mp4`;
export const HOVER_SECONDS = 5;
/** Redis: a hover clip of this video is in storage. */
export const hoverMarkKey = (videoId: string) => `hover:${videoId}`;
