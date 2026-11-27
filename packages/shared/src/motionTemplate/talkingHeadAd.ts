// "Talking-head ad": a Rendrr preset motion template, broken down frame by frame from a founder-style fintech ad
// (33.6 s, 9:16): one person talks to camera in an office, cut every 1 to 2 s with whips and overexposure flashes to
// b-roll, word-timed captions, a kinetic title on dark boxes, a number disc, a corner logo and a blue end card.
// Timing is the reference's to the word (its transcript's word times); every word, picture, video and colour is a
// slot. The footage (talking head and b-roll) is built as an edit around the graphic (edit.shots): the talking head
// is one video whose speech runs on across the cuts, the b-roll shots push in with motion-blurred whips.
const W = 1080, H = 1920;

const slots = [
  { id: "brand", type: "text", label: "Product name", default: "Nimbus", maxChars: 16 },
  { id: "logo", type: "image", label: "Logo in white on a see-through background", default: "" },
  { id: "speaker", type: "image", label: "Talking-head video (the person speaking to camera)", default: "", video: true },
  { id: "broll_logo", type: "image", label: "B-roll 1: the logo on a screen", default: "", video: true },
  { id: "broll_site", type: "image", label: "B-roll 2: the product's website on a laptop", default: "", video: true },
  { id: "broll_walk", type: "image", label: "B-roll 3: the speaker walking away (two short cuts)", default: "", video: true },
  { id: "broll_old1", type: "image", label: "B-roll 4: the old way (writing by hand)", default: "", video: true },
  { id: "broll_old2", type: "image", label: "B-roll 5: the old way (a calculator, paperwork)", default: "", video: true },
  { id: "screen", type: "image", label: "Screen recording of the product", default: "", video: true },
  { id: "broll_fees1", type: "image", label: "B-roll 6: a headline about the cost", default: "", video: true },
  { id: "broll_fees2", type: "image", label: "B-roll 7: a page about the cost", default: "", video: true },
  {
    id: "script", type: "text", maxChars: 600,
    label: "Captions, one per | (same word counts keep the word timing)",
    default: "You've seen Nimbus.|You know it's|a simpler way to get|worldwide|client payments.|And yet,|you're still using|the same old|payment method.|Maybe|switching|sounds|like an effort.|But, it isn't.|With Nimbus,|you can get started|in just five minutes|and manage|all your global|client payments|from one place.|And I probably|don't have to|remind you|how much|you could save on|transfer fees.|We've already had|that conversation.|Since we are|meeting again,|maybe this is|your sign|to finally|give|Nimbus a try.",
  },
  { id: "title", type: "text", label: "Kinetic title, all caps (two lines, | between)", default: "WORLDWIDE|CLIENT PAYMENTS", maxChars: 40 },
  { id: "disc_number", type: "text", label: "Big number in the disc", default: "5", maxChars: 3 },
  { id: "disc_label", type: "text", label: "Word under the number", default: "Minutes", maxChars: 12 },
  { id: "end1", type: "text", label: "End card line 1 (white)", default: "The smarter way", maxChars: 20 },
  { id: "end2", type: "text", label: "End card line 2 (white)", default: "to get paid", maxChars: 20 },
  { id: "end3", type: "text", label: "End card line 3 (accent)", default: "from clients", maxChars: 20 },
  { id: "end4", type: "text", label: "End card line 4 (accent)", default: "worldwide.", maxChars: 20 },
  { id: "f1_title", type: "text", label: "Feature 1 title (accent)", default: "Fully", maxChars: 18 },
  { id: "f1_sub", type: "text", label: "Feature 1 line", default: "licensed", maxChars: 18 },
  { id: "f2_title", type: "text", label: "Feature 2 title (accent)", default: "150+ countries", maxChars: 18 },
  { id: "f2_sub", type: "text", label: "Feature 2 line", default: "supported", maxChars: 18 },
  { id: "f3_title", type: "text", label: "Feature 3 title (accent)", default: "24hrs", maxChars: 18 },
  { id: "f3_sub", type: "text", label: "Feature 3 line", default: "settlements", maxChars: 18 },
  { id: "f4_title", type: "text", label: "Feature 4 title (accent)", default: "ISO 27001", maxChars: 18 },
  { id: "f4_sub", type: "text", label: "Feature 4 line", default: "certified", maxChars: 18 },
  { id: "cta", type: "text", label: "Button", default: "Sign up now", maxChars: 18 },
  { id: "brand_color", type: "color", label: "End card blue", default: "#3A4DAA" },
  { id: "accent", type: "color", label: "Accent (end card lines and feature titles)", default: "#6EE3A8" },
  { id: "disc_top", type: "color", label: "Disc gradient top", default: "#45519A" },
  { id: "disc_bottom", type: "color", label: "Disc gradient bottom", default: "#2C3253" },
  { id: "cta_from", type: "color", label: "Button gradient left", default: "#5DC48A" },
  { id: "cta_to", type: "color", label: "Button gradient right", default: "#1E8E55" },
];

// The talking head and b-roll shots. A whip pushes the last shot out (motion blurred, ~0.1-0.3 s); the flashes are
// the graphic's (an overexposure on the cut). Times in the reference's seconds.
type Shot = { id: string; slot: string; t0: number; t1: number; from?: number; in?: { type: "whip" | "cut"; dur?: number; dir?: "left" | "right" | "up" | "down" }; keys?: { t: number; scale?: number; x?: number; y?: number; ease?: "linear" | "in" | "out" | "in-out" }[]; blur?: number; what: string };
const whip = (dur: number) => ({ type: "whip" as const, dur, dir: "left" as const });
const shots: Shot[] = [
  { id: "s1", slot: "speaker", t0: 0, t1: 0.97, in: { type: "cut" }, what: "Speaker walks into frame in a corridor; opens on a white flash" },
  { id: "s2", slot: "broll_logo", t0: 0.97, t1: 1.93, from: 0, in: whip(0.12), keys: [{ t: 0.28, scale: 1 }, { t: 0.78, scale: 1.058, ease: "linear" }], what: "Logo on a laptop screen, a 6% push in" },
  { id: "s3", slot: "broll_site", t0: 1.93, t1: 3.13, from: 0, in: whip(0.12), what: "The website on a laptop on a concrete shelf, hard window light" },
  { id: "s4", slot: "speaker", t0: 3.13, t1: 4.62, in: whip(0.2), what: "Close-up of the speaker under the kinetic title" },
  { id: "s5", slot: "broll_walk", t0: 4.62, t1: 4.93, from: 0, in: { type: "cut" }, what: "Walking away down the corridor, white flash" },
  { id: "s6", slot: "speaker", t0: 4.93, t1: 6.47, in: whip(0.3), what: "Speaker in a kitchen, holding a mug" },
  { id: "s7", slot: "broll_old1", t0: 6.47, t1: 7.17, from: 0, in: whip(0.3), what: "The old way: a hand writing on paper, white flash" },
  { id: "s8", slot: "broll_old2", t0: 7.17, t1: 7.93, from: 0, in: whip(0.13), what: "The old way: a calculator and paperwork" },
  { id: "s9", slot: "speaker", t0: 7.93, t1: 11.67, in: { type: "cut" }, keys: [{ t: 0.2, scale: 1 }, { t: 3.74, scale: 1.22, ease: "linear" }], what: "Speaker in the kitchen, a slow 22% push in" },
  { id: "s10", slot: "broll_walk", t0: 11.67, t1: 11.97, from: 0.4, in: { type: "cut" }, what: "Walking away in the open office, white flash" },
  { id: "s11", slot: "speaker", t0: 11.97, t1: 14.17, in: whip(0.2), what: "Speaker in the open office; the disc pops in beside her and she steps in front of it" },
  { id: "s12", slot: "speaker", t0: 14.17, t1: 15.6, in: { type: "cut" }, blur: 40, what: "The same shot blurred hard behind the number disc" },
  { id: "s13", slot: "screen", t0: 15.6, t1: 18.67, from: 0, in: whip(0.1), keys: [{ t: 0, scale: 1.16, x: 0.06 }, { t: 1.25, scale: 1, x: 0, ease: "linear" }, { t: 1.48, y: 0 }, { t: 1.98, y: -0.12, ease: "linear" }], what: "Screen recording: zooms out and pans right, then scrolls down; a hand cursor clicks" },
  { id: "s14", slot: "speaker", t0: 18.67, t1: 21.63, in: { type: "cut" }, what: "Speaker in the open office, back from a white dip" },
  { id: "s15", slot: "broll_fees1", t0: 21.63, t1: 22.15, from: 0, in: whip(0.12), what: "A printed headline, the cost highlighted in yellow, sliding with motion blur" },
  { id: "s16", slot: "broll_fees2", t0: 22.15, t1: 23.1, from: 0, in: whip(0.12), what: "A book page, the same words highlighted, shallow focus" },
  { id: "s17", slot: "speaker", t0: 23.1, t1: 24.7, in: whip(0.15), what: "Speaker in the open office" },
  { id: "s18", slot: "speaker", t0: 24.7, t1: 28.93, in: { type: "cut" }, what: "Speaker at a glass door, the sign-off" },
];

// Picture fallback for each shot (a picture slot plays here; a video plays as b-roll under the graphic instead):
// the same whip as keys, so a still pushes in with motion blur too.
const backdrops = shots.map((s, i) => {
  const next = shots[i + 1], d = s.in?.type === "whip" ? s.in.dur ?? 0.12 : 0, nd = next?.in?.type === "whip" ? next.in.dur ?? 0.12 : 0;
  const keys: Record<string, unknown>[] = [];
  if (d) keys.push({ t: s.t0 - d / 2, x: W / 2 + W }, { t: s.t0 + d / 2, x: W / 2, e: "inOut" });
  if (nd) keys.push({ t: s.t1 - nd / 2, x: W / 2 }, { t: s.t1 + nd / 2, x: W / 2 - W, e: "inOut" });
  if (s.blur) keys.push({ t: s.t0, bblur: 26 });
  if (s.slot === "screen") keys.push({ t: s.t0, bblur: 22 }, { t: s.t0 + 0.25, bblur: 0, e: "out" });
  const zoom = s.keys?.filter((k) => k.scale != null) ?? [];
  return {
    id: "shot_" + s.id, kind: "backdrop", src: `{{${s.slot}}}`, t0: Math.max(0, s.t0 - d / 2), t1: s.t1 + nd / 2, z: 1 + i * 0.01,
    vignette: 0, dim: 0, mb: 0.7, x: W / 2, y: H / 2,
    kb: zoom.length >= 2 ? [zoom[0].scale, zoom[zoom.length - 1].scale] : [1, 1.03],
    keys: keys.sort((a, b) => (a.t as number) - (b.t as number)),
  };
});

// Caption windows and word times (the reference's transcript), one entry per | in the script.
const capWins: [number, number, number[]][] = [
  [0.29, 1.4, [0.29, 0.49, 0.78]], [1.4, 1.96, [1.4, 1.64, 1.78]], [1.96, 3.12, [1.96, 2.16, 2.48, 2.54, 2.78]], [3.12, 3.7, [3.12]],
  [3.7, 4.53, [3.7, 4.06]], [4.53, 5.33, [4.53, 4.76]], [5.33, 6.26, [5.33, 5.58, 5.98]], [6.26, 6.89, [6.26, 6.46, 6.78]],
  [6.89, 8.2, [6.89, 7.32]], [8.2, 8.68, [8.2]], [8.68, 9.09, [8.68]], [9.09, 9.41, [9.09]], [9.41, 10.4, [9.41, 9.65, 9.75]],
  [10.4, 11.82, [10.4, 10.89, 11.06]], [11.82, 12.74, [11.82, 11.98]], [12.74, 13.96, [12.74, 12.92, 13.12, 13.32]],
  [13.96, 15.24, [13.96, 14.2, 14.44, 14.82]], [15.24, 15.82, [15.24, 15.3]], [15.82, 16.78, [15.82, 16.08, 16.31]],
  [16.78, 17.55, [16.78, 17.11]], [17.55, 18.6, [17.55, 17.82, 18.05]], [18.73, 19.37, [18.73, 18.84, 18.94]],
  [19.37, 19.97, [19.37, 19.68, 19.86]], [19.97, 20.69, [19.97, 20.32]], [20.69, 20.96, [20.69, 20.75]],
  [20.96, 21.7, [20.96, 21.15, 21.35, 21.54]], [21.7, 22.55, [21.7, 21.97]], [22.55, 23.25, [22.55, 22.66, 23.05]],
  [23.25, 24.2, [23.25, 23.46]], [24.2, 24.69, [24.2, 24.45, 24.56]], [24.69, 25.51, [24.69, 25.0]], [25.51, 26.24, [25.51, 25.88, 26.18]],
  [26.24, 26.86, [26.24, 26.57]], [26.86, 27.56, [26.86, 27.12]], [27.56, 27.68, [27.56]], [27.68, 28.93, [27.68, 28.18, 28.3]],
];

const elements = [
  "Talking head: one speaker to camera, five places (corridor, kitchen, open office, glass door), cut every 1 to 2 s; the speech runs on across every cut (one take, slot speaker).",
  "B-roll: 7 shots of 0.3 to 1.2 s and one 3 s screen recording, each on the words it shows (laptop logo, website, old way writing, calculator, headline, book page).",
  "Whip transition: the new shot pushes the last one out to the left in 0.1 to 0.3 s with heavy horizontal motion blur (8 of the 17 cuts).",
  "Overexposure flash: the frame blows out to white in 0.04 s and settles back over 0.3 s (on 4 cuts: 0, 4.6, 6.5, 11.7 s); the brightest parts, often the person, burn out first.",
  "White dip: 18.6 s, the screen recording fades to white (grey at the bottom) and the talking head comes back out of it.",
  "Captions: Poppins Bold, white with a soft dark shadow, about 44 px at 1080 wide, centred 65% down; 1 to 4 words a caption, laid out whole so each word lands in place; the newest word shows dim and slightly soft for 0.18 s.",
  "Kinetic title (3.1 to 4.9 s): Archivo Black all caps on near-black boxes (rgba 32,32,32,.93), left-aligned at 9.6% from the left, 52% down; each word lands on its spoken word (pops from 114% in 0.12 s), the line's box grows to fit it (eased 0.15 s); letters white to light grey top to bottom; holds across the next cut.",
  "Number disc (12.35 to 15.6 s): a circle 61% of the width, centred 40% down, navy gradient #45519A to #2C3253 top to bottom with a deep soft shadow; pops in with overshoot and blur, holds the logo; the speaker steps in front of it (behind-person); the logo slides out to the right inside the circle, a big italic Poppins ExtraBold number pops in from 140% blurred, its label (Poppins SemiBold italic) rises under it.",
  "Background blur: behind the number the talking head blurs hard (about 40) for 1.4 s.",
  "Screen recording: starts out of focus and pulls sharp in 0.25 s, zooms out 16% and pans right over 1.25 s (linear), then scrolls down; a hand cursor clicks a menu.",
  "Corner logo: the white logo top right (right edge 90.6% across, 9.9% down, 62 px tall), on all the time except over the screen recording and the end card.",
  "End card (28.93 s): arrives as a blue panel rising from the bottom in 0.22 s whose leading edge drags the picture into vertical streaks.",
  "End card look: royal blue #3A4DAA with a lighter middle and a faint dot grid fading to the edges; the logo; a 4-line headline in Poppins SemiBold, the last two lines in mint #6EE3A8; a 2x2 grid of features (a metal coin icon, a mint bold title, a white line) split by hairlines that fade at their ends; a green gradient Sign up pill.",
  "Cursor: a black arrow with a white edge glides up onto the button from the bottom right (29.1 to 29.8 s) and rests on it.",
  "Pacing: a new picture about every 1.9 s, a new caption every 0.8 s; 161 words a minute; pauses kept short (median 0.16 s).",
  "Grade: natural, bright and muted (low saturation, neutral white balance), soft background blur on every talking-head shot.",
  "Sound: no music under the talking; a soft ambient bed comes in on the end card; a whoosh on the whip into the screen recording and hits on the disc pop and the number.",
];

export const TALKING_HEAD_AD = {
  v: 1,
  name: "Talking-head ad",
  source: "reference",
  description: "A 34 s vertical founder ad: one person talks to camera, cut every 1 to 2 s with whips and white flashes to b-roll, word-timed captions, a kinetic title on dark boxes, a number disc, a corner logo and a blue end card with a feature grid. Recreate it with your talking-head video, b-roll, logo and words.",
  w: W, h: H, duration: 33.6, fps: 30,
  design: {
    bg: "#121212", ink: "#FFFFFF", muted: "#BFBFBF", brand: "{{brand_color}}", accent: ["{{accent}}", "{{brand_color}}"],
    font: "Poppins", headWeight: 600, headSize: 71, tracking: -0.02, radius: 0,
  },
  motion: {
    word: { ms: 180, stagger: 0, blur: 1.6, rise: 0 },
    notes: [
      "Captions follow the speech word by word; each word lands in place, dim for 0.18 s, then white.",
      "Cuts every 1 to 2 s; whips push left with motion blur, flashes blow out to white on the other cuts.",
      "Pops overshoot (spring) and blur while they grow; boxes grow with an expo ease-out.",
    ],
  },
  scenes: [
    { id: "hook", start: 0, end: 3.13, what: "You've seen it: the speaker, then the logo and the website on a laptop (whips)." },
    { id: "problem", start: 3.13, end: 7.93, what: "The kinetic title on the key phrase, then the old way (hand writing, calculator)." },
    { id: "objection", start: 7.93, end: 11.67, what: "Talking head with a slow push in: switching sounds like effort, but it isn't." },
    { id: "promise", start: 11.67, end: 15.6, what: "The number disc: the logo, then the number of minutes, the background blurred." },
    { id: "product", start: 15.6, end: 18.67, what: "Screen recording of the product, out to a white dip." },
    { id: "savings", start: 18.67, end: 24.7, what: "Talking head, the cost on a headline and a book page." },
    { id: "signoff", start: 24.7, end: 28.93, what: "Talking head at a glass door: give it a try." },
    { id: "endcard", start: 28.93, end: 33.6, what: "Blue end card: headline, four features, the button and a cursor." },
  ],
  elements,
  slots,
  audio: { music: "m_ambient", musicDb: -14, musicStart: 28.93, sfx: [{ t: 12.35, id: "sfx_hit" }, { t: 14.44, id: "sfx_hit" }, { t: 15.55, id: "sfx_whoosh" }] },
  edit: { shots },
  layers: [
    ...backdrops,
    { id: "flashes", kind: "flash", z: 20, hits: [{ t: 0, in: 0.001, ms: 380, peak: 0.85 }, { t: 4.62, ms: 300, peak: 0.8 }, { t: 6.47, ms: 300, peak: 0.8 }, { t: 11.67, ms: 320, peak: 0.85 }, { t: 18.62, in: 0.12, ms: 300, peak: 1 }] },
    {
      id: "captions", kind: "captions", z: 30, t0: 0, t1: 28.93, x: W / 2, y: H * 0.655, size: 44, font: "Poppins", weight: 700,
      text: "{{script}}", groups: capWins.map(([t0, t1, w]) => ({ t0, t1, w })),
    },
    {
      id: "title", kind: "titlebox", z: 31, t0: 3.12, t1: 4.93, anchor: "left", x: W * 0.096, y: H * 0.52 + 154, w: W * 0.82,
      size: 88, text: "{{title}}", times: [[3.12], [3.7, 4.06]],
    },
    {
      id: "disc", kind: "disc", z: 25, t0: 12.35, t1: 15.62, x: W / 2, y: H * 0.396, radius: 330, behind: { until: 14.17 },
      logo: "{{logo}}", brand: "{{brand}}", number: "{{disc_number}}", label: "{{disc_label}}", top: "{{disc_top}}", bottom: "{{disc_bottom}}",
      swapAt: 14.17, numberAt: 14.44, labelAt: 14.82, outAt: 15.5,
    },
    { id: "bug", kind: "bug", z: 40, t0: 0, t1: 33.6, anchor: "right", x: W * 0.906, y: H * 0.099, size: 62, src: "{{logo}}", text: "{{brand}}", hide: [[15.6, 18.67], [28.93, 33.7]] },
    {
      id: "endcard", kind: "endcard", z: 50, t0: 28.93, t1: 33.6, revealMs: 220,
      color: "{{brand_color}}", accent: "{{accent}}", logo: "{{logo}}", brand: "{{brand}}",
      lines: ["{{end1}}", "{{end2}}", "{{end3}}", "{{end4}}"], accentFrom: 2,
      features: [
        { icon: "shield", title: "{{f1_title}}", sub: "{{f1_sub}}" }, { icon: "globe", title: "{{f2_title}}", sub: "{{f2_sub}}" },
        { icon: "clock", title: "{{f3_title}}", sub: "{{f3_sub}}" }, { icon: "badge", title: "{{f4_title}}", sub: "{{f4_sub}}" },
      ],
      cta: "{{cta}}", ctaFrom: "{{cta_from}}", ctaTo: "{{cta_to}}", ctaY: H * 0.695,
    },
    { id: "cursor", kind: "cursor", z: 60, t0: 29.05, t1: 33.6, fixed: true, path: [{ t: 29.05, x: 690, y: 1450 }, { t: 29.8, x: 566, y: 1352, out: { infl: 0.2, speed: 0 }, in: { infl: 0.75, speed: 0 } }] },
  ],
};
