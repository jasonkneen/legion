import { getSql } from "@/lib/db";
import {
  PROVIDERS,
  PROVIDER_BY_ID,
  isProviderId,
  keyHint,
  type ProviderId,
  type ProviderStatus,
} from "@/lib/providers";
import { isClaudeOAuthToken, type CodexTokens } from "./oauth.server";

export type ResolvedCreds = {
  provider: ProviderId;
  apiKey: string;
  model: string;
  fromEnv: boolean;
  authKind: "api_key" | "oauth";
  refreshToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
};

let tableReady: Promise<void> | null = null;

async function ensureTable() {
  tableReady ??= (async () => {
    const sql = await getSql();
    await sql.query(`
      create table if not exists provider_keys (
        user_id text not null,
        provider text not null,
        api_key text not null,
        model text not null default '',
        updated_at timestamptz not null default now(),
        primary key (user_id, provider)
      )
    `);
    await sql.query(`alter table provider_keys add column if not exists auth_kind text not null default 'api_key'`);
    await sql.query(`alter table provider_keys add column if not exists refresh_token text`);
    await sql.query(`alter table provider_keys add column if not exists account_id text`);
    await sql.query(`alter table provider_keys add column if not exists expires_at timestamptz`);
    await sql.query(`alter table provider_keys add column if not exists extra_json text not null default '{}'`);
  })().catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
}

function envKey(name?: string): string | undefined {
  if (!name) return undefined;
  const value = process.env[name]?.trim();
  return value || undefined;
}

export async function listStatuses(userId: string): Promise<ProviderStatus[]> {
  const stored = await loadStored(userId);
  return PROVIDERS.map((p) => {
    const row = stored.get(p.id);
    const fallback = envKey(p.envVar);
    const configured = Boolean(row?.apiKey || fallback || p.id === "ollama");
    return {
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      docsUrl: p.docsUrl,
      docsLabel: p.docsLabel,
      placeholder: p.placeholder,
      defaultModel: p.defaultModel,
      model: row?.model || p.defaultModel,
      configured,
      hint: row?.apiKey
        ? row.authKind === "oauth"
          ? `OAuth ${keyHint(row.apiKey)}`
          : keyHint(row.apiKey)
        : fallback
          ? "workspace key"
          : p.id === "ollama"
            ? "local, no key"
            : null,
      fromEnv: !row?.apiKey && Boolean(fallback),
      auth: p.auth,
      authKind: row?.authKind ?? null,
      accountId: row?.accountId ?? null,
      featured: Boolean(p.featured),
    };
  });
}

export async function resolveCreds(userId: string, provider: ProviderId): Promise<ResolvedCreds | null> {
  const def = PROVIDER_BY_ID[provider];
  const stored = await loadStored(userId);
  const row = stored.get(provider);
  const fallback = envKey(def.envVar);
  const apiKey = row?.apiKey || fallback || (provider === "ollama" ? "ollama" : "");
  if (!apiKey) return null;
  return {
    provider,
    apiKey,
    model: (row?.model || def.defaultModel).trim() || def.defaultModel,
    fromEnv: !row?.apiKey && Boolean(fallback),
    authKind: row?.authKind ?? (fallback ? "api_key" : "api_key"),
    refreshToken: row?.refreshToken ?? null,
    accountId: row?.accountId ?? null,
    expiresAt: row?.expiresAt ?? null,
  };
}

export async function saveKey(
  userId: string,
  provider: ProviderId,
  input: { apiKey?: string; model?: string },
): Promise<ProviderStatus> {
  if (!isProviderId(provider)) throw new Error("Unknown provider");
  await ensureTable();
  const sql = await getSql();
  const existing = (await loadStored(userId)).get(provider);
  const nextKey = sanitizeIncomingKey(input.apiKey, existing?.apiKey);
  const nextModel = (input.model ?? existing?.model ?? "").trim();
  const authKind = nextKey && isClaudeOAuthToken(nextKey) ? "oauth" : existing?.authKind ?? "api_key";

  if (!nextKey && provider !== "ollama") {
    await sql`
      delete from provider_keys
      where user_id = ${userId} and provider = ${provider}
    `;
  } else {
    await sql`
      insert into provider_keys (user_id, provider, api_key, model, auth_kind, updated_at)
      values (${userId}, ${provider}, ${nextKey || "local"}, ${nextModel}, ${authKind}, now())
      on conflict (user_id, provider)
      do update set
        api_key = excluded.api_key,
        model = excluded.model,
        auth_kind = excluded.auth_kind,
        updated_at = now()
    `;
  }

  const statuses = await listStatuses(userId);
  return statuses.find((s) => s.id === provider)!;
}

export async function saveOAuthTokens(
  userId: string,
  provider: ProviderId,
  tokens: CodexTokens,
  model?: string,
): Promise<ProviderStatus> {
  await ensureTable();
  const sql = await getSql();
  const existing = (await loadStored(userId)).get(provider);
  const nextModel = (model ?? existing?.model ?? PROVIDER_BY_ID[provider].defaultModel).trim();
  const expires = tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null;
  await sql`
    insert into provider_keys
      (user_id, provider, api_key, model, auth_kind, refresh_token, account_id, expires_at, updated_at)
    values
      (${userId}, ${provider}, ${tokens.accessToken}, ${nextModel}, 'oauth', ${tokens.refreshToken},
       ${tokens.accountId}, ${expires}, now())
    on conflict (user_id, provider)
    do update set
      api_key = excluded.api_key,
      model = excluded.model,
      auth_kind = 'oauth',
      refresh_token = excluded.refresh_token,
      account_id = excluded.account_id,
      expires_at = excluded.expires_at,
      updated_at = now()
  `;
  const statuses = await listStatuses(userId);
  return statuses.find((s) => s.id === provider)!;
}

export async function updateAccessToken(
  userId: string,
  provider: ProviderId,
  tokens: CodexTokens,
): Promise<void> {
  await ensureTable();
  const sql = await getSql();
  const expires = tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null;
  await sql`
    update provider_keys
    set api_key = ${tokens.accessToken},
        refresh_token = coalesce(${tokens.refreshToken}, refresh_token),
        account_id = coalesce(${tokens.accountId}, account_id),
        expires_at = ${expires},
        updated_at = now()
    where user_id = ${userId} and provider = ${provider}
  `;
}

export async function clearKey(userId: string, provider: ProviderId): Promise<ProviderStatus> {
  await ensureTable();
  const sql = await getSql();
  await sql`
    delete from provider_keys
    where user_id = ${userId} and provider = ${provider}
  `;
  const statuses = await listStatuses(userId);
  return statuses.find((s) => s.id === provider)!;
}

function sanitizeIncomingKey(incoming: string | undefined, existing?: string): string {
  const value = (incoming ?? "").trim();
  if (!value) return existing ?? "";
  if (value.startsWith("•") || value === "workspace key" || value === "local") return existing ?? "";
  return value;
}

type Stored = {
  apiKey: string;
  model: string;
  authKind: "api_key" | "oauth";
  refreshToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
};

async function loadStored(userId: string): Promise<Map<ProviderId, Stored>> {
  await ensureTable();
  const sql = await getSql();
  const rows = await sql<{
    provider: string;
    api_key: string;
    model: string;
    auth_kind: string | null;
    refresh_token: string | null;
    account_id: string | null;
    expires_at: string | null;
  }>`
    select provider, api_key, model, auth_kind, refresh_token, account_id,
           expires_at::text as expires_at
    from provider_keys
    where user_id = ${userId}
  `;
  const map = new Map<ProviderId, Stored>();
  for (const row of rows) {
    if (!isProviderId(row.provider)) continue;
    if (!row.api_key) continue;
    map.set(row.provider, {
      apiKey: row.api_key,
      model: row.model ?? "",
      authKind: row.auth_kind === "oauth" ? "oauth" : "api_key",
      refreshToken: row.refresh_token,
      accountId: row.account_id,
      expiresAt: row.expires_at ? Date.parse(row.expires_at) : null,
    });
  }
  return map;
}
