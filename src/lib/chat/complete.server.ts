import { PROVIDER_BY_ID, type ProviderId } from "@/lib/providers";
import { localCliFor, resolveCreds, updateAccessToken, type ResolvedCreds } from "./keys.server";
import { isClaudeOAuthToken, refreshCodexTokens } from "./oauth.server";
import { completeWithClaudeCli, completeWithCodexCli } from "./local-cli.server";
import type { ProviderMessage } from "./xai.server";

export type CompleteOpts = {
  maxTokens: number;
  temperature?: number;
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
    return creds.provider === "codex"
      ? completeWithCodexCli(messages, creds.model)
      : completeWithClaudeCli(messages, creds.model);
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

function friendlyError(err: unknown, name: string): string {
  const raw = err instanceof Error ? err.message : "The seat went quiet.";
  if (/401|unauthorized|invalid.?api.?key|invalid.?x-api-key|token_expired/i.test(raw)) {
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
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  if (isGpt5) {
    body.max_completion_tokens = opts.maxTokens;
  } else {
    body.max_tokens = opts.maxTokens;
    if (opts.temperature != null) body.temperature = opts.temperature;
  }

  const data = await postJson(url, {
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  }, body);

  const text = data.choices?.[0]?.message?.content;
  if (typeof text === "string") return text;
  throw new Error(`${provider} returned an empty reply.`);
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

  const data = await postJson("https://api.anthropic.com/v1/messages", headers, {
    model,
    max_tokens: opts.maxTokens,
    system: system || undefined,
    messages: rest,
  });

  const parts = data.content;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((p): p is { type: string; text: string } => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (text) return text;
  }
  throw new Error("Anthropic returned an empty reply.");
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
): Promise<{
  choices?: { message?: { content?: string } }[];
  content?: { type?: string; text?: string }[];
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
  error?: { message?: string };
}> {
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
    let parsed: {
      choices?: { message?: { content?: string } }[];
      content?: { type?: string; text?: string }[];
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
      output_text?: string;
      output?: { content?: { type?: string; text?: string }[] }[];
      error?: { message?: string };
    } = {};
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
