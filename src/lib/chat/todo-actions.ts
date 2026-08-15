import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { listTodos, writeTodos, type TodoItem } from "./todos.server";

/** The shared plan for one conversation. */
export const listConversationTodos = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((conversationId: string) => conversationId)
  .handler(async ({ data: conversationId }): Promise<TodoItem[]> => listTodos(conversationId));

/** Let the human tick items off too — it is a shared list, not the agents'. */
export const setTodoStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { conversationId: string; id: string; status: "pending" | "in_progress" | "completed" }) => input)
  .handler(async ({ data }) => {
    const next = listTodos(data.conversationId).map((t) => (t.id === data.id ? { ...t, status: data.status } : t));
    writeTodos(data.conversationId, "host", next);
    return { ok: true as const };
  });
