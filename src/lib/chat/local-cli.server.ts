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
import { MAX_TOOL_CALLS, runTool, toolsRoot, type ToolContext } from "./tools.server";
import { logEvent } from "@/lib/log.server";
import { codexHome, grokHome } from "./agent-home.server";
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
  /**
   * Build argv for a single-shot run. `mcpConfig` is a path to a generated MCP
   * config when this turn has a human to approve things, and empty when it does
   * not — a seat with nobody to ask gets nothing that writes.
   */
  args: (prompt: string, system: string, model: string, mcpConfig: string) => string[];
  /** Pull the answer out of stdout. */
  parse: (stdout: string) => string;
  /** True when this CLI can be handed Legion's tools through the bridge. */
  bridge?: boolean;
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

/**
 * The tools a pi seat may use.
 *
 * `--tools` is an allowlist, so `write`, `edit`, `bash` and pi's extension
 * tools are absent rather than discouraged. Skills stay on: they are how a pi
 * seat knows what its owner taught it, and a skill can do no more than the
 * tools allow.
 *
 * `mcp` is how pi reaches an MCP server at all — it does not surface each
 * remote tool by name, so without this entry Legion's tools are invisible to
 * it and the seat can only read. That is also why the allowlist matters twice
 * over: `mcp` is a door, and the only server behind it is ours.
 */
export const PI_SEAT_TOOLS = ["read", "grep", "find", "ls", "mcp"];

/** Hermes toolsets a chat seat may have. Measured against `hermes tools list`. */
export const HERMES_TOOLSETS = ["web", "skills", "todo", "clarify"];

const SIMPLE_CLIS: Partial<Record<LocalCliId, SimpleCliSpec>> = {
  pi: {
    // pi keeps its own read-only tools and its skills. It cannot route a
    // permission request back to us, so nothing of its own may write: the
    // allowlist is the enforcement, and anything that changes the workstation
    // comes from Legion's tools over the bridge, which stop for a human inside
    // this process.
    bridge: true,
    args: (prompt, system, model, mcpConfig) => [
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--tools",
      PI_SEAT_TOOLS.join(","),
      ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
      ...(system ? ["--system-prompt", system] : []),
      ...(model ? ["--model", model] : []),
      prompt,
    ],
    parse: parsePiOutput,
  },
  hermes: {
    // Hermes ships with far more than a chat seat should hold — terminal, code
    // execution, browser automation, cron jobs, home automation — and no way to
    // ask before using any of it. The toolset list is the whole safety story
    // here, so it names what a seat may have rather than what it may not:
    // reading the web, its own skills, planning, and asking a question.
    args: (prompt, system, model) => [
      "-z",
      system ? `${system}\n\n---\n\n${prompt}` : prompt,
      "--safe-mode",
      "-t",
      HERMES_TOOLSETS.join(","),
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
export const GROK_READONLY_TOOLS = [
  "read_file",
  "list_dir",
  "grep",
  "web_search",
  "open_page",
  "open_page_with_find",
  // Planning only writes to the room's shared list, never to disk.
  "todo_write",
];

/**
 * Tools grok is refused outright, on top of the allowlist.
 *
 * The allowlist alone should be enough, but grok's permission mode is read from
 * the workstation's own `~/.grok/config.toml`, and a common setting there is
 * `permission_mode = "always-approve"`. Measured on this machine: with that set,
 * an ACP seat wrote a file without ever sending `session/request_permission` —
 * `--permission-mode`, a private `GROK_HOME`, a private leader socket and
 * `_meta: { yoloMode: false }` all failed to make it ask. Deny rules are the one
 * thing documented to outrank always-approve, and measured to: grok tried the
 * write, then a shell fallback, and was blocked both times.
 *
 * So this seat is read-only by construction, not by good behaviour. Until grok
 * can route a permission request back to us the way Claude Code and Codex do,
 * widening `GROK_READONLY_TOOLS` would hand it unattended write access.
 */
export const GROK_DENY_RULES = ["Write", "Edit", "Bash", "write", "search_replace", "run_terminal_command"];

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
  // Bash is gated, with one measured caveat: Claude Code classifies harmless
  // commands itself and runs them before `canUseTool` is reached. `echo hello`
  // executed with no prompt; `touch file` asked. Both are logged, so an
  // unprompted command is still visible in the activity panel.
  "Bash",
  // TodoWrite is how some Claude Code builds plan. Whether it exists at all is
  // version-dependent — this workstation's build offers TaskCreate/TaskUpdate
  // instead, and silently drops an unknown name from `tools`, which is why the
  // seat used to answer "I have no todo tool". It is still requested (harmless
  // where absent, useful where present) and captured in `canUseTool`, but the
  // reliable path is `mcp__legion__publish_plan` below, which we supply
  // ourselves and so exists on every build.
  "TodoWrite",
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
        // Publishing a plan touches nothing on disk, so it is pre-approved
        // rather than parked — asking a human to confirm a to-do list would be
        // noise, and the plan is visible in the panel the moment it lands.
        allowedTools: ctx ? [...CLAUDE_READONLY_TOOLS, ...LEGION_MCP_TOOLS] : CLAUDE_READONLY_TOOLS,
        ...(ctx ? { canUseTool: claudeApprovalBridge(ctx) } : {}),
        settingSources: [],
        // The user's MCP servers, handed to Claude Code directly rather than
        // proxied: it speaks MCP natively, and its own tool loop can use them
        // without a round trip through ours. `settingSources: []` means only
        // these are loaded, not the workstation's own MCP config.
        ...(ctx
          ? {
              mcpServers: {
                ...(await claudeMcpServers(ctx.userId)),
                legion: await legionSeatServer(ctx),
              },
            }
          : {}),
        cwd: toolsRoot(),
        maxTurns: MAX_TOOL_CALLS,
        abortController: abort,
      },
    });

    for await (const message of run) {
      // Every tool the seat actually uses, whether or not it had to ask.
      //
      // `canUseTool` is not the whole story: Claude Code classifies harmless
      // commands itself and runs them before the callback is consulted —
      // measured, `echo hello` executed with no approval and left no trace
      // anywhere in the app. Reads running unattended is the intended bargain,
      // but "what did this session do on my machine" has to include them, so
      // the activity panel is fed from the message stream rather than from the
      // approval path.
      if (message.type === "assistant" && ctx) {
        for (const block of message.message?.content ?? []) {
          if (typeof block === "object" && block && (block as { type?: string }).type === "tool_use") {
            const use = block as { name?: string; input?: Record<string, unknown> };
            const input = use.input ?? {};
            const target =
              typeof input.command === "string"
                ? input.command
                : typeof input.file_path === "string"
                  ? input.file_path
                  : typeof input.pattern === "string"
                    ? input.pattern
                    : "";
            logEvent({
              kind: "tool:start",
              actor: ctx.actor,
              conversationId: ctx.conversationId,
              message: `${use.name ?? "tool"}${target ? `: ${target.slice(0, 160)}` : ""}`,
              data: { preview: target.slice(0, 200) },
            });
          }
        }
      }

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

  // Legion's tools, for the CLIs that can be pointed at an MCP server. They run
  // in this process and stop for a human, which is what lets a seat that has no
  // permission channel of its own still change something.
  let token = "";
  let mcpConfig = "";
  let disposeConfig: (() => void) | null = null;
  if (ctx && spec.bridge) {
    const { mintSeatGrant } = await import("./seat-grant.server");
    const { writeBridgeConfig } = await import("./agent-home.server");
    token = mintSeatGrant(ctx, "all");
    const written = writeBridgeConfig(cli, token, legionUrl());
    mcpConfig = written.path;
    disposeConfig = written.dispose;
  }

  logEvent({
    kind: "cli:spawn",
    actor: cli,
    conversationId: ctx?.conversationId,
    message: mcpConfig ? `${cli} single-shot (Legion tools attached)` : `${cli} single-shot`,
  });

  const child = spawn(bin, spec.args(prompt, system, model, mcpConfig), { stdio: ["ignore", "pipe", "pipe"] });
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
  }).finally(async () => {
    clearTimeout(timer);
    // The token and the file it lives in die with the turn.
    disposeConfig?.();
    if (token) {
      const { revokeSeatGrant } = await import("./seat-grant.server");
      revokeSeatGrant(token);
    }
  });

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
/**
 * The tools Legion supplies to the Claude seat, under its own MCP server.
 *
 * The division of labour: the CLI brings the workspace tools it is good at, and
 * Legion brings the ones that are about the *room* — the shared plan, and who
 * is sitting in it. Claude Code has no equivalent for either, and a seat that
 * cannot bring in help has to fake it: the failure that prompted this was grok
 * announcing "@claude — you're in" while seating nobody.
 *
 * Pre-approved at the SDK layer because `runTool` gates them on the way
 * through; prompting here as well would ask the human the same question twice.
 */
const LEGION_MCP_TOOLS = [
  "mcp__legion__publish_plan",
  "mcp__legion__list_ranks",
  "mcp__legion__add_seat",
];

/**
 * An in-process MCP server giving the Claude seat the room's shared plan.
 *
 * Claude Code's own planning tool is not stable across builds — the preset on
 * this workstation has no `TodoWrite` — so the seat cannot be relied on to have
 * one. This supplies it, runs in this process (no subprocess, no transport),
 * and writes straight to the same list grok and Codex publish to.
 */
async function legionSeatServer(ctx: ToolContext) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");
  return createSdkMcpServer({
    name: "legion",
    version: "1.0.0",
    tools: [
      tool(
        "list_ranks",
        "List the agents that could be brought into this chat: which model each is, whether it has a " +
          "working credential, and whether it is already seated.",
        {},
        async () => ({ content: [{ type: "text", text: await runTool("list_ranks", {}, ctx) }] }),
      ),
      tool(
        "add_seat",
        "Bring another agent into this chat so it can answer for itself. Use it when the work needs a " +
          "capability nobody seated has. The human is asked first.",
        {
          modelId: z.string().describe("Which rank, from list_ranks, e.g. gemini or codex"),
          role: z.string().describe("One line on why they are here and what they own"),
          handle: z.string().optional().describe("Short @handle for them in this chat"),
        },
        async (args) => ({
          content: [{ type: "text", text: await runTool("add_seat", { ...args }, ctx) }],
        }),
      ),
      tool(
        "publish_plan",
        "Publish or update your plan for this chat. Everyone in the room sees it, " +
          "so send the whole list each time — including steps already finished.",
        {
          steps: z
            .array(
              z.object({
                text: z.string().describe("What the step is"),
                status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
              }),
            )
            .describe("The full plan, in order"),
        },
        async ({ steps }) => {
          const { writeTodos } = await import("./todos.server");
          const written = writeTodos(ctx.conversationId, ctx.actor, steps);
          logEvent({
            kind: "tool:end",
            actor: ctx.actor,
            conversationId: ctx.conversationId,
            message: `published a ${written.length}-step plan`,
          });
          return { content: [{ type: "text", text: `Plan published: ${written.length} step(s).` }] };
        },
      ),
    ],
  });
}

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
    // Planning is not a permission question. Capture the plan for the shared
    // panel and let it through, so a Claude seat's todos show up beside every
    // other seat's instead of staying inside the CLI.
    if (toolName === "TodoWrite") {
      const rows = Array.isArray((input as { todos?: unknown[] }).todos)
        ? ((input as { todos: Record<string, unknown>[] }).todos ?? [])
        : [];
      if (rows.length) {
        const { writeTodos } = await import("./todos.server");
        writeTodos(
          ctx.conversationId,
          ctx.actor,
          rows.map((row) => ({
            text: String(row.content ?? row.text ?? row.activeForm ?? ""),
            status: row.status,
          })),
        );
        logEvent({
          kind: "tool:end",
          actor: ctx.actor,
          conversationId: ctx.conversationId,
          message: `published a ${rows.length}-step plan`,
        });
      }
      return { behavior: "allow", updatedInput: input };
    }

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
              : "The human declined this. Do not retry it, and do not achieve the same thing another way — " +
                "no shell command standing in for a refused edit. Say what you would have done and carry on.",
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

  // With a human to ask, the seat also gets Legion's own write tools, served by
  // the `legion` MCP server. They run inside this process, where the approval
  // registry lives, so grok's permission model never decides whether a write
  // happens — ours does. The token travels in the environment because grok
  // spawns the MCP server itself and passes its own environment down.
  let token = "";
  if (ctx) {
    const { mintSeatGrant } = await import("./seat-grant.server");
    token = mintSeatGrant(ctx);
  }

  const args = [
    "-p",
    prompt,
    // ACP session updates rather than a single JSON blob: this is the only
    // format that reports the plan and the tool calls, and it lets the answer
    // be assembled as it is written instead of after the process exits.
    "--output-format",
    "streaming-json",
    "--cwd",
    toolsRoot(),
    "--tools",
    GROK_READONLY_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    ...GROK_DENY_RULES.flatMap((rule) => ["--deny", rule]),
    "--no-subagents",
    "--max-turns",
    String(MAX_TOOL_CALLS),
  ];
  if (system) {
    // Without this the seat burns two turns discovering the obvious: it reaches
    // for `write`, is refused by the allowlist, tries the shell, is refused by
    // the deny rules, and only then finds the tools it was always meant to use.
    const rules = token
      ? `${system}\n\nYour own file-writing and shell tools are switched off in this chat. ` +
        "To change anything, use the legion tools (write_file, run_command) — they ask the human first."
      : system;
    args.push("--rules", rules);
  }
  if (model) args.push("--model", model);

  logEvent({
    kind: "cli:spawn",
    actor: "grok",
    conversationId: ctx?.conversationId,
    message: `grok -p (${GROK_READONLY_TOOLS.length} tools)`,
    data: { model: model || "(cli default)" },
  });
  const started = Date.now();
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Read by scripts/legion-mcp-bridge.mjs, which grok starts as its own
      // subprocess. No token means the bridge offers no tools at all, so a
      // human's own grok session sees an inert server rather than one whose
      // every call fails.
      LEGION_URL: legionUrl(),
      LEGION_SEAT_TOKEN: token,
      // A grok home Legion owns. Without it the seat inherits the workstation's
      // skills, plugins, hooks and every MCP server in ~/.claude.json.
      GROK_HOME: grokHome(),
    },
  });

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

  try {
    return await parseGrokStream(stdout, ctx);
  } finally {
    if (token) {
      const { revokeSeatGrant } = await import("./seat-grant.server");
      revokeSeatGrant(token);
    }
  }
}

/** Where a CLI subprocess should call this server back. */
function legionUrl(): string {
  return process.env.LEGION_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

/**
 * Fold grok's ACP session updates into an answer.
 *
 * `text` frames are the reply, arriving token by token. A `plan` frame is grok
 * planning its own work — copied into the room's shared list so its todos sit
 * beside every other seat's rather than staying inside the CLI. Anything else
 * (thoughts, tool call bookkeeping) is deliberately not shown: it is the seat's
 * working, not its answer.
 */
async function parseGrokStream(stdout: string, ctx?: ToolContext): Promise<string> {
  let text = "";
  let stopReason = "";
  let failure = "";
  let plan: Record<string, unknown>[] | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let frame: { type?: string; data?: string; entries?: unknown[]; stopReason?: string; error?: string };
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === "text" && typeof frame.data === "string") text += frame.data;
    else if (frame.type === "plan" && Array.isArray(frame.entries)) {
      // Keep the last plan frame; grok revises it as it works.
      plan = frame.entries as Record<string, unknown>[];
    } else if (frame.type === "end") stopReason = String(frame.stopReason ?? "");
    else if (frame.type === "error") failure = String(frame.error ?? "grok reported an error");
  }

  if (plan?.length && ctx) {
    const { writeTodos } = await import("./todos.server");
    writeTodos(
      ctx.conversationId,
      ctx.actor,
      plan.map((e) => ({ text: String(e.content ?? e.text ?? ""), status: e.status })),
    );
    logEvent({
      kind: "tool:end",
      actor: ctx.actor,
      conversationId: ctx.conversationId,
      message: `published a ${plan.length}-step plan`,
    });
  }

  const answer = text.trim();
  if (answer) return answer;
  if (failure) throw new Error(failure);
  throw new Error(
    stopReason === "cancelled"
      ? "grok stopped before answering (hit its turn limit)."
      : "grok returned an empty reply.",
  );
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
/**
 * What a streamed Codex item is about, so an approval can name it.
 *
 * The approval request itself carries only ids — measured: an
 * `item/fileChange/requestApproval` arrives as `{threadId, turnId, itemId,
 * startedAtMs, reason: null}`. The paths and the diff came earlier, on
 * `item/started`. Without joining the two, the human is asked to approve
 * "codex:file_change" with nothing to judge it by.
 */
type CodexItemFacts = { command?: string; path?: string; content?: string };

export function codexItemFacts(item: Record<string, unknown> | undefined): CodexItemFacts | null {
  if (!item || typeof item !== "object") return null;
  const type = item.type;

  if (type === "fileChange" && Array.isArray(item.changes)) {
    const changes = item.changes as { path?: string; kind?: { type?: string }; diff?: string }[];
    const paths = changes.map((c) => c.path).filter((x): x is string => typeof x === "string");
    if (!paths.length) return null;
    const label =
      paths.length === 1
        ? paths[0]
        : `${paths.length} files: ${paths.map((x) => x.split("/").pop()).join(", ")}`;
    return { path: label, content: changes.map((c) => c.diff ?? "").join("") };
  }

  if (type === "commandExecution" && typeof item.command === "string") {
    return { command: item.command };
  }

  return null;
}

async function codexApprovalDecision(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown> | undefined,
  items?: Map<string, CodexItemFacts>,
): Promise<string> {
  const { requestApproval } = await import("./approvals.server");
  const itemId = typeof params?.itemId === "string" ? params.itemId : "";
  const facts = (itemId && items?.get(itemId)) || {};
  const command = typeof params?.command === "string" ? params.command : (facts.command ?? "");
  const reasonField = typeof params?.reason === "string" ? params.reason : "";
  const isFileChange = method.includes("fileChange") || method === "applyPatchApproval";

  const args: Record<string, unknown> = {};
  if (command) args.command = command;
  if (facts.path) args.path = facts.path;
  if (facts.content) args.content = facts.content;

  const outcome = await requestApproval({
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    actor: ctx.actor,
    tool: isFileChange ? "codex:file_change" : "codex:run_command",
    args,
    reason:
      reasonField ||
      (command
        ? `Run: ${command.slice(0, 200)}`
        : facts.path
          ? `Write ${facts.path}`
          : isFileChange
            ? "Apply file changes in your workspace"
            : "Run a tool"),
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

  // The workstation's own MCP servers stay out: a chat seat has no use for them
  // and starting them adds seconds to every turn. Legion's one server does go
  // in, scoped to the room — Codex already edits and runs commands under its
  // own approvals, so it needs the shared plan and the seating tools, not a
  // second `write_file`.
  let token = "";
  if (ctx) {
    const { mintSeatGrant } = await import("./seat-grant.server");
    token = mintSeatGrant(ctx, "room");
  }
  const mcpConfig = token
    ? `mcp_servers={legion={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(
        join(process.cwd(), "scripts", "legion-mcp-bridge.mjs"),
      )}],env={LEGION_URL=${JSON.stringify(legionUrl())},LEGION_SEAT_TOKEN=${JSON.stringify(token)}}}}`
    : "mcp_servers={}";

  const child: ChildProcessWithoutNullStreams = spawn(bin, ["app-server", "-c", mcpConfig], {
    stdio: ["pipe", "pipe", "pipe"],
    // A codex home Legion owns, so the seat does not inherit the workstation's
    // MCP servers. `-c` merges rather than replaces: with the user's config in
    // scope, `mcp_servers={legion=…}` left blender, infinitty and the rest
    // attached, and the seat reached for one of those instead of ours.
    env: { ...process.env, CODEX_HOME: codexHome() },
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

  // Item id -> what that item is about, filled as the turn streams. An approval
  // request names only the id, so this is what lets the prompt say which file.
  const codexItems = new Map<string, CodexItemFacts>();

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
            void codexApprovalDecision(ctx, msg.method, msg.params, codexItems)
              .then((decision) => send({ jsonrpc: "2.0", id, result: { decision } }))
              .catch(() => send({ jsonrpc: "2.0", id, result: { decision: "decline" } }));
            continue;
          }
          // Codex asks before letting an MCP server run a tool, as a form
          // elicitation rather than one of its approval methods. Ours is the
          // only server here and its tools stop for a human inside `runTool`,
          // so answering yes is not waving anything through — declining, or
          // leaving it unanswered as this once did, just meant the seat could
          // never use the tools we lent it.
          if (msg.method === "mcpServer/elicitation/request") {
            const server = (msg.params as { serverName?: string })?.serverName;
            send({
              jsonrpc: "2.0",
              id,
              result: server === "legion" ? { action: "accept", content: {} } : { action: "decline" },
            });
            continue;
          }
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no interactive client" } });
          continue;
        }

        // Remember what each item is about; an approval for it arrives later
        // carrying nothing but its id.
        if (msg.method === "item/started" || msg.method === "item/updated") {
          const item = msg.params?.item as Record<string, unknown> | undefined;
          const id = typeof item?.id === "string" ? item.id : "";
          const facts = codexItemFacts(item);
          if (id && facts) codexItems.set(id, facts);
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
