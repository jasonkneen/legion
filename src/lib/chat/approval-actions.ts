import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  decideApproval,
  pendingApprovals,
  setStandingDecision,
  standingDecisions,
  toApprovalView,
  type ApprovalScope,
  type PendingApprovalView,
} from "./approvals.server";

/**
 * Approval requests waiting on this human, for the open conversation.
 *
 * Polled by the chat view while a turn runs. A parked turn is holding a child
 * process open, so the poll is deliberately cheap: it reads an in-memory map
 * and touches no database.
 */
export const listPendingApprovals = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((conversationId: string) => conversationId)
  .handler(async ({ data: conversationId }): Promise<PendingApprovalView[]> =>
    pendingApprovals(conversationId).map(toApprovalView),
  );

/** Answer one request. Returns false when it already timed out or was answered. */
export const answerApproval = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; scope: ApprovalScope }) => input)
  .handler(async ({ context, data }) => ({
    ok: await decideApproval(context.userId, data.id, data.scope),
  }));

/** Standing "always allow" / "always deny" decisions, for the settings screen. */
export const listStandingDecisions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => standingDecisions(context.userId));

/** Change or clear a standing decision. */
export const setStandingApproval = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { tool: string; decision: "always" | "deny" | null }) => input)
  .handler(async ({ context, data }) => {
    await setStandingDecision(context.userId, data.tool, data.decision);
    return { ok: true as const };
  });
