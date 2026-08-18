import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { storedEvents } from "@/lib/log.server";
import { pendingApprovals, toApprovalView, type PendingApprovalView } from "./approvals.server";
import { pendingQuestions, type PendingQuestion } from "./questions.server";
import { loadTodos, type TodoItem } from "./todos.server";
import { workspaceChanges, type FileChange } from "./tools.server";
import type { ActivityEvent } from "./activity-actions";

/**
 * Everything the chat polls for, in one answer.
 *
 * Four panels used to keep their own timers: approvals and questions every
 * 1.2s, the plan every 2.5s, activity and file changes every 2.5s — five
 * requests a cycle for one chamber, and two of those timers carried on for as
 * long as the tab existed, whether or not anything was happening. One of them
 * shelled out to `git status` each time.
 *
 * The expensive parts are opt-in rather than always included: a closed activity
 * panel should not make the server run git, so the client says what it is
 * actually showing.
 */
export type ChamberPulse = {
  approvals: PendingApprovalView[];
  questions: PendingQuestion[];
  todos: TodoItem[];
  /** Present only when asked for. `undefined` means "not fetched", not "empty". */
  activity?: ActivityEvent[];
  changes?: FileChange[];
};

export const chamberPulse = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { conversationId: string; activity?: boolean; changes?: boolean }) => input)
  .handler(async ({ data, context }): Promise<ChamberPulse> => {
    const { conversationId } = data;
    if (!conversationId) return { approvals: [], questions: [], todos: [] };

    // Activity is persisted now, so a chamber id alone is no longer proof of
    // ownership the way an in-memory ring was.
    const sql = await getSql();
    const owned = await sql<{ id: string }>`
      select id from conversations
      where id = ${conversationId} and user_id = ${context.userId} limit 1
    `;
    if (!owned.length) return { approvals: [], questions: [], todos: [] };

    const pulse: ChamberPulse = {
      approvals: pendingApprovals(conversationId).map(toApprovalView),
      questions: pendingQuestions(conversationId),
      todos: await loadTodos(conversationId),
    };
    if (data.activity) {
      pulse.activity = (await storedEvents(conversationId, 200)).map((e) => ({
        id: e.key,
        at: e.at,
        kind: e.kind,
        actor: e.actor ?? "",
        message: e.message,
        durationMs: e.durationMs,
        detail: typeof e.data?.preview === "string" ? e.data.preview : undefined,
      }));
    }
    if (data.changes) pulse.changes = await workspaceChanges();
    return pulse;
  });
