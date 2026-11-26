// The MCP server one request gets: the tools (forwarded to the API as the user), the guide, the editing skill, and the
// Rendrr app in the chat (an MCP App: open_projects shows it, its own tools are hidden from the AI).
import { createHash } from "node:crypto";
import { internalSecret } from "./secret";
import { serverIcons } from "./icons";
import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_MIME_TYPE, APP_RESOURCE_URI, APP_TOOLS, EDITING_SKILL, HOW_TO_EDIT, MCP_INSTRUCTIONS, MCP_TOOLS, type ToolDef } from "@rendrr/shared";
import { z } from "zod";

export type Who = { clerkId: string; kind: "claude" | "chatgpt"; name: string };

const API = () => (process.env.API_INTERNAL_URL || process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
const SECRET = internalSecret;

/** The app's page: one file, no network of its own (it plays the signed preview links the API gives it). */
export const APP_HTML = readFileSync(new URL("./app/projects.html", import.meta.url), "utf8");
/** The page's address carries a hash of the page: hosts keep app pages by address (Claude showed the first version
 *  after the page changed), so a changed page gets a new address and is fetched again. */
export const APP_URI = APP_RESOURCE_URI.replace(/\.html$/, `-${createHash("sha256").update(APP_HTML).digest("hex").slice(0, 12)}.html`);
export const SKILL_URI = "skill://rendrr/editing-skill/SKILL.md";
/** Where the app's fonts come from: the web app's own Google Fonts stylesheet and its font files. */
export const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

// ---------------- forwarding to the API ----------------
type ToolOut = { text: string; images?: string[]; data?: unknown };
export async function callApi(w: Who, path: string, body?: unknown, method = "POST"): Promise<{ ok: boolean; json: any }> {
  // A time limit, so a slow or stuck server never leaves the AI waiting with no answer (audit #7). Long tools answer
  // within seconds by design (they hand back an id to poll), so two minutes is far more than any call needs.
  const r = await fetch(API() + path, {
    method,
    signal: AbortSignal.timeout(120_000),
    headers: { "x-internal-secret": SECRET(), "x-rendrr-clerk-id": w.clerkId, "x-rendrr-ai": w.kind, "x-rendrr-ai-name": w.name, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  }).catch(() => null);
  if (!r) return { ok: false, json: { error: { message: "Rendrr's server did not answer. Try again in a moment." } } };
  return { ok: r.ok, json: await r.json().catch(() => ({})) };
}

async function imageContent(urls: string[] = []) {
  // All at once, in their order, each with a time limit (they were fetched one after another: audit #17).
  const got = await Promise.all(urls.slice(0, 8).map(async (u) => {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 900_000) return null;
      return { type: "image" as const, data: buf.toString("base64"), mimeType: r.headers.get("content-type") || "image/jpeg" };
    } catch { return null; /* skip */ }
  }));
  return got.filter((x): x is { type: "image"; data: string; mimeType: string } => !!x);
}

/** Where the app's video and pictures come from (the storage the API signs links for), asked once in a while. */
let origins: { list: string[]; at: number } | null = null;
async function mediaOrigins(w: Who): Promise<string[]> {
  if (origins && Date.now() - origins.at < 10 * 60_000) return origins.list;
  const r = await callApi(w, "/internal/app-config", undefined, "GET");
  const list = r.ok && Array.isArray(r.json?.mediaOrigins) ? (r.json.mediaOrigins as string[]).filter((o) => /^https?:\/\/[^/\s]+$/.test(o)) : [];
  if (list.length) origins = { list, at: Date.now() };
  return list;
}

/** A tool's _meta: the app it opens (the MCP Apps keys, and ChatGPT's own names for the same: outputTemplate, a
 *  widget that may call tools, a private tool), or that only the app may call it. */
function metaOf(def: ToolDef): Record<string, unknown> | undefined {
  if (def.ui) return { ui: { resourceUri: APP_URI }, "ui/resourceUri": APP_URI, "openai/outputTemplate": APP_URI, "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Opening Rendrr…", "openai/toolInvocation/invoked": "Rendrr is open" };
  if (def.app) return { ui: { resourceUri: APP_URI, visibility: ["app"] }, "openai/widgetAccessible": true, "openai/visibility": "private" };
  return undefined;
}

export function buildServer(w: Who, base = process.env.PUBLIC_MCP_URL || "") {
  // icons: the Rendrr mark the AI chat shows next to "Using Rendrr" (MCP 2025-11-25 server info).
  const site = (process.env.PUBLIC_WEB_URL || "https://rendrr.live").replace(/\/$/, "");
  const server = new McpServer({ name: "rendrr", version: "1.0.0", title: "Rendrr", description: "Video editing for AI: you decide the edit, Rendrr applies and renders it.", websiteUrl: site, ...(base ? { icons: serverIcons(base.replace(/\/mcp\/?$/, "")) } : {}) }, { instructions: MCP_INSTRUCTIONS });

  for (const def of [...MCP_TOOLS, ...APP_TOOLS]) {
    server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      // Strict: a field the tool does not have is an error the AI sees (it was dropped silently, e.g. "ops" for "edits").
      inputSchema: def.input.strict(),
      annotations: { readOnlyHint: !def.write && !def.long, destructiveHint: !!def.destructive, openWorldHint: false },
      ...(metaOf(def) ? { _meta: metaOf(def) } : {}),
    }, async (args: Record<string, unknown>, extra) => {
      // Long tools (renders, graphics) keep the client's timeout alive with progress notifications.
      const token = extra?._meta?.progressToken;
      let n = 0;
      const tick = token != null ? setInterval(() => { n++; extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: "Still working…" } }).catch(() => {}); }, 5000) : null;
      try {
        // The card's own log: written to the connector's log (who, what, how long the card was open), nothing saved.
        if (def.name === "app_log") {
          const a = args as { event?: string; detail?: string; seconds?: number };
          console.log(`[card] ${w.clerkId || "?"} ${a.event}${a.seconds != null ? ` after ${Math.round(a.seconds)} s` : ""}${a.detail ? `: ${String(a.detail).replace(/\s+/g, " ").slice(0, 500)}` : ""}`);
          return { content: [{ type: "text" as const, text: "ok" }] };
        }
        const r = await callApi(w, `/internal/tools/${def.name}`, args);
        if (!r.ok) return { content: [{ type: "text" as const, text: r.json?.error?.message || "That did not work. Try again." }], isError: true };
        const out = r.json as ToolOut;
        // The app reads its data from structuredContent; the AI reads the text.
        const structured = (def.ui || def.app) && out.data && typeof out.data === "object" ? { structuredContent: out.data as Record<string, unknown> } : {};
        return { content: [{ type: "text" as const, text: out.text }, ...(await imageContent(out.images))], ...structured };
      } finally {
        if (tick) clearInterval(tick);
      }
    });
  }

  const appPage = async (uri: URL) => {
    const media = await mediaOrigins(w);
    // The video and pictures from Rendrr's storage; the web app's fonts (Inter, Space Grotesk) from Google Fonts.
    return { contents: [{ uri: uri.href, mimeType: APP_MIME_TYPE, text: APP_HTML, _meta: {
      ui: { csp: { resourceDomains: [...media, ...FONT_ORIGINS], connectDomains: [] }, permissions: { clipboardWrite: {} }, prefersBorder: true },
      // ChatGPT's names for the same.
      "openai/widgetCSP": { resource_domains: [...media, ...FONT_ORIGINS], connect_domains: [] }, "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "The user's Rendrr edits: each edit's latest preview to play, and its comments to read, add, resolve and send to the AI.",
    } }] };
  };
  server.registerResource("projects-app", APP_URI, { title: "Rendrr projects", description: "The user's edits, previews and comments, shown in the chat.", mimeType: APP_MIME_TYPE }, appPage);
  // The first address, for a host still holding a tool list that names it: the newest page there too.
  server.registerResource("projects-app-first", APP_RESOURCE_URI, { title: "Rendrr projects", description: "The same page at its first address.", mimeType: APP_MIME_TYPE }, appPage);
  // Every earlier page address (a chat started before the page last changed still asks for the hash it was given):
  // the newest page, so the app opens instead of "Unable to reach Rendrr".
  server.registerResource("projects-app-earlier", new ResourceTemplate(APP_RESOURCE_URI.replace(/\.html$/, "-{hash}.html"), { list: undefined }), { title: "Rendrr projects", description: "The same page at an earlier address.", mimeType: APP_MIME_TYPE }, appPage);
  server.registerResource("styles", "rendrr://styles", { title: "Style packs", description: "Every style pack with its rules, as text and machine rules.", mimeType: "text/markdown" }, async (uri) => {
    const r = await callApi(w, "/internal/resources/styles", undefined, "GET");
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: r.ok ? r.json.text : "Could not load the styles right now." }] };
  });
  server.registerResource("how-to-edit", "rendrr://how-to-edit", { title: "How to edit with Rendrr", description: "A short guide: read, style, edit in one call, check, render once, hand off.", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: HOW_TO_EDIT }],
  }));
  server.registerResource("editing-skill", SKILL_URI, { title: "Fazinflo Editing Skill", description: "The editing skill that comes with Rendrr: rules, the mistakes reviewers flag most, workflow, comments loop, QA gate.", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: EDITING_SKILL }],
  }));

  server.registerPrompt("editing-skill", {
    title: "Use the editing skill",
    description: "Load the Fazinflo Editing Skill into the chat: how to cut talking heads tight and clean, check before rendering, and work through comments.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text: `Use this editing skill for every Rendrr edit in this chat.\n\n${EDITING_SKILL}` } }],
  }));
  server.registerPrompt("edit-footage", {
    title: "Edit footage",
    description: "A first pass of an edit: read the footage, its marks and the style, cut, caption, check, render one preview.",
    argsSchema: { videoId: z.string().describe("Footage id from list_footage"), styleId: z.string().describe("Style id from list_styles, for example s1") },
  }, ({ videoId, styleId }) => ({
    messages: [{ role: "user", content: { type: "text", text:
      `Edit my footage ${videoId} in style ${styleId} with Rendrr. Follow the editing skill (get_editing_skill).\n\n` +
      `1. get_footage("${videoId}") and get_style("${styleId}"). Read the whole transcript. Tell me in two lines what the video is about and the strongest hook.\n` +
      `2. mark_silences, mark_fillers, get_retakes and list_marks on the footage: Rendrr measures, you decide what goes.\n` +
      `3. create_project, then ONE apply_edits call with everything: apply_style ${styleId} (its captions; it lists its other rules for you), the cuts you chose (cut_words with word ids or from/to on the sound), the best take of each retake, caption fixes. Keep sentences whole. Add a short note.\n` +
      `4. check_edit (no render). Fix everything it shows in one more apply_edits.\n` +
      `5. render_preview ONCE and read its check. Then open_projects with the project id so I can watch it and comment.\n` +
      `6. Tell me what you did. Ask before rendering the final.\n\nGuide: rendrr://how-to-edit` } }],
  }));
  server.registerPrompt("work-through-comments", {
    title: "Work through comments",
    description: "Read the open comments on an edit, fix them all in one revision, check, render one preview, resolve them.",
    argsSchema: { projectId: z.string().describe("Edit id from list_projects") },
  }, ({ projectId }) => ({
    messages: [{ role: "user", content: { type: "text", text:
      `Work through the open comments on my Rendrr edit ${projectId}, following the editing skill (get_editing_skill).\n\n` +
      `1. get_comments("${projectId}") and get_project. Look at each comment's moment (get_preview_frames) and map its time with map_time.\n` +
      `2. Fix every comment, then search the whole edit for the same kind of mistake.\n` +
      `3. All fixes in ONE apply_edits, then check_edit, then render_preview ONCE.\n` +
      `4. resolve_comment each one you fixed; tell me what changed and anything you could not do.` } }],
  }));
  return server;
}
