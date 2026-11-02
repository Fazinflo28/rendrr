// A client newer than the SDK: its MCP-Protocol-Version header names a version the SDK does not know. Without the fix
// the SDK refuses every call after initialize with 400; with it, the call is answered.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { useKnownProtocolVersion } from "../src/protocol";

async function serve(fix: boolean) {
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ""; for await (const c of req) raw += c;
    if (fix) useKnownProtocolVersion(req);
    const mcp = new McpServer({ name: "t", version: "1" });
    mcp.registerTool("ping", { description: "ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(raw));
  }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/` };
}
const call = (url: string, version: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });

describe("a client on a newer protocol version", () => {
  it("is refused by the SDK on its own, and answered with the fix; known versions are left as they are", async () => {
    const plain = await serve(false), fixed = await serve(true);
    try {
      assert.equal((await call(plain.url, "2099-01-01")).status, 400, "the SDK alone refuses the unknown version");
      const r = await call(fixed.url, "2099-01-01");
      assert.equal(r.status, 200);
      assert.match(await r.text(), /"ping"/);
      assert.equal((await call(fixed.url, "2025-06-18")).status, 200);
      const req = { headers: { "mcp-protocol-version": "2025-06-18" }, rawHeaders: ["mcp-protocol-version", "2025-06-18"] } as unknown as IncomingMessage;
      assert.equal(useKnownProtocolVersion(req), null, "a known version is not touched");
    } finally { plain.srv.close(); fixed.srv.close(); }
  });
});
