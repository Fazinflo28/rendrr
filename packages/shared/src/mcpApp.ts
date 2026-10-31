import { z } from "zod";
import type { ToolDef } from "./mcpTools";

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

export const APP_TOOLS: ToolDef[] = [
  { name: "app_list_projects", title: "Projects for the app", app: true, description: "The Rendrr app: a page of the user's edits, newest first.",
    input: z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(60).optional(), query: z.string().max(100).optional() }) },
  { name: "app_get_project", title: "One project for the app", app: true, description: "The Rendrr app: one edit's latest preview (or the render asked for), its rendered versions, its render progress and its comments.",
    input: z.object({ projectId: id("project"), renderId: id("render").optional() }) },
  { name: "app_rename_project", title: "Rename the edit", app: true, write: true, description: "The Rendrr app: rename the edit.",
    input: z.object({ projectId: id("project"), name: z.string().trim().min(1).max(120) }) },
  { name: "app_add_comment", title: "Add a comment", app: true, write: true, description: "The Rendrr app: add the user's comment at a moment of the preview (seconds of the edited video), with a drawing on the picture and pictures if they made them.",
    input: z.object({ projectId: id("project"), time: z.number().min(0).max(24 * 3600), text: z.string().trim().max(2000).default(""), renderId: id("render").optional(), drawing: DrawingInput.optional(), images: z.array(CommentImageInput).max(COMMENT_IMAGES_MAX).optional() }) },
  { name: "app_edit_comment", title: "Edit a comment", app: true, write: true, description: "The Rendrr app: change the user's own comment: its text, its drawing (null takes it off), pictures to take off (their ids) or to add.",
    input: z.object({ projectId: id("project"), commentId: id("comment"), text: z.string().trim().max(2000).optional(), drawing: DrawingInput.nullable().optional(), removeImages: z.array(z.string().max(300)).max(COMMENT_IMAGES_MAX).optional(), images: z.array(CommentImageInput).max(COMMENT_IMAGES_MAX).optional() }) },
  { name: "app_delete_comment", title: "Delete a comment", app: true, write: true, description: "The Rendrr app: delete a comment (the user's own, or a client's on their edit) and its pictures.",
    input: z.object({ projectId: id("project"), commentId: id("comment") }) },
  { name: "app_resolve_comment", title: "Resolve a comment", app: true, write: true, description: "The Rendrr app: mark a comment resolved, or open again with resolved false.",
    input: z.object({ projectId: id("project"), commentId: id("comment"), resolved: z.boolean().optional() }) },
  { name: "app_share_link", title: "Share the video", app: true, write: true, description: "The Rendrr app: a review link for this version (watch and comment, no account needed): the one already made, or a new one.",
    input: z.object({ projectId: id("project"), version: z.number().int().min(1).max(100_000).optional() }) },
  { name: "app_render_preview", title: "Render a preview", app: true, write: true, description: "The Rendrr app: render a preview of the latest version when it has none.",
    input: z.object({ projectId: id("project") }) },
  { name: "app_get_samples", title: "Samples for the app", app: true, description: "The Rendrr app: a set of samples (render_samples): its progress, each frame's picture and each clip's video, and the user's changes on them.",
    input: z.object({ renderId: id("render") }) },
];

/** What the app shows for one edit (app_get_project, open_projects with a projectId). */
export type Stroke = { c: string; w: number; p: number[] };
export type CommentDrawing = { w: number; h: number; strokes: Stroke[] };
export type CommentImage = { id: string; url: string; w: number | null; h: number | null; name: string | null };
export type AppComment = { id: string; time: number; text: string; author: string; mine: boolean; resolved: boolean; at: number; edited: boolean; renderId: string | null; drawing: CommentDrawing | null; images: CommentImage[] };
export type AppProjectView = {
  project: { id: string; name: string; folder: string; aspect: string; status: string; version: number; updated: number; seconds: number | null; editorUrl: string | null };
  /** The render being watched: the latest preview, or the version picked (a preview or a final); download: its file. */
  preview: { renderId: string; version: number; kind: "preview" | "final"; url: string; download: string; fileName: string; seconds: number; quality: string; at: number } | null;
  /** Every rendered version to pick from, newest first (a final and a preview of the same version are both there). */
  versions: { renderId: string; version: number; kind: "preview" | "final"; quality: string; at: number }[];
  rendering: { renderId: string; version: number; percent: number; step: string | null; etaSec: number | null; queued: boolean } | null;
  failed: { version: number; error: string } | null;
  comments: AppComment[];
};
export type AppProjectCard = {
  id: string; name: string; folder: string; aspect: string; status: string; version: number; updated: number; seconds: number | null;
  thumb: string | null; previewVersion: number | null; rendering: boolean; openComments: number;
};
export type AppProjectsPage = { projects: AppProjectCard[]; total: number; offset: number };
/** Samples (render_samples): a few frames and short clips of an edit, shown as a storyboard to ask changes on. */
export type AppSampleItem = { kind: "frame" | "clip"; at: number; end: number | null; note: string | null; still: string | null; clip: string | null };
export type AppSamples = {
  renderId: string; project: { id: string; name: string; aspect: string; version: number; editorUrl: string | null };
  /** The edit's version the samples show. */
  version: number;
  status: "queued" | "running" | "done" | "failed"; percent: number; step: string | null; etaSec: number | null; error: string | null;
  width: number | null; height: number | null;
  items: AppSampleItem[];
  /** The user's changes asked on these samples (comments on this render, at each sample's edit time). */
  comments: AppComment[];
};
/** open_projects' structured result: the page of projects, and the edit to open when it was asked for. */
/** With an edit open, the list is left out (the app loads it with app_list_projects when the user goes back to it). */
export type AppOpen = Partial<AppProjectsPage> & { open: AppProjectView | null; webUrl: string | null; samples?: AppSamples | null };
