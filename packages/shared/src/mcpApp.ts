import { z } from "zod";
import type { ToolDef } from "./mcpTools";
import type { BoardStyle } from "./storyboard";

// The Rendrr app inside the chat (an MCP App, io.modelcontextprotocol/ui): the user's edits, each one's latest preview
// and its comments. open_projects (an AI tool, MCP_TOOLS) opens it; the app itself calls these tools through the host.
// They are hidden from the AI (visibility "app"); the AI reads comments with get_comments.

export const APP_RESOURCE_URI = "ui://rendrr/projects.html";
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

const id = (what: string) => z.string().min(1).max(80).describe(`The ${what} id`);

/** A drawing on the picture: strokes in 0-1 of the picture (x, y pairs), colour, width as a share of the picture's
 *  width; png: the strokes on a clear picture (base64), so the AI can see them on the frame. */
export const DrawingInput = z.object({
  w: z.number().int().min(16).max(4096), h: z.number().int().min(16).max(4096),
  strokes: z.array(z.object({ c: z.string().regex(/^#[0-9a-fA-F]{6}$/), w: z.number().min(0.001).max(0.05), p: z.array(z.number().min(0).max(1)).min(2).max(4000) })).min(1).max(80),
  png: z.string().max(800_000).optional(),
});
/** A picture added to a comment: JPEG, PNG or WebP as base64 (the app makes it 1600 px or smaller). */
export const CommentImageInput = z.object({ name: z.string().max(200).optional(), type: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().min(16).max(1_500_000), w: z.number().int().min(1).max(8192).optional(), h: z.number().int().min(1).max(8192).optional() });
export const COMMENT_IMAGES_MAX = 4;
/** Words one Apply in the app's transcript may cut or bring back (each list). */
export const TRANSCRIPT_EDIT_MAX = 20_000;

export const APP_TOOLS: ToolDef[] = [
  { name: "app_list_projects", title: "Projects for the app", app: true, description: "The Rendrr app: the user's projects (folders), and a page of edits, newest first: those of one project (folderId), or all.",
    input: z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(60).optional(), query: z.string().max(100).optional(), folderId: id("project folder").optional() }) },
  { name: "app_get_project", title: "One project for the app", app: true, description: "The Rendrr app: one edit's latest preview (or the render asked for), its rendered versions, its render progress and its comments.",
    input: z.object({ projectId: id("project"), renderId: id("render").optional() }) },
  { name: "app_rename_project", title: "Rename the edit", app: true, write: true, description: "The Rendrr app: rename the edit.",
    input: z.object({ projectId: id("project"), name: z.string().trim().min(1).max(120) }) },
  { name: "app_add_comment", title: "Add a comment", app: true, write: true, description: "The Rendrr app: add the user's comment at a moment of the preview (seconds of the edited video), with a drawing on the picture and pictures if they made them, and x/y (0-1 of the frame) when it was pinned to a spot.",
    input: z.object({ projectId: id("project"), time: z.number().min(0).max(24 * 3600), text: z.string().trim().max(2000).default(""), renderId: id("render").optional(), drawing: DrawingInput.optional(), images: z.array(CommentImageInput).max(COMMENT_IMAGES_MAX).optional(), x: z.number().finite().min(0).max(1).optional(), y: z.number().finite().min(0).max(1).optional() }) },
  { name: "app_edit_comment", title: "Edit a comment", app: true, write: true, description: "The Rendrr app: change the user's own comment: its text, its drawing (null takes it off), pictures to take off (their ids) or to add.",
    input: z.object({ projectId: id("project"), commentId: id("comment"), text: z.string().trim().max(2000).optional(), drawing: DrawingInput.nullable().optional(), removeImages: z.array(z.string().max(300)).max(COMMENT_IMAGES_MAX).optional(), images: z.array(CommentImageInput).max(COMMENT_IMAGES_MAX).optional() }) },
  { name: "app_delete_comment", title: "Delete a comment", app: true, write: true, description: "The Rendrr app: delete a comment (the user's own, or a client's on their edit) and its pictures.",
    input: z.object({ projectId: id("project"), commentId: id("comment") }) },
  { name: "app_resolve_comment", title: "Resolve a comment", app: true, write: true, description: "The Rendrr app: mark a comment resolved, or open again with resolved false.",
    input: z.object({ projectId: id("project"), commentId: id("comment"), resolved: z.boolean().optional() }) },
  { name: "app_share_link", title: "Share the video", app: true, write: true, description: "The Rendrr app: a review link (watch and comment, no account needed) for this version of an edit (projectId), or for a whole project folder (folderId: every edit in it, edits added later too): the one already made, or a new one.",
    input: z.object({ projectId: id("project").optional(), folderId: id("project folder").optional(), version: z.number().int().min(1).max(100_000).optional() }) },
  { name: "app_render_preview", title: "Render a preview", app: true, write: true, description: "The Rendrr app: render a preview of the latest version when it has none.",
    input: z.object({ projectId: id("project") }) },
  { name: "app_log", title: "Card log", app: true, description: "The Rendrr app: what happened to the card (it started, the host closed it, an error), kept in the connector's log to find problems. Nothing is saved.",
    input: z.object({ event: z.enum(["start", "mode", "teardown", "error", "hide"]), detail: z.string().max(500).optional(), seconds: z.number().min(0).max(7 * 86400).optional() }) },
  { name: "app_get_samples", title: "Samples for the app", app: true, description: "The Rendrr app: a set of samples (render_samples) or a storyboard (create_storyboard): its progress, each frame's picture and each clip's video, and the user's changes on them.",
    input: z.object({ renderId: id("render") }) },
  { name: "app_approve_storyboard", title: "Approve the storyboard", app: true, write: true, description: "The Rendrr app: the user approves a storyboard (approved false takes it back).",
    input: z.object({ renderId: id("render"), approved: z.boolean().optional() }) },
  { name: "app_get_transcript", title: "Transcript for the app", app: true, description: "The Rendrr app: the edit's footage, word by word: each word in the edit, cut, or out of it, and where it plays in the render watched (renderId) to jump there.",
    input: z.object({ projectId: id("project"), renderId: id("render").optional() }) },
  { name: "app_cut_words", title: "Cut words from the transcript", app: true, write: true, description: "The Rendrr app: the user cut words from the transcript (cut: word ids) and brought cut ones back (restore), as one new version of the edit.",
    input: z.object({ projectId: id("project"), cut: z.array(z.string().min(1).max(40)).max(TRANSCRIPT_EDIT_MAX).optional(), restore: z.array(z.string().min(1).max(40)).max(TRANSCRIPT_EDIT_MAX).optional(), renderId: id("render").optional() }) },
  // The @ footage picker in the app's comment boxes: the edit's client folder first, every library folder, a folder's
  // clips (a tiny hover preview each), and which library folder shows first for a client.
  { name: "app_footage_folders", title: "Footage folders", app: true, description: "The Rendrr app: the footage picker (@ in a comment box): the edit's client and its library folder, every library folder, and how many videos are in none.",
    input: z.object({ projectId: id("project") }) },
  { name: "app_footage_clips", title: "Footage clips", app: true, description: "The Rendrr app: the footage picker: one library folder's clips (folderId), the videos in no folder (loose), or clips found by name (query), each with a tiny hover preview.",
    input: z.object({ folderId: id("library folder").optional(), loose: z.boolean().optional(), query: z.string().max(80).optional() }) },
  { name: "app_set_client_footage", title: "Client footage folder", app: true, write: true, description: "The Rendrr app: the footage picker: show this library folder first for the edit's client (null: none).",
    input: z.object({ projectId: id("project"), libraryFolderId: id("library folder").nullable() }) },
];

/** What the app shows for one edit (app_get_project, open_projects with a projectId). */
export type Stroke = { c: string; w: number; p: number[] };
export type CommentDrawing = { w: number; h: number; strokes: Stroke[] };
export type CommentImage = { id: string; url: string; w: number | null; h: number | null; name: string | null };
export type AppComment = { id: string; time: number; text: string; author: string; mine: boolean; resolved: boolean; at: number; edited: boolean; renderId: string | null; drawing: CommentDrawing | null; images: CommentImage[]; x?: number; y?: number };
export type AppProjectView = {
  project: { id: string; name: string; folder: string; folderId: string; aspect: string; status: string; version: number; updated: number; seconds: number | null; editorUrl: string | null };
  /** The render being watched: the latest preview, or the version picked (a preview or a final); download: its file. */
  preview: { renderId: string; version: number; kind: "preview" | "final"; url: string; download: string; fileName: string; seconds: number; quality: string; at: number; where?: string; machine?: string;
    /** Show only the fix (audit #23): after a comment fix, the moments this preview changed since v`of` (edit seconds),
     *  played first; then the whole preview. */
    fix?: { of: number; moments: { from: number; to: number }[] } } | null;
  /** Every rendered version to pick from, newest first (a final and a preview of the same version are both there). */
  versions: { renderId: string; version: number; kind: "preview" | "final"; quality: string; at: number }[];
  /** A preview or final being made now; where: where it is made (the user's Mac or the cloud) and where the file goes. */
  rendering: { renderId: string; version: number; percent: number; step: string | null; etaSec: number | null; queued: boolean; kind?: "preview" | "final"; where?: string; machine?: string } | null;
  /** The Rendrr desktop app: open (and on which computer: a Mac, or a Windows PC), so the AI's finals go to its Downloads. */
  mac?: { online: boolean; device: string | null; renders?: boolean; platform?: "mac" | "windows"; count?: number };
  failed: { version: number; error: string } | null;
  comments: AppComment[];
};
export type AppProjectCard = {
  id: string; name: string; folder: string; folderId: string; aspect: string; status: string; version: number; updated: number; seconds: number | null;
  thumb: string | null; previewVersion: number | null; rendering: boolean; openComments: number;
};
/** A project (a folder of edits, one per client or campaign) on the app's first page. */
/** thumb: the newest video's picture; thumbs: the newest videos' pictures, up to 4 (the card shows them as a grid). */
export type AppFolderCard = { id: string; name: string; edits: number; updated: number; thumb: string | null; thumbs?: string[]; aspect: string | null; openComments: number; rendering: boolean };
/** folders: every project of the user (sent with the first page); folder: the project the edits are of, when one was asked for. */
export type AppProjectsPage = { projects: AppProjectCard[]; total: number; offset: number; folders?: AppFolderCard[]; folder?: { id: string; name: string } | null };
/** Samples (render_samples): a few frames and short clips of an edit, shown as a storyboard to ask changes on. */
export type AppSampleItem = { kind: "frame" | "clip"; at: number; end: number | null; note: string | null; still: string | null; clip: string | null;
  /** A storyboard's panel: its beat, the words said, what we see, and the captions and text on screen there. */
  title?: string | null; caption?: string | null; shot?: string | null; onScreen?: string | null;
  /** A board of picture frames: the clip a panel was asked as ([start, end]), for video frames later. */
  video?: [number, number] };
/** A storyboard's board (Storyboard mode): its title, rules, palette, the edit's style sheet, and the user's approval.
 *  latestVersion: the edit's version now (a board of an older one shows the edit before later changes). */
export type AppBoard = { title: string; rules: string[]; palette: { hex: string; name: string }[]; style: BoardStyle | null; status: "review" | "approved"; approvedAt: number | null; latestVersion: number; url: string | null;
  /** "images": picture frames only; "video": pictures and short video frames. */
  frames?: "images" | "video" };
export type AppSamples = {
  renderId: string; project: { id: string; name: string; aspect: string; version: number; editorUrl: string | null };
  /** The edit's version the samples show. */
  version: number;
  status: "queued" | "running" | "done" | "failed"; percent: number; step: string | null; etaSec: number | null; error: string | null;
  width: number | null; height: number | null;
  items: AppSampleItem[];
  /** The user's changes asked on these samples (comments on this render, at each sample's edit time). */
  comments: AppComment[];
  /** Set when these samples are a storyboard. */
  board?: AppBoard | null;
};
/** open_projects' structured result: the page of projects, and the edit to open when it was asked for. */
/** With an edit open, the list is left out (the app loads it with app_list_projects when the user goes back to it). */
export type AppOpen = Partial<AppProjectsPage> & { open: AppProjectView | null; webUrl: string | null; samples?: AppSamples | null };

/** The app's Transcript tab (app_get_transcript): the main footage's words, a line at a time. A word is
 *  [id, text, footage start, footage end, state, at, filler]: state "in" (plays in the edit), "cut" (cut from the
 *  transcript, restore brings it back), "out" (its footage is not in the edit: a range cut or a trimmed clip); at: where
 *  it starts in the render watched (edit seconds of that render's version), null where it does not play there. */
export type AppWord = [id: string, text: string, t: number, end: number, state: "in" | "cut" | "out", at: number | null, filler: 0 | 1];
export type AppTranscriptLine = { id: string; start: number; gap: number; words: AppWord[] };
export type AppTranscript = {
  projectId: string; name: string;
  /** The edit's version now: the states are of it. */
  version: number;
  /** The version whose times "at" are (the render watched, else the edit now), and that render. */
  timesOf: { version: number; renderId: string | null };
  lines: AppTranscriptLine[];
  counts: { words: number; cut: number; out: number };
  /** Set when there is nothing to show yet (the footage still being transcribed), or the words were cut short. */
  note: string | null;
};
/** app_cut_words' result: the transcript after the change, the edit as the app shows it, and what changed. */
export type AppTranscriptChange = { transcript: AppTranscript; view: AppProjectView; summary: string; version: number; changed: boolean; cut: number; restored: number };

