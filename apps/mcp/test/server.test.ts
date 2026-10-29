// The connector as Claude sees it, against a stand-in API: the editing skill in the instructions, the get_editing_skill
// tool, the skill resource and prompt; open_projects opens the Rendrr app (a ui:// resource of the MCP Apps type, its
// video allowed from the storage the API names) and hands it structured data; the app's own tools are hidden from
// the AI and forwarded as the user. Run: pnpm --filter @rendrr/mcp test
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const calls: { path: string; body: unknown; headers: IncomingMessage["headers"] }[] = [];
const api = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ path: req.url || "", body, headers: req.headers });
  res.setHeader("content-type", "application/json");
  if (req.url === "/internal/app-config") return res.end(JSON.stringify({ mediaOrigins: ["https://bucket.storage.example", "javascript:alert(1)"] }));
  if (req.url === "/internal/tools/open_projects") return res.end(JSON.stringify({ text: "Showing the Rendrr app with 1 edit.", data: { projects: [{ id: "p1", name: "Reel" }], total: 1, offset: 0, open: null, webUrl: "https://app.rendrr.live" } }));
  if (req.url === "/internal/tools/app_add_comment") return res.end(JSON.stringify({ text: "Comment added.", data: { project: { id: "p1" }, comments: [{ id: "c1", time: 1.5, text: (body as { text: string }).text }] } }));
  if (req.url === "/internal/tools/get_editing_skill") return res.end(JSON.stringify({ text: "# Fazinflo Editing Skill (Rendrr edition)" }));
  if (req.url === "/internal/tools/check_edit") return res.end(JSON.stringify({ text: "Check of v2", data: { ignored: true } }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "There is no tool called that." } }));
});

describe("the connector", () => {
  let client: Client;
  before(async () => {
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    process.env.INTERNAL_API_SECRET = "s3cret";
    const { buildServer } = await import("../src/build");
    const server = buildServer({ clerkId: "user_1", kind: "claude", name: "Claude" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "claude-ai", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  after(async () => { await client.close(); api.close(); });

  it("comes with the editing skill: instructions, a tool, a resource and a prompt", async () => {
    const ins = client.getInstructions() || "";
    assert.match(ins, /call get_editing_skill once and follow it/);
    assert.match(ins, /render_preview ONCE/);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "get_editing_skill" && t.annotations?.readOnlyHint === true));
    assert.ok(tools.some((t) => t.name === "check_edit" && t.annotations?.readOnlyHint === true));
    const r = await client.callTool({ name: "get_editing_skill", arguments: {} });
    assert.match((r.content as { text: string }[])[0].text, /^# Fazinflo Editing Skill/);
    const { resources } = await client.listResources();
    assert.ok(resources.some((x) => x.uri === "skill://rendrr/editing-skill/SKILL.md"));
    const skill = await client.readResource({ uri: "skill://rendrr/editing-skill/SKILL.md" });
    assert.match(String((skill.contents[0] as { text: string }).text), /## The rules \(never break these\)/);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["edit-footage", "editing-skill", "work-through-comments"]);
    const p = await client.getPrompt({ name: "editing-skill" });
    assert.match(String((p.messages[0].content as { text: string }).text), /Use this editing skill for every Rendrr edit/);
    const edit = await client.getPrompt({ name: "edit-footage", arguments: { videoId: "v1", styleId: "s1" } });
    assert.match(String((edit.messages[0].content as { text: string }).text), /check_edit \(no render\)[\s\S]*render_preview ONCE/);
  });

  it("open_projects opens the Rendrr app; the app's tools are hidden from the AI", async () => {
    const { tools } = await client.listTools();
    const open = tools.find((t) => t.name === "open_projects")!;
    assert.deepEqual(open._meta, { ui: { resourceUri: "ui://rendrr/projects.html" }, "ui/resourceUri": "ui://rendrr/projects.html" });
    for (const name of ["app_list_projects", "app_get_project", "app_add_comment", "app_resolve_comment", "app_render_preview"]) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, name);
      assert.deepEqual((t!._meta as { ui: { visibility: string[] } }).ui.visibility, ["app"], name);
    }
    // Other tools carry no app.
    assert.equal(tools.find((t) => t.name === "apply_edits")!._meta, undefined);
  });

  it("the app is an MCP Apps page whose video and pictures may come from the storage the API names, nothing else", async () => {
    const { resources } = await client.listResources();
    const res = resources.find((x) => x.uri === "ui://rendrr/projects.html")!;
    assert.equal(res.mimeType, "text/html;profile=mcp-app");
    const read = await client.readResource({ uri: "ui://rendrr/projects.html" });
    const c = read.contents[0] as { mimeType: string; text: string; _meta: { ui: { csp: { resourceDomains: string[]; connectDomains: string[] }; prefersBorder: boolean } } };
    assert.equal(c.mimeType, "text/html;profile=mcp-app");
    assert.match(c.text, /^<!doctype html>/);
    assert.match(c.text, /ui\/initialize/);
    assert.doesNotMatch(c.text, /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/, "no outside scripts, styles or links in the page");
    assert.deepEqual(c._meta.ui.csp, { resourceDomains: ["https://bucket.storage.example"], connectDomains: [] });
  });

  it("open_projects and the app's tools give the app structured data, forwarded as the user", async () => {
    const r = await client.callTool({ name: "open_projects", arguments: {} });
    assert.equal((r.content as { text: string }[])[0].text, "Showing the Rendrr app with 1 edit.");
    assert.equal((r.structuredContent as { total: number }).total, 1);
    const add = await client.callTool({ name: "app_add_comment", arguments: { projectId: "p1", time: 1.5, text: "Too long" } });
    assert.equal((add.structuredContent as { comments: { text: string }[] }).comments[0].text, "Too long");
    const last = calls.filter((x) => x.path === "/internal/tools/app_add_comment").pop()!;
    assert.deepEqual(last.body, { projectId: "p1", time: 1.5, text: "Too long" });
    assert.equal(last.headers["x-rendrr-clerk-id"], "user_1");
    assert.equal(last.headers["x-internal-secret"], "s3cret");
    // A tool that does not open the app gives the AI text only.
    const chk = await client.callTool({ name: "check_edit", arguments: { projectId: "p1" } });
    assert.equal(chk.structuredContent, undefined);
    // Bad input is refused before it reaches Rendrr.
    const bad = await client.callTool({ name: "app_add_comment", arguments: { projectId: "p1", time: -1, text: "x" } });
    assert.equal(bad.isError, true);
  });
});
