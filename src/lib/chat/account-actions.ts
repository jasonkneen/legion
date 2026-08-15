import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { allAgentAccounts, type AgentAccount } from "./accounts.server";

/**
 * The local agent CLIs, their logins and their usage.
 *
 * Nothing here is per-user Legion state — it is whatever the workstation's CLIs
 * report — but it stays behind auth because it names the accounts they are
 * signed in as.
 */
export const listAgentAccounts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((force?: boolean) => Boolean(force))
  .handler(async ({ data: force }): Promise<AgentAccount[]> => allAgentAccounts(force));
