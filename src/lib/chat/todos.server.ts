/**
 * A shared todo list per conversation (server-only).
 *
 * Every agent tracks plans differently — Codex emits `turn/plan/updated`, grok
 * and Claude Code have their own todo tools, API seats have nothing — so the
 * room keeps one list and each seat writes into it in whatever way it can.
 * That way the human sees a single plan rather than three private ones.
 *
 * In memory, keyed by conversation, held on `globalThis`: a plan belongs to the
 * session that is happening now, and should not outlive the server or need a
 * migration.
 */
import { logEvent } from "@/lib/log.server";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  /** Seat handle that last touched this item. */
  actor: string;
  updatedAt: number;
};

type Store = Map<string, TodoItem[]>;
const globalRef = globalThis as typeof globalThis & { __legionTodos__?: Store };
function store(): Store {
  globalRef.__legionTodos__ ??= new Map();
  return globalRef.__legionTodos__;
}

export function listTodos(conversationId: string): TodoItem[] {
  return store().get(conversationId) ?? [];
}

export function clearTodos(conversationId: string): void {
  store().delete(conversationId);
}

function normaliseStatus(value: unknown): TodoStatus {
  const s = String(value ?? "").toLowerCase();
  if (s.startsWith("in") || s === "active" || s === "doing") return "in_progress";
  if (s.startsWith("done") || s.startsWith("complet")) return "completed";
  return "pending";
}

/**
 * Replace the list for a conversation.
 *
 * Agents send the whole list every time rather than deltas — that is what their
 * own todo tools do, and it avoids trying to reconcile two seats' partial
 * edits. Ids are kept stable by text so a status change does not look like a
 * new item to the UI.
 */
export function writeTodos(
  conversationId: string,
  actor: string,
  items: { text: string; status?: unknown }[],
): TodoItem[] {
  const existing = new Map(listTodos(conversationId).map((t) => [t.text, t]));
  const next: TodoItem[] = items
    .filter((i) => typeof i.text === "string" && i.text.trim())
    .slice(0, 40)
    .map((i) => {
      const text = i.text.trim().slice(0, 200);
      const prior = existing.get(text);
      return {
        id: prior?.id ?? `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        status: normaliseStatus(i.status),
        actor,
        updatedAt: Date.now(),
      };
    });

  store().set(conversationId, next);
  logEvent({
    kind: "tool:end",
    actor,
    conversationId,
    message: `todo list: ${next.filter((t) => t.status === "completed").length}/${next.length} done`,
  });
  return next;
}

/**
 * Codex reports its plan as `turn/plan/updated`, with steps and a status each.
 * Fold that into the same list so its planning shows up beside everyone else's.
 */
export function writeTodosFromCodexPlan(conversationId: string, params: Record<string, unknown> | undefined): void {
  const plan = (params?.plan ?? params?.steps) as unknown;
  const rows = Array.isArray(plan) ? plan : Array.isArray((plan as { items?: unknown[] })?.items) ? (plan as { items: unknown[] }).items : [];
  if (!rows.length) return;
  writeTodos(
    conversationId,
    "codex",
    rows.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return { text: String(r.step ?? r.text ?? r.title ?? ""), status: r.status };
    }),
  );
}
