/**
 * Local coding-agent CLIs as chat seats (server-only).
 *
 * When this app runs on a workstation that already has Claude Code or Codex
 * installed and signed in, those CLIs are a working credential — no API key to
 * paste, no device flow to complete. Both are driven through their supported
 * programmatic entry points rather than by scraping their token stores:
 *
 *   Claude → `@anthropic-ai/claude-agent-sdk`, which spawns the Claude Code
 *            binary and inherits whatever it is logged into.
 *   Codex  → `codex app-server`, the CLI's JSON-RPC stdio protocol.
 *
 * Both run as child processes of this server, so they only exist when Legion
 * runs locally. Detection is therefore a per-process fact, not per-user config;
 * see `keys.server.ts` for how it becomes a provider status.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_TOOL_CALLS, toolsRoot, type ToolContext } from "./tools.server";
import { logEvent } from "@/lib/log.server";
import type { ProviderMessage } from "./xai.server";

export type LocalCliId = "claude" | "codex" | "grok" | "pi" | "hermes" | "qwen";

/** How long a single local turn may take before the child is killed. */
const TURN_TIMEOUT_MS = 180_000;

/**
 * Directories searched on top of `PATH`. A server started from a desktop
 * launcher (rather than a shell) often gets a minimal `PATH` that omits exactly
 * the places these CLIs install into.
 */
function extraBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

const ENV_OVERRIDE: Record<LocalCliId, string> = {
  claude: "CLAUDE_CLI_PATH",
  codex: "CODEX_CLI_PATH",
  grok: "GROK_CLI_PATH",
  pi: "PI_CLI_PATH",
  hermes: "HERMES_CLI_PATH",
  qwen: "QWEN_CLI_PATH",
};

/**
 * The simpler CLIs: one process, a prompt in, an answer out.
 *
 * Unlike Claude (an SDK with a permission callback) and Codex (a JSON-RPC
 * protocol), these three are asked once and answer once. Each needs its own
 * flags for "don't be interactive", "here is the system prompt" and "no tools" —
 * tools stay off because none of them can ask before acting, and an unattended
 * seat must not edit the workstation without a prompt the human can see.
 */
type SimpleCliSpec = {
  /** Build argv for a single-shot run. */
  args: (prompt: string, system: string, model: string) => string[];
  /** Pull the answer out of stdout. */
  parse: (stdout: string) => string;
};

/** Last assistant text in pi's NDJSON stream. */
function parsePiOutput(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const row = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: { type?: string; text?: string }[] };
      };
      if (row.type !== "turn_end" && row.type !== "message_end") continue;
      if (row.message?.role !== "assistant") continue;
      const joined = (row.message.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (joined.trim()) text = joined;
    } catch {
      // Partial or non-JSON lines are normal in a stream; skip them.
    }
  }
  return text.trim();
}

const SIMPLE_CLIS: Partial<Record<LocalCliId, SimpleCliSpec>> = {
  pi: {
    args: (prompt, system, model) => [
      "-p",
      "--mode",
      "json",
      // No tools: pi cannot route a permission request back to us.
      "--no-tools",
      "--no-session",
      ...(system ? ["--system-prompt", system] : []),
      ...(model ? ["--model", model] : []),
      prompt,
    ],
    parse: parsePiOutput,
  },
  hermes: {
    args: (prompt, system, model) => [
      "-z",
      system ? `${system}\n\n---\n\n${prompt}` : prompt,
      "--safe-mode",
      ...(model ? ["-m", model] : []),
    ],
    // Plain text on stdout.
    parse: (out) => out.trim(),
  },
  qwen: {
    args: (prompt, system, model) => [
      "-p",
      system ? `${system}\n\n---\n\n${prompt}` : prompt,
      ...(model ? ["-m", model] : []),
    ],
    parse: (out) =>
      out
        .split("\n")
        // Qwen prefixes warnings about MCP servers it could not start.
        .filter((l) => !/^(Warning|Loaded cached|\[dotenv)/i.test(l.trim()))
        .join("\n")
        .trim(),
  },
};

/**
 * Grok's built-in tools, filtered to the ones that only look.
 *
 * `--tools` is an allowlist, so anything omitted is unavailable rather than
 * merely discouraged: `run_terminal_command`, `search_replace`, the schedulers
 * and `spawn_subagent` all stay off for an unattended chat seat. Web search and
 * page fetch are in — they read the world without touching the workstation, and
 * they are the one capability the API seats cannot offer.
 */
const GROK_READONLY_TOOLS = ["read_file", "list_dir", "grep", "web_search", "open_page", "open_page_with_find"];

type DetectCache = Partial<Record<LocalCliId, string | null>>;
const globalRef = globalThis as typeof globalThis & { __legionLocalCli__?: DetectCache };
function cache(): DetectCache {
  globalRef.__legionLocalCli__ ??= {};
  return globalRef.__legionLocalCli__;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to a local CLI, or null when it is not installed. Cached for
 * the life of the process — installing a CLI while the server runs needs a
 * restart, which beats stat-ing the whole `PATH` on every settings render.
 */
export function detectLocalCli(id: LocalCliId): string | null {
  const cached = cache()[id];
  if (cached !== undefined) return cached;

  const override = process.env[ENV_OVERRIDE[id]]?.trim();
  if (override) {
    const found = isExecutable(override) ? override : null;
    cache()[id] = found;
    return found;
  }

  const dirs = [...(process.env.PATH ?? "").split(":").filter(Boolean), ...extraBinDirs()];
  for (const dir of dirs) {
    const candidate = join(dir, id);
    if (isExecutable(candidate)) {
      cache()[id] = candidate;
      return candidate;
    }
  }
  cache()[id] = null;
  return null;
}

/** Forget cached detection (used by tests and after an install). */
export function resetLocalCliCache(): void {
  globalRef.__legionLocalCli__ = {};
}

/**
 * Flatten a chat history into one prompt. Neither entry point takes an
 * OpenAI-style message array: the Agent SDK takes a single prompt plus a system
 * prompt, and an app-server turn takes user input items. Prior turns are
 * therefore rendered as a labelled transcript, with the final user message left
 * as the live question so the model answers it rather than the transcript.
 */
function renderPrompt(messages: ProviderMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();

  const turns = messages.filter((m) => m.role !== "system");
  const last = turns[turns.length - 1];
  const history = turns.slice(0, -1);

  const transcript = history
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");

  if (!last) return { system, prompt: transcript };
  if (!transcript) return { system, prompt: last.content };
  return {
    system,
    prompt: `Earlier in this conversation:\n\n${transcript}\n\n---\n\nUser: ${last.content}`,
  };
}

/**
 * One turn through the Claude Agent SDK.
 *
 * The seat gets Claude Code's own read-only tools — Read, Glob, Grep — so it
 * can inspect the workspace like the API seats can. Everything that writes
 * (Edit, Write, Bash, WebFetch) stays off: a turn fires unattended and there is
 * no UI here to approve anything. `settingSources: []` keeps the workstation's
 * CLAUDE.md and settings out of app conversations, and `maxTurns` bounds the
 * tool loop the way MAX_TOOL_CALLS bounds the API ones.
 */
const CLAUDE_READONLY_TOOLS = ["Read", "Glob", "Grep"];

/**
 * Tools the Claude seat may use once a human says yes.
 *
 * Kept separate from the read-only set: these are only offered when a caller
 * supplies a tool context, because without one there is nobody to approve them
 * and an unattended turn must not edit the workstation.
 */
const CLAUDE_WRITE_TOOLS = [
  "Edit",
  "Write",
  "Bash",
  // Task fans work out to subagents. It is in the gated set because a subagent
  // inherits the seat's reach: approving one Task can mean several tool calls
  // the human never saw individually. The activity panel shows each subagent
  // start and finish so it is at least visible after the fact.
  "Task",
];

export async function completeWithClaudeCli(
  messages: ProviderMessage[],
  model: string,
  ctx?: ToolContext,
): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { system, prompt } = renderPrompt(messages);
  const executable = detectLocalCli("claude");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);

  try {
    const run = query({
      prompt,
      options: {
        // Fall back to the SDK's bundled binary when nothing is on PATH; both
        // read the same login, so auth works either way.
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        ...(model ? { model } : {}),
        ...(system ? { systemPrompt: system } : {}),
        tools: ctx ? [...CLAUDE_READONLY_TOOLS, ...CLAUDE_WRITE_TOOLS] : CLAUDE_READONLY_TOOLS,
        // Reads are pre-approved; anything that writes goes through canUseTool
        // below, which parks the turn on the same approval registry the API
        // seats use — so one prompt style covers every kind of agent.
        allowedTools: CLAUDE_READONLY_TOOLS,
        ...(ctx ? { canUseTool: claudeApprovalBridge(ctx) } : {}),
        settingSources: [],
        // The user's MCP servers, handed to Claude Code directly rather than
        // proxied: it speaks MCP natively, and its own tool loop can use them
        // without a round trip through ours. `settingSources: []` means only
        // these are loaded, not the workstation's own MCP config.
        ...(ctx ? { mcpServers: await claudeMcpServers(ctx.userId) } : {}),
        cwd: toolsRoot(),
        maxTurns: MAX_TOOL_CALLS,
        abortController: abort,
      },
    });

    for await (const message of run) {
      // Subagents: Claude Code can fan work out to Task subagents, which would
      // otherwise be invisible — the seat just takes longer and comes back with
      // more. Log each one so the activity panel can show who it delegated to.
      if (message.type === "system" && ctx) {
        if (message.subtype === "task_started") {
          logEvent({
            kind: "cli:spawn",
            actor: `${ctx.actor}:subagent`,
            conversationId: ctx.conversationId,
            message: `subagent started: ${message.description}`,
            data: { type: message.subagent_type ?? message.task_type ?? "task", id: message.task_id },
          });
        } else if (message.subtype === "task_notification") {
          logEvent({
            kind: message.status === "failed" ? "cli:exit" : "cli:exit",
            actor: `${ctx.actor}:subagent`,
            conversationId: ctx.conversationId,
            message: `subagent ${message.status}: ${message.summary}`,
            data: { id: message.task_id, tokens: message.usage?.total_tokens },
          });
        }
        continue;
      }
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) return message.result;
      const detail =
        "result" in message && typeof message.result === "string" && message.result.trim()
          ? message.result
          : message.subtype;
      throw new Error(`Claude Code failed: ${detail}`);
    }
    throw new Error("Claude Code returned no result.");
  } catch (err) {
    if (abort.signal.aborted) throw new Error("The seat took too long and was cut off.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One turn through a single-shot CLI (pi, hermes, qwen).
 *
 * An error here is usually "installed but not signed in" — qwen answers 401
 * from ModelScope, for instance — so the message is passed through rather than
 * flattened, and the seat says what the CLI said.
 */
export async function completeWithSimpleCli(
  cli: LocalCliId,
  messages: ProviderMessage[],
  model: string,
  ctx?: ToolContext,
): Promise<string> {
  const spec = SIMPLE_CLIS[cli];
  if (!spec) throw new Error(`${cli} has no single-shot runner.`);
  const bin = detectLocalCli(cli);
  if (!bin) throw new Error(`The ${cli} CLI is not installed on this machine.`);

  const { system, prompt } = renderPrompt(messages);
  const started = Date.now();
  logEvent({ kind: "cli:spawn", actor: cli, conversationId: ctx?.conversationId, message: `${cli} single-shot` });

  const child = spawn(bin, spec.args(prompt, system, model), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr = `${stderr}${c.toString()}`.slice(-2000);
  });

  const timer = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  }).finally(() => clearTimeout(timer));

  logEvent({
    kind: "cli:exit",
    actor: cli,
    conversationId: ctx?.conversationId,
    message: `${cli} exited ${code}`,
    durationMs: Date.now() - started,
  });

  const text = spec.parse(stdout);
  if (text) return text;
  const detail = (stderr || stdout).trim().slice(-300);
  throw new Error(detail ? `${cli} said: ${detail}` : `${cli} returned nothing (exit ${code}).`);
}

/**
 * The user's MCP servers in the Agent SDK's own config shape.
 *
 * Claude Code connects to these itself, so its tool loop can call them without
 * every request bouncing through Legion. A malformed entry is skipped rather
 * than failing the turn.
 */
async function claudeMcpServers(
  userId: string,
): Promise<Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig>> {
  const { listMcpServers } = await import("./mcp.server");
  const out: Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig> = {};
  for (const server of await listMcpServers(userId)) {
    if (!server.enabled) continue;
    if (server.transport === "stdio") {
      const argv = server.target.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [];
      if (!argv.length) continue;
      let env: Record<string, string> = {};
      try {
        env = JSON.parse(server.envJson || "{}") as Record<string, string>;
      } catch {
        env = {};
      }
      out[server.name] = { command: argv[0], args: argv.slice(1), env };
    } else {
      out[server.name] =
        server.transport === "sse"
          ? { type: "sse", url: server.target }
          : { type: "http", url: server.target };
    }
  }
  return out;
}

/**
 * Turn Claude Code's own permission prompt into a Legion approval.
 *
 * The Agent SDK asks its host before running a tool it is not pre-allowed; that
 * host is us. Rather than answer from a static rule, park on the same registry
 * the API seats use, so the human sees one consistent prompt whichever kind of
 * agent is asking. A refusal comes back as `behavior: "deny"` with a message
 * the model can read, which keeps the turn alive instead of killing it.
 */
function claudeApprovalBridge(ctx: ToolContext) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { title?: string; description?: string },
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
    const { requestApproval } = await import("./approvals.server");
    const outcome = await requestApproval({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      actor: ctx.actor,
      tool: toolName,
      args: input,
      // The SDK renders a better sentence than we could reconstruct.
      reason: options.title ?? options.description ?? `Run ${toolName}`,
    });
    return outcome.allowed
      ? { behavior: "allow", updatedInput: input }
      : {
          behavior: "deny",
          message:
            outcome.scope === "timeout"
              ? "No answer in time; treat this tool as unavailable and continue."
              : "The human declined. Do not retry; continue without it.",
        };
  };
}

/**
 * One turn through the `grok` CLI in headless single-turn mode.
 *
 * `-p` prints one response and exits, and `--output-format json` wraps it with
 * the stop reason and usage, so unlike the other two CLIs there is no protocol
 * to speak — just a child process and a JSON document. The system prompt goes
 * through `--rules` (appended to grok's own) rather than
 * `--system-prompt-override`, which would throw away the harness instructions
 * that make its tools work.
 */
export async function completeWithGrokCli(
  messages: ProviderMessage[],
  model: string,
  ctx?: ToolContext,
): Promise<string> {
  const bin = detectLocalCli("grok");
  if (!bin) throw new Error("The grok CLI is not installed on this machine.");

  const { system, prompt } = renderPrompt(messages);
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--cwd",
    toolsRoot(),
    "--tools",
    GROK_READONLY_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--no-subagents",
    "--max-turns",
    String(MAX_TOOL_CALLS),
  ];
  if (system) args.push("--rules", system);
  if (model) args.push("--model", model);

  logEvent({
    kind: "cli:spawn",
    actor: "grok",
    conversationId: ctx?.conversationId,
    message: `grok -p (${GROK_READONLY_TOOLS.length} tools)`,
    data: { model: model || "(cli default)" },
  });
  const started = Date.now();
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr = `${stderr}${c.toString()}`.slice(-2000);
  });

  const timer = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  }).finally(() => clearTimeout(timer));

  logEvent({
    kind: "cli:exit",
    actor: "grok",
    conversationId: ctx?.conversationId,
    message: `grok exited ${code}`,
    durationMs: Date.now() - started,
  });

  if (code !== 0 && !stdout.trim()) {
    throw new Error(`grok exited ${code}${stderr ? `: ${stderr.slice(-200)}` : ""}`);
  }

  // Older/plain output is bare text; JSON mode is the documented shape.
  try {
    const parsed = JSON.parse(stdout) as { text?: string; stopReason?: string; error?: string };
    if (parsed.error) throw new Error(parsed.error);
    const text = parsed.text?.trim();
    if (text) return text;
    throw new Error(
      parsed.stopReason === "cancelled"
        ? "grok stopped before answering (hit its turn limit)."
        : "grok returned an empty reply.",
    );
  } catch (err) {
    if (err instanceof SyntaxError) {
      const text = stdout.trim();
      if (text) return text;
    }
    throw err;
  }
}

/** Codex approval methods, and how each names the thing being approved. */
const CODEX_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

/**
 * Answer a Codex approval request from the human.
 *
 * Codex asks over the wire mid-turn, the same way Claude's SDK asks through a
 * callback, so both end up on the one registry. Its vocabulary is richer than
 * ours in one direction (`cancel` also interrupts the turn) and poorer in
 * another (no cross-session memory), so "always" answers `acceptForSession`
 * here and is remembered on our side for the next session instead.
 */
async function codexApprovalDecision(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<string> {
  const { requestApproval } = await import("./approvals.server");
  const command = typeof params?.command === "string" ? params.command : "";
  const reasonField = typeof params?.reason === "string" ? params.reason : "";
  const isFileChange = method.includes("fileChange") || method === "applyPatchApproval";

  const outcome = await requestApproval({
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    actor: ctx.actor,
    tool: isFileChange ? "codex:file_change" : "codex:run_command",
    args: command ? { command } : {},
    reason:
      reasonField ||
      (command ? `Run: ${command.slice(0, 200)}` : isFileChange ? "Apply file changes in your workspace" : "Run a tool"),
  });

  if (!outcome.allowed) return "decline"; // the turn continues without it
  return outcome.scope === "session" || outcome.scope === "always" ? "acceptForSession" : "accept";
}

/**
 * Pull a readable sentence out of an app-server `error` notification. The
 * upstream API error arrives as a JSON document stuffed into a string field,
 * so the useful line ("The 'x' model is not supported…") is two levels down.
 */
function codexErrorText(params: Record<string, unknown> | undefined): string {
  const error = params?.error as { message?: string } | undefined;
  const raw = error?.message;
  if (!raw) return "Codex app-server error";
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

/**
 * One turn through `codex app-server` (JSON-RPC over stdio, newline-framed).
 *
 * Flow: initialize → initialized → thread/start → turn/start, then read
 * notifications until `turn/completed`, whose `turn.items` carry the final
 * agentMessage. The thread is ephemeral and sandboxed read-only with approvals
 * off: this seat is a chat turn, not an agent with a workspace, and there is no
 * one here to approve a command.
 */
export async function completeWithCodexCli(
  messages: ProviderMessage[],
  model: string,
  ctx?: ToolContext,
): Promise<string> {
  const bin = detectLocalCli("codex");
  if (!bin) throw new Error("The codex CLI is not installed on this machine.");

  const { system, prompt } = renderPrompt(messages);
  // `mcp_servers={}` mirrors `tools: []` on the Claude side: a chat seat has no
  // use for the workstation's MCP servers, and starting them adds seconds to
  // every turn.
  const child: ChildProcessWithoutNullStreams = spawn(bin, ["app-server", "-c", "mcp_servers={}"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const send = (payload: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });

  const finished = new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      for (; newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;

        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue; // Non-protocol chatter on stdout is not fatal.
        }

        // A reply to something we asked for.
        if (msg.id != null && !msg.method) {
          const waiter = pending.get(Number(msg.id));
          if (!waiter) continue;
          pending.delete(Number(msg.id));
          if (msg.error) waiter.reject(new Error(msg.error.message ?? "Codex app-server error"));
          else waiter.resolve(msg.result ?? {});
          continue;
        }

        // A request FROM the server. Approvals get routed to the human when
        // this turn has one; anything else (elicitations, tool-call hosting)
        // still has no answer here, so refuse it rather than hang the turn.
        if (msg.id != null && msg.method) {
          const id = msg.id;
          if (ctx && CODEX_APPROVAL_METHODS.has(msg.method)) {
            void codexApprovalDecision(ctx, msg.method, msg.params)
              .then((decision) => send({ jsonrpc: "2.0", id, result: { decision } }))
              .catch(() => send({ jsonrpc: "2.0", id, result: { decision: "decline" } }));
            continue;
          }
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no interactive client" } });
          continue;
        }

        if (msg.method === "turn/plan/updated" && ctx) {
          // Codex plans its own work; surface it in the room's shared list
          // rather than leaving it invisible inside the CLI.
          void import("./todos.server").then(({ writeTodosFromCodexPlan }) =>
            writeTodosFromCodexPlan(ctx.conversationId, msg.params),
          );
          continue;
        }
        if (msg.method === "turn/completed") {
          const turn = (msg.params?.turn ?? {}) as {
            items?: { type?: string; text?: string }[];
            error?: { message?: string } | null;
          };
          if (turn.error) {
            reject(new Error(turn.error.message ?? "Codex turn failed."));
            return;
          }
          const text = (turn.items ?? [])
            .filter((item) => item.type === "agentMessage" && typeof item.text === "string")
            .map((item) => item.text as string)
            .join("\n")
            .trim();
          if (text) resolve(text);
          else reject(new Error("Codex returned an empty reply."));
          return;
        }

        if (msg.method === "error") {
          reject(new Error(codexErrorText(msg.params)));
          return;
        }
      }
    });

    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      reject(new Error(`codex app-server exited (${code})${stderr ? `: ${stderr.slice(-200)}` : ""}`));
    });
  });

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("The seat took too long and was cut off.")), TURN_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        await request("initialize", {
          clientInfo: { name: "legion", title: "Legion", version: "0.1.0" },
          capabilities: {},
        });
        send({ jsonrpc: "2.0", method: "initialized" });
        const started = await request("thread/start", {
          cwd: toolsRoot(),
          // Stay read-only either way. `workspace-write` looks like the
          // permissive-but-supervised option, but it pre-authorises every edit
          // inside the workspace: measured here, codex created a file without
          // ever asking. Read-only plus "on-request" means a write has to
          // escape the sandbox, which is exactly the moment a human should see
          // it. Unattended (no ctx) nothing may ask, so it never escapes.
          sandbox: "read-only",
          approvalPolicy: ctx ? "on-request" : "never",
          ephemeral: true,
          ...(model ? { model } : {}),
          ...(system ? { developerInstructions: system } : {}),
        });
        const thread = started.thread as { id?: string } | undefined;
        const threadId = thread?.id;
        if (!threadId) throw new Error("Codex app-server did not start a thread.");
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
        });
      })(),
      finished,
      timeout,
    ]);
    return await Promise.race([finished, timeout]);
  } finally {
    child.kill();
  }
}
