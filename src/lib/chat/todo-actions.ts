import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { loadTodos, setTodoStatus as applyTodoStatus, type TodoItem } from "./todos.server";

/** The shared plan for one conversation. */
export const listConversationTodos = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((conversationId: string) => conversationId)
  .handler(async ({ data: conversationId }): Promise<TodoItem[]> => loadTodos(conversationId));

/** Let the human tick items off too — it is a shared list, not the agents'. */
export const setTodoStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { conversationId: string; id: string; status: "pending" | "in_progress" | "completed" }) => input)
  .handler(async ({ data }) => {
    await loadTodos(data.conversationId);
    applyTodoStatus(data.conversationId, data.id, data.status);
    return { ok: true as const };
  });
