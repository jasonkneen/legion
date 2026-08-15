/**
 * MCP servers as extra tools for every seat (server-only).
 *
 * A user registers a server once — a local command over stdio, or a remote URL
 * over SSE / streamable HTTP — and its tools become available to the seats
 * alongside the built-in ones. Names are namespaced `mcp__<server>__<tool>` so
 * two servers can both expose `search` without colliding, and so a tool call
 * can always be traced back to who provided it.
 *
 * Connections are pooled per process and lazily opened: a settings page that
 * lists servers should not spawn every one of them, and a turn that never calls
 * an MCP tool should not pay for a handshake.
 */
import { getSql } from "@/lib/db";
import { logEvent } from "@/lib/log.server";
import type { ToolDef } from "./tools.server";

export type McpTransport = "stdio" | "sse" | "http";

export type McpServerConfig = {
  id: string;
  userId: string;
  name: string;
  transport: McpTransport;
  /** stdio: the command line. sse/http: the URL. */
  target: string;
  /** Extra environment for a stdio server, as JSON. */
  envJson: string;
  enabled: boolean;
};

export type McpToolInfo = {
  server: string;
  /** Namespaced name as the model sees it. */
  qualifiedName: string;
  /** Bare name as the MCP server knows it. */
  toolName: string;
  description: string;
  /** True when the server annotates it as non-mutating. */
  readOnly: boolean;
  parameters: ToolDef["parameters"];
};

export const MCP_PREFIX = "mcp__";

let tableReady: Promise<void> | null = null;
async function ensureTable(): Promise<void> {
  tableReady ??= (async () => {
    const sql = await getSql();
    await sql.query(`
      create table if not exists mcp_servers (
        id text primary key,
        user_id text not null,
        name text not null,
        transport text not null,
        target text not null,
        env_json text not null default '{}',
        enabled boolean not null default true,
        created_at timestamptz not null default now()
      )
    `);
    await sql.query(`create index if not exists mcp_servers_user on mcp_servers (user_id)`);
  })().catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
}

export async function listMcpServers(userId: string): Promise<McpServerConfig[]> {
  await ensureTable();
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    user_id: string;
    name: string;
    transport: string;
    target: string;
    env_json: string;
    enabled: boolean;
  }>`
    select id, user_id, name, transport, target, env_json, enabled
    from mcp_servers where user_id = ${userId} order by name asc
  `;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    transport: (r.transport === "sse" || r.transport === "http" ? r.transport : "stdio") as McpTransport,
    target: r.target,
    envJson: r.env_json,
    enabled: Boolean(r.enabled),
  }));
}

export async function addMcpServer(
  userId: string,
  input: { name: string; transport: McpTransport; target: string; env?: Record<string, string> },
): Promise<McpServerConfig> {
  await ensureTable();
  const sql = await getSql();
  // The name becomes part of every tool name the model sees, so keep it to
  // something that cannot break a function-name schema.
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  if (!name) throw new Error("That server needs a name");
  if (!input.target.trim()) throw new Error("That server needs a command or URL");

  const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    insert into mcp_servers (id, user_id, name, transport, target, env_json, enabled)
    values (${id}, ${userId}, ${name}, ${input.transport}, ${input.target.trim()},
            ${JSON.stringify(input.env ?? {})}, true)
  `;
  return { id, userId, name, transport: input.transport, target: input.target.trim(), envJson: JSON.stringify(input.env ?? {}), enabled: true };
}

export async function setMcpEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
  await ensureTable();
  const sql = await getSql();
  await sql`update mcp_servers set enabled = ${enabled} where id = ${id} and user_id = ${userId}`;
  closeConnection(id);
}

export async function removeMcpServer(userId: string, id: string): Promise<void> {
  await ensureTable();
  const sql = await getSql();
  await sql`delete from mcp_servers where id = ${id} and user_id = ${userId}`;
  closeConnection(id);
}

/** A live client plus the tools it advertised, keyed by server id. */
type Pooled = { client: unknown; tools: McpToolInfo[]; openedAt: number };
const globalRef = globalThis as typeof globalThis & { __legionMcp__?: Map<string, Pooled> };
function pool(): Map<string, Pooled> {
  globalRef.__legionMcp__ ??= new Map();
  return globalRef.__legionMcp__;
}

function closeConnection(id: string): void {
  const hit = pool().get(id);
  if (!hit) return;
  pool().delete(id);
  void (hit.client as { close?: () => Promise<void> }).close?.().catch(() => undefined);
}

/** Split a command line into argv, honouring simple quoting. */
function splitCommand(line: string): string[] {
  return line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [];
}

/**
 * Open (or reuse) a connection and return the server's tools.
 *
 * Failures are returned rather than thrown: one broken server must not take
 * down a turn or a settings page, and "why is it broken" is worth showing.
 */
export async function connectMcp(
  config: McpServerConfig,
): Promise<{ tools: McpToolInfo[] } | { error: string }> {
  const hit = pool().get(config.id);
  if (hit) return { tools: hit.tools };

  const started = Date.now();
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "legion", version: "0.1.0" }, { capabilities: {} });

    if (config.transport === "stdio") {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const argv = splitCommand(config.target);
      if (!argv.length) return { error: "empty command" };
      const env: Record<string, string> = { ...(JSON.parse(config.envJson || "{}") as Record<string, string>) };
      await client.connect(
        new StdioClientTransport({
          command: argv[0],
          args: argv.slice(1),
          // Inherit PATH and friends, or a server launched via npx cannot resolve.
          env: { ...(process.env as Record<string, string>), ...env },
        }),
      );
    } else if (config.transport === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      await client.connect(new SSEClientTransport(new URL(config.target)));
    } else {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      await client.connect(new StreamableHTTPClientTransport(new URL(config.target)));
    }

    const listed = await client.listTools();
    const tools: McpToolInfo[] = listed.tools.map((t) => ({
      server: config.name,
      qualifiedName: `${MCP_PREFIX}${config.name}__${t.name}`.slice(0, 64),
      toolName: t.name,
      description: (t.description ?? `${t.name} (from ${config.name})`).slice(0, 400),
      // Trust the server's own annotation; anything unannotated is treated as
      // mutating, so it goes through the approval gate.
      readOnly: t.annotations?.readOnlyHint === true,
      parameters: {
        type: "object",
        properties: (t.inputSchema?.properties ?? {}) as ToolDef["parameters"]["properties"],
        required: Array.isArray(t.inputSchema?.required) ? (t.inputSchema.required as string[]) : [],
        additionalProperties: false,
      },
    }));

    pool().set(config.id, { client, tools, openedAt: Date.now() });
    logEvent({
      kind: "cli:spawn",
      actor: `mcp:${config.name}`,
      message: `connected (${config.transport}), ${tools.length} tools`,
      durationMs: Date.now() - started,
    });
    return { tools };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEvent({ kind: "cli:exit", actor: `mcp:${config.name}`, message: `connect failed: ${error}`, durationMs: Date.now() - started });
    return { error };
  }
}

/** Every enabled server's tools for this user, with per-server errors kept. */
export async function mcpToolsFor(
  userId: string,
): Promise<{ tools: McpToolInfo[]; errors: { server: string; error: string }[] }> {
  const servers = (await listMcpServers(userId)).filter((s) => s.enabled);
  const tools: McpToolInfo[] = [];
  const errors: { server: string; error: string }[] = [];
  await Promise.all(
    servers.map(async (server) => {
      const result = await connectMcp(server);
      if ("error" in result) errors.push({ server: server.name, error: result.error });
      else tools.push(...result.tools);
    }),
  );
  return { tools, errors };
}

/** Call one namespaced MCP tool. Returns text, like the built-in tools do. */
export async function callMcpTool(
  userId: string,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const servers = (await listMcpServers(userId)).filter((s) => s.enabled);
  for (const server of servers) {
    const result = await connectMcp(server);
    if ("error" in result) continue;
    const match = result.tools.find((t) => t.qualifiedName === qualifiedName);
    if (!match) continue;

    const pooled = pool().get(server.id);
    if (!pooled) return `${qualifiedName}: connection was closed`;
    const client = pooled.client as {
      callTool: (p: { name: string; arguments: Record<string, unknown> }) => Promise<{
        content?: { type?: string; text?: string }[];
        isError?: boolean;
      }>;
    };
    try {
      const out = await client.callTool({ name: match.toolName, arguments: args });
      const text = (out.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (out.isError) return `${qualifiedName} failed: ${text || "the server reported an error"}`;
      return text || "(the tool returned no text)";
    } catch (err) {
      return `${qualifiedName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return `No MCP server provides ${qualifiedName}.`;
}
