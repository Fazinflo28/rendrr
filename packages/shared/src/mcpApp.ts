import { z } from "zod";
import type { ToolDef } from "./mcpTools";

// The Rendrr app inside the chat (an MCP App, io.modelcontextprotocol/ui): the user's edits, each one's latest preview
// and its comments. open_projects (an AI tool, MCP_TOOLS) opens it; the app itself calls these tools through the host.
// They are hidden from the AI (visibility "app"); the AI reads comments with get_comments.

export const APP_RESOURCE_URI = "ui://rendrr/projects.html";
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

const id = (what: string) => z.string().min(1).max(80).describe(`The ${what} id`);

export const APP_TOOLS: ToolDef[] = [
  { name: "app_list_projects", title: "Projects for the app", app: true, description: "The Rendrr app: a page of the user's edits, newest first.",
    input: z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(60).optional(), query: z.string().max(100).optional() }) },
  { name: "app_get_project", title: "One project for the app", app: true, description: "The Rendrr app: one edit's latest preview, its render progress and its comments.",
    input: z.object({ projectId: id("project") }) },
  { name: "app_add_comment", title: "Add a comment", app: true, write: true, description: "The Rendrr app: add the user's comment at a moment of the preview (seconds of the edited video).",
    input: z.object({ projectId: id("project"), time: z.number().min(0).max(24 * 3600), text: z.string().trim().min(1).max(2000) }) },
  { name: "app_resolve_comment", title: "Resolve a comment", app: true, write: true, description: "The Rendrr app: mark a comment resolved, or open again with resolved false.",
    input: z.object({ projectId: id("project"), commentId: id("comment"), resolved: z.boolean().optional() }) },
  { name: "app_render_preview", title: "Render a preview", app: true, write: true, description: "The Rendrr app: render a preview of the latest version when it has none.",
    input: z.object({ projectId: id("project") }) },
];

/** What the app shows for one edit (app_get_project, open_projects with a projectId). */
export type AppComment = { id: string; time: number; text: string; author: string; mine: boolean; resolved: boolean; at: number };
export type AppProjectView = {
  project: { id: string; name: string; folder: string; aspect: string; status: string; version: number; updated: number; seconds: number | null; editorUrl: string | null };
  preview: { renderId: string; version: number; url: string; seconds: number; quality: string; at: number } | null;
  rendering: { renderId: string; version: number; percent: number; step: string | null; etaSec: number | null; queued: boolean } | null;
  failed: { version: number; error: string } | null;
  comments: AppComment[];
};
export type AppProjectCard = {
  id: string; name: string; folder: string; aspect: string; status: string; version: number; updated: number; seconds: number | null;
  thumb: string | null; previewVersion: number | null; rendering: boolean; openComments: number;
};
export type AppProjectsPage = { projects: AppProjectCard[]; total: number; offset: number };
/** open_projects' structured result: the page of projects, and the edit to open when it was asked for. */
export type AppOpen = AppProjectsPage & { open: AppProjectView | null; webUrl: string | null };
