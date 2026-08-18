import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { storedEvents } from "@/lib/log.server";
import { pendingApprovals, toApprovalView, type PendingApprovalView } from "./approvals.server";
import { pendingQuestions, type PendingQuestion } from "./questions.server";
import { loadTodos, type TodoItem } from "./todos.server";
import { workspaceChanges, type FileChange } from "./tools.server";
import type { ActivityEvent } from "./activity-actions";
import type { ModelId } from "@/lib/models";
import type { Seat } from "./types";

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
  /**
   * Who is in the room. A seat can now be added mid-turn by an agent that
   * decided the work needed someone else, so the rail cannot be a snapshot
   * taken when the chamber opened.
   */
  seats: Seat[];
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
    if (!conversationId) return { seats: [], approvals: [], questions: [], todos: [] };

    // Activity is persisted now, so a chamber id alone is no longer proof of
    // ownership the way an in-memory ring was.
    const sql = await getSql();
    const owned = await sql<{ id: string }>`
      select id from conversations
      where id = ${conversationId} and user_id = ${context.userId} limit 1
    `;
    if (!owned.length) return { seats: [], approvals: [], questions: [], todos: [] };

    const seatRows = await sql<{
      id: string;
      conversation_id: string;
      handle: string;
      display_name: string;
      model_id: string;
      role: string;
      seat_order: number;
      created_at: string;
    }>`
      select id, conversation_id, handle, display_name, model_id, role, seat_order,
             created_at::text as created_at
      from conversation_agents
      where conversation_id = ${conversationId} and user_id = ${context.userId}
      order by seat_order asc, created_at asc
    `;

    const pulse: ChamberPulse = {
      seats: seatRows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        handle: r.handle,
        displayName: r.display_name,
        modelId: r.model_id as ModelId,
        role: r.role,
        seatOrder: Number(r.seat_order),
        createdAt: r.created_at,
      })),
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
