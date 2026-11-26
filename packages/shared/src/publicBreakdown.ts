// The style file as the public breakdown shown beside a published video in Explore (GET /gallery/:id/breakdown).
// Plain words first, then shot by shot, fonts, b-roll, camera, animations, transitions, music, sound effects and
// what a new video in this style needs. Only what anyone watching the video could see or hear: no ids, no file
// names, no owner. Pure functions, no I/O.
import { EASING_WORDS, topCounts } from "./referenceMap";
import { plainWords, type StyleFile } from "./styleFile";

export type PublicShot = { start: number; end: number; kind: string; what: string | null; says: string };
export type PublicSection = { title: string; lines: string[] };
export type PublicBreakdown = {
  /** One or two sentences on what the video is (the AI's own words from the frames), when there are some. */
  summary: string | null;
  /** Short facts for the top: length, shape, kind, pace. */
  facts: { label: string; value: string }[];
  /** The plain-words list: "Pace: ...", "Captions: ...", one line each. */
  plain: string[];
  shots: PublicShot[];
  fonts: { family: string; weight?: string; use: string; color?: string }[];
  /** Colours as hex, biggest share first. */
  palette: string[];
  /** The detail, one titled list each: b-roll, camera, animations, transitions, music, sound effects, look. */
  sections: PublicSection[];
  needs: string[];
};

const s1 = (n: number) => `${Math.round(n * 10) / 10} s`;
const span = (a: number, b: number) => `${Math.round(a * 10) / 10} to ${Math.round(b * 10) / 10} s`;
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const SHAPE: Record<string, string> = { "9:16": "Vertical (9:16)", "16:9": "Landscape (16:9)", "1:1": "Square (1:1)", "4:5": "Portrait (4:5)" };
const KIND: Record<string, string> = { "talking head": "Talking head", "motion graphics": "Motion graphics", footage: "Camera footage", mixed: "Camera and graphics" };
/** Ids, keys, links and emails never leave the server, whatever the AI wrote in its notes. */
const clean = (s: string) => s.replace(/https?:\/\/\S+/gi, "").replace(/\S+@\S+\.\S+/g, "").replace(/\bc[a-z0-9]{20,}\b/g, "").replace(/\s{2,}/g, " ").trim();

export function publicBreakdown(f: StyleFile): PublicBreakdown {
  const m = f.map ?? null, n = f.notes ?? null, S = f.video.seconds;
  const facts: PublicBreakdown["facts"] = [{ label: "Length", value: `${Math.round(S)} seconds` }, { label: "Shape", value: SHAPE[f.video.shape] ?? f.video.shape }];
  if (m) facts.push({ label: "Type", value: KIND[m.kind] ?? m.kind });
  const cuts = Math.round((f.pacing.cutsPerMin * S) / 60), events = cuts + (m ? m.camera.count + m.animations.count : 0);
  if (events) facts.push({ label: "Pace", value: `Something new every ${Math.max(0.3, Math.round((S / events) * 10) / 10)} s` });
  if (f.pacing.wordsPerMin) facts.push({ label: "Talking speed", value: `${Math.round(f.pacing.wordsPerMin)} words a minute` });

  // Plain words without the summary line (it shows on its own at the top).
  const plain = plainWords(f).filter((x) => x !== n?.summary).map(clean);

  // Shot by shot: the measured scenes, each with what the AI saw in it.
  const seen = [...(n?.scenes ?? [])].sort((a, b) => a.at - b.at);
  const shots: PublicShot[] = m
    ? m.scenes.map((s) => {
        const w = seen.filter((x) => x.at >= s.start - 0.15 && x.at < s.end);
        return { start: s.start, end: s.end, kind: w[0]?.type ? clean(w[0].type) : s.kind, what: w.length ? clean(w.map((x) => x.what).join(". ")) : null, says: clip(s.says) };
      })
    : seen.map((x, k) => ({ start: x.at, end: seen[k + 1]?.at ?? S, kind: x.type ? clean(x.type) : "scene", what: clean(x.what), says: "" }));

  const sections: PublicSection[] = [];
  if (m?.broll?.count) sections.push({ title: "B-roll, one by one", lines: m.broll.list.map((b) => `${span(b.start, b.end)}: ${b.type}${b.says ? ` over "${clip(b.says, 80)}"` : ""}`) });
  if (m?.camera.count) sections.push({ title: "Camera moves", lines: m.camera.list.map((c) => `${s1(c.start)}: ${c.kind}, ${Math.round(c.ms / 100) / 10} s, ${EASING_WORDS[c.easing] ?? c.easing}`) });
  if (m?.animations.count) {
    const a = m.animations;
    sections.push({ title: "Animations", lines: [
      `${a.count} in all, about ${Math.round(a.perMin)} a minute, each about ${Math.round((a.medianMs ?? 0) / 100) / 10} s.`,
      `Most common: ${topCounts(a.kinds, 4).map(([k, v]) => `${k} (${v})`).join(", ")}.`,
      ...a.list.slice(0, 40).map((x) => `${s1(x.start)}: ${x.kind}`),
    ] });
  }
  const tr = f.transitions.list.filter((t) => t[1] !== "cut");
  sections.push({ title: "Transitions", lines: tr.length ? tr.map((t) => `${s1(t[0])}: ${t[1] === "flash" ? "white flash" : t[1]}`) : ["Hard cuts only."] });
  const mu = m?.music;
  sections.push({ title: "Music", lines: [
    ...(n?.music ? [clean(n.music)] : []),
    ...(mu ? [
      `${mu.words.join(", ")}${mu.bpm ? `, about ${Math.round(mu.bpm)} beats a minute` : ""}.`,
      `Plays ${mu.sections.map((x) => span(x.start, x.end)).join(", ")} (${Math.round(mu.share * 100)}% of the video).`,
      ...mu.changes.map((x) => `${s1(x[0])}: ${x[1]}`),
      ...mu.stops.map((t) => `${s1(t)}: stops`),
    ] : n?.music ? [] : ["No music found."]),
  ] });
  const fx = m?.sfx;
  sections.push({ title: "Sound effects", lines: [
    ...(n?.sfx ? [clean(n.sfx)] : []),
    ...(fx?.count ? fx.list.map((x) => `${s1(x.t)}: ${x.kind}${x.near ? ` on the ${x.near[1]}` : ""}`) : n?.sfx ? [] : ["No sound effects found."]),
  ] });
  const look = [n?.look ? clean(n.look) : "", f.grade?.words?.length ? `Colour grade: ${f.grade.words.join(", ")}.` : ""].filter(Boolean);
  if (look.length) sections.push({ title: "Look", lines: look });

  return {
    summary: n?.summary ? clean(n.summary) : null,
    facts, plain, shots,
    fonts: (n?.fonts ?? []).map((x) => ({ family: clean(x.family), ...(x.weight ? { weight: clean(x.weight) } : {}), use: clean(x.use), ...(x.color ? { color: clean(x.color) } : {}) })),
    palette: (m?.palette ?? []).slice(0, 6).map((p) => p[0]),
    sections,
    needs: (m?.needs ?? []).map((x) => clean(x.replace(/\s*\(before editing.*$/i, ""))),
  };
}
