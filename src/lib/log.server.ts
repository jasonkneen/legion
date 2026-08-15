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

type LogState = { events: LogEvent[]; nextId: number };
const globalRef = globalThis as typeof globalThis & { __legionLog__?: LogState };
function state(): LogState {
  globalRef.__legionLog__ ??= { events: [], nextId: 1 };
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

export function logEvent(event: Omit<LogEvent, "id" | "at">): LogEvent {
  const s = state();
  const full: LogEvent = {
    ...event,
    data: event.data ? (trim(event.data) as Record<string, unknown>) : undefined,
    id: s.nextId++,
    at: Date.now(),
  };
  s.events.push(full);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);

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

/** Newest-last events, optionally filtered to one conversation. */
export function recentEvents(conversationId?: string, limit = 200): LogEvent[] {
  const all = state().events;
  const scoped = conversationId ? all.filter((e) => e.conversationId === conversationId) : all;
  return scoped.slice(-limit);
}

/** Drop everything (used by tests). */
export function clearEvents(): void {
  globalRef.__legionLog__ = { events: [], nextId: 1 };
}
