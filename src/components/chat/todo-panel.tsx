import { useEffect, useState } from "react";
import { Circle, CircleCheck, CircleDot, ListTodo } from "lucide-react";
import { listConversationTodos, setTodoStatus } from "@/lib/chat/todo-actions";
import type { TodoItem, TodoStatus } from "@/lib/chat/todos.server";
import { cn } from "@/lib/utils";

const NEXT: Record<TodoStatus, TodoStatus> = {
  pending: "in_progress",
  in_progress: "completed",
  completed: "pending",
};

const ICON: Record<TodoStatus, typeof Circle> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
};

/**
 * The room's shared plan.
 *
 * One list for every seat: API seats write it with `todo_write`, Codex's own
 * `turn/plan/updated` folds into the same store, and the human can tick items
 * off too — a plan the agents can edit but the human cannot is a status report,
 * not a plan.
 */
export function TodoPanel({ conversationId, live }: { conversationId: string; live: boolean }) {
  const [items, setItems] = useState<TodoItem[]>([]);

  useEffect(() => {
    let stopped = false;
    const poll = () => {
      void listConversationTodos({ data: conversationId })
        .then((rows) => {
          if (!stopped) setItems(rows);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, live ? 2500 : 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [conversationId, live]);

  if (items.length === 0) return null;

  const done = items.filter((t) => t.status === "completed").length;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-bg-subtle/40">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <ListTodo className="size-3.5 text-fg-subtle" />
        <span className="text-xs font-medium text-fg-muted">
          Plan · {done}/{items.length}
        </span>
      </div>
      <ul className="space-y-0.5 px-2 pb-2">
        {items.map((item) => {
          const Icon = ICON[item.status];
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() =>
                  void setTodoStatus({
                    data: { conversationId, id: item.id, status: NEXT[item.status] },
                  }).then(() =>
                    setItems((prev) =>
                      prev.map((t) => (t.id === item.id ? { ...t, status: NEXT[item.status] } : t)),
                    ),
                  )
                }
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-bg-subtle"
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    item.status === "completed" ? "text-accent" : item.status === "in_progress" ? "text-accent" : "text-fg-subtle",
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-xs",
                    item.status === "completed" ? "text-fg-subtle line-through" : "text-fg-muted",
                  )}
                >
                  {item.text}
                </span>
                <span className="shrink-0 text-[11px] text-fg-subtle">@{item.actor}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
