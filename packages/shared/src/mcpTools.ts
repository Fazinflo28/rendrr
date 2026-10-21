import { z } from "zod";
import { ASPECTS, CAPTION_LOOKS } from "./constants";

// The AI tools. One list: the MCP server advertises it, the API validates against it.
// Every write goes through applyTimelineChange and makes a new version.
const id = (what: string) => z.string().min(1).max(80).describe(`The ${what} id`);
const projectId = id("project");
const sec = (d: string) => z.number().min(0).max(24 * 3600).describe(d + " (seconds in the ORIGINAL footage, not the edited output)");
const track = z.enum(["v1", "v2", "v3", "a1", "a2", "a3"]).describe("v1 main cut, v2 b-roll and zooms, v3 titles and graphics, a1 dialogue, a2 music, a3 sound effects");

export type ToolDef = { name: string; title: string; description: string; input: z.ZodObject<z.ZodRawShape>; write?: boolean; long?: boolean };

export const MCP_TOOLS: ToolDef[] = [
  // ---------------- read ----------------
  { name: "list_footage", title: "List footage", description: "List the user's footage: id, name, length, shape, status and where the raw file lives. Only footage with status ready can be edited.", input: z.object({}) },
  { name: "get_footage", title: "Read footage", description: "Read one piece of footage: transcript (sentence lines with start times and line ids; pass detail \"words\" for word ids and times), silences, filler words, scene cuts, 5 key frames, length and shape. Use from/to (seconds) to page through long transcripts.",
    input: z.object({ videoId: id("footage"), detail: z.enum(["sentences", "words"]).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional() }) },
  { name: "list_styles", title: "List styles", description: "List the style packs: id, name, type, vibe, shapes and platforms.", input: z.object({}) },
  { name: "get_style", title: "Read a style", description: "Read every rule of one style pack, as text and as the machine rules the server applies.", input: z.object({ styleId: id("style") }) },
  { name: "list_folders", title: "List folders", description: "List the user's project folders (one per client).", input: z.object({}) },
  { name: "list_projects", title: "List edits", description: "List edits (projects), optionally only those in one folder.", input: z.object({ folderId: id("folder").optional() }) },
  { name: "get_project", title: "Read an edit", description: "Read one edit: clips per track with times and labels, cut word count, captions on/off and look, style, aspect, status and current version. Clip times are seconds in the original footage.", input: z.object({ projectId }) },
  { name: "get_reference", title: "Read a reference", description: "Read a reference recipe (from the community gallery or a saved reference): cut rhythm, caption look, zoom pattern and structure, plus up to 5 frames.", input: z.object({ referenceId: id("reference or gallery item") }) },
  { name: "list_graphics", title: "List graphics", description: "List graphic templates and the user's custom graphics, with the params each template accepts. Also lists the music tracks and sound effects.", input: z.object({}) },
  { name: "get_comments", title: "Read comments", description: "Read the comments on an edit: the client's review comments and the user's own notes from the editor, each with time, text and resolved.", input: z.object({ projectId }) },
  { name: "get_preview_frames", title: "See the preview", description: "Get up to 5 frames from the latest preview render (at the given OUTPUT times in seconds, or spread evenly) plus the transcript as it now plays after cuts. Render a preview first.",
    input: z.object({ projectId, times: z.array(z.number().min(0)).max(5).optional() }) },

  // ---------------- write (each makes a new version) ----------------
  { name: "create_project", title: "Create an edit", write: true, description: "Create a new edit from ready footage. Starts from the footage as recorded; call apply_style next for a first pass.",
    input: z.object({ videoId: id("footage"), styleId: id("style").optional(), folderId: id("folder").optional(), name: z.string().max(200).optional(), aspect: z.enum(ASPECTS).optional() }) },
  { name: "apply_style", title: "Apply a style", write: true, description: "Apply a style pack's rules on the server: cuts pauses over the style's threshold, removes filler words if the style says so, sets the caption look, adds zooms and music. Returns a summary of what changed.", input: z.object({ projectId, styleId: id("style") }) },
  { name: "cut_words", title: "Cut words", write: true, description: "Remove words from the video, by word ids (from get_footage detail \"words\") or by a from/to time range.", input: z.object({ projectId, wordIds: z.array(z.string().max(40)).max(5000).optional(), from: sec("Start").optional(), to: sec("End").optional() }) },
  { name: "restore_words", title: "Restore words", write: true, description: "Put cut words back.", input: z.object({ projectId, wordIds: z.array(z.string().max(40)).min(1).max(5000) }) },
  { name: "cut_silences", title: "Cut silences", write: true, description: "Remove every pause longer than overSeconds.", input: z.object({ projectId, overSeconds: z.number().min(0.1).max(30) }) },
  { name: "remove_fillers", title: "Remove filler words", write: true, description: "Cut every filler word (um, uh, like, you know, basically, honestly).", input: z.object({ projectId }) },
  { name: "set_clips", title: "Set a track's clips", write: true, description: "Replace all clips on one track. Each clip: {id, start, end, label, ...track fields}. Times are seconds in the original footage.", input: z.object({ projectId, track, clips: z.array(z.object({ id: z.string().max(80), start: z.number().min(0), end: z.number().min(0), label: z.string().max(300).default("") }).passthrough()).max(2000) }) },
  { name: "split_clip", title: "Split a clip", write: true, description: "Split a clip in two at a time inside it.", input: z.object({ projectId, track, clipId: id("clip"), at: sec("Split time") }) },
  { name: "trim_clip", title: "Trim a clip", write: true, description: "Set a clip's start and end.", input: z.object({ projectId, track, clipId: id("clip"), start: sec("New start"), end: sec("New end") }) },
  { name: "delete_clip", title: "Delete a clip", write: true, description: "Remove a clip from a track.", input: z.object({ projectId, track, clipId: id("clip") }) },
  { name: "add_zoom", title: "Add a zoom", write: true, description: "Zoom in between start and end. scale 1.1 = 110%. Short zooms punch in; zooms over 4 seconds push in slowly.", input: z.object({ projectId, start: sec("Start"), end: sec("End"), scale: z.number().min(1.01).max(2) }) },
  { name: "add_broll", title: "Add b-roll", write: true, description: "Lay another piece of the user's ready footage over the main video (picture only; dialogue keeps playing). sourceStart is where to start inside the b-roll footage.",
    input: z.object({ projectId, videoId: id("b-roll footage"), start: sec("Start"), end: sec("End"), sourceStart: z.number().min(0).default(0).describe("Seconds into the b-roll footage") }) },
  { name: "set_captions", title: "Captions on or off", write: true, description: "Turn captions on or off and optionally set the look: clean, bold or outline. Captions are timed by the server from the transcript.", input: z.object({ projectId, on: z.boolean(), look: z.enum(CAPTION_LOOKS).optional() }) },
  { name: "edit_caption", title: "Edit a caption line", write: true, description: "Change the caption text of one transcript line (line ids from get_footage). Keep the same number of words to keep word timing.", input: z.object({ projectId, lineId: z.string().max(40), text: z.string().max(2000) }) },
  { name: "add_music", title: "Add music", write: true, description: "Add a music bed by track id or by mood (lofi, upbeat, cinematic, ambient, trending, news, suspense, gameshow). It plays under the whole edit, ducked under speech. gainDb defaults to -18.",
    input: z.object({ projectId, trackId: z.string().max(80).optional(), mood: z.string().max(40).optional(), gainDb: z.number().min(-40).max(6).optional() }) },
  { name: "add_graphic", title: "Add a graphic", write: true, description: "Place a graphic (template or custom, from list_graphics) on V3 between start and end, with template params.", input: z.object({ projectId, graphicId: id("graphic"), start: sec("Start"), end: sec("End"), params: z.record(z.unknown()).optional() }) },
  { name: "create_graphic", title: "Create a custom graphic", long: true, description: "Make a custom motion graphic from HTML/CSS/JS. It is recorded in a locked browser with no network, at most 15 seconds and 1080x1920. Animate with CSS animations, or define window.renderFrame(t) (t in seconds) to draw each frame; requestAnimationFrame and Date.now follow the recording clock. Returns the graphic id and 4 check frames. Then use add_graphic.",
    input: z.object({ code: z.string().min(1).max(200_000), durationSec: z.number().min(0.5).max(15), width: z.number().int().min(64).max(1920), height: z.number().int().min(64).max(1920), transparent: z.boolean().default(true), name: z.string().max(120).optional() }) },
  { name: "set_aspect", title: "Change the shape", write: true, description: "Set the output shape: 16:9, 9:16 or 1:1.", input: z.object({ projectId, aspect: z.enum(ASPECTS) }) },
  { name: "rename_project", title: "Rename an edit", write: true, description: "Rename an edit.", input: z.object({ projectId, name: z.string().min(1).max(200) }) },
  { name: "undo", title: "Undo", write: true, description: "Go back `steps` versions (default 1). The undone versions stay in history.", input: z.object({ projectId, steps: z.number().int().min(1).max(50).optional() }) },

  // ---------------- render and share ----------------
  { name: "render_preview", title: "Render a preview", long: true, description: "Render a quick 540p preview. Waits up to 60 seconds and returns the preview link and 4 frames; if it takes longer, returns a render id for get_render.", input: z.object({ projectId }) },
  { name: "render_final", title: "Render the final", long: true, description: "Render the full-quality 1080p final from the original. Waits up to 180 seconds; otherwise returns a render id for get_render. Footage from the user's computer needs the original once: the tool says so.", input: z.object({ projectId }) },
  { name: "get_render", title: "Check a render", description: "Status of a render. When done: link, quality, size and 4 frames.", input: z.object({ renderId: id("render") }) },
  { name: "create_review_link", title: "Share for review", write: true, description: "Make a client review link for an edit (the client can watch, comment and approve without an account).", input: z.object({ projectId, password: z.string().max(100).optional(), expiresDays: z.number().int().min(1).max(365).optional(), allowDownload: z.boolean().optional() }) },
  { name: "resolve_comment", title: "Resolve a comment", write: true, description: "Mark a comment (client comment or the user's note) as resolved.", input: z.object({ commentId: id("comment") }) },
];

export const HOW_TO_EDIT = `# How to edit with Rendrr

Rendrr is your eyes and hands. You are the brain: read small text, decide the edit, send small instructions. You never render pixels yourself.

1. **Read the footage.** list_footage, then get_footage(videoId). Read the transcript (line ids, start times), silences, filler words, scene cuts and key frames.
2. **Read the style.** get_style(styleId) for the rules, or list_styles to pick one that fits the platform and shape.
3. **Plan the hook.** The first 3 seconds decide everything. Find the strongest line; cut to it or move the weak opening out with cut_words.
4. **First pass.** create_project, then apply_style (cuts pauses, removes fillers, sets captions, zooms, music by the style's rules).
5. **Cut.** cut_words with word ids (get_footage detail "words") or a from/to range. cut_silences for any leftover dead air. Keep sentences whole.
6. **Caption.** Captions are timed by the server. Fix wording with edit_caption (same word count keeps timing). set_captions for the look.
7. **Polish.** add_zoom on key lines, add_broll from other footage, add_music by mood, add_graphic (list_graphics) or create_graphic for something custom.
8. **Render a preview.** render_preview, then get_preview_frames to check framing, captions and the opening.
9. **Fix.** Adjust, render again. Every change is a version; undo goes back.
10. **Hand off.** Tell the user what you did and the preview link. create_review_link when they want client feedback; get_comments and resolve_comment to work through notes. render_final for the 1080p export.

Times: every start/end you send is seconds in the ORIGINAL footage (the transcript's times), not the edited output. Output times only appear in get_preview_frames.`;
