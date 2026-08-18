/**
 * Structured session logging (server-only).
 *
 * Two consumers, one event stream: the terminal during development, and the
 * session activity panel in the UI. Events are kept in a bounded in-memory ring
 * per process — enough to render "what just happened in this chat" without
 * standing up a log store, and cheap enough to leave on.
 *
 * Held on `globalThis` so a dev HMR reload does not silently start a new buffer
 * (the same trap that made the DB path degrade on every save).
 */
export type LogKind =
  | "turn:start"
  | "turn:end"
  | "turn:error"
  | "tool:start"
  | "tool:end"
  | "tool:error"
  | "provider:request"
  | "provider:response"
  | "cli:spawn"
  | "cli:exit";

export type LogEvent = {
  id: number;
  /**
   * Stable key for the UI. The numeric `id` counts from 1 in each process, so
   * it collides with rows written before the last restart; this does not.
   */
  key: string;
  at: number;
  kind: LogKind;
  /** Conversation this belongs to, when the caller knows it. */
  conversationId?: string;
  /** Seat handle or provider id, for grouping in the UI. */
  actor?: string;
  message: string;
  /** Small structured payload. Keep it JSON-serialisable and short. */
  data?: Record<string, unknown>;
  /** Milliseconds, for the paired :end events. */
  durationMs?: number;
};

const MAX_EVENTS = 500;

type LogState = {
  events: LogEvent[];
  nextId: number;
  /** Written but not yet persisted. Drained by `flushActivity`. */
  pending: LogEvent[];
  /** When the old-row sweep last ran, so it is not repeated per flush. */
  prunedAt?: number;
  flushing?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const globalRef = globalThis as typeof globalThis & { __legionLog__?: LogState };
function state(): LogState {
  globalRef.__legionLog__ ??= { events: [], nextId: 1, pending: [] };
  // An older shape can survive an HMR reload; keep the new field present.
  globalRef.__legionLog__.pending ??= [];
  return globalRef.__legionLog__;
}

/** Truncate anything that could turn a log line into a wall of text. */
function trim(value: unknown, max = 300): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => trim(v, 120));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([k, v]) => [k, trim(v, 160)]));
  }
  return value;
}

const isDev = process.env.NODE_ENV !== "production";
let warnedAboutFlush = false;

export function logEvent(event: Omit<LogEvent, "id" | "at" | "key">): LogEvent {
  const s = state();
  const id = s.nextId++;
  const full: LogEvent = {
    ...event,
    data: event.data ? (trim(event.data) as Record<string, unknown>) : undefined,
    id,
    key: `${bootId()}-${String(id).padStart(9, "0")}`,
    at: Date.now(),
  };
  s.events.push(full);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);

  // Anything belonging to a chamber outlives this process. Queued rather than
  // written here: logging is called from inside tool runs and must stay
  // synchronous and unfailable — a database hiccup cannot break a turn.
  if (full.conversationId) {
    s.pending.push(full);
    scheduleFlush(s);
  }

  if (isDev) {
    const who = full.actor ? ` ${full.actor}` : "";
    const ms = full.durationMs != null ? ` ${full.durationMs}ms` : "";
    console.log(`[legion]${who} ${full.kind}${ms} — ${full.message}`);
  }
  return full;
}

/** Time an async span and log start/end (or error) around it. */
export async function logSpan<T>(
  base: { kind: LogKind; endKind: LogKind; errorKind: LogKind; actor?: string; conversationId?: string; message: string; data?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  logEvent({ kind: base.kind, actor: base.actor, conversationId: base.conversationId, message: base.message, data: base.data });
  try {
    const result = await run();
    logEvent({
      kind: base.endKind,
      actor: base.actor,
      conversationId: base.conversationId,
      message: base.message,
      durationMs: Date.now() - started,
      data: typeof result === "string" ? { chars: result.length } : undefined,
    });
    return result;
  } catch (err) {
    logEvent({
      kind: base.errorKind,
      actor: base.actor,
      conversationId: base.conversationId,
      message: `${base.message}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

/**
 * A per-process token, so event keys from before a restart cannot collide with
 * ones written after it.
 */
function bootId(): string {
  const g = globalThis as typeof globalThis & { __legionLogBoot__?: string };
  g.__legionLogBoot__ ??= Math.random().toString(36).slice(2, 8);
  return g.__legionLogBoot__;
}

/** Coalesce a burst of events into one round trip. */
function scheduleFlush(s: LogState): void {
  if (s.timer || s.flushing) return;
  s.timer = setTimeout(() => {
    s.timer = undefined;
    void flushActivity();
  }, 700);
  // Never hold the process open for a log write.
  (s.timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Persist queued events.
 *
 * Failures drop the batch rather than retrying forever: activity is useful, but
 * not so useful that an unreachable database should grow a buffer without
 * bound. Rows are written one statement at a time so a single bad row — an
 * event for a chamber that has since been deleted, which the foreign key
 * rejects — cannot take the rest of the batch with it.
 */
export async function flushActivity(): Promise<void> {
  const s = state();
  if (s.flushing || !s.pending.length) return;
  s.flushing = true;
  const batch = s.pending.splice(0, s.pending.length);
  try {
    const { getSql } = await import("./db");
    const sql = await getSql();
    for (const e of batch) {
      try {
        await sql`
          insert into activity_events (id, conversation_id, at, kind, actor, message, duration_ms, data_json)
          values (
            ${e.key}, ${e.conversationId!}, to_timestamp(${e.at / 1000}), ${e.kind},
            ${e.actor ?? ""}, ${e.message}, ${e.durationMs ?? null},
            ${e.data ? JSON.stringify(e.data) : null}
          )
          on conflict (id) do nothing
        `;
      } catch {
        /* one unpersistable event must not lose the others */
      }
    }
    // Activity is a working record, not an archive: sweep anything older than a
    // fortnight, at most hourly so a busy chamber does not pay for it per flush.
    if (!s.prunedAt || Date.now() - s.prunedAt > 3_600_000) {
      s.prunedAt = Date.now();
      await sql`delete from activity_events where at < now() - interval '14 days'`;
    }
  } catch (err) {
    // No database, or a schema that predates this table. Dropping the batch is
    // deliberate, but doing it silently once cost an afternoon of "is it
    // working?" — say so, once, rather than on every flush.
    if (isDev && !warnedAboutFlush) {
      warnedAboutFlush = true;
      console.warn(`[legion] activity is not being persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    s.flushing = false;
    if (s.pending.length) scheduleFlush(s);
  }
}

/** Events for one chamber, oldest first: persisted history plus what is queued. */
export async function storedEvents(conversationId: string, limit = 200): Promise<LogEvent[]> {
  const s = state();
  const queued = s.pending.filter((e) => e.conversationId === conversationId);
  try {
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      at: string;
      kind: string;
      actor: string;
      message: string;
      duration_ms: number | null;
      data_json: string | null;
    }>`
      select id, at::text as at, kind, actor, message, duration_ms, data_json
      from activity_events
      where conversation_id = ${conversationId}
      order by at desc, id desc
      limit ${limit}
    `;
    const stored: LogEvent[] = rows.reverse().map((r, i) => ({
      id: i,
      key: r.id,
      at: new Date(r.at).getTime(),
      kind: r.kind as LogKind,
      conversationId,
      actor: r.actor || undefined,
      message: r.message,
      durationMs: r.duration_ms ?? undefined,
      data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : undefined,
    }));
    return [...stored, ...queued].slice(-limit);
  } catch {
    // Fall back to whatever this process still holds.
    return recentEvents(conversationId, limit);
  }
}

/** Newest-last events, optionally filtered to one conversation. */
export function recentEvents(conversationId?: string, limit = 200): LogEvent[] {
  const all = state().events;
  const scoped = conversationId ? all.filter((e) => e.conversationId === conversationId) : all;
  return scoped.slice(-limit);
}

/** Drop everything (used by tests). */
export function clearEvents(): void {
  globalRef.__legionLog__ = { events: [], nextId: 1, pending: [] };
}
