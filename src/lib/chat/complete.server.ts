import { PROVIDER_BY_ID, type ProviderId } from "@/lib/providers";
import { localCliFor, resolveCreds, updateAccessToken, type ResolvedCreds } from "./keys.server";
import { isClaudeOAuthToken, refreshCodexTokens } from "./oauth.server";
import {
  completeWithClaudeCli,
  completeWithCodexCli,
  completeWithGrokCli,
  completeWithSimpleCli,
} from "./local-cli.server";
import { MAX_TOOL_CALLS, TOOL_DEFS, runTool, type ToolContext, type ToolDef } from "./tools.server";
import { logEvent } from "@/lib/log.server";
import type { ProviderMessage } from "./xai.server";

export type CompleteOpts = {
  maxTokens: number;
  temperature?: number;
  /** Set false for turns that must answer immediately (the jump-in check). */
  tools?: boolean;
  /**
   * Identifies the turn for tools that need a human decision. Without it,
   * write-capable tools refuse rather than run unattended.
   */
  toolContext?: ToolContext;
};

/** A chat-completions message, including the tool-call shapes. */
type OpenAiToolCall = { id: string; type: "function"; function?: { name?: string; arguments?: string } };
type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

/** Anthropic content blocks, which carry tool use inline with the text. */
type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicBlock[] };

/** Everything `postJson` may hand back, across all four provider shapes. */
type ProviderResponse = {
  choices?: { message?: { content?: string; tool_calls?: OpenAiToolCall[] } }[];
  content?: { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
  error?: { message?: string };
};

export type CompleteResult =
  | { ok: true; text: string; model: string; provider: ProviderId }
  | { ok: false; error: string; missing?: { id: ProviderId; name: string; docsUrl: string } };

export async function completeForProvider(
  userId: string,
  provider: ProviderId,
  messages: ProviderMessage[],
  opts: CompleteOpts,
): Promise<CompleteResult> {
  const creds = await resolveCreds(userId, provider);
  const def = PROVIDER_BY_ID[provider];
  if (!creds) {
    return {
      ok: false,
      error: `Add a ${def.name} key in Settings so this seat can speak.`,
      missing: { id: def.id, name: def.name, docsUrl: def.docsUrl },
    };
  }

  try {
    const text = await dispatch(userId, creds, messages, opts);
    // A local CLI with no model pinned in Settings answers on its own default,
    // which this process never learns the name of.
    const model =
      creds.model || (creds.authKind === "local_cli" ? `${localCliFor(provider) ?? "local"} CLI default` : creds.model);
    return { ok: true, text: text.trim(), model, provider };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const cli = localCliFor(provider);

    // A stored key that the provider now refuses should not silence a seat that
    // has a working CLI sitting right there. This is the common case after a
    // subscription token goes stale: the API path 403s while `codex` / `claude`
    // on the same machine are still signed in.
    if (cli && creds.authKind !== "local_cli" && (isAuthFailure(raw) || /<html|<!doctype/i.test(raw))) {
      logEvent({
        kind: "provider:request",
        actor: provider,
        conversationId: opts.toolContext?.conversationId,
        message: `${def.name} rejected the stored credential; falling back to the local ${cli} CLI`,
      });
      try {
        const text = await dispatch(
          userId,
          { ...creds, authKind: "local_cli", apiKey: "", model: "" },
          messages,
          opts,
        );
        return { ok: true, text: text.trim(), model: `${cli} CLI default`, provider };
      } catch (fallbackErr) {
        return { ok: false, error: friendlyError(fallbackErr, def.name) };
      }
    }

    return { ok: false, error: friendlyError(err, def.name) };
  }
}

async function dispatch(
  userId: string,
  creds: ResolvedCreds,
  messages: ProviderMessage[],
  opts: CompleteOpts,
): Promise<string> {
  const def = PROVIDER_BY_ID[creds.provider];
  if (creds.authKind === "local_cli") {
    // No key anywhere — a CLI on this machine is signed in and answers instead.
    if (creds.provider === "codex") return completeWithCodexCli(messages, creds.model, opts.toolContext);
    if (creds.provider === "xai") return completeWithGrokCli(messages, creds.model, opts.toolContext);
    // pi, hermes and qwen are one-shot CLIs with no permission channel.
    const simple = localCliFor(creds.provider);
    if (simple === "pi" || simple === "hermes" || simple === "qwen") {
      return completeWithSimpleCli(simple, messages, creds.model, opts.toolContext);
    }
    // Claude is the one CLI whose SDK can ask us before each tool, so it gets
    // the write set plus the approval bridge when a context is available.
    return completeWithClaudeCli(messages, creds.model, opts.toolContext);
  }
  if (def.kind === "codex" || (creds.provider === "codex" && creds.authKind === "oauth")) {
    return completeCodex(userId, creds, messages, opts);
  }
  if (def.kind === "anthropic") {
    return completeAnthropic(creds.apiKey, creds.model, messages, opts);
  }
  if (def.kind === "gemini") {
    return completeGemini(creds.apiKey, creds.model, messages, opts);
  }
  return completeOpenAi(def.baseUrl, creds.apiKey, creds.model, messages, opts, creds.provider);
}

/** True when a failure means "this credential is no longer accepted". */
function isAuthFailure(message: string): boolean {
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid.?api.?key|invalid.?x-api-key|token_expired/i.test(message);
}

function friendlyError(err: unknown, name: string): string {
  const raw = err instanceof Error ? err.message : "The seat went quiet.";

  // Providers behind a CDN answer with an HTML error page. Dumping that into
  // the thread is unreadable and buries the status code that matters.
  if (/<html|<!doctype/i.test(raw)) {
    const status = /\b(4\d\d|5\d\d)\b/.exec(raw)?.[1];
    return status
      ? `${name} refused the request (HTTP ${status}). ${
          isAuthFailure(status) ? "That credential looks dead — reconnect it in Settings." : "Try again shortly."
        }`
      : `${name} returned an error page instead of a reply.`;
  }

  if (isAuthFailure(raw)) {
    return `${name} rejected that credential. Update it in Settings.`;
  }
  if (/429|rate.?limit/i.test(raw)) {
    return `${name} rate-limited this turn. Wait a moment and try again.`;
  }
  if (/404|model.?not.?found|does not exist/i.test(raw)) {
    return `${name} could not find that model. Change the model id in Settings.`;
  }
  if (/AbortError|too long|cut off|timed out/i.test(raw)) {
    return `${name} took too long and was cut off.`;
  }
  return raw.length > 220 ? `${raw.slice(0, 200)}…` : raw;
}

async function completeCodex(
  userId: string,
  creds: ResolvedCreds,
  messages: ProviderMessage[],
  opts: CompleteOpts,
): Promise<string> {
  if (creds.authKind !== "oauth" && creds.apiKey.startsWith("sk-")) {
    return completeOpenAi("https://api.openai.com/v1", creds.apiKey, creds.model, messages, opts, "openai");
  }

  const tryOnce = async (access: string, accountId: string | null) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${access}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs",
    };
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
      headers["OpenAI-Account-Id"] = accountId;
    }

    try {
      return await completeOpenAi(
        "https://chatgpt.com/backend-api/codex",
        access,
        creds.model,
        messages,
        opts,
        "codex",
        headers,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!/404|not found|no route/i.test(msg)) throw err;
    }

    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const input = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));
    const data = await postJson(
      "https://chatgpt.com/backend-api/codex/responses",
      { ...headers, "Content-Type": "application/json" },
      {
        model: creds.model,
        instructions: system || undefined,
        input,
        store: false,
        max_output_tokens: opts.maxTokens,
      },
    );
    const text = extractResponsesText(data);
    if (text) return text;
    throw new Error("Codex returned an empty reply.");
  };

  try {
    return await tryOnce(creds.apiKey, creds.accountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/401|unauthorized|token_expired|expired/i.test(msg) || !creds.refreshToken) throw err;
    const next = await refreshCodexTokens(creds.refreshToken);
    await updateAccessToken(userId, "codex", next);
    return tryOnce(next.accessToken, next.accountId ?? creds.accountId);
  }
}

function extractResponsesText(data: {
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
  choices?: { message?: { content?: string } }[];
}): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data.output)) {
    const bits: string[] = [];
    for (const item of data.output) {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" || part.type === "text") bits.push(part.text ?? "");
      }
    }
    if (bits.join("").trim()) return bits.join("");
  }
  if (typeof data.choices?.[0]?.message?.content === "string") return data.choices[0].message.content;
  return "";
}

async function completeOpenAi(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  opts: CompleteOpts,
  provider: ProviderId,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const isGpt5 = (provider === "openai" || provider === "codex") && /gpt-5/i.test(model);
  const headers = { Authorization: `Bearer ${apiKey}`, ...extraHeaders };

  // The running transcript. Tool calls and their results are appended here so
  // the model sees what it asked for on the next pass.
  const thread: OpenAiMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));

  // Not every OpenAI-compatible endpoint accepts `tools` (local runtimes and
  // some gateways 400 on it). Try with, drop them permanently if refused.
  let offerTools = opts.tools !== false;
  const available = await toolsForTurn(opts);

  for (let pass = 0; pass < MAX_TOOL_CALLS; pass += 1) {
    const body: Record<string, unknown> = { model, messages: thread, stream: false };
    if (isGpt5) {
      body.max_completion_tokens = opts.maxTokens;
    } else {
      body.max_tokens = opts.maxTokens;
      if (opts.temperature != null) body.temperature = opts.temperature;
    }
    if (offerTools) {
      body.tools = available.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    let data;
    try {
      data = await postJson(url, headers, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (offerTools && /^4\d\d|tool|function/i.test(msg)) {
        // This endpoint does not do tool calling. Carry on as a plain chat.
        offerTools = false;
        continue;
      }
      throw err;
    }

    const message = data.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!calls.length) {
      const text = message?.content;
      if (typeof text === "string" && text.trim()) return text;
      throw new Error(`${provider} returned an empty reply.`);
    }

    // Echo the assistant's tool_calls back verbatim — the API rejects a
    // tool result whose call it cannot find in the preceding turn.
    thread.push({ role: "assistant", content: message?.content ?? "", tool_calls: calls });
    for (const call of calls) {
      thread.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runTool(call.function?.name ?? "", parseToolArgs(call.function?.arguments), opts.toolContext),
      });
    }
  }

  // Out of passes. Ask for a written answer rather than returning the silence
  // that made seats look hung.
  thread.push({
    role: "user",
    content: `[room] That is ${MAX_TOOL_CALLS} rounds of tool calls. Answer now from what we already have.`,
  });
  const final = await postJson(url, headers, {
    model,
    messages: thread,
    stream: false,
    ...(isGpt5 ? { max_completion_tokens: opts.maxTokens } : { max_tokens: opts.maxTokens }),
  });
  const text = final.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) return text;
  throw new Error(`${provider} kept calling tools without answering.`);
}

/**
 * The tools one turn may offer: the built-ins plus whatever MCP servers this
 * user has enabled. Resolved per turn rather than cached, so enabling a server
 * takes effect on the next message instead of the next restart.
 */
async function toolsForTurn(opts: CompleteOpts): Promise<ToolDef[]> {
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
    // A broken MCP server must not cost the seat its built-in tools.
    return TOOL_DEFS;
  }
}

/** Tool arguments arrive as a JSON string, and models occasionally mangle it. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function completeAnthropic(
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  opts: CompleteOpts,
): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  };
  if (isClaudeOAuthToken(apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["anthropic-beta"] = "oauth-2025-04-20,claude-code-20250219";
  } else {
    headers["x-api-key"] = apiKey;
  }

  const thread: AnthropicMessage[] = rest.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));
  const available = await toolsForTurn(opts);
  const tools = available.length
    ? available.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    : undefined;

  const textOf = (blocks: unknown): string =>
    Array.isArray(blocks)
      ? blocks
          .filter((p): p is { type: string; text: string } => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("")
      : "";

  for (let pass = 0; pass < MAX_TOOL_CALLS; pass += 1) {
    const data = await postJson("https://api.anthropic.com/v1/messages", headers, {
      model,
      max_tokens: opts.maxTokens,
      system: system || undefined,
      messages: thread,
      ...(tools ? { tools } : {}),
    });

    const blocks = (Array.isArray(data.content) ? data.content : []) as AnthropicBlock[];
    const uses = blocks.filter((b): b is Extract<AnthropicBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (!uses.length) {
      const text = textOf(blocks);
      if (text) return text;
      throw new Error("Anthropic returned an empty reply.");
    }

    // Anthropic wants the assistant turn replayed whole, then one user turn
    // carrying a tool_result per tool_use, in the same order.
    thread.push({ role: "assistant", content: blocks });
    const results: AnthropicBlock[] = [];
    for (const use of uses) {
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: await runTool(use.name, use.input ?? {}, opts.toolContext),
      });
    }
    thread.push({ role: "user", content: results });
  }

  thread.push({
    role: "user",
    content: `[room] That is ${MAX_TOOL_CALLS} rounds of tool calls. Answer now from what we already have.`,
  });
  const final = await postJson("https://api.anthropic.com/v1/messages", headers, {
    model,
    max_tokens: opts.maxTokens,
    system: system || undefined,
    messages: thread,
  });
  const text = textOf(final.content);
  if (text) return text;
  throw new Error("Anthropic kept calling tools without answering.");
}

async function completeGemini(
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  opts: CompleteOpts,
): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJson(
    url,
    { "x-goog-api-key": apiKey },
    {
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.7,
      },
    },
  );

  const text = data.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? "")
    .join("");
  if (text) return text;
  const block = data.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked the turn (${block}).`);
  throw new Error("Gemini returned an empty reply.");
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let parsed: ProviderResponse = {};
    try {
      parsed = raw ? (JSON.parse(raw) as typeof parsed) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const detail = parsed.error?.message || raw.slice(0, 240) || res.statusText;
      throw new Error(`${res.status} ${detail}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("The seat took too long and was cut off.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
