import { useState } from "react";
import { Circle, CircleCheck, CircleDot, ListTodo } from "lucide-react";
import { setTodoStatus } from "@/lib/chat/todo-actions";
import { usePulse } from "@/lib/chat/use-pulse";
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
  // The plan rides the chamber's shared poll rather than a timer of its own.
  const rows: TodoItem[] = usePulse(conversationId, live)?.todos ?? [];
  // A tick should look instant even though the next poll may be seconds away.
  // The override drops out as soon as the server agrees.
  const [optimistic, setOptimistic] = useState<Record<string, TodoStatus>>({});
  const items: TodoItem[] = rows.map((t) =>
    optimistic[t.id] && optimistic[t.id] !== t.status ? { ...t, status: optimistic[t.id] } : t,
  );

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
                  {
                    const next = NEXT[item.status];
                    setOptimistic((prev) => ({ ...prev, [item.id]: next }));
                    void setTodoStatus({ data: { conversationId, id: item.id, status: next } });
                  }
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
