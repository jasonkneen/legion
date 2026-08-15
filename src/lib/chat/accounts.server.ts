/**
 * Which local agent CLIs exist, who they are signed in as, and what they have
 * spent (server-only).
 *
 * Detection is automatic: nothing here asks the user to configure a path or
 * paste a token. If the binary is on the machine and signed in, the seat works.
 * That answers "is my Claude/Codex hooked up?" without a settings dance, and it
 * is the honest place to show subscription and usage, since those belong to the
 * CLI's own login rather than to anything Legion stores.
 *
 * Each CLI reports differently, so each gets its own reader and everything ends
 * up in one shape:
 *   claude → `claude auth status` (JSON)
 *   codex  → app-server `account/read`, `account/rateLimits/read`, `account/usage/read`
 *   grok   → `grok models` (prints the signed-in host)
 */
import { spawn } from "node:child_process";
import { detectLocalCli, type LocalCliId } from "./local-cli.server";

/** One rate-limit window, e.g. "Session" (5h) or "Week" (7d). */
export type UsageWindow = {
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms when the window resets, when the provider says. */
  resetsAt?: number;
};

export type AgentUsage = {
  /** Providers report several windows; Claude has two, Codex one. */
  windows: UsageWindow[];
  /** Lifetime tokens through this CLI, when it keeps count. */
  lifetimeTokens?: number;
  /** Consecutive days used, when the CLI tracks it. */
  streakDays?: number;
};

export type AgentAccount = {
  cli: LocalCliId;
  installed: boolean;
  /** Absolute path to the binary, so the user can see which one is being used. */
  path?: string;
  version?: string;
  signedIn: boolean;
  /** How it authenticates: "claude.ai", "chatgpt", "grok.com", "api key"… */
  authMethod?: string;
  email?: string;
  /** Subscription or plan name, verbatim from the CLI. */
  plan?: string;
  usage?: AgentUsage;
  /** Set when something could not be read, so the UI never invents a status. */
  note?: string;
  checkedAt: number;
};

const CACHE_MS = 30_000;
type Cache = Partial<Record<LocalCliId, AgentAccount>>;
const globalRef = globalThis as typeof globalThis & { __legionAccounts__?: Cache };
function cache(): Cache {
  globalRef.__legionAccounts__ ??= {};
  return globalRef.__legionAccounts__;
}

function run(bin: string, args: string[], timeoutMs = 25_000): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, out, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, timedOut });
    });
  });
}

/** First JSON object in a CLI's output, ignoring any human preamble. */
function firstJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function versionOf(out: string): string | undefined {
  const line = out.trim().split("\n")[0]?.trim();
  return line ? line.replace(/^[a-z-]+\s+/i, "").trim() || line : undefined;
}

/**
 * Claude Code's OAuth access token, from wherever that CLI keeps it.
 *
 * A file on Linux/Windows; the login Keychain on macOS, which is why this may
 * prompt the first time and returns null if the user declines. `CLAUDE_CONFIG_DIR`
 * relocates the directory.
 */
async function claudeAccessToken(): Promise<{ token: string; expiresAt?: number } | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");

  /**
   * Two shapes in the wild. Claude Code 2.1.x writes snake_case
   * `oauth_token` / `oauth_expires_at` to `credentials.json`; older builds (and
   * the macOS Keychain item) use `claudeAiOauth.accessToken`. Accept either
   * rather than pinning to whichever happens to be installed today.
   */
  const parse = (raw: string) => {
    const json = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
      oauth_token?: string;
      oauth_expires_at?: number;
    };
    if (json.claudeAiOauth?.accessToken) {
      return { token: json.claudeAiOauth.accessToken, expiresAt: json.claudeAiOauth.expiresAt };
    }
    if (!json.oauth_token) return null;
    // This field has been seen in both seconds and milliseconds; anything below
    // year-2001 in ms is really a seconds stamp.
    const stamp = json.oauth_expires_at;
    const expiresAt = typeof stamp === "number" ? (stamp < 1_000_000_000_000 ? stamp * 1000 : stamp) : undefined;
    return { token: json.oauth_token, expiresAt };
  };

  for (const name of ["credentials.json", ".credentials.json"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      const found = parse(readFileSync(file, "utf8"));
      if (found) return found;
    } catch {
      // Unreadable or not the shape we know — try the next location.
    }
  }

  if (process.platform !== "darwin") return null;
  const keychain = await run("/usr/bin/security", [
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
    "-w",
  ]);
  if (!keychain.ok) return null;
  try {
    return parse(keychain.out.trim());
  } catch {
    return null;
  }
}

/**
 * Claude's rate-limit windows, from the endpoint its own `/usage` view uses.
 *
 * Deliberately never refreshes an expired token: that token pair belongs to the
 * running CLI, and rotating it here could log the user out of Claude Code. An
 * expired token simply means no usage this time.
 */
async function claudeUsage(): Promise<{ usage: AgentUsage } | { reason: string }> {
  const creds = await claudeAccessToken();
  if (!creds) return { reason: "no OAuth token found for the Claude CLI" };
  if (creds.expiresAt && creds.expiresAt < Date.now() + 30_000) {
    // Refreshing would rotate the token pair the CLI itself owns and can log
    // the user out of Claude Code, so the honest answer is "unknown".
    return { reason: "the Claude CLI's stored token has expired; refreshing it here could sign you out of the CLI" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });
    if (!res.ok) return { reason: `Anthropic usage endpoint returned ${res.status}` };
    const body = (await res.json()) as Record<string, { utilization?: number; resets_at?: string }>;
    const windows: UsageWindow[] = [];
    for (const [key, label] of [
      ["five_hour", "Session"],
      ["seven_day", "Week"],
    ] as const) {
      const w = body[key];
      if (typeof w?.utilization !== "number") continue;
      const resets = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
      windows.push({
        label,
        usedPercent: w.utilization,
        resetsAt: Number.isFinite(resets) ? resets : undefined,
      });
    }
    return windows.length ? { usage: { windows } } : { reason: "the usage endpoint reported no windows" };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : "usage request failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function readClaudeAccount(bin: string): Promise<AgentAccount> {
  const [version, status, usage] = await Promise.all([
    run(bin, ["--version"]),
    run(bin, ["auth", "status"]),
    claudeUsage(),
  ]);
  const json = firstJson(status.out);
  if (!json) {
    return {
      cli: "claude",
      installed: true,
      path: bin,
      version: versionOf(version.out),
      signedIn: false,
      note: "claude auth status did not return JSON",
      checkedAt: Date.now(),
    };
  }
  return {
    cli: "claude",
    installed: true,
    path: bin,
    version: versionOf(version.out),
    signedIn: json.loggedIn === true,
    authMethod: typeof json.authMethod === "string" ? json.authMethod : undefined,
    email: typeof json.email === "string" ? json.email : undefined,
    plan: typeof json.subscriptionType === "string" ? json.subscriptionType : undefined,
    usage: "usage" in usage ? usage.usage : undefined,
    // Say which of several reasons applies; "unknown" must never render as 0%.
    note: "reason" in usage ? `usage unavailable — ${usage.reason}` : undefined,
    checkedAt: Date.now(),
  };
}

/**
 * grok's login, read from `~/.grok/auth.json`.
 *
 * `grok models` does print "You are logged in with …", but it reaches the
 * network and its wording is prose — it reported a signed-in account as signed
 * out under the server while working from a shell. The credential file is the
 * fact; the CLI's sentence is a rendering of it.
 */
async function grokLogin(): Promise<{ email?: string; issuer?: string; expiresAt?: number } | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const file = join(process.env.GROK_HOME?.trim() || join(homedir(), ".grok"), "auth.json");
  if (!existsSync(file)) return null;
  try {
    // Keyed by "<issuer>::<id>", one entry per login.
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
    const entry = Object.entries(json)[0];
    if (!entry) return null;
    const [key, value] = entry;
    const stamp = value.expires_at;
    const expiresAt =
      typeof stamp === "number" ? (stamp < 1_000_000_000_000 ? stamp * 1000 : stamp) : undefined;
    return {
      email: typeof value.email === "string" ? value.email : undefined,
      issuer: typeof value.oidc_issuer === "string" ? value.oidc_issuer : key.split("::")[0],
      expiresAt,
    };
  } catch {
    return null;
  }
}

async function readGrokAccount(bin: string): Promise<AgentAccount> {
  const [version, login] = await Promise.all([run(bin, ["--version"]), grokLogin()]);
  const host = login?.issuer?.replace(/^https?:\/\//, "").replace(/^auth\./, "");
  return {
    cli: "grok",
    installed: true,
    path: bin,
    version: versionOf(version.out),
    signedIn: Boolean(login),
    authMethod: host,
    email: login?.email,
    note: login ? "usage is not reported by the grok CLI" : "run `grok login` to sign in",
    checkedAt: Date.now(),
  };
}

async function readCodexAccount(bin: string): Promise<AgentAccount> {
  const version = await run(bin, ["--version"]);
  const base: AgentAccount = {
    cli: "codex",
    installed: true,
    path: bin,
    version: versionOf(version.out),
    signedIn: false,
    checkedAt: Date.now(),
  };

  try {
    const { codexRequests } = await import("./codex-rpc.server");
    const answers = await codexRequests([
      { method: "account/read", params: {} },
      { method: "account/rateLimits/read", params: {} },
      { method: "account/usage/read", params: {} },
    ]);

    const account = (answers["account/read"] as { account?: Record<string, unknown> } | undefined)?.account;
    const limits = (answers["account/rateLimits/read"] as { rateLimits?: Record<string, unknown> } | undefined)
      ?.rateLimits;
    const primary = limits?.primary as { usedPercent?: number; resetsAt?: number; windowDurationMins?: number } | undefined;
    const summary = (answers["account/usage/read"] as { summary?: Record<string, unknown> } | undefined)?.summary;

    return {
      ...base,
      signedIn: Boolean(account),
      authMethod: typeof account?.type === "string" ? account.type : undefined,
      email: typeof account?.email === "string" ? account.email : undefined,
      plan: typeof account?.planType === "string" ? account.planType : undefined,
      usage: {
        windows:
          typeof primary?.usedPercent === "number"
            ? [
                {
                  // Codex reports the window length, so name it the way its own
                  // /status does rather than inventing a label.
                  label: primary.windowDurationMins === 10080 ? "Week" : `${Math.round((primary.windowDurationMins ?? 0) / 60)}h`,
                  usedPercent: primary.usedPercent,
                  // The protocol reports seconds; the UI works in milliseconds.
                  resetsAt: typeof primary.resetsAt === "number" ? primary.resetsAt * 1000 : undefined,
                },
              ]
            : [],
        lifetimeTokens: typeof summary?.lifetimeTokens === "number" ? summary.lifetimeTokens : undefined,
        streakDays: typeof summary?.currentStreakDays === "number" ? summary.currentStreakDays : undefined,
      },
    };
  } catch (err) {
    return { ...base, note: err instanceof Error ? err.message : "codex app-server did not answer" };
  }
}

/** One CLI's account, cached briefly (each read spawns a process). */
export async function agentAccount(cli: LocalCliId, force = false): Promise<AgentAccount> {
  const hit = cache()[cli];
  if (!force && hit && Date.now() - hit.checkedAt < CACHE_MS) return hit;

  const bin = detectLocalCli(cli);
  if (!bin) {
    const missing: AgentAccount = { cli, installed: false, signedIn: false, checkedAt: Date.now() };
    cache()[cli] = missing;
    return missing;
  }

  const result =
    cli === "claude" ? await readClaudeAccount(bin) : cli === "grok" ? await readGrokAccount(bin) : await readCodexAccount(bin);
  cache()[cli] = result;
  return result;
}

/** Every local agent, in a stable order, read in parallel. */
export async function allAgentAccounts(force = false): Promise<AgentAccount[]> {
  const ids: LocalCliId[] = ["claude", "codex", "grok"];
  return Promise.all(ids.map((id) => agentAccount(id, force)));
}
