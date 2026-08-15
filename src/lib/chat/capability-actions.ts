import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { allAgentCapabilities, type AgentCapabilities } from "./capabilities.server";

/**
 * What each local agent brings: skills, plugins, hooks, MCP servers.
 *
 * Behind auth because it enumerates the workstation's tooling, and cached
 * server-side — reading it spawns processes, so a settings render must not do
 * that on every keystroke.
 */
export const listAgentCapabilities = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((force?: boolean) => Boolean(force))
  .handler(async ({ data: force }): Promise<AgentCapabilities[]> => allAgentCapabilities(force));
