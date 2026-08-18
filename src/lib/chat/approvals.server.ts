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
  /** True when "always" will remember this exact command, not the whole tool. */
  perCommand: boolean;
  createdAt: number;
};

/**
 * Argument names that say *what* a tool is about to act on, most specific first.
 *
 * Each agent names them differently — our own tools use `path`, Claude Code's
 * Write and Edit use `file_path`, shells use `command`. Missing one is not
 * cosmetic: a browser run of the approval flow showed "@claude wants to run
 * Write" with no path underneath, which is a prompt no one can answer safely.
 */
const DETAIL_KEYS = [
  "command",
  "path",
  "file_path",
  "filePath",
  "notebook_path",
  "url",
  "pattern",
  "query",
];

/**
 * Tools whose whole purpose is to run whatever they are handed.
 *
 * These get remembered per command rather than per tool. "Always allow Bash"
 * would otherwise be the widest grant in the app — every command, in every
 * chamber, for good — from a button pressed to approve one `npm test`.
 */
const COMMAND_TOOLS = new Set(["Bash", "run_command", "codex:run_command", "run_terminal_command"]);

/**
 * What a grant is remembered against.
 *
 * For most tools that is the tool name: approving `Write` once and for all is a
 * coherent thing to want. For a shell it is the tool *and the exact command*, so
 * a remembered `npm test` cannot quietly authorise `rm -rf`.
 */
export function permissionKey(tool: string, args: Record<string, unknown>): string {
  if (!COMMAND_TOOLS.has(tool)) return tool;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  return command ? `${tool}(${command})` : tool;
}

/** True when a decision on this tool will be remembered per command. */
export function isCommandTool(tool: string): boolean {
  return COMMAND_TOOLS.has(tool);
}

export function toApprovalView(p: PendingApproval): PendingApprovalView {
  let detail = "";
  for (const key of DETAIL_KEYS) {
    const value = p.args[key];
    if (typeof value === "string" && value.trim()) {
      detail = value;
      break;
    }
  }
  // For a write, how much is being written matters as much as where.
  const content = p.args.content ?? p.args.new_string;
  if (detail && typeof content === "string") {
    const lines = content.split("\n").length;
    detail += `  (${content.length} chars, ${lines} line${lines === 1 ? "" : "s"})`;
  }
  return {
    id: p.id,
    conversationId: p.conversationId,
    actor: p.actor,
    tool: p.tool,
    reason: p.reason,
    detail,
    perCommand: isCommandTool(p.tool),
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

/** Forget a conversation's session grants. */
export function clearSessionGrants(conversationId: string): void {
  state().session.delete(conversationId);
}

/**
 * Release everything a deleted chamber was holding.
 *
 * A turn parked on an approval waits five minutes for an answer. If the human
 * deletes the chat while a seat is asking, that prompt is unanswerable — the
 * screen it lives on is gone — so the turn sat there holding a CLI subprocess
 * open until it timed out. Deleting the room refuses its outstanding questions
 * instead, which the seats already know how to handle.
 */
export function abandonConversation(conversationId: string): number {
  let released = 0;
  for (const [id, waiter] of [...state().waiting.entries()]) {
    if (waiter.pending.conversationId !== conversationId) continue;
    state().waiting.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve("deny");
    released += 1;
  }
  clearSessionGrants(conversationId);
  return released;
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

  const key = permissionKey(waiter.pending.tool, waiter.pending.args);
  if (scope === "session") grantSession(waiter.pending.conversationId, key);
  if (scope === "always") await setStandingDecision(userId, key, "always");
  if (scope === "deny") {
    // A one-off refusal, not a standing ban: banning a tool forever should be
    // an explicit choice in settings, not the fastest button in a dialog.
    logEvent({ kind: "tool:error", actor: waiter.pending.actor, message: `denied ${waiter.pending.tool}` });
  }

  logEvent({
    kind: "tool:start",
    actor: waiter.pending.actor,
    conversationId: waiter.pending.conversationId,
    message: `approval ${scope} for ${key}`,
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
  const key = permissionKey(req.tool, req.args);
  // A ban on the tool outranks a grant on one of its commands.
  if (standing[req.tool] === "deny" || standing[key] === "deny") return { allowed: false, scope: "always" };
  if (standing[key] === "always") return { allowed: true, scope: "auto" };
  if (hasSessionGrant(req.conversationId, key)) return { allowed: true, scope: "auto" };

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
