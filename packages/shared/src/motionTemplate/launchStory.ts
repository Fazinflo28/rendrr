// "Launch story": a Rendrr preset motion template, mapped frame by frame from a pro SaaS launch film (41 s, 16:9).
// Structure, timing, easing, camera and every element (78 of them, listed in `elements`) are the reference's; every
// brand word, picture and colour is a slot, so anyone can swap the assets or build a new video in the same motion and
// design. Pictures are empty by default (the runtime draws soft gradients in the accent colours until they are filled).
// Keys use the After Effects model where it matters: temporal handles (in/out: influence and speed), auto (continuous)
// keys and motion blur, so moves accelerate and settle the way an animator would key them.
const W = 1920, H = 1080, CX = W / 2;
const tileIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const EASY = { infl: 0.33, speed: 0 }; // AE easy ease
const SLOW_IN = { infl: 0.8, speed: 0 }; // long, soft settle (an animator's "exponential" ease)
const FAST_OUT = { infl: 0.15, speed: 0 };

// the social window (grid) and its tiles: shared by the grid, the halftone that builds it and the picked cards
const G = { x: CX, y: 590, w: 1340, cols: 6, gap: 14, pad: 22, bar: 58, tw: 0, th: 0, h: 0, top: 0 };
G.tw = (G.w - 2 * G.pad - (G.cols - 1) * G.gap) / G.cols; G.th = G.tw * 16 / 9;
G.h = G.pad * 2 + G.bar + 2 * G.th + G.gap; G.top = G.y - G.h / 2;
const tilePos = (i: number) => ({ x: G.x - G.w / 2 + G.pad + G.tw / 2 + (i % G.cols) * (G.tw + G.gap), y: G.top + G.pad + G.bar + G.th / 2 + Math.floor(i / G.cols) * (G.th + G.gap) });
const tileArea = [G.x - G.w / 2 + G.pad, G.top + G.pad + G.bar, G.w - 2 * G.pad, 2 * G.th + G.gap];
const picks = [2, 4, 7];
// the prompt card (typing shot) and the reply card that becomes the phone
const P1 = { x: CX, y: 545, w: 1470, h: 322 };
const P2 = { left: CX - 648, y: 541, w: 1297, h: 389 };

const slots = [
  { id: "brand", type: "text", label: "Product name", default: "Kite", maxChars: 14 },
  { id: "version", type: "text", label: "Version or tag", default: "2.0", maxChars: 6 },
  { id: "brand_tag", type: "text", label: "Small word after the name (grey)", default: "Workspace", maxChars: 14 },
  { id: "logo", type: "image", label: "Logo (square)", default: "" },
  { id: "partner", type: "text", label: "Partner app it works with", default: "Claude", maxChars: 16 },
  { id: "partner_logo", type: "image", label: "Partner app's logo (square)", default: "" },
  { id: "opener_left", type: "text", label: "Opener word left", default: "KITE", maxChars: 8 },
  { id: "opener_right", type: "text", label: "Opener word right", default: "2.0", maxChars: 6 },
  { id: "opener_sub", type: "text", label: "Opener line", default: "is finally here.", maxChars: 28 },
  { id: "opener_image", type: "image", label: "Picture in the opener pill", default: "" },
  { id: "hero_image", type: "image", label: "Hero picture (full screen)", default: "", video: true },
  { id: "audience", type: "text", label: "Who it is for (wrap key words in *)", default: "For teams who *ship every week*", maxChars: 40 },
  { id: "dark_image", type: "image", label: "Background behind the big title", default: "" },
  { id: "connect_line", type: "text", label: "Step 1 headline ({word} = accent)", default: "Connect {Kite} to your stack.", maxChars: 40 },
  { id: "connect_title", type: "text", label: "Form title", default: "Add connector", maxChars: 26 },
  { id: "connect_url", type: "text", label: "URL typed in the form", default: "api.kite.app/v2", maxChars: 30 },
  { id: "reads_line", type: "text", label: "Step 2 headline ([words] = grey)", default: "Kite reads [every thread you have.]", maxChars: 48 },
  { id: "src1", type: "text", label: "Source 1", default: "Calls", maxChars: 12 },
  { id: "src2", type: "text", label: "Source 2", default: "Inbox", maxChars: 12 },
  { id: "src3", type: "text", label: "Source 3", default: "Chat", maxChars: 12 },
  { id: "src4", type: "text", label: "Source 4", default: "Docs", maxChars: 12 },
  { id: "src1_icon", type: "image", label: "Source 1 icon", default: "" },
  { id: "src2_icon", type: "image", label: "Source 2 icon", default: "" },
  { id: "src3_icon", type: "image", label: "Source 3 icon", default: "" },
  { id: "src4_icon", type: "image", label: "Source 4 icon", default: "" },
  { id: "command", type: "text", label: "Prompt command", default: "kite /follow-up", maxChars: 22 },
  { id: "prompt", type: "text", label: "Prompt text", default: "Draft a reply to every call from this week", maxChars: 60 },
  { id: "scan_line", type: "text", label: "Step 3 headline", default: "Kite scans your whole week.", maxChars: 40 },
  { id: "grid_title", type: "text", label: "Grid window title", default: "Workspace", maxChars: 16 },
  { id: "grid_query", type: "text", label: "Grid search line", default: "this week · calls · threads · deals", maxChars: 44 },
  { id: "grid_icon", type: "image", label: "Grid window icon", default: "" },
  { id: "tile_captions", type: "text", label: "Words on the tiles (| between them)", default: "Q3 renewal call|Pricing follow-up|Demo recap|Intro from Sam|Contract redlines|Weekly sync|Trial ends Friday|Onboarding call|Budget approved|Feature ask|Kickoff notes|Signed!", maxChars: 400 },
  { id: "tile_tags", type: "text", label: "Tags on the tiles (commas)", default: "Hot,Reply,Intro,Demo,Pricing,Renewal,Urgent,Signed,Trial,Follow-up,Q3,Call", maxChars: 200 },
  ...tileIdx.map((i) => ({ id: "tile" + (i + 1), type: "image", label: "Grid picture " + (i + 1), default: "" })),
  { id: "pick_line", type: "text", label: "Step 4 headline", default: "Spotting the {hot leads.}", maxChars: 40 },
  { id: "pick_name", type: "text", label: "Name on the picked items", default: "lead", maxChars: 10 },
  { id: "pick1_meta", type: "text", label: "Picked item 1 stat", default: "replied 2x", maxChars: 16 },
  { id: "pick2_meta", type: "text", label: "Picked item 2 stat", default: "replied 3x", maxChars: 16 },
  { id: "pick3_meta", type: "text", label: "Picked item 3 stat", default: "replied 4x", maxChars: 16 },
  { id: "command2", type: "text", label: "Second command", default: "kite /reply", maxChars: 22 },
  { id: "prompt2", type: "text", label: "Second prompt", default: "Send these today.", maxChars: 40 },
  { id: "drop_hint", type: "text", label: "Drop zone hint", default: "Drop your leads here", maxChars: 24 },
  { id: "build_line", type: "text", label: "Step 5 headline ([words] = grey)", default: "[It writes] your reply.", maxChars: 40 },
  { id: "build_status", type: "text", label: "Progress pill", default: "Writing replies", maxChars: 22 },
  { id: "post_image", type: "image", label: "The built result (tall)", default: "" },
  { id: "handle", type: "text", label: "Account on the result", default: "kite.app", maxChars: 22 },
  { id: "done_line", type: "text", label: "Step 6 headline", default: "[Sent.] And they {say yes.}", maxChars: 40 },
  { id: "payoff_image", type: "image", label: "Payoff picture (full screen)", default: "", video: true },
  { id: "payoff_1", type: "text", label: "Payoff small line", default: "And the deals", maxChars: 24 },
  { id: "payoff_2", type: "text", label: "Payoff big line 1", default: "start closing", maxChars: 20 },
  { id: "payoff_3", type: "text", label: "Payoff big line 2", default: "on autopilot.", maxChars: 20 },
  { id: "toast_title", type: "text", label: "Notification title", default: "Deal won", maxChars: 22 },
  { id: "toast_amount", type: "text", label: "Notification amount", default: "+$2,400", maxChars: 10 },
  { id: "end_image", type: "image", label: "End card picture", default: "", video: true },
  { id: "tagline", type: "text", label: "End card line ([words] = grey)", default: "Free for your [first 30 days.]", maxChars: 40 },
  { id: "cta", type: "text", label: "Button", default: "Start free", maxChars: 18 },
  { id: "cta_badge", type: "text", label: "Word after the button's divider", default: "Free", maxChars: 10 },
  { id: "url", type: "text", label: "Website", default: "kite.app", maxChars: 30 },
  { id: "accent1", type: "color", label: "Accent colour 1", default: "#EE4F8C" },
  { id: "accent2", type: "color", label: "Accent colour 2", default: "#B13FD9" },
  { id: "brandColor", type: "color", label: "Brand colour (buttons)", default: "#D7193A" },
];

// what every element of the reference is, and how the template carries it (fixed, or a slot)
const elements = [
  "opener: canvas", "opener: left word (gradient)", "opener: dot that grows into a pill (spring)", "opener: picture inside the pill", "opener: right word (gradient)", "opener: grey line, word by word", "opener: pill grows to full frame, words pushed and blurred, next picture pushes up", "opener: camera drift x1.04",
  "hero: full-screen picture or video with push-in", "hero: caption, light and bold words, soft shadow, word by word", "hero: picture blurs and darkens", "hero: selection box with corner crosses",
  "title: dark backdrop tinted in the brand colour", "title: guide lines along the frame's edges across the screen", "title: frame box with corner crosses", "title: outline letters in shuffled order", "title: brand row (logo, name, grey tag, partner logo and name)", "title: toggle", "title: caps line, letter-spaced", "title: cursor flips the toggle", "title: fill (white to accent), glow behind", "title: soft light beams",
  "connect: title scene shrinks into a tilted 3D card", "connect: cross grid on the canvas", "connect: headline with accent word", "connect: form (partner icon, title, name field with logo, URL field typing in mono, Cancel and Add buttons), tilt settling flat", "connect: cursor presses Add",
  "reads: form folds into a node (logo, name, gradient ring)", "reads: headline left-aligned with grey tail", "reads: curved gradient branches with end dots, staggered", "reads: source chips with icons", "reads: node grows into the prompt card",
  "prompt: camera dives into the card and follows the caret", "prompt: wide lens (edges bow, vignette, sides blur)", "prompt: letters type in with a short blur (command in brand colour)", "prompt: pull-out reveal, lens straightens", "prompt: partner chip and send button", "prompt: cursor sends",
  "scan: halftone burst from the send button", "scan: prompt card dissolves from its right edge", "scan: tags pop in the burst", "scan: window frame with icon, title and search", "scan: pixel sweep builds the tiles right to left", "scan: tiles with caption, play count and coloured tag", "scan: tags float off the window on lines", "scan: tiles swap pictures", "scan: highlight hops between tiles", "scan: headline", "scan: picks get a red ring and check, one by one", "scan: the rest grey out",
  "pick: push-in", "pick: picked cards pop out in a loose 3D scatter", "pick: they line up; rings and checks turn green; a mono stat under each", "pick: headline with accent",
  "reply: card grows in from the left, typing", "reply: picked cards fly to a stack above it", "reply: drop slots (dashed) with a hint", "reply: cards drop in and become chips (thumb, name, stat)", "reply: cursor sends",
  "build: card morphs to a grey 4:5 placeholder, then a phone", "build: faint cards either side", "build: headline (grey first words)", "build: picture builds from tiles, bottom up", "build: progress pill with logo and counting percent", "build: glow when done", "build: phone app rail (likes counting up, comments, shares, save) and account bar", "build: hearts float up", "build: second headline with accent", "build: the phone's picture becomes the next scene's, then it grows to full frame",
  "payoff: full-screen picture or video", "payoff: small line and two big lines", "payoff: frosted notifications stacking", "payoff: blur out, one notification glides to the middle",
  "end: picture tinted in the accent", "end: logo, name and accent version", "end: line with grey tail", "end: button pill (logo + partner, label, divider, badge) and website, cursor hovers",
];

const T = (id: string, t0: number, text: string, y: number, o: Record<string, unknown> = {}) => ({ id, kind: "text", t0, text, x: CX, y, z: 20, ...o });
const card2 = "card2";
export const LAUNCH_STORY = {
  v: 1,
  name: "Launch story",
  description: "A 41 s SaaS launch film: opener pill, full-screen hero, dark title reveal, then the product in steps on a light canvas (connect, read, prompt, scan, pick, build, done), a payoff over a picture and an end card. Every scene morphs out of the one before.",
  w: W, h: H, duration: 41.3, fps: 30,
  design: {
    bg: "#F7F6F4", ink: "#141214", muted: "#A3A0A2", accent: ["{{accent1}}", "{{accent2}}"], brand: "{{brandColor}}",
    card: "#FFFFFF", line: "#E7E4E1", dark: "#160A10", font: "Inter", mono: "JetBrains Mono", headSize: 52, headWeight: 700, tracking: -0.025, radius: 22,
    grid: { kind: "crosses", gap: 240, color: "#D3CFCC", size: 14 },
  },
  motion: {
    word: { ms: 110, stagger: 0.11, blur: 14, rise: 8 },
    blur: 0.5,
    notes: [
      "Words blur in one by one: 110 ms each, 110 ms apart; the key word in the accent gradient, tail words grey.",
      "Keys follow After Effects: easy ease (influence 33%, speed 0) on settles, long 80% influence on big moves, auto keys where a move passes through; motion blur at a 180 degree shutter on everything that moves.",
      "The camera holds still in product scenes; it moves big only at reveals (a dive into the prompt with a wide lens that follows the caret, then a 1.45 s pull-out, ease 0.40,0,0.25,1.10).",
      "No hard cuts in the product part: every scene morphs out of an element of the one before (pill grows to full screen, text box becomes the title frame, the title scene shrinks into a tilted card that wipes into a form, the form folds into a node, the node grows into the prompt, the send button breaks into a halftone that builds the grid, picked tiles fly out, the prompt becomes a phone, the phone grows to full screen).",
      "Pops use a spring with a small overshoot; exits are fast (100 to 250 ms) blur-outs.",
      "A new thing happens about every 0.5 s; each headline holds about 1 to 1.5 s once complete.",
    ],
  },
  elements,
  scenes: [
    { id: "opener", start: 0, end: 2.45, what: "Word, a dot that grows into a pill with a picture, word; a line types under it; the pill grows to fill the frame as the next picture pushes up." },
    { id: "hero", start: 2.45, end: 5.7, what: "Full-screen picture; who it is for, word by word; a thin box with corner crosses frames the line as the picture blurs and darkens." },
    { id: "title", start: 5.7, end: 8.9, what: "Dark, brand-tinted: guide lines and a frame with corner crosses; outline title (letters in shuffled order), brand row, toggle; the cursor flips it and the title fills with the gradient, a glow and soft beams." },
    { id: "connect", start: 8.9, end: 12.55, what: "The title scene shrinks into a tilted card on the light canvas and wipes into a connect form that settles flat; the URL types; the cursor presses Add." },
    { id: "reads", start: 12.55, end: 14.0, what: "The form folds into a node; gradient branches draw out to four sources; the node grows into the prompt card." },
    { id: "prompt", start: 14.0, end: 18.2, what: "Camera dives in with a wide lens on the prompt as it types and follows the caret, then pulls out to reveal the whole box; the cursor sends." },
    { id: "scan", start: 18.2, end: 23.0, what: "The send button breaks into a halftone that sweeps into a social window of tiles; tiles swap and a highlight scans; picks light up one by one; the rest grey out." },
    { id: "pick", start: 23.0, end: 25.0, what: "Push-in; the picked tiles pop out in a 3D scatter, line up, turn green with a stat under each." },
    { id: "reply", start: 25.0, end: 27.8, what: "A new prompt grows in; the row stacks and drops into its slots as chips; the cursor sends." },
    { id: "build", start: 27.8, end: 32.85, what: "The prompt becomes a placeholder, then a phone; the result builds from tiles bottom up with a progress pill; it glows; likes count up and hearts float." },
    { id: "payoff", start: 32.85, end: 37.0, what: "The phone's picture becomes the next scene and grows to full screen; stacked lines; notifications stack; blur out with one notification in the middle." },
    { id: "end", start: 37.0, end: 41.3, what: "The end card: logo, name, accent tag, line, button pill, website; the cursor hovers the button." },
  ],
  slots,
  audio: { music: "m_upbeat", musicDb: -8, sfx: [{ t: 0.35, id: "sfx_pop" }, { t: 1.95, id: "sfx_whoosh" }, { t: 5.4, id: "sfx_whoosh" }, { t: 7.7, id: "sfx_hit" }, { t: 8.85, id: "sfx_whoosh" }, { t: 12.5, id: "sfx_pop" }, { t: 13.95, id: "sfx_whoosh" }, { t: 16.45, id: "sfx_whoosh" }, { t: 18.12, id: "sfx_pop" }, { t: 18.2, id: "sfx_whoosh" }, { t: 20.9, id: "sfx_pop" }, { t: 21.35, id: "sfx_pop" }, { t: 21.8, id: "sfx_pop" }, { t: 22.95, id: "sfx_whoosh" }, { t: 25.05, id: "sfx_whoosh" }, { t: 27.85, id: "sfx_pop" }, { t: 28.0, id: "sfx_whoosh" }, { t: 30.5, id: "sfx_hit" }, { t: 32.85, id: "sfx_whoosh" }, { t: 36.95, id: "sfx_whoosh" }, { t: 38.5, id: "sfx_pop" }] },
  camera: [
    { t: 0, z: 1 }, { t: 0.6, z: 1.04, e: "out" }, { t: 1.95, z: 1.04 }, { t: 2.1, z: 1, e: "inOut" },
    { t: 13.93, z: 1, x: CX, y: H / 2, lens: 0, out: { infl: 0.1, speed: 0 } },
    // the dive: fast in, long settle (AE: 10% out, 85% in)
    { t: 14.12, z: 3.9, x: 480, y: 452, lens: 1, in: { infl: 0.85, speed: 0 }, lensLayer: card2 + "a", track: { layer: card2 + "a", to: 16.4, lead: 560, y: true } },
    { t: 16.2, lens: 1 },
    { t: 16.3, z: 2.9, x: 1170, y: 452, auto: true },
    { t: 16.75, lens: 0, e: "inOut" },
    { t: 17.75, z: 1, x: CX, y: P1.y, e: "reveal" },
    { t: 18.3, z: 1, x: CX, y: H / 2, e: "inOut" },
    { t: 22.95, z: 1, out: FAST_OUT }, { t: 23.5, z: 1.1, in: SLOW_IN }, { t: 25.05, z: 1.1, out: EASY }, { t: 25.4, z: 1, in: SLOW_IN },
    { t: 30.4, z: 1, out: EASY }, { t: 31.0, z: 1.02, in: SLOW_IN }, { t: 32.8, z: 1.02, out: EASY }, { t: 33.3, z: 1, in: EASY },
  ],
  layers: [
    // ---- opener ----
    { id: "pill", kind: "wordpill", t0: 0, t1: 2.55, left: "{{opener_left}}", right: "{{opener_right}}", src: "{{opener_image}}", next: "{{hero_image}}", size: 124, y: 455, expandAt: 2.0, expandMs: 500, z: 10 },
    T("sub", 1.1, "[{{opener_sub}}]", 600, { size: 46, weight: 600, mutedColor: "#8C8A8B", outAt: 2.1, outMs: 220 }),
    // ---- hero ----
    { id: "hero", kind: "backdrop", t0: 2.42, t1: 6.25, src: "{{hero_image}}", kb: [1.0, 1.05], z: 5,
      keys: [{ t: 2.42, s: 1.0, dim: 0, bblur: 0, out: FAST_OUT }, { t: 3.0, s: 1.12, in: SLOW_IN }, { t: 5.3, dim: 0, bblur: 0, out: EASY }, { t: 5.9, dim: 0.78, bblur: 24, in: EASY }] },
    T("aud", 3.45, "{{audience}}", 400, { size: 62, weight: 400, boldWeight: 700, color: "#FFFFFF", shadow: true, outAt: 5.62, outMs: 200, z: 22 }),
    { id: "box", kind: "box", t0: 5.15, t1: 6.05, z: 23, color: "rgba(255,255,255,.8)", ticks: true,
      keys: [{ t: 5.15, x: CX, y: 400, w: 980, h: 108, o: 0 }, { t: 5.27, o: 1, e: "out" }, { t: 5.5, x: CX, y: 405, w: 980, h: 108, out: { infl: 0.6, speed: 0 } }, { t: 5.9, x: CX, y: 545, w: 1040, h: 264, in: { infl: 0.7, speed: 0 } }, { t: 5.95, o: 1 }, { t: 6.05, o: 0 }] },
    // ---- dark title ----
    { id: "dark", kind: "backdrop", t0: 5.55, t1: 8.86, src: "{{dark_image}}", z: 6, fadeIn: 0.35, dimColor: "#16050d", tint: "{{brandColor}}", tintBlend: "color", tintOpacity: 0.55, vignette: 0.5, keys: [{ t: 5.55, dim: 0.62, bblur: 26 }] },
    { id: "ftitle", kind: "frametitle", t0: 5.8, t1: 8.86, text: "{{brand}} {{version}}", logo: "{{logo}}", brandName: "{{brand}}", brandTag: "{{brand_tag}}", partner: "{{partner}}", partnerLogo: "{{partner_logo}}", sub: "Introducing {{brand}} {{version}}", size: 200, y: 548, fillAt: 7.72, z: 12 },
    // ---- connect: title scene -> tilted card -> form that settles flat ----
    { id: "card1", kind: "card", t0: 8.85, t1: 12.62, z: 14, persp: 1400,
      views: [
        { at: 8.85, kind: "scene", text: "{{brand}} {{version}}", src: "{{dark_image}}", size: 200, tint: "{{brandColor}}", logo: "{{logo}}", brandRow: "{{brand}} · {{partner}}", sub: "Introducing {{brand}} {{version}}" },
        { at: 9.46, kind: "dialog", wipeMs: 140, title: "{{connect_title}}", icon: "{{partner_logo}}",
          fields: [{ label: "Name", value: "{{brand}}", icon: "{{logo}}" }, { label: "Server URL", prefix: "https://", value: "{{connect_url}}", mono: true, typeFrom: 10.0, typeTo: 11.6 }],
          ok: "Add", pressAt: 12.3 },
      ],
      keys: [
        { t: 8.85, x: CX, y: 540, w: W, h: H, s: 1, rad: 0, rx: 0, ry: 0, r: 0, out: { infl: 0.2, speed: 0 } },
        { t: 9.3, x: 975, y: 580, w: W, h: H, s: 0.64, rad: 36, rx: 12, ry: -16, r: -2, in: { infl: 0.6, speed: 0 } },
        { t: 9.45, s: 0.4, w: W, h: H, rad: 50, e: "in" },
        { t: 9.62, x: CX, y: 620, w: 700, h: 430, s: 1, rad: 22, rx: 14, ry: -14, r: -4, e: "out" },
        { t: 11.0, rx: 6, ry: -7, r: -2, auto: true },
        { t: 12.35, x: CX, y: 618, w: 700, h: 430, rx: 0, ry: 0, r: 0, in: SLOW_IN },
        { t: 12.5, x: CX, y: 618, w: 700, h: 430, o: 1, out: { infl: 0.4, speed: 0 } },
        { t: 12.62, x: 713, y: 623, w: 300, h: 96, o: 0.3, rad: 48, e: "in" },
      ] },
    T("h_connect", 9.3, "{{connect_line}}", 315, { outAt: 12.52 }),
    { id: "cur1", kind: "cursor", t0: 6.8, t1: 8.5, fadeIn: 0.2, fadeOut: 0.25, z: 60,
      path: [{ t: 6.8, x: 1260, y: 990 }, { t: 7.6, x: 988, y: 771 }, { t: 7.72, x: 988, y: 771, click: true }, { t: 8.5, x: 1120, y: 900 }] },
    { id: "cur2", kind: "cursor", t0: 11.7, t1: 12.62, fadeIn: 0.15, fadeOut: 0.12, z: 60,
      path: [{ t: 11.7, x: 1460, y: 960 }, { t: 12.25, x: 1224, y: 776 }, { t: 12.3, x: 1224, y: 776, click: true }] },
    // ---- reads: node + branches, then the node grows into the prompt ----
    { id: "node", kind: "node", t0: 12.56, t1: 14.06, x: 713, y: 623, reach: 430, spread: 110, icon: "{{logo}}", label: "{{brand}}",
      branches: [{ label: "{{src1}}", icon: "{{src1_icon}}", glyph: "phone", color: "#E1306C" }, { label: "{{src2}}", icon: "{{src2_icon}}", glyph: "mail", color: "#2B7FFF" }, { label: "{{src3}}", icon: "{{src3_icon}}", glyph: "chat", color: "#111111" }, { label: "{{src4}}", icon: "{{src4_icon}}", glyph: "doc", color: "#0A66C2" }],
      branchAt: 12.85, morphAt: 13.9, morphMs: 170, morphTo: [P1.x, P1.y, P1.w, P1.h], z: 15 },
    T("h_reads", 12.7, "{{reads_line}}", 263, { anchor: "left", x: 363, align: "left", outAt: 13.95 }),
    // ---- prompt: dive with a wide lens, caret follow, reveal ----
    { id: card2 + "a", kind: "card", t0: 14.0, t1: 18.85, z: 16, x: P1.x, y: P1.y, w: P1.w, h: P1.h,
      views: [{ at: 14.0, kind: "prompt", cmd: "{{command}}", text: "{{prompt}}", size: 40, typeFrom: 14.3, typeTo: 16.9, model: "{{partner}}", modelIcon: "{{partner_logo}}", sendAt: 18.12 }],
      wipeOut: { at: 18.22, ms: 600, dir: "left", soft: 0.3 },
      keys: [{ t: 18.3, blur: 0 }, { t: 18.8, blur: 6, e: "in" }] },
    { id: "cur3", kind: "cursor", t0: 17.4, t1: 18.35, fadeIn: 0.15, fadeOut: 0.12, z: 60,
      path: [{ t: 17.4, x: 1560, y: 900 }, { t: 18.02, x: 1641, y: 660 }, { t: 18.12, x: 1641, y: 660, click: true }] },
    // ---- scan: halftone builds the social window ----
    { id: "grid", kind: "grid", t0: 18.45, t1: 23.4, x: G.x, y: G.y, w: G.w, cols: G.cols, pad: G.pad, gap: G.gap, bar: G.bar, z: 17,
      icon: "{{grid_icon}}", title: "{{grid_title}}", query: "{{grid_query}}", captions: "{{tile_captions}}", tags: "{{tile_tags}}", tagPrefix: "{{brand}}", sideTags: ["{{src1}}", "{{src2}}"],
      tiles: tileIdx.map((i) => "{{tile" + (i + 1) + "}}"), picks, frameAt: 18.6, revealSweep: [18.62, 19.25], swapFrom: 19.6, swapStep: 0.17, swapHold: 1.0, scan: [19.5, 20.85, 0.28], sideAt: 19.3,
      pickAt: 20.9, dimAt: 22.4, clearAt: 22.95 },
    { id: "halftone", kind: "halftone", t0: 18.18, t1: 19.7, x: 1641, y: 660, to: tileArea, tiles: "grid", pitch: 22, sweep: [18.62, 19.25], fadeAt: 19.3, z: 31 },
    T("h_scan", 18.6, "{{scan_line}}", 80, { outAt: 22.95 }),
    // ---- picked tiles pop out into a 3D scatter, line up, turn green; then stack and drop into the reply prompt ----
    ...picks.map((ti, k) => {
      const p = tilePos(ti), rowX = CX + (k - 1) * 327;
      const scatter = [{ x: 636, y: 548, r: -3, rx: -6, ry: 12 }, { x: 1009, y: 518, r: 4, rx: 4, ry: -10 }, { x: 1139, y: 744, r: 6, rx: -4, ry: 8 }][k];
      const meta = ["{{pick1_meta}}", "{{pick2_meta}}", "{{pick3_meta}}"][k];
      return { id: "pick" + k, kind: "media", t0: 22.95, t1: 26.85, src: "{{tile" + (ti + 1) + "}}", rad: 14, z: 25 + (k === 2 ? 2 : 0), kb: [1, 1], persp: 1200,
        rings: [{ at: 22.95, color: "{{brandColor}}" }, { at: 24.0 + k * 0.08, color: "#22C55E" }], ringWidth: 4,
        checks: [{ at: 22.95, color: "{{brandColor}}" }, { at: 24.0 + k * 0.08, color: "#22C55E" }],
        caption: { at: 24.15 + k * 0.08, until: 24.98 + k * 0.05, text: "{{pick_name}}_0" + (k + 1), meta },
        keys: [
          { t: 22.95, x: p.x, y: p.y, w: G.tw, h: G.th, r: 0, rx: 0, ry: 0, out: { infl: 0.25, speed: 0 } },
          { t: 23.45 + k * 0.05, x: scatter.x, y: scatter.y, w: 282, h: 487, r: scatter.r, rx: scatter.rx, ry: scatter.ry, auto: true },
          { t: 24.05 + k * 0.05, x: rowX, y: 559, w: 282, h: 470, r: 0, rx: 0, ry: 0, in: SLOW_IN },
          { t: 25.0 + k * 0.05, x: rowX, y: 559, w: 282, h: 470, r: 0, out: { infl: 0.3, speed: 0 } },
          { t: 25.45 + k * 0.05, x: 1290 + k * 26, y: 250 + k * 8, w: 150, h: 258, r: -8 + k * 7, po: [120, -160], in: { infl: 0.6, speed: 0 } },
          { t: 26.3, x: 1330 + k * 10, y: 256 + k * 4, w: 150, h: 258, r: -5 + k * 5 },
          { t: 26.75, x: 528, y: 460, w: 70, h: 120, r: 0, o: 1, e: "inOut" },
          { t: 26.85, o: 0 },
        ] };
    }),
    T("h_pick", 23.25, "{{pick_line}}", 205, { outAt: 25.0 }),
    // ---- reply prompt -> placeholder -> phone -> full screen ----
    { id: card2, kind: "card", t0: 25.0, t1: 33.45, z: 18, anchor: "left", glowAt: 30.5,
      views: [
        { at: 25.0, kind: "prompt", cmd: "{{command2}}", text: "{{prompt2}}", size: 38, typeFrom: 25.3, typeTo: 26.4, model: "{{partner}}", modelIcon: "{{partner_logo}}", sendAt: 27.85,
          drop: { at: 25.9, fillAt: 26.95, h: 116, push: 140, hint: "{{drop_hint}}", items: picks.map((ti, k) => ({ src: "{{tile" + (ti + 1) + "}}", label: "{{pick_name}}_0" + (k + 1), kind: "Lead", meta: ["{{pick1_meta}}", "{{pick2_meta}}", "{{pick3_meta}}"][k], sub: "thread · notes · draft" })) } },
        { at: 28.1, kind: "blank", bg: "#EDEBE9", wipe: "fade", wipeMs: 160 },
        { at: 28.7, kind: "mosaic", bg: "#EDEBE9", wipe: "fade", wipeMs: 200, src: "{{post_image}}", from: 28.8, to: 30.35 },
        { at: 30.4, kind: "post", wipe: "fade", wipeMs: 160, src: "{{post_image}}", next: "{{payoff_image}}", nextAt: 32.85, logo: "{{logo}}", handle: "{{handle}}", likes: [12000, 183000, 30.6, 32.8], hearts: [31.9], uiAt: 30.5 },
      ],
      keys: [
        { t: 25.0, x: P2.left, y: P2.y, w: 430, h: 330, o: 0, out: { infl: 0.2, speed: 0 } }, { t: 25.12, o: 1 },
        { t: 25.5, w: P2.w, in: SLOW_IN }, { t: 25.9, h: 330 }, { t: 26.3, h: P2.h, in: EASY },
        { t: 27.95, x: P2.left, y: P2.y, w: P2.w, h: P2.h, rad: 22, out: { infl: 0.4, speed: 0 } },
        { t: 28.35, x: CX - 300, y: 580, w: 600, h: 688, rad: 30, auto: true },
        { t: 28.75, x: CX - 214, y: 589, w: 428, h: 762, rad: 34, in: SLOW_IN },
        { t: 30.4, x: CX - 214, y: 589, w: 428, h: 762, out: EASY },
        { t: 31.0, x: CX - 230, y: 589, w: 460, h: 814, rad: 36, in: EASY },
        { t: 32.85, x: CX - 230, y: 589, w: 460, h: 814, rad: 36, out: { infl: 0.5, speed: 0 } },
        { t: 33.38, x: 0, y: 540, w: W, h: H, rad: 0, e: "expand" },
      ] },
    { id: "ghostL", kind: "media", t0: 28.2, t1: 30.6, src: "{{tile6}}", rad: 30, z: 17, shadow: false, mb: 0,
      keys: [{ t: 28.2, x: CX - 620, y: 589, w: 400, h: 700, o: 0, blur: 10 }, { t: 28.6, o: 0.16 }, { t: 30.2, o: 0.16 }, { t: 30.6, o: 0 }] },
    { id: "ghostR", kind: "media", t0: 28.2, t1: 30.6, src: "{{tile11}}", rad: 30, z: 17, shadow: false, mb: 0,
      keys: [{ t: 28.2, x: CX + 620, y: 589, w: 400, h: 700, o: 0, blur: 10 }, { t: 28.6, o: 0.16 }, { t: 30.2, o: 0.16 }, { t: 30.6, o: 0 }] },
    { id: "status", kind: "chip", t0: 28.9, t1: 30.6, fadeOut: 0.2, x: CX, y: 1030, icon: "{{logo}}", text: "{{build_status}}", count: { from: 0, to: 100, t0: 28.9, t1: 30.35, suffix: "%" }, size: 20, z: 26 },
    { id: "cur4", kind: "cursor", t0: 27.25, t1: 28.05, fadeIn: 0.15, fadeOut: 0.12, z: 60,
      path: [{ t: 27.25, x: 1500, y: 960 }, { t: 27.78, x: 1561, y: 685 }, { t: 27.85, x: 1561, y: 685, click: true }] },
    T("h_build", 28.05, "{{build_line}}", 97, { outAt: 30.62 }),
    T("h_done", 30.75, "{{done_line}}", 84, { outAt: 32.95, outMs: 160 }),
    // ---- payoff ----
    { id: "payoff", kind: "backdrop", t0: 33.3, t1: 37.6, src: "{{payoff_image}}", kb: [1.04, 1.0], z: 8, fadeIn: 0.1,
      keys: [{ t: 33.3, dim: 0.26, bblur: 0 }, { t: 36.9, dim: 0.26, bblur: 0, out: { infl: 0.3, speed: 0 } }, { t: 37.35, dim: 0.55, bblur: 44, in: EASY }] },
    { id: "p1", kind: "text", t0: 33.85, t1: 37.1, fadeOut: 0.2, text: "{{payoff_1}}", anchor: "left", x: 150, y: 451, size: 34, weight: 500, color: "#FFFFFF", align: "left", shadow: true, z: 26 },
    { id: "p2", kind: "text", t0: 34.25, t1: 37.1, fadeOut: 0.2, text: "{{payoff_2}}", anchor: "left", x: 150, y: 522, size: 72, weight: 700, color: "#FFFFFF", align: "left", shadow: true, z: 26 },
    { id: "p3", kind: "text", t0: 34.55, t1: 37.1, fadeOut: 0.2, text: "{{payoff_3}}", anchor: "left", x: 150, y: 610, size: 72, weight: 700, color: "#FFFFFF", align: "left", shadow: true, z: 26 },
    { id: "toasts", kind: "toasts", t0: 34.4, t1: 37.75, fadeOut: 0.3, x: 1460, y: 600, w: 600, h: 640, gap: 113, count: 9, every: 0.3, keep: 5, focusAt: 36.95, focusMs: 450, title: "{{toast_title}}", meta: "{{brand}} · just now", amount: "{{toast_amount}}", icon: "bolt", iconColor: "#5B4BFF", z: 27 },
    // ---- end card ----
    { id: "endbg", kind: "backdrop", t0: 37.3, t1: 41.3, src: "{{end_image}}", kb: [1.0, 1.05], z: 9, fadeIn: 0.35, tint: "{{accent2}}", tintBlend: "color", tintOpacity: 0.4, vignette: 0.45,
      keys: [{ t: 37.3, dim: 0.42, bblur: 30, out: FAST_OUT }, { t: 37.85, bblur: 0, dim: 0.34, in: SLOW_IN }] },
    { id: "cta", kind: "cta", t0: 37.55, t1: 41.3, logo: "{{logo}}", name: "{{brand}}", accent: "{{version}}", tagline: "{{tagline}}", button: "{{cta}}", badge: "{{cta_badge}}", partner: "{{partner}}", partnerLogo: "{{partner_logo}}", url: "{{url}}", size: 120, y: 389, z: 28 },
    { id: "cur5", kind: "cursor", t0: 39.4, t1: 41.3, fadeIn: 0.2, z: 60, path: [{ t: 39.4, x: 1300, y: 900, out: EASY }, { t: 40.3, x: 1130, y: 650, in: SLOW_IN }] },
  ],
};
