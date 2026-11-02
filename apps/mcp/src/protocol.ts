import type { IncomingMessage } from "node:http";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

/**
 * A client newer than this SDK names a protocol version the SDK does not know in the MCP-Protocol-Version header of
 * every request after initialize, and the SDK refuses each with 400 before any tool runs (a card in Claude could then
 * open and close at once). Initialize already settled on the newest version the SDK knows, so the header is set to
 * that one (in req.rawHeaders too: the SDK reads those). Returns what the client sent when it was changed, else null.
 */
export function useKnownProtocolVersion(req: IncomingMessage): string | null {
  const sent = req.headers["mcp-protocol-version"];
  if (typeof sent !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return null;
  req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "mcp-protocol-version") req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
  return sent;
}
