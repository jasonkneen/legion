import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { allAgentCapabilities, type AgentCapabilities } from "./capabilities.server";
import type { ProviderId } from "@/lib/providers";
import type { SeatReach } from "./reach.server";

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

/**
 * What each seated agent can actually reach in this chat.
 *
 * One round trip for the whole rail: the seat menu shows it, and a rail of six
 * seats must not mean six requests.
 */
export const listSeatReach = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((providers: string[]) => providers)
  .handler(async ({ data: providers, context }): Promise<SeatReach[]> => {
    const { seatReach } = await import("./reach.server");
    const unique = [...new Set(providers)] as ProviderId[];
    return Promise.all(unique.map((p) => seatReach(context.userId, p)));
  });
