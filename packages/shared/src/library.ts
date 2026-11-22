// Engine Part 4.1: the hidden animation library. Ready components the AI places with simple settings (list_library,
// get_library_item, add_library_item, test_graphic); never shown in the user interface. Most are graphics: HTML drawn
// by the same recorder and player as the templates, frame by frame from the clock alone (renderFramePure), so the
// render and the editor draw the same thing. A few are edits (a picture-in-picture, a transition on a cut, what is
// behind V1): add_library_item turns them into the explicit edits they stand for. Every one says what it does.
type P = Record<string, unknown>;
export const LIBRARY_KINDS = ["text", "lower_third", "stat", "list", "callout", "whiteboard", "pip", "transition", "social", "background", "icon"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export const EASINGS = ["linear", "ease-out-cubic", "ease-in-out", "spring"] as const;
export const POSITIONS = ["auto", "center", "top", "bottom", "lower-third", "top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const ENTRANCES = ["blur-in", "slide-in", "pop", "typewriter", "word-by-word", "mask-reveal", "highlight-wipe", "underline", "strike"] as const;

/** place "graphic": drawn on V3 like a template; "edits": add_library_item makes the edits it names. */
export type LibraryItem = {
  id: string; kind: LibraryKind; name: string; description: string; durationSec: number; transparent: boolean;
  place: "graphic" | "edits"; paramsSchema: { type: "object"; properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties: false };
};

// ---------------------------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------------------------
const str = (description: string, def: string, maxLength = 120) => ({ type: "string", description, default: def, maxLength });
const color = (description: string, def: string) => ({ type: "string", description, default: def, pattern: "^#[0-9a-fA-F]{6}$" });
const num = (description: string, def: number, minimum: number, maximum: number) => ({ type: "number", description, default: def, minimum, maximum });
const bool = (description: string, def: boolean) => ({ type: "boolean", description, default: def });
const oneOf = (description: string, values: readonly string[], def: string) => ({ type: "string", description, default: def, enum: values });
const list = (description: string, def: unknown[], max = 8) => ({ type: "array", description, default: def, maxItems: max });
const position = (def: string) => ({ description: `Where it sits: ${POSITIONS.join(", ")} ("auto": add_library_item puts it clear of the face, from its measured box; a tall frame keeps clear of the app's buttons at top and bottom), or {x, y} shares of the frame (its centre)`, default: def, anyOf: [{ type: "string", enum: POSITIONS }, { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } }] });
const COMMON = {
  font: str("Font family: any installed one (Inter, Montserrat, Poppins, Open Sans, Roboto, Oswald, Bebas Neue, Anton, Space Grotesk, Playfair Display, DM Serif Display, Kalam, Permanent Marker, Bangers, Lilita One, ...; create_graphic lists them all) or one added with add_font", "Inter", 60),
  weight: num("Font weight 100-900", 800, 100, 900),
  size: num("Text size, share of the frame's short side", 0.07, 0.015, 0.3),
  color: color("Text colour", "#ffffff"),
  accent: color("Accent colour (marks, bars, highlights)", "#ffcc00"),
  easing: oneOf("How it moves", EASINGS, "ease-out-cubic"),
  speed: num("Entrance speed: 2 = twice as fast, 0.5 = half", 1, 0.25, 4),
  exit: bool("Leave with the matching exit at the end (false: stays to the end)", true),
};
const obj = (properties: Record<string, Record<string, unknown>>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false as const });

// ---------------------------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------------------------
const textItem = (e: (typeof ENTRANCES)[number], description: string): LibraryItem => ({
  id: `lib_text_${e.replace(/-/g, "_")}`, kind: "text", name: `Text: ${e.replace(/-/g, " ")}`, description, durationSec: 3, transparent: true, place: "graphic",
  paramsSchema: obj({
    text: str("The text (\\n = new line)", "Make every second count", 200), ...COMMON, ...(e === "pop" ? { easing: oneOf("How it moves", EASINGS, "spring") } : {}), position: position("auto"), align: oneOf("Line alignment", ["left", "center", "right"], "center"),
    box: { description: "A box behind the text: {color, opacity 0-1} or null", default: null },
    shadow: bool("A soft shadow under the text", true),
    ...(e === "slide-in" ? { from: oneOf("Comes in from", ["left", "right", "up", "down"], "left") } : {}),
    ...(["highlight-wipe", "underline", "strike"].includes(e) ? { mark: str("The word or words to mark (default: the last word; underline: all of it)", "", 80) } : {}),
    ...(e === "highlight-wipe" ? { markColor: color("Colour of the marked words over the highlight", "#111111") } : {}),
  }, ["text"]),
});
const lowerThird = (style: string, name: string, description: string): LibraryItem => ({
  id: `lib_lt_${style}`, kind: "lower_third", name: `Lower third: ${name}`, description, durationSec: 4, transparent: true, place: "graphic",
  paramsSchema: obj({ name: str("Name", "Ronny K", 60), title: str("Title or role", "Founder, Rendrr", 80), ...COMMON, size: num("Name size, share of the short side", 0.05, 0.02, 0.12), weight: num("Name weight", 800, 100, 900), accent: color("Accent colour", "#ffcc00"), panel: color("Panel colour", "#111114"), position: position("bottom-left") }, ["name"]),
});
const card = (id: string, kind: LibraryKind, name: string, description: string, durationSec: number, properties: Record<string, Record<string, unknown>>, required: string[] = [], transparent = true): LibraryItem =>
  ({ id, kind, name, description, durationSec, transparent, place: "graphic", paramsSchema: obj(properties, required) });
const edits = (id: string, kind: LibraryKind, name: string, description: string, durationSec: number, properties: Record<string, Record<string, unknown>>, required: string[] = []): LibraryItem =>
  ({ id, kind, name, description, durationSec, transparent: true, place: "edits", paramsSchema: obj(properties, required) });
const point = (what: string, x: number, y: number) => ({ x: num(`${what} across, share of the width`, x, 0, 1), y: num(`${what} down, share of the height`, y, 0, 1) });

export const LIBRARY_ITEMS: LibraryItem[] = [
  textItem("blur-in", "Text that comes into focus from a blur; leaves by blurring out."),
  textItem("slide-in", "Text that slides in from a side; leaves the way it came."),
  textItem("pop", "Text that pops up with a little bounce; leaves by shrinking away."),
  textItem("typewriter", "Text typed letter by letter with a caret; leaves by deleting itself."),
  textItem("word-by-word", "Each word appears in turn; they leave in turn."),
  textItem("mask-reveal", "Text revealed by a wipe from left to right; wiped off to the right."),
  textItem("highlight-wipe", "Text with a highlight swept behind the marked word; the highlight sweeps away."),
  textItem("underline", "Text with a line drawn under it (or under the marked words); the line draws back."),
  textItem("strike", "Text with a line drawn through the marked words (a correction); fades out."),
  lowerThird("bar", "accent bar", "Name and title next to an accent bar; slides in behind a mask."),
  lowerThird("box", "solid box", "Name and title on a solid panel that wipes open."),
  lowerThird("split", "two blocks", "Name on an accent block, title on a dark block under it, sliding in one after the other."),
  lowerThird("line", "minimal line", "Name with a thin line drawing under it, title fading in."),
  lowerThird("pill", "pill", "A rounded pill with a dot, the name and the title; pops in."),
  lowerThird("corner", "corner brackets", "Title in small caps over the name, with corner brackets that draw."),
  card("lib_stat_counter", "stat", "Stat: number counter", "A big number counting up (or down) with a label.", 3,
    { from: num("Start number", 0, -1e12, 1e12), to: num("End number", 100, -1e12, 1e12), decimals: num("Decimals", 0, 0, 4), prefix: str("Before the number, like $", "", 10), suffix: str("After the number, like %", "", 12), label: str("Line under it", "", 80), ...COMMON, size: num("Number size, share of the short side", 0.16, 0.05, 0.35), card: bool("On a dark card", false), position: position("center") }, ["to"]),
  card("lib_stat_ring", "stat", "Stat: percentage ring", "A ring that fills to a percentage, the number counting in its middle.", 3,
    { percent: num("Percent 0-100", 75, 0, 100), label: str("Line under the ring", "", 80), ...COMMON, size: num("Ring size, share of the short side", 0.32, 0.1, 0.8), position: position("center") }, ["percent"]),
  card("lib_stat_bars", "stat", "Stat: bar fill", "Bars that fill to their values, one after another, each with its label and number.", 4,
    { bars: list("Bars: [{label, value}] (up to 5)", [{ label: "Before", value: 30 }, { label: "After", value: 85 }], 5), max: num("The value a full bar shows", 100, 0.0001, 1e12), suffix: str("After each number", "%", 12), ...COMMON, size: num("Label size, share of the short side", 0.04, 0.015, 0.1), position: position("center") }, ["bars"]),
  card("lib_stat_compare", "stat", "Stat: before / after", "Two numbers side by side (before and after) with an arrow and the change between them.", 4,
    { before: num("Before value", 12, -1e12, 1e12), after: num("After value", 48, -1e12, 1e12), beforeLabel: str("Before label", "Before", 40), afterLabel: str("After label", "After", 40), prefix: str("Before each number", "", 10), suffix: str("After each number", "", 12), ...COMMON, size: num("Number size", 0.11, 0.04, 0.25), position: position("center") }),
  card("lib_list_steps", "list", "List: numbered steps", "Numbered steps appearing one by one (the newest one bright, earlier ones dimmed).", 6,
    { title: str("Title over the steps", "", 80), items: list("The steps (up to 8)", ["Find your angle", "Write the hook", "Cut the pauses"]), ...COMMON, size: num("Text size", 0.045, 0.02, 0.1), position: position("center") }, ["items"]),
  card("lib_list_checklist", "list", "List: checklist", "Items whose boxes tick one after another.", 5,
    { title: str("Title over the list", "", 80), items: list("The items (up to 8)", ["Hook in 3 seconds", "One idea", "Clear call to action"]), ...COMMON, size: num("Text size", 0.045, 0.02, 0.1), position: position("center") }, ["items"]),
  card("lib_list_flow", "list", "List: flow", "Boxes joined by arrows that draw themselves from one to the next.", 5,
    { items: list("The boxes (up to 6)", ["Idea", "Script", "Shoot", "Edit"], 6), ...COMMON, size: num("Text size", 0.04, 0.02, 0.08), vertical: bool("Top to bottom (default: across; portrait frames go down anyway)", false), position: position("center") }, ["items"]),
  card("lib_callout_arrow", "callout", "Callout: arrow", "A curved arrow that draws itself to a point, with a label at its tail.", 3,
    { ...point("The point it points at", 0.62, 0.42), label: str("Label at the tail", "Look here", 60), ...COMMON, size: num("Label size", 0.045, 0.02, 0.1), color: color("Arrow and label colour", "#ffcc00") }),
  card("lib_callout_circle", "callout", "Callout: circle", "A hand-drawn circle drawn around a point, with an optional label.", 3,
    { ...point("Centre", 0.5, 0.45), radius: num("Radius, share of the short side", 0.12, 0.02, 0.5), label: str("Label", "", 60), ...COMMON, color: color("Line colour", "#ff3b30"), size: num("Label size", 0.04, 0.02, 0.1) }),
  card("lib_callout_zoombox", "callout", "Callout: zoom box", "A frame that snaps onto a region with corner marks and a tag (pair it with add_zoom to enlarge the footage there).", 3,
    { ...point("Box left", 0.35, 0.3), w: num("Box width, share", 0.3, 0.02, 1), h: num("Box height, share", 0.3, 0.02, 1), label: str("Tag over the box", "", 60), ...COMMON, color: color("Frame colour", "#ffffff"), size: num("Tag size", 0.035, 0.015, 0.08) }),
  card("lib_callout_spotlight", "callout", "Callout: spotlight", "Darkens everything but a soft circle on a point, with an optional label.", 3,
    { ...point("Centre", 0.5, 0.45), radius: num("Radius, share of the short side", 0.18, 0.03, 0.6), dim: num("How dark the rest gets, 0-1", 0.65, 0.1, 0.95), label: str("Label", "", 60), ...COMMON, size: num("Label size", 0.04, 0.02, 0.1) }),
  card("lib_whiteboard", "whiteboard", "Whiteboard", "One large board with notes written on it in a hand-drawn style; a smooth virtual camera moves from note to note, arrows drawn between them, then pulls back to show the whole board. Opaque.", 12,
    { notes: list("The notes, in order (up to 8): text, or {text, x, y} on the board (0-1 each way)", ["Idea", "Script", "Edit", "Post"]), board: color("Board colour", "#fbfbf7"), ink: color("Ink colour", "#1f2937"), accent: color("Accent (underlines, arrows)", "#2563eb"), font: str("Handwriting font", "Kalam", 60), size: num("Note size, share of the short side", 0.09, 0.03, 0.2), speed: COMMON.speed }, ["notes"], false),
  edits("lib_pip_circle", "pip", "Picture in picture: circle", "The speaker in a circle with a border and a shadow, centred on their face box, placed in a corner (or x, y). Makes: set_card (crop around the face, round, border, shadow) and set_framing on the V1 clips in the range (split at its ends), and set_background if one is given.", 0,
    { corner: oneOf("Where it goes", ["bottom-right", "bottom-left", "top-right", "top-left"], "bottom-right"), size: num("Its size, share of the frame's height", 0.32, 0.12, 0.8), border: color("Border colour", "#ffffff"), borderWidth: num("Border width, share of the short side", 0.008, 0, 0.05), shadow: bool("A drop shadow", true), background: { description: "What shows around it: {color} | {gradient: {from, to, angle}} | {blur} | {pattern} (set_background); default leave it", default: null } }),
  edits("lib_pip_box", "pip", "Picture in picture: rounded box", "The speaker in a rounded box with a border and a shadow, centred on their face box, placed in a corner (or x, y). Makes: set_card and set_framing on the V1 clips in the range (split at its ends), and set_background if one is given.", 0,
    { corner: oneOf("Where it goes", ["bottom-right", "bottom-left", "top-right", "top-left"], "bottom-right"), size: num("Its size, share of the frame's height", 0.36, 0.12, 0.8), radius: num("Corner radius, share of its short side", 0.12, 0, 0.5), border: color("Border colour", "#ffffff"), borderWidth: num("Border width", 0.006, 0, 0.05), shadow: bool("A drop shadow", true), background: { description: "What shows around it (set_background); default leave it", default: null } }),
  edits("lib_tr_flash", "transition", "Transition: overexposure flash", "The picture blows out to white with a glow on the cut nearest `start` and comes back fast (set_transition flash, 0.5 s).", 0.5, { duration: num("Seconds", 0.5, 0.2, 1) }),
  edits("lib_tr_dip", "transition", "Transition: dip to black", "A dip to black on the cut nearest `start` (set_transition dip-black).", 0.6, { duration: num("Seconds", 0.6, 0.1, 2) }),
  edits("lib_tr_whip", "transition", "Transition: whip", "A whip pan on the cut nearest `start` (set_transition whip).", 0.3, { duration: num("Seconds", 0.3, 0.1, 1), dir: oneOf("Direction", ["left", "right", "up", "down"], "left") }),
  edits("lib_tr_zoom_punch", "transition", "Transition: zoom punch", "A zoom punch through the cut nearest `start` (set_transition zoom).", 0.4, { duration: num("Seconds", 0.4, 0.1, 1.5) }),
  edits("lib_tr_slide", "transition", "Transition: slide", "The next shot slides in over the cut nearest `start` (set_transition slide).", 0.5, { duration: num("Seconds", 0.5, 0.1, 2), dir: oneOf("Direction", ["left", "right", "up", "down"], "left") }),
  card("lib_tr_glitch", "transition", "Transition: glitch", "Glitch bars, colour-split blocks and scan lines over the picture for a moment: place it centred on a cut.", 0.5,
    { intensity: num("How much, 0-1", 0.7, 0.1, 1), color: color("Main glitch colour", "#00e5ff"), accent: color("Second colour", "#ff2bd6") }),
  card("lib_tr_light_leak", "transition", "Transition: light leak", "Warm light sweeping across the picture: place it centred on a cut.", 1.2,
    { color: color("Light colour", "#ff9a3c"), accent: color("Second colour", "#ff3c6e"), strength: num("Strength 0-1", 0.75, 0.1, 1), from: oneOf("Sweeps from", ["left", "right"], "left") }),
  card("lib_social_comment", "social", "Social: comment", "A comment bubble (avatar letter, name, text, likes) that pops in. Generic: no real logos.", 4,
    { name: str("Commenter", "alex.creates", 40), text: str("Comment", "This changed how I edit!", 200), likes: num("Likes", 128, 0, 1e9), avatar: color("Avatar colour", "#7c3aed"), size: num("Text size", 0.038, 0.015, 0.08), position: position("auto"), easing: COMMON.easing, speed: COMMON.speed, exit: COMMON.exit }, ["text"]),
  card("lib_social_notification", "social", "Social: notification", "A phone-style notification banner sliding down from the top. Generic.", 3.5,
    { app: str("App name", "Rendrr", 30), title: str("Title", "New follower", 60), body: str("Body", "Sam started following you", 120), icon: color("App square colour", "#111827"), size: num("Text size", 0.034, 0.015, 0.07), easing: COMMON.easing, speed: COMMON.speed, exit: COMMON.exit }),
  card("lib_social_followers", "social", "Social: follower counter", "A follower count ticking up with +1 chips floating off it.", 4,
    { from: num("Start", 9870, 0, 1e12), to: num("End", 10000, 0, 1e12), label: str("Label", "followers", 30), ...COMMON, size: num("Number size", 0.12, 0.04, 0.25), position: position("center") }),
  card("lib_social_chat", "social", "Social: chat", "Chat bubbles appearing in turn, with typing dots before each reply.", 6,
    { messages: list("[{side: left|right, text}] (up to 6)", [{ side: "left", text: "Did you finish the edit?" }, { side: "right", text: "Rendered 5 minutes ago" }], 6), mine: color("Right bubble colour", "#2563eb"), theirs: color("Left bubble colour", "#e5e7eb"), size: num("Text size", 0.036, 0.015, 0.07), position: position("center"), speed: COMMON.speed, exit: COMMON.exit }, ["messages"]),
  card("lib_social_post", "social", "Social: post card", "A generic social post (avatar, name, handle, text, reply / repost / like counts counting up). No real brand logo.", 4,
    { name: str("Name", "Ronny K", 40), handle: str("Handle", "@ronny", 30), text: str("Post text", "Stop cutting by hand. Let the engine measure.", 280), replies: num("Replies", 48, 0, 1e9), reposts: num("Reposts", 210, 0, 1e9), likes: num("Likes", 1900, 0, 1e9), avatar: color("Avatar colour", "#f97316"), size: num("Text size", 0.036, 0.015, 0.07), position: position("center"), easing: COMMON.easing, speed: COMMON.speed, exit: COMMON.exit }),
  edits("lib_bg_solid", "background", "Background: solid", "A solid colour behind V1 (set_background color).", 0, { color: color("Colour", "#111827") }),
  edits("lib_bg_gradient", "background", "Background: gradient", "A gradient behind V1 (set_background gradient).", 0, { from: color("From", "#ff66aa"), to: color("To", "#ffffff"), angle: num("Angle, degrees as CSS (180 = top to bottom)", 180, 0, 360) }),
  edits("lib_bg_grid", "background", "Background: grid", "Grid lines behind V1 (set_background pattern grid).", 0, { color: color("Paper colour", "#f8fafc"), ink: color("Line colour", "#cbd5e1"), size: num("Cell size, share of the short side", 0.06, 0.01, 0.3) }),
  edits("lib_bg_dots", "background", "Background: dots", "A dot grid behind V1 (set_background pattern dots).", 0, { color: color("Paper colour", "#f8fafc"), ink: color("Dot colour", "#94a3b8"), size: num("Spacing, share of the short side", 0.04, 0.01, 0.3) }),
  edits("lib_bg_paper", "background", "Background: paper", "A paper texture behind V1 (set_background pattern paper).", 0, { color: color("Paper colour", "#f4efe6"), ink: color("Fibre colour", "#d8cfbf") }),
  edits("lib_bg_blur", "background", "Background: blurred footage", "The clip's own picture blurred behind V1 (set_background blur).", 0, { amount: num("Blur 1-100", 50, 1, 100) }),
  card("lib_icon", "icon", "Icon", "One icon from the bundled set (search_icons finds it), animated in with an entrance, with an optional label beside it.", 3,
    { icon: str("Icon id from search_icons, like tabler:rocket", "tabler:sparkles", 80), svg: { type: "string", description: "Filled in by Rendrr from icon (leave it out)", default: "", maxLength: 20000 }, entrance: oneOf("Entrance", ["pop", "blur-in", "slide-in", "mask-reveal", "draw"], "pop"), label: str("Label beside it", "", 80), ...COMMON, color: color("Icon and label colour", "#ffffff"), size: num("Icon size, share of the short side", 0.16, 0.03, 0.6), position: position("center") }, ["icon"]),
];

export const libraryItem = (id: string) => LIBRARY_ITEMS.find((x) => x.id === id);
/** Library graphics behave as templates everywhere a template goes (render, editor player, test_graphic). */
export const isLibraryGraphic = (id: string | undefined | null) => !!id && LIBRARY_ITEMS.some((x) => x.id === id && x.place === "graphic");

/** The params a placement draws with: each default, replaced by what was sent. Refuses unknown names, wrong types and
 *  values outside the item's limits, naming what it takes. */
export function libraryParams(item: LibraryItem, params: P = {}): { params: P } | { error: string } {
  const props = item.paramsSchema.properties, out: P = {};
  for (const [k, s] of Object.entries(props)) out[k] = s.default ?? null;
  for (const [k, v] of Object.entries(params)) {
    const s = props[k];
    if (!s) return { error: `${item.name} has no param "${k}". Its params: ${Object.keys(props).join(", ")}.` };
    if (v === null || v === undefined) { out[k] = s.default ?? null; continue; }
    const t = Array.isArray(v) ? "array" : typeof v;
    if (s.type && s.type !== t && !(s.type === "number" && t === "string" && isFinite(Number(v)))) return { error: `Param "${k}" of ${item.name} takes a ${s.type}, not a ${t}.` };
    if (s.enum && !(s.enum as unknown[]).includes(v)) return { error: `Param "${k}" of ${item.name} is one of ${(s.enum as string[]).join(", ")}.` };
    if (s.type === "number") { const n = Number(v); if ((s.minimum != null && n < (s.minimum as number)) || (s.maximum != null && n > (s.maximum as number))) return { error: `Param "${k}" of ${item.name} is ${s.minimum} to ${s.maximum}.` }; out[k] = n; continue; }
    if (s.pattern && typeof v === "string" && !new RegExp(s.pattern as string).test(v)) return { error: `Param "${k}" of ${item.name} is a colour like #FF66AA.` };
    if (typeof v === "string" && s.maxLength && v.length > (s.maxLength as number)) return { error: `Param "${k}" of ${item.name} is at most ${s.maxLength} characters.` };
    if (Array.isArray(v) && s.maxItems && v.length > (s.maxItems as number)) return { error: `Param "${k}" of ${item.name} takes at most ${s.maxItems} entries.` };
    if (k === "position" && typeof v === "object" && !Array.isArray(v)) { const o = v as { x?: unknown; y?: unknown }; if (typeof o.x !== "number" || typeof o.y !== "number") return { error: `Param "position" is a name (${POSITIONS.join(", ")}) or {x, y} shares of the frame.` }; }
    out[k] = v;
  }
  for (const r of item.paramsSchema.required ?? []) if (out[r] == null || out[r] === "" || (Array.isArray(out[r]) && !(out[r] as unknown[]).length)) return { error: `${item.name} needs "${r}".` };
  return { params: out };
}

/** "lib_text_pop | text | Text: pop | 3s | text, font, ..." for list_library. */
export function libraryLine(x: LibraryItem): string {
  return `${x.id} | ${x.kind} | ${x.name} | ${x.place === "edits" ? "makes edits" : `${x.durationSec}s${x.transparent ? "" : ", opaque"}`} | ${x.description}`;
}
/** Each param with its default and what it is, for get_library_item. */
export function libraryParamsText(x: LibraryItem): string {
  return Object.entries(x.paramsSchema.properties).filter(([k]) => k !== "svg").map(([k, s]) => `${k}${(x.paramsSchema.required ?? []).includes(k) ? "*" : ""} = ${JSON.stringify(s.default ?? null)}${s.enum ? ` (${(s.enum as string[]).join("|")})` : s.type === "number" ? ` (${s.minimum}-${s.maximum})` : ""}: ${s.description ?? ""}`).join("\n");
}
