// Calls the MCP server like an AI client would. Needs an OAuth access token (see SMOKE_TEST.md).
//   MCP_URL=https://mcp-production-7fa0.up.railway.app/mcp MCP_TOKEN=... pnpm tsx scripts/mcp-check.ts [--render]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL || "http://localhost:4100/mcp";
const token = process.env.MCP_TOKEN || "";
const render = process.argv.includes("--render");
const client = new Client({ name: "claude-ai", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const say = (label: string, r: any) => {
  const text = (r.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const imgs = (r.content || []).filter((c: any) => c.type === "image").length;
  console.log(`\n=== ${label}${r.isError ? " (ERROR)" : ""}${imgs ? ` [${imgs} images]` : ""}\n${text.split("\n").slice(0, 14).join("\n")}${text.split("\n").length > 14 ? "\n…" : ""}`);
  return text;
};
const tools = await client.listTools();
console.log(`tools: ${tools.tools.length} -> ${tools.tools.map((t) => t.name).join(", ")}`);
const res = await client.listResources(); console.log(`resources: ${res.resources.map((r) => r.uri).join(", ")}`);
const pr = await client.listPrompts(); console.log(`prompts: ${pr.prompts.map((p) => p.name).join(", ")}`);
const guide = await client.readResource({ uri: "rendrr://how-to-edit" }); console.log(`how-to-edit: ${String((guide.contents[0] as any).text).length} chars`);
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 240_000, resetTimeoutOnProgress: true });

const footage = say("list_footage", await call("list_footage"));
const vid = /^(\S+) \| .* \| ready \|/m.exec(footage)?.[1];
if (!vid) { console.log("No ready footage: add sample footage first."); process.exit(0); }
say("get_footage", await call("get_footage", { videoId: vid }));
say("list_styles", await call("list_styles"));
say("get_style s1", await call("get_style", { styleId: "s1" }));
const created = say("create_project", await call("create_project", { videoId: vid, styleId: "s1", name: "MCP check" }));
const pid = /\(([a-z0-9]{20,})\)/.exec(created)?.[1];
if (!pid) process.exit(1);
say("mark_silences", await call("mark_silences", { projectId: pid, limit: 10 }));
say("mark_fillers", await call("mark_fillers", { projectId: pid, limit: 10 }));
say("get_retakes", await call("get_retakes", { projectId: pid, limit: 3 }));
say("list_marks", await call("list_marks", { projectId: pid, limit: 10 }));
say("apply_edits", await call("apply_edits", { projectId: pid, note: "First pass from the MCP check.", edits: [
  { op: "apply_style", styleId: "s1" }, { op: "cut_words", from: 0, to: 2 }, { op: "add_marks", marks: [{ kind: "custom", start: 3, end: 4, note: "MCP check" }] },
  { op: "add_zoom", start: 5, end: 7, scale: 1.2 }, { op: "add_music", trackId: "lofi", gainDb: -20 },
  { op: "set_captions", on: true, look: "outline" }, { op: "edit_caption", lineId: "l0", text: "So the thing NOBODY tells you about starting an agency" },
  { op: "add_graphic", graphicId: "gt_lower_third", start: 1, end: 5, params: { name: "Ronnii K", role: "Founder" } },
] }));
say("get_project", await call("get_project", { projectId: pid }));
say("undo", await call("undo", { projectId: pid }));
say("bad input", await call("apply_edits", { projectId: pid, edits: [{ op: "set_captions", on: true }, { op: "trim_clip", track: "v1", clipId: "nope", start: 1, end: 2 }] }));
say("list_graphics", await call("list_graphics"));
say("get_comments", await call("get_comments", { projectId: pid }));
if (render) {
  say("render_preview", await call("render_preview", { projectId: pid }));
  say("get_preview_frames", await call("get_preview_frames", { projectId: pid, times: [1, 5, 10] }));
  say("create_graphic", await call("create_graphic", { code: "<div id=b style='position:absolute;left:40px;top:40px;width:200px;height:200px;background:#ff3366;border-radius:24px;animation:s 2s linear infinite'></div><style>@keyframes s{to{transform:rotate(360deg)}}</style>", durationSec: 2, width: 400, height: 400, transparent: true, name: "Spinner" }));
  say("create_review_link", await call("create_review_link", { projectId: pid }));
}
await client.close();
