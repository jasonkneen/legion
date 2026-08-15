import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  addMcpServer,
  connectMcp,
  listMcpServers,
  removeMcpServer,
  setMcpEnabled,
  type McpTransport,
} from "./mcp.server";

/** Registered MCP servers, each with its live tool count or connection error. */
export const listMcpStatuses = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const servers = await listMcpServers(context.userId);
    return Promise.all(
      servers.map(async (s) => {
        // Only probe what the user has switched on: a disabled server should
        // not be spawned just to draw a row.
        const probe = s.enabled ? await connectMcp(s) : null;
        return {
          id: s.id,
          name: s.name,
          transport: s.transport,
          target: s.target,
          enabled: s.enabled,
          toolCount: probe && "tools" in probe ? probe.tools.length : 0,
          tools: probe && "tools" in probe ? probe.tools.map((t) => t.toolName).slice(0, 24) : [],
          error: probe && "error" in probe ? probe.error : null,
        };
      }),
    );
  });

export const addMcp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; transport: McpTransport; target: string }) => input)
  .handler(async ({ context, data }) => {
    await addMcpServer(context.userId, data);
    return { ok: true as const };
  });

export const toggleMcp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; enabled: boolean }) => input)
  .handler(async ({ context, data }) => {
    await setMcpEnabled(context.userId, data.id, data.enabled);
    return { ok: true as const };
  });

export const deleteMcp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    await removeMcpServer(context.userId, id);
    return { ok: true as const };
  });
