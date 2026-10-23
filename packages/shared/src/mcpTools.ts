import { z } from "zod";
import { ASPECTS } from "./constants";
import { EDIT_OP_NAMES } from "./ops";

// The AI tools. One list: the MCP server advertises it, the API validates against it.
// Kept short on purpose: every word here is sent to the AI at the start of every conversation.
const id = (what: string) => z.string().min(1).max(80).describe(`The ${what} id`);
const projectId = id("project");
const page = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional().describe("Default 20") };
// The edit list and style rules are described in words, not as full schemas (much shorter); the API checks each
// edit against EditOpSchema and the rules against StyleRulesPatchSchema, and says exactly what is wrong.
const EDIT_FIELDS = "cut_silences{overSeconds} remove_fillers cut_words{wordIds | from,to} restore_words{wordIds} set_captions{on, look: clean|bold|outline} edit_caption{lineId, text} add_zoom{start, end, scale: 1.1 = 110%} add_broll{videoId, start, end, sourceStart} add_music{trackId: track id or mood, gainDb} add_graphic{graphicId, start, end, params} apply_style{styleId, overrides: rules} set_aspect{aspect: 16:9|9:16|1:1} rename{name} split_clip{track, clipId, at} trim_clip{track, clipId, start, end} delete_clip{track, clipId} set_clips{track, clips}. Tracks: v1 main, v2 b-roll/zooms, v3 graphics, a1 dialogue, a2 music, a3 sfx.";
const RULE_FIELDS = "cutSilencesOver (seconds or null), removeFillers, trimEdges, captions{on, look, wordsAtOnce, upper, maxLines}, zoom{mode: none|newSentence|interval|slowPush|count, scale, everySec, holdSec, count}, music{mood, gainDb}, sfxOnZoom";

export type ToolDef = { name: string; title: string; description: string; input: z.ZodObject<z.ZodRawShape>; write?: boolean; long?: boolean };

export const MCP_TOOLS: ToolDef[] = [
  // ---------------- read ----------------
  { name: "list_footage", title: "List footage", description: "The user's videos, newest first: id, name, kind (footage, or reference = a style to copy), length, shape, status. Only ready videos can be read or edited.",
    input: z.object({ kind: z.enum(["footage", "reference"]).optional(), ...page }) },
  { name: "get_footage", title: "Read a video", description: "Read a video without watching it: shots (times, light, colour, motion, loudness, what is said), pacing, hook, beat, transcript with line ids, silences, fillers, scene cuts. Attached: one overview image of 16 frames across the video, time on each tile. pictures \"sheets\" sends the frame sheets for from/to (up to 4), \"none\" text only. detail \"words\" adds word ids. Works for reference videos and saved recipes too.",
    input: z.object({ videoId: id("video"), detail: z.enum(["sentences", "words", "json"]).optional(), pictures: z.enum(["overview", "sheets", "none"]).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional() }) },
  { name: "get_frames", title: "Look at moments", description: "Frames of a video at exact times (seconds in the original video): up to 8 times, or from/to with a count.",
    input: z.object({ videoId: id("video"), times: z.array(z.number().min(0)).max(8).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional(), count: z.number().int().min(1).max(8).optional() }) },
  { name: "list_styles", title: "List styles", description: "Style packs, built in and saved: id, name, type, vibe, shapes, platforms.", input: z.object({}) },
  { name: "get_style", title: "Read a style", description: "Every rule of one style.", input: z.object({ styleId: id("style") }) },
  { name: "list_folders", title: "List folders", description: "The user's folders (one per client).", input: z.object({}) },
  { name: "list_projects", title: "List edits", description: "The user's edits, newest first, optionally in one folder.", input: z.object({ folderId: id("folder").optional(), ...page }) },
  { name: "get_project", title: "Read an edit", description: "One edit: clips per track with ids and times (original footage seconds), cut words, captions, style, aspect, status, version.", input: z.object({ projectId }) },
  { name: "list_graphics", title: "List graphics", description: "Graphic templates with their params, the user's custom graphics, music tracks and sound effects.", input: z.object({}) },
  { name: "get_comments", title: "Read comments", description: "Client review comments and the user's notes on an edit: id, time, text, resolved.", input: z.object({ projectId }) },
  { name: "get_preview_frames", title: "See the preview", description: "Frames of the latest preview at OUTPUT times (up to 5, default spread) and the transcript as it now plays. Only when you need to look: render_preview already returns a text check.",
    input: z.object({ projectId, times: z.array(z.number().min(0)).max(5).optional() }) },

  // ---------------- write ----------------
  { name: "create_project", title: "Create an edit", write: true, description: "New edit from ready footage. Version 1 is the footage as recorded; then apply_edits.",
    input: z.object({ videoId: id("footage"), styleId: id("style").optional(), folderId: id("folder").optional(), name: z.string().max(200).optional(), aspect: z.enum(ASPECTS).optional() }) },
  { name: "apply_edits", title: "Edit", write: true, description: `Change an edit in one call: the edits run in order and are saved as ONE new version (undo reverts them together); if one fails nothing is saved. Times are seconds in the ORIGINAL footage. Each edit is {op, ...fields}: ${EDIT_FIELDS} apply_style overrides change some of the style's rules, e.g. {"zoom":{"mode":"count","count":2}}. note: one or two plain sentences for the user, shown with the steps in Rendrr's AI tab (a note with no edits just posts it).`,
    input: z.object({ projectId, edits: z.array(z.object({ op: z.enum(EDIT_OP_NAMES) }).passthrough()).max(50).default([]), note: z.string().max(600).optional() }) },
  { name: "save_style", title: "Save a style", write: true, description: `Save rules as a style to apply in one step later (apply_edits apply_style). Rules: ${RULE_FIELDS}; anything left out comes from baseStyleId (default: no cuts, clean captions, no zooms, no music). fromVideoId: the reference video the rules come from, so it is not read again.`,
    input: z.object({ name: z.string().min(1).max(80), rules: z.record(z.unknown()), baseStyleId: id("style").optional(), fromVideoId: id("reference video").optional() }) },
  { name: "undo", title: "Undo", write: true, description: "Go back `steps` versions (default 1). Undone versions stay in history.", input: z.object({ projectId, steps: z.number().int().min(1).max(50).optional() }) },
  { name: "create_graphic", title: "Create a custom graphic", long: true, description: "Make a motion graphic from HTML/CSS/JS, recorded in a locked browser with no network (max 15s, 1080x1920). Animate with CSS, or define window.renderFrame(t). Returns the graphic id and 4 check frames; place it with apply_edits add_graphic.",
    input: z.object({ code: z.string().min(1).max(200_000), durationSec: z.number().min(0.5).max(15), width: z.number().int().min(64).max(1920), height: z.number().int().min(64).max(1920), transparent: z.boolean().default(true), name: z.string().max(120).optional() }) },
  { name: "link_account", title: "Link to the user's account", write: true, description: "Use when this login shows an empty library but the user has videos on the Rendrr website: they get a code in Rendrr > Connect AI > Link another login; pass it here.",
    input: z.object({ code: z.string().min(4).max(12) }) },

  // ---------------- render and share ----------------
  { name: "render_preview", title: "Render a preview", long: true, description: "Render a 540p preview (waits up to 60s). Returns a text check of the result: length, pauses and fillers left, caption coverage, zooms, b-roll, graphics, music, cuts, loudness.", input: z.object({ projectId }) },
  { name: "render_final", title: "Render the final", long: true, description: "Render the 1080p final (waits up to 180s, else returns a render id). Footage from the user's computer needs the original once: the tool says so.", input: z.object({ projectId }) },
  { name: "get_render", title: "Check a render", description: "Status of a render id.", input: z.object({ renderId: id("render") }) },
  { name: "create_review_link", title: "Share for review", write: true, description: "A client review link (watch, comment, approve; no account needed).", input: z.object({ projectId, password: z.string().max(100).optional(), expiresDays: z.number().int().min(1).max(365).optional(), allowDownload: z.boolean().optional() }) },
  { name: "resolve_comment", title: "Resolve a comment", write: true, description: "Mark a comment resolved.", input: z.object({ commentId: id("comment") }) },
];

export const HOW_TO_EDIT = `# How to edit with Rendrr

You decide the edit. Rendrr measures, does exactly what you send, and renders. Every time you send is seconds in the ORIGINAL footage.

1. **Read.** list_footage, then get_footage(videoId): the breakdown (shots, pacing, hook, beat), transcript, silences and fillers, plus one overview image. Ask for pictures "sheets" or get_frames only when you need to see more.
2. **Style.** list_styles and get_style. For a reference video (a style to copy): read it once with get_footage, then save_style with fromVideoId and the rules you take from it. Next time apply that style; no need to read the reference again.
3. **Edit.** create_project, then one apply_edits call with all the changes: cuts, captions, zooms, music, b-roll, graphics. apply_style with overrides is a quick rule-based first pass. Add a short note for the user.
4. **Check.** render_preview returns a text check: pauses and fillers left, captions, zooms, music, loudness. Fix with another apply_edits. get_preview_frames only to look at framing.
5. **Hand off.** Tell the user what you did. create_review_link for client feedback, get_comments and resolve_comment for notes, render_final for the 1080p file.`;
