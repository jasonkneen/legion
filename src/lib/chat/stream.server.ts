/**
 * Streaming turns (server-only).
 *
 * A reply that takes twenty seconds and then lands in one lump reads as a hang.
 * This runs the same turn as `complete.server`, but emits events as they
 * happen: text deltas, and a status line whenever a tool runs so the wait is
 * legible rather than blank.
 *
 * Not every seat can stream. The CLI seats hand back a finished answer, so they
 * emit status events and then the whole text — still better than silence,
 * because the human sees which agent is working and what it is doing.
 */
import { PROVIDER_BY_ID, type ProviderId } from "@/lib/providers";
import { localCliFor, resolveCreds } from "./keys.server";
import { MAX_TOOL_CALLS, TOOL_DEFS, runTool, type ToolContext, type ToolDef } from "./tools.server";
import { logEvent } from "@/lib/log.server";
import type { ProviderMessage } from "./xai.server";

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; model: string }
  | { type: "error"; error: string };

export type StreamOpts = {
  maxTokens: number;
  temperature?: number;
  tools?: boolean;
  toolContext?: ToolContext;
  /**
   * Aborts the turn. Passed down to the provider request itself, so stopping
   * actually cancels generation rather than just hanging up on a stream the
   * provider keeps producing (and billing for).
   */
  signal?: AbortSignal;
};

/** Tools for this turn: built-ins plus the user's MCP servers. */
async function toolsForTurn(opts: StreamOpts): Promise<ToolDef[]> {
  if (opts.tools === false) return [];
  const userId = opts.toolContext?.userId;
  if (!userId) return TOOL_DEFS;
  try {
    const { mcpToolsFor } = await import("./mcp.server");
    const { tools } = await mcpToolsFor(userId);
    return [
      ...TOOL_DEFS,
      ...tools.map((t) => ({
        name: t.qualifiedName,
        description: t.description,
        risk: t.readOnly ? ("read" as const) : ("write" as const),
        parameters: t.parameters,
      })),
    ];
  } catch {
    return TOOL_DEFS;
  }
}

/** Human-readable line for "what is the seat doing right now". */
function toolStatus(name: string, args: Record<string, unknown>): string {
  if (name === "read_file") return `reading ${String(args.path ?? "a file")}`;
  if (name === "list_files") return `listing ${String(args.path ?? "the workspace")}`;
  if (name === "search_files") return `searching for ${String(args.pattern ?? "")}`;
  if (name === "git_history") return "reading recent commits";
  if (name === "git_changes") return "checking workspace changes";
  if (name === "write_file") return `writing ${String(args.path ?? "a file")}`;
  if (name === "run_command") return `running ${String(args.command ?? "").slice(0, 60)}`;
  if (name === "ask_seat") return `asking @${String(args.handle ?? "another seat")}`;
  if (name === "ask_human") return "waiting on your answer";
  if (name === "todo_write") return "updating the plan";
  if (name.startsWith("mcp__")) return `calling ${name.split("__").slice(2).join("__")}`;
  return `running ${name}`;
}

type OpenAiToolCall = { id: string; type: "function"; function?: { name?: string; arguments?: string } };
type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

/** Read an SSE body line by line, yielding parsed `data:` payloads. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    for (; newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // A partial frame; the next chunk completes it.
      }
    }
  }
}

/**
 * OpenAI-compatible streaming with the tool loop intact.
 *
 * Deltas are forwarded as they arrive. When the model calls tools instead, the
 * accumulated call is executed, a status line is emitted, and the loop asks
 * again — so a turn that inspects three files shows three status lines and then
 * streams the answer.
 */
async function* streamOpenAi(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  opts: StreamOpts,
  provider: ProviderId,
  extraHeaders?: Record<string, string>,
): AsyncGenerator<TurnEvent> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const isGpt5 = (provider === "openai" || provider === "codex") && /gpt-5/i.test(model);
  const available = await toolsForTurn(opts);
  const thread: OpenAiMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  // Text said before a tool call belongs to the same reply as text said after
  // it. Accumulating per pass would silently drop everything before the last
  // tool, which is exactly what the persisted message is built from.
  let full = "";

  for (let pass = 0; pass < MAX_TOOL_CALLS; pass += 1) {
    const body: Record<string, unknown> = { model, messages: thread, stream: true };
    if (isGpt5) body.max_completion_tokens = opts.maxTokens;
    else {
      body.max_tokens = opts.maxTokens;
      if (opts.temperature != null) body.temperature = opts.temperature;
    }
    if (available.length) {
      body.tools = available.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${detail.slice(0, 240)}`);
    }

    let text = "";
    // Tool calls arrive in fragments keyed by index; assemble them as we go.
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const frame of sseLines(res.body)) {
      const choice = (frame.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0];
      const delta = choice?.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        full += delta.content;
        yield { type: "delta", text: delta.content };
      }

      for (const part of (delta.tool_calls ?? []) as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[]) {
        const index = part.index ?? 0;
        const current = calls.get(index) ?? { id: "", name: "", args: "" };
        calls.set(index, {
          id: part.id || current.id,
          name: part.function?.name || current.name,
          args: current.args + (part.function?.arguments ?? ""),
        });
      }
    }

    if (calls.size === 0) {
      yield { type: "done", text: full, model };
      return;
    }

    const assembled = [...calls.values()];
    thread.push({
      role: "assistant",
      content: text,
      tool_calls: assembled.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const call of assembled) {
      let args: Record<string, unknown> = {};
      try {
        args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      yield { type: "status", text: toolStatus(call.name, args) };
      const output = await runTool(call.name, args, opts.toolContext);
      thread.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }

  yield { type: "error", error: "The seat kept calling tools without answering." };
}

/** Anthropic streaming. Tool use ends the stream, runs, and the loop continues. */
async function* streamAnthropic(
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  opts: StreamOpts,
): AsyncGenerator<TurnEvent> {
  const { isClaudeOAuthToken } = await import("./oauth.server");
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const available = await toolsForTurn(opts);

  type Block = { type: string; [k: string]: unknown };
  const thread: { role: "user" | "assistant"; content: string | Block[] }[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));

  const headers: Record<string, string> = { "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
  if (isClaudeOAuthToken(apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["anthropic-beta"] = "oauth-2025-04-20,claude-code-20250219";
  } else {
    headers["x-api-key"] = apiKey;
  }

  let full = "";
  for (let pass = 0; pass < MAX_TOOL_CALLS; pass += 1) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      signal: opts.signal,
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens,
        system: system || undefined,
        messages: thread,
        stream: true,
        ...(available.length
          ? { tools: available.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
          : {}),
      }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${detail.slice(0, 240)}`);
    }

    let text = "";
    const blocks: Block[] = [];
    let toolJson = "";
    let current: Block | null = null;

    for await (const frame of sseLines(res.body)) {
      const kind = frame.type as string;
      if (kind === "content_block_start") {
        current = { ...((frame.content_block as Block) ?? { type: "text" }) };
        toolJson = "";
      } else if (kind === "content_block_delta") {
        const delta = frame.delta as { type?: string; text?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) {
          text += delta.text;
          full += delta.text;
          yield { type: "delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          toolJson += delta.partial_json ?? "";
        }
      } else if (kind === "content_block_stop" && current) {
        if (current.type === "tool_use") {
          try {
            current.input = toolJson ? (JSON.parse(toolJson) as Record<string, unknown>) : {};
          } catch {
            current.input = {};
          }
        }
        blocks.push(current);
        current = null;
      }
    }

    const uses = blocks.filter((b) => b.type === "tool_use");
    if (!uses.length) {
      yield { type: "done", text: full, model };
      return;
    }

    thread.push({ role: "assistant", content: blocks });
    const results: Block[] = [];
    for (const use of uses) {
      const args = (use.input ?? {}) as Record<string, unknown>;
      yield { type: "status", text: toolStatus(String(use.name), args) };
      results.push({
        type: "tool_result",
        tool_use_id: String(use.id),
        content: await runTool(String(use.name), args, opts.toolContext),
      });
    }
    thread.push({ role: "user", content: results });
  }

  yield { type: "error", error: "The seat kept calling tools without answering." };
}

/**
 * Stream one turn for any provider.
 *
 * Falls back to the non-streaming path for seats that cannot stream (the local
 * CLIs, Gemini, the Codex backend), emitting the finished text as a single
 * delta so the client has one code path.
 */
export async function* streamTurn(
  userId: string,
  provider: ProviderId,
  messages: ProviderMessage[],
  opts: StreamOpts,
): AsyncGenerator<TurnEvent> {
  const creds = await resolveCreds(userId, provider);
  const def = PROVIDER_BY_ID[provider];
  if (!creds) {
    yield { type: "error", error: `Add a ${def.name} key in Settings so this seat can speak.` };
    return;
  }

  const started = Date.now();
  logEvent({
    kind: "turn:start",
    actor: opts.toolContext?.actor ?? provider,
    conversationId: opts.toolContext?.conversationId,
    message: `streaming turn via ${provider}`,
  });

  try {
    const canStream =
      creds.authKind !== "local_cli" && def.kind !== "gemini" && !(def.kind === "codex" && creds.authKind === "oauth");

    if (canStream && def.kind === "anthropic") {
      yield* streamAnthropic(creds.apiKey, creds.model, messages, opts);
    } else if (canStream) {
      yield* streamOpenAi(def.baseUrl, creds.apiKey, creds.model, messages, opts, provider);
    } else {
      // No token stream available: say who is working, then hand over the text.
      const cli = localCliFor(provider);
      yield { type: "status", text: cli ? `${cli} is working` : "working" };
      const { completeForProvider } = await import("./complete.server");
      const result = await completeForProvider(userId, provider, messages, opts);
      if (!result.ok) yield { type: "error", error: result.error };
      else {
        yield { type: "delta", text: result.text };
        yield { type: "done", text: result.text, model: result.model };
      }
    }
  } catch (err) {
    const aborted = opts.signal?.aborted || (err instanceof Error && err.name === "AbortError");
    if (!aborted) {
      yield { type: "error", error: err instanceof Error ? err.message : "The seat went quiet." };
    }
  } finally {
    logEvent({
      kind: "turn:end",
      actor: opts.toolContext?.actor ?? provider,
      conversationId: opts.toolContext?.conversationId,
      message: "streaming turn finished",
      durationMs: Date.now() - started,
    });
  }
}
