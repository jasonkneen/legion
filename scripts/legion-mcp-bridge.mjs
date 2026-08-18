#!/usr/bin/env node
/**
 * An MCP server that hands a CLI agent Legion's own tools.
 *
 * Runs as a subprocess of the agent (grok launches it from a per-process
 * plugin), speaks MCP over stdio, and forwards every call to the Legion server
 * over localhost. The tools therefore execute inside Legion, where the approval
 * registry lives — which is the whole point. grok's own permission model never
 * sees a write, so it cannot auto-approve one.
 *
 * Configured entirely by environment, because that is all a plugin's `.mcp.json`
 * can pass: LEGION_URL (the server) and LEGION_SEAT_TOKEN (this turn's grant).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const base = process.env.LEGION_URL ?? "http://localhost:3000";
const token = process.env.LEGION_SEAT_TOKEN ?? "";

async function ask(payload) {
  const res = await fetch(`${base}/api/seat-tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...payload }),
  });
  if (!res.ok) throw new Error(`Legion refused the call (${res.status}).`);
  return res.json();
}

const server = new Server(
  { name: "legion", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // No token means this is not a Legion turn — someone's own grok session, which
  // happens to have the server registered. Offer nothing rather than a set of
  // tools whose every call would fail.
  if (!token) return { tools: [] };
  const { tools } = await ask({ op: "list" });
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!token) {
    return { content: [{ type: "text", text: "Legion is not driving this session." }], isError: true };
  }
  try {
    const { text } = await ask({
      op: "call",
      name: request.params.name,
      args: request.params.arguments ?? {},
    });
    return { content: [{ type: "text", text: String(text ?? "") }] };
  } catch (err) {
    // A failed tool is a result the model can read, not a dead connection.
    return {
      content: [{ type: "text", text: `That tool could not run: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
