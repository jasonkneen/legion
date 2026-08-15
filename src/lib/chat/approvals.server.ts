/**
 * Tool approvals (server-only).
 *
 * A turn runs inside a server function with nobody watching it, so "ask the
 * human" cannot be a function call — the turn has to park, publish what it
 * wants, and wait for a separate request to carry the answer back. That is what
 * this module is: a registry of parked requests plus the remembered decisions.
 *
 * Scopes, narrowest first:
 *   once    — this call only; the next identical call asks again
 *   session — the rest of this conversation, in memory
 *   always  — remembered in the database until revoked
 *   deny    — refuse this call (the tool returns a refusal, the turn continues)
 *
 * Everything transient lives on `globalThis`, because a dev HMR reload must not
 * strand a turn that is already waiting on an answer.
 */
import { getSql } from "@/lib/db";
import { logEvent } from "@/lib/log.server";

export type ApprovalScope = "once" | "session" | "always" | "deny";

/** What the UI needs to render a request. */
export type PendingApproval = {
  id: string;
  conversationId: string;
  /** Seat handle that wants the tool, for "who is asking". */
  actor: string;
  tool: string;
  /** Arguments, already trimmed for display. */
  args: Record<string, unknown>;
  /** Why it needs asking: the risk line shown to the human. */
  reason: string;
  createdAt: number;
};

/**
 * What crosses the wire to the browser.
 *
 * `PendingApproval.args` is `Record<string, unknown>`, which the server-function
 * boundary refuses to serialise — and rightly so. The UI only ever shows one
 * line of detail anyway, so flatten it here instead of widening the type.
 */
export type PendingApprovalView = {
  id: string;
  conversationId: string;
  actor: string;
  tool: string;
  reason: string;
  /** The command line or path, already stringified for display. */
  detail: string;
  createdAt: number;
};

export function toApprovalView(p: PendingApproval): PendingApprovalView {
  const detail =
    typeof p.args.command === "string"
      ? p.args.command
      : typeof p.args.path === "string"
        ? p.args.path
        : "";
  return {
    id: p.id,
    conversationId: p.conversationId,
    actor: p.actor,
    tool: p.tool,
    reason: p.reason,
    detail,
    createdAt: p.createdAt,
  };
}

type Waiter = {
  pending: PendingApproval;
  resolve: (scope: ApprovalScope) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ApprovalState = {
  /** Parked requests, keyed by request id. */
  waiting: Map<string, Waiter>;
  /** Session grants: conversationId -> set of tool names. */
  session: Map<string, Set<string>>;
};

const globalRef = globalThis as typeof globalThis & { __legionApprovals__?: ApprovalState };
function state(): ApprovalState {
  globalRef.__legionApprovals__ ??= { waiting: new Map(), session: new Map() };
  return globalRef.__legionApprovals__;
}

/**
 * How long a parked call waits before giving up.
 *
 * Long enough that someone can read the request and think; short enough that a
 * turn cannot hold a seat hostage all afternoon because a tab was closed.
 */
const WAIT_TIMEOUT_MS = 5 * 60_000;

let tableReady: Promise<void> | null = null;
async function ensureTable(): Promise<void> {
  tableReady ??= (async () => {
    const sql = await getSql();
    await sql.query(`
      create table if not exists tool_permissions (
        user_id text not null,
        tool text not null,
        decision text not null,
        updated_at timestamptz not null default now(),
        primary key (user_id, tool)
      )
    `);
  })().catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
}

/** Persisted always/never decisions for one user. */
export async function standingDecisions(userId: string): Promise<Record<string, "always" | "deny">> {
  await ensureTable();
  const sql = await getSql();
  const rows = await sql<{ tool: string; decision: string }>`
    select tool, decision from tool_permissions where user_id = ${userId}
  `;
  const out: Record<string, "always" | "deny"> = {};
  for (const row of rows) {
    if (row.decision === "always" || row.decision === "deny") out[row.tool] = row.decision;
  }
  return out;
}

/** Remember (or revoke) a standing decision. */
export async function setStandingDecision(
  userId: string,
  tool: string,
  decision: "always" | "deny" | null,
): Promise<void> {
  await ensureTable();
  const sql = await getSql();
  if (decision === null) {
    await sql`delete from tool_permissions where user_id = ${userId} and tool = ${tool}`;
    return;
  }
  await sql`
    insert into tool_permissions (user_id, tool, decision, updated_at)
    values (${userId}, ${tool}, ${decision}, now())
    on conflict (user_id, tool) do update set decision = excluded.decision, updated_at = now()
  `;
}

/** Grant for the rest of this conversation, in memory only. */
function grantSession(conversationId: string, tool: string): void {
  const map = state().session;
  const set = map.get(conversationId) ?? new Set<string>();
  set.add(tool);
  map.set(conversationId, set);
}

function hasSessionGrant(conversationId: string, tool: string): boolean {
  return state().session.get(conversationId)?.has(tool) ?? false;
}

/** Forget a conversation's session grants (called when a chat is deleted). */
export function clearSessionGrants(conversationId: string): void {
  state().session.delete(conversationId);
}

/** Everything currently parked, for the UI to render. */
export function pendingApprovals(conversationId?: string): PendingApproval[] {
  const all = [...state().waiting.values()].map((w) => w.pending);
  return conversationId ? all.filter((p) => p.conversationId === conversationId) : all;
}

/**
 * Answer a parked request. Returns false when the id is unknown — the turn
 * timed out, or another tab answered first.
 */
export async function decideApproval(
  userId: string,
  id: string,
  scope: ApprovalScope,
): Promise<boolean> {
  const waiter = state().waiting.get(id);
  if (!waiter) return false;
  state().waiting.delete(id);
  clearTimeout(waiter.timer);

  if (scope === "session") grantSession(waiter.pending.conversationId, waiter.pending.tool);
  if (scope === "always") await setStandingDecision(userId, waiter.pending.tool, "always");
  if (scope === "deny") {
    // A one-off refusal, not a standing ban: banning a tool forever should be
    // an explicit choice in settings, not the fastest button in a dialog.
    logEvent({ kind: "tool:error", actor: waiter.pending.actor, message: `denied ${waiter.pending.tool}` });
  }

  logEvent({
    kind: "tool:start",
    actor: waiter.pending.actor,
    conversationId: waiter.pending.conversationId,
    message: `approval ${scope} for ${waiter.pending.tool}`,
  });
  waiter.resolve(scope);
  return true;
}

export type ApprovalRequest = {
  userId: string;
  conversationId: string;
  actor: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
};

export type ApprovalOutcome = { allowed: boolean; scope: ApprovalScope | "auto" | "timeout" };

/**
 * Decide whether one tool call may proceed, parking the turn if a human has to
 * answer. Checks standing decisions first, then this conversation's grants,
 * and only then asks.
 */
export async function requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
  const standing = await standingDecisions(req.userId).catch(() => ({}) as Record<string, "always" | "deny">);
  if (standing[req.tool] === "deny") return { allowed: false, scope: "always" };
  if (standing[req.tool] === "always") return { allowed: true, scope: "auto" };
  if (hasSessionGrant(req.conversationId, req.tool)) return { allowed: true, scope: "auto" };

  const id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending: PendingApproval = {
    id,
    conversationId: req.conversationId,
    actor: req.actor,
    tool: req.tool,
    args: req.args,
    reason: req.reason,
    createdAt: Date.now(),
  };

  logEvent({
    kind: "tool:start",
    actor: req.actor,
    conversationId: req.conversationId,
    message: `waiting for approval: ${req.tool}`,
    data: req.args,
  });

  const scope = await new Promise<ApprovalScope | "timeout">((resolve) => {
    const timer = setTimeout(() => {
      state().waiting.delete(id);
      logEvent({
        kind: "tool:error",
        actor: req.actor,
        conversationId: req.conversationId,
        message: `approval timed out: ${req.tool}`,
      });
      resolve("timeout");
    }, WAIT_TIMEOUT_MS);
    state().waiting.set(id, { pending, resolve: (s) => resolve(s), timer });
  });

  if (scope === "timeout") return { allowed: false, scope: "timeout" };
  return { allowed: scope !== "deny", scope };
}
