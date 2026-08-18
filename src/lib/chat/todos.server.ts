/**
 * A shared todo list per conversation (server-only).
 *
 * Every agent tracks plans differently — Codex emits `turn/plan/updated`, grok
 * and Claude Code have their own todo tools, API seats have nothing — so the
 * room keeps one list and each seat writes into it in whatever way it can.
 * That way the human sees a single plan rather than three private ones.
 *
 * Held in memory, keyed by conversation, on `globalThis` — and written behind to
 * the database. Writes come from inside tool callbacks, which must stay
 * synchronous and unfailable, so the memory copy is authoritative while the
 * server is up and the rows are what survive a restart.
 */
import { logEvent } from "@/lib/log.server";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  /** Seat handle that last touched this item. */
  actor: string;
  /**
   * Order of first appearance. A counter rather than a timestamp: several seats
   * publish inside the same millisecond, and equal timestamps sorted stably put
   * every other seat's steps ahead of the writer's, which shuffled the list.
   */
  seq: number;
  updatedAt: number;
};

type Store = Map<string, TodoItem[]>;
const globalRef = globalThis as typeof globalThis & { __legionTodos__?: Store; __legionTodoSeq__?: { n: number } };
function store(): Store {
  globalRef.__legionTodos__ ??= new Map();
  return globalRef.__legionTodos__;
}

/** Ever-increasing, so two steps added in the same millisecond still order. */
function nextSeq(): number {
  globalRef.__legionTodoSeq__ ??= { n: 0 };
  globalRef.__legionTodoSeq__.n += 1;
  return globalRef.__legionTodoSeq__.n;
}

export function listTodos(conversationId: string): TodoItem[] {
  return store().get(conversationId) ?? [];
}

export function clearTodos(conversationId: string): void {
  store().delete(conversationId);
  void persistTodos(conversationId);
}

/**
 * Tick one step off, without rewriting the rest.
 *
 * The human ticking a box used to go through `writeTodos(convo, "host", all)`,
 * which stamped *every* step as the host's — one click and the plan no longer
 * showed which seat owned what. A status change is not authorship, so the owner
 * is left alone.
 */
export function setTodoStatus(conversationId: string, id: string, status: TodoStatus): TodoItem[] {
  const next = listTodos(conversationId).map((t) =>
    t.id === id ? { ...t, status, updatedAt: Date.now() } : t,
  );
  store().set(conversationId, next);
  void persistTodos(conversationId);
  return next;
}

function normaliseStatus(value: unknown): TodoStatus {
  const s = String(value ?? "").toLowerCase();
  if (s.startsWith("in") || s === "active" || s === "doing") return "in_progress";
  if (s.startsWith("done") || s.startsWith("complet")) return "completed";
  return "pending";
}

/**
 * Merge one seat's plan into the room's list.
 *
 * Agents send their whole list every time rather than deltas, because that is
 * what their own todo tools do. Taking them at their word and replacing the
 * list wholesale was wrong in the case this app is built for: with three seats
 * answering one message, whichever published last erased the others. Measured —
 * Claude's two steps disappeared the moment Codex published one of its own.
 *
 * So a write replaces what this seat previously said and leaves other seats'
 * steps alone. Two exceptions keep it useful rather than merely safe: a step
 * matched by text is updated in place whoever owns it, so one seat can tick off
 * another's work; and a seat omitting its *own* earlier step really does drop
 * it, because that is the only way to remove one.
 *
 * Order is by first appearance, so a rewrite never shuffles the list under the
 * reader.
 */
export function writeTodos(
  conversationId: string,
  actor: string,
  items: { text: string; status?: unknown }[],
): TodoItem[] {
  const all = listTodos(conversationId);
  const byText = new Map(all.map((t) => [t.text, t]));
  const now = Date.now();

  const incoming: TodoItem[] = items
    .filter((i) => typeof i.text === "string" && i.text.trim())
    .slice(0, 40)
    .map((i) => {
      const text = i.text.trim().slice(0, 200);
      const prior = byText.get(text);
      return {
        id: prior?.id ?? `todo-${now}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        status: normaliseStatus(i.status),
        actor,
        seq: prior?.seq ?? nextSeq(),
        updatedAt: now,
      };
    });

  const mentioned = new Set(incoming.map((i) => i.text));
  const kept = all.filter((t) => !mentioned.has(t.text) && t.actor !== actor);
  const next = [...kept, ...incoming].sort((a, b) => a.seq - b.seq);

  store().set(conversationId, next);
  void persistTodos(conversationId);
  logEvent({
    kind: "tool:end",
    actor,
    conversationId,
    message: `todo list: ${next.filter((t) => t.status === "completed").length}/${next.length} done`,
  });
  return next;
}

/**
 * Write the current list to the database.
 *
 * Fire-and-forget from the callers' point of view: a plan write happens inside
 * a tool callback and must never fail a turn. Delete-then-insert rather than a
 * diff — the list is at most forty short rows, and correctness here is worth
 * more than the saved statements.
 */
async function persistTodos(conversationId: string): Promise<void> {
  try {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = listTodos(conversationId);
    await sql`delete from conversation_todos where conversation_id = ${conversationId}`;
    for (const t of rows) {
      await sql`
        insert into conversation_todos (id, conversation_id, seq, text, status, actor, updated_at)
        values (${t.id}, ${conversationId}, ${t.seq}, ${t.text}, ${t.status}, ${t.actor}, to_timestamp(${t.updatedAt / 1000}))
        on conflict (id) do update set
          seq = excluded.seq, text = excluded.text, status = excluded.status,
          actor = excluded.actor, updated_at = excluded.updated_at
      `;
    }
  } catch {
    // No database, or a chamber that has since been deleted. The session keeps
    // its in-memory plan either way.
  }
}

/**
 * The plan for a chamber, reading it back from the database when this process
 * has not seen it yet — after a restart, or in another worker.
 */
export async function loadTodos(conversationId: string): Promise<TodoItem[]> {
  const cached = store().get(conversationId);
  if (cached) return cached;
  try {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      seq: number;
      text: string;
      status: string;
      actor: string;
      updated_at: string;
    }>`
      select id, seq, text, status, actor, updated_at::text as updated_at
      from conversation_todos where conversation_id = ${conversationId}
      order by seq asc
    `;
    if (!rows.length) return [];
    const items: TodoItem[] = rows.map((r) => ({
      id: r.id,
      text: r.text,
      status: normaliseStatus(r.status),
      actor: r.actor,
      seq: Number(r.seq),
      updatedAt: new Date(r.updated_at).getTime(),
    }));
    // Restart the counter above what was loaded, or new steps would sort ahead
    // of the ones already on screen.
    const highest = Math.max(...items.map((i) => i.seq), 0);
    globalRef.__legionTodoSeq__ ??= { n: 0 };
    globalRef.__legionTodoSeq__.n = Math.max(globalRef.__legionTodoSeq__.n, highest);
    store().set(conversationId, items);
    return items;
  } catch {
    return [];
  }
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
