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
import { MAX_TOOL_CALLS, toolsRoot } from "./tools.server";
import type { ProviderMessage } from "./xai.server";

export type LocalCliId = "claude" | "codex";

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
};

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
export async function completeWithClaudeCli(
  messages: ProviderMessage[],
  model: string,
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
        tools: CLAUDE_READONLY_TOOLS,
        allowedTools: CLAUDE_READONLY_TOOLS,
        settingSources: [],
        cwd: toolsRoot(),
        maxTurns: MAX_TOOL_CALLS,
        abortController: abort,
      },
    });

    for await (const message of run) {
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

        // A request FROM the server (an approval, an elicitation). Nothing here
        // can answer one, and the sandbox settings should prevent them, so
        // refuse rather than hang the turn.
        if (msg.id != null && msg.method) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no interactive client" } });
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
          sandbox: "read-only",
          approvalPolicy: "never",
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
