import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { isProviderId, type ProviderId, type ProviderStatus } from "@/lib/providers";

export const listProviderStatuses = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ProviderStatus[]> => {
    const { listStatuses } = await import("./keys.server");
    return listStatuses(context.userId);
  });

export const saveProviderKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { provider: string; apiKey?: string; model?: string }) => input)
  .handler(async ({ context, data }): Promise<ProviderStatus> => {
    if (!isProviderId(data.provider)) throw new Error("Unknown provider");
    const { saveKey } = await import("./keys.server");
    return saveKey(context.userId, data.provider as ProviderId, {
      apiKey: data.apiKey,
      model: data.model,
    });
  });

export const clearProviderKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { provider: string }) => input)
  .handler(async ({ context, data }): Promise<ProviderStatus> => {
    if (!isProviderId(data.provider)) throw new Error("Unknown provider");
    const { clearKey } = await import("./keys.server");
    return clearKey(context.userId, data.provider as ProviderId);
  });

export const startCodexLogin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const oauth = await import("./oauth.server");
    const start = await oauth.startCodexDevice();
    oauth.rememberCodexDevice(context.userId, start);
    return {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
      interval: start.interval,
      expiresAt: start.expiresAt,
    };
  });

export const pollCodexLogin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(
    async ({
      context,
    }): Promise<
      | { status: "pending"; interval: number }
      | { status: "expired" }
      | { status: "ready"; provider: ProviderStatus }
    > => {
      const oauth = await import("./oauth.server");
      const result = await oauth.pollCodexDevice(context.userId);
      if (result.status !== "ready") return result;
      const { saveOAuthTokens } = await import("./keys.server");
      const status = await saveOAuthTokens(context.userId, "codex", result.tokens);
      return { status: "ready", provider: status };
    },
  );

export const saveCodexPaste = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { raw: string; accountId?: string; model?: string }) => input)
  .handler(async ({ context, data }) => {
    const oauth = await import("./oauth.server");
    const tokens = oauth.parsePastedCodexAuth(data.raw);
    if (data.accountId?.trim()) tokens.accountId = data.accountId.trim();
    const { saveOAuthTokens } = await import("./keys.server");
    return saveOAuthTokens(context.userId, "codex", tokens, data.model);
  });

export const saveClaudeAgentToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { token: string; model?: string }) => input)
  .handler(async ({ context, data }) => {
    const token = data.token.trim();
    if (!token) throw new Error("Paste a Claude setup-token or API key");
    const { saveOAuthTokens, saveKey } = await import("./keys.server");
    const { isClaudeOAuthToken } = await import("./oauth.server");
    if (isClaudeOAuthToken(token)) {
      return saveOAuthTokens(
        context.userId,
        "anthropic",
        { accessToken: token, refreshToken: null, accountId: null, expiresAt: null },
        data.model,
      );
    }
    return saveKey(context.userId, "anthropic", { apiKey: token, model: data.model });
  });
