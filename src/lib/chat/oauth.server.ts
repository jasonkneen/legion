import { randomBytes } from "node:crypto";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_URL = "https://auth.openai.com/oauth/device/code";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_ALT_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";

export type CodexDeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  interval: number;
  expiresAt: number;
};

export type CodexTokens = {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
};

type PendingMap = Map<string, CodexDeviceStart>;
const globalRef = globalThis as typeof globalThis & { __lumenCodexPending__?: PendingMap };
function pending(): PendingMap {
  globalRef.__lumenCodexPending__ ??= new Map();
  return globalRef.__lumenCodexPending__;
}

export async function startCodexDevice(): Promise<CodexDeviceStart> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    scope: "openid profile email offline_access",
  });

  let res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  if (!res.ok) {
    res = await fetch(DEVICE_ALT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
  }

  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(asString(data.error_description) || asString(data.error) || `Codex login failed (${res.status})`);
  }

  const deviceCode = asString(data.device_code) || asString(data.deviceCode);
  const userCode = asString(data.user_code) || asString(data.userCode) || asString(data.code);
  const verificationUri =
    asString(data.verification_uri) ||
    asString(data.verificationUri) ||
    asString(data.verification_url) ||
    "https://auth.openai.com/codex/device";
  const verificationUriComplete =
    asString(data.verification_uri_complete) || asString(data.verificationUriComplete) || null;
  if (!deviceCode || !userCode) {
    throw new Error("Codex did not return a device code. Paste an access token instead.");
  }

  const interval = Number(data.interval ?? 5) || 5;
  const expiresIn = Number(data.expires_in ?? 900) || 900;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    interval,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function rememberCodexDevice(userId: string, start: CodexDeviceStart) {
  pending().set(userId, start);
}

export function forgetCodexDevice(userId: string) {
  pending().delete(userId);
}

export function getCodexDevice(userId: string): CodexDeviceStart | null {
  const row = pending().get(userId);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    pending().delete(userId);
    return null;
  }
  return row;
}

export async function pollCodexDevice(userId: string): Promise<
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "ready"; tokens: CodexTokens }
> {
  const row = getCodexDevice(userId);
  if (!row) return { status: "expired" };

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: row.deviceCode,
    client_id: CODEX_CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }

  const err = asString(data.error);
  if (err === "authorization_pending" || err === "slow_down" || res.status === 428) {
    return { status: "pending", interval: row.interval };
  }
  if (err === "expired_token" || err === "access_denied") {
    forgetCodexDevice(userId);
    return { status: "expired" };
  }
  if (!res.ok) {
    throw new Error(asString(data.error_description) || err || `Codex token exchange failed (${res.status})`);
  }

  const tokens = parseTokenResponse(data);
  forgetCodexDevice(userId);
  return { status: "ready", tokens };
}

export async function refreshCodexTokens(refreshToken: string): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(asString(data.error_description) || asString(data.error) || `Codex refresh failed (${res.status})`);
  }
  const tokens = parseTokenResponse(data);
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

export function parsePastedCodexAuth(raw: string): CodexTokens {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const tokens = data.tokens && typeof data.tokens === "object" ? (data.tokens as Record<string, unknown>) : data;
    const access =
      asString(tokens.access_token) ||
      asString(tokens.accessToken) ||
      asString(data.access_token) ||
      asString(data.accessToken);
    if (!access) throw new Error("That JSON has no access_token.");
    return {
      accessToken: access,
      refreshToken:
        asString(tokens.refresh_token) || asString(tokens.refreshToken) || asString(data.refresh_token) || null,
      accountId:
        asString(tokens.account_id) ||
        asString(tokens.accountId) ||
        asString(data.account_id) ||
        asString(data.accountId) ||
        null,
      expiresAt: null,
    };
  }
  return {
    accessToken: trimmed,
    refreshToken: null,
    accountId: null,
    expiresAt: null,
  };
}

export function isClaudeOAuthToken(token: string): boolean {
  return token.startsWith("sk-ant-oat") || token.startsWith("sk-ant-ort");
}

export function newState(): string {
  return randomBytes(16).toString("hex");
}

function parseTokenResponse(data: Record<string, unknown>): CodexTokens {
  const access = asString(data.access_token) || asString(data.accessToken);
  if (!access) throw new Error("Codex returned no access token.");
  const expiresIn = Number(data.expires_in ?? 0);
  return {
    accessToken: access,
    refreshToken: asString(data.refresh_token) || asString(data.refreshToken) || null,
    accountId: asString(data.account_id) || asString(data.accountId) || nestedAccountId(data),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  };
}

function nestedAccountId(data: Record<string, unknown>): string | null {
  const auth = data["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const rec = auth as Record<string, unknown>;
    return asString(rec.chatgpt_account_id) || asString(rec.account_id) || null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
