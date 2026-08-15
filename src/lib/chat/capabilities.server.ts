/**
 * What each local agent can actually do (server-only).
 *
 * Every CLI already knows its own skills, plugins and MCP servers; none of them
 * agree on how to say so. This module asks each one in its own language and
 * returns one shape, so the UI can show "what this seat brings to the room"
 * without caring which binary answered.
 *
 * Everything here shells out, so results are cached: a settings page render
 * must not spawn six processes, and this inventory changes when the user
 * installs something, not between two clicks.
 */
import { spawn } from "node:child_process";
import { detectLocalCli, type LocalCliId } from "./local-cli.server";
import { logEvent } from "@/lib/log.server";

export type CapabilityKind = "skill" | "plugin" | "mcp" | "model" | "hook";

export type Capability = {
  kind: CapabilityKind;
  name: string;
  /** Where it came from (plugin name, scope, config file) when known. */
  source?: string;
  /** Free-text status: "connected", "disabled", "needs authentication"… */
  status?: string;
  /** True when the agent will actually use it right now. */
  enabled: boolean;
};

export type AgentCapabilities = {
  cli: LocalCliId;
  installed: boolean;
  /** Populated only for the sections that CLI can report. */
  capabilities: Capability[];
  /** Sections we could not read, with the reason — better than pretending zero. */
  unavailable: { kind: CapabilityKind; reason: string }[];
  checkedAt: number;
};

const CACHE_MS = 60_000;
type Cache = Partial<Record<LocalCliId, AgentCapabilities>>;
const globalRef = globalThis as typeof globalThis & { __legionCaps__?: Cache };
function cache(): Cache {
  globalRef.__legionCaps__ ??= {};
  return globalRef.__legionCaps__;
}

/** Run a CLI and capture stdout. Never throws — a missing feature is data. */
function run(bin: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString();
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });
}

/** Strip ANSI colour and box-drawing noise the CLIs use for humans. */
function clean(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex -- stripping ANSI colour is the point
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^[\s│├└─┌┐┘|>❯*•]+/, "")
    .trim();
}

/**
 * `grok inspect` prints indented sections ("Skills (511)", "MCP", …). Parse the
 * section headers rather than guessing at line shapes, so a new section added
 * upstream is ignored instead of misread.
 */
function parseGrokInspect(text: string): Capability[] {
  const caps: Capability[] = [];
  let section: CapabilityKind | null = null;
  for (const rawLine of text.split("\n")) {
    const line = clean(rawLine);
    if (!line) continue;
    const header = /^(Skills|Plugins|MCP Servers|Hooks|Agents)\s*\((\d+)\)/i.exec(line);
    if (header) {
      const label = header[1].toLowerCase();
      section = label.startsWith("skill")
        ? "skill"
        : label.startsWith("plugin")
          ? "plugin"
          : label.startsWith("mcp")
            ? "mcp"
            : label.startsWith("hook")
              ? "hook"
              : null;
      continue;
    }
    // A new unindented heading ends the current section.
    if (/^[A-Z][A-Za-z ]+$/.test(line) && !rawLine.startsWith("  └")) {
      section = null;
      continue;
    }
    if (!section) continue;
    // "name        scope" or "name   plugin: foo"
    const [name, ...rest] = line.split(/\s{2,}/);
    if (!name) continue;
    caps.push({ kind: section, name, source: rest.join(" ").trim() || undefined, enabled: true });
  }
  return caps;
}

/** `claude mcp list`: "name: command - ✔ Connected". */
function parseClaudeMcp(text: string): Capability[] {
  const caps: Capability[] = [];
  for (const rawLine of text.split("\n")) {
    const line = clean(rawLine);
    const m = /^([\w:.-]+):\s+(.*?)\s+-\s+(.*)$/.exec(line);
    if (!m) continue;
    const status = m[3].replace(/[✔✘!]/g, "").trim();
    caps.push({
      kind: "mcp",
      name: m[1],
      source: m[2],
      status,
      enabled: /connected/i.test(status),
    });
  }
  return caps;
}

/** `claude plugin list`: blocks of "name@marketplace" then indented fields. */
function parseClaudePlugins(text: string): Capability[] {
  const caps: Capability[] = [];
  let current: Capability | null = null;
  for (const rawLine of text.split("\n")) {
    const line = clean(rawLine);
    if (!line) continue;
    const head = /^([\w.-]+)@([\w.-]+)$/.exec(line);
    if (head) {
      current = { kind: "plugin", name: head[1], source: head[2], enabled: true };
      caps.push(current);
      continue;
    }
    if (!current) continue;
    const status = /^Status:\s*(.+)$/i.exec(line);
    if (status) {
      current.status = status[1].replace(/[✔✘]/g, "").trim();
      current.enabled = !/disabled/i.test(current.status);
    }
  }
  return caps;
}

/** `grok mcp list` / `grok plugin list`: one per line, name first. */
function parseGrokList(text: string, kind: CapabilityKind): Capability[] {
  const caps: Capability[] = [];
  for (const rawLine of text.split("\n")) {
    const line = clean(rawLine);
    if (!line || /^(no |usage|error)/i.test(line)) continue;
    const [name, ...rest] = line.split(/\s{2,}|\s-\s/);
    if (!name || name.length > 80) continue;
    const detail = rest.join(" ").trim();
    caps.push({
      kind,
      name: name.replace(/:$/, ""),
      source: detail || undefined,
      status: detail || undefined,
      enabled: !/disabled/i.test(detail),
    });
  }
  return caps;
}

async function readGrok(bin: string): Promise<AgentCapabilities> {
  const unavailable: AgentCapabilities["unavailable"] = [];
  const caps: Capability[] = [];

  const inspect = await run(bin, ["inspect"]);
  if (inspect.ok) caps.push(...parseGrokInspect(inspect.out));
  else unavailable.push({ kind: "skill", reason: "grok inspect failed" });

  const mcp = await run(bin, ["mcp", "list"]);
  if (mcp.ok) caps.push(...parseGrokList(mcp.out, "mcp"));
  else unavailable.push({ kind: "mcp", reason: "grok mcp list failed" });

  const plugins = await run(bin, ["plugin", "list"]);
  if (plugins.ok) caps.push(...parseGrokList(plugins.out, "plugin"));
  else unavailable.push({ kind: "plugin", reason: "grok plugin list failed" });

  return { cli: "grok", installed: true, capabilities: caps, unavailable, checkedAt: Date.now() };
}

async function readClaude(bin: string): Promise<AgentCapabilities> {
  const unavailable: AgentCapabilities["unavailable"] = [];
  const caps: Capability[] = [];

  const mcp = await run(bin, ["mcp", "list"], 45_000);
  if (mcp.out.trim()) caps.push(...parseClaudeMcp(mcp.out));
  else unavailable.push({ kind: "mcp", reason: "claude mcp list returned nothing" });

  const plugins = await run(bin, ["plugin", "list"]);
  if (plugins.out.trim()) caps.push(...parseClaudePlugins(plugins.out));
  else unavailable.push({ kind: "plugin", reason: "claude plugin list returned nothing" });

  // Skills are configured per-query through the SDK rather than listed by the
  // binary, so there is nothing to read here without running a session.
  unavailable.push({ kind: "skill", reason: "not listable from the CLI; set per session via the Agent SDK" });

  return { cli: "claude", installed: true, capabilities: caps, unavailable, checkedAt: Date.now() };
}

/**
 * Codex answers each list scoped by working directory —
 * `{ data: [{ cwd, skills: [...] }] }` — so the rows worth showing are one
 * level in. Plugins come back under `marketplaces[].plugins[]` instead.
 */
function flattenCodexRows(rows: unknown, kind: CapabilityKind): Record<string, unknown>[] {
  if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  const obj = (rows ?? {}) as Record<string, unknown>;

  if (Array.isArray(obj.marketplaces)) {
    return (obj.marketplaces as Record<string, unknown>[]).flatMap((m) =>
      Array.isArray(m.plugins) ? (m.plugins as Record<string, unknown>[]) : [],
    );
  }

  const data = Array.isArray(obj.data) ? (obj.data as Record<string, unknown>[]) : [];
  const nestedKey = kind === "skill" ? "skills" : kind === "hook" ? "hooks" : kind === "mcp" ? "servers" : "plugins";
  const nested = data.flatMap((entry) =>
    Array.isArray(entry[nestedKey]) ? (entry[nestedKey] as Record<string, unknown>[]) : [],
  );
  return nested.length ? nested : data;
}

/**
 * Codex speaks its inventory over the app-server protocol rather than as
 * subcommands, so it is read through the JSON-RPC client in `codex-rpc`.
 */
async function readCodex(): Promise<AgentCapabilities> {
  const { codexRequests } = await import("./codex-rpc.server");
  try {
    const answers = await codexRequests([
      { method: "skills/list", params: {} },
      // `plugin/installed` is what is actually active; `plugin/list` returns
      // every marketplace entry — ~6 MB here, most of it not installed.
      { method: "plugin/installed", params: {} },
      { method: "hooks/list", params: {} },
      { method: "mcpServerStatus/list", params: {} },
    ]);
    const caps: Capability[] = [];
    const unavailable: AgentCapabilities["unavailable"] = [];
    const push = (kind: CapabilityKind, rows: unknown) => {
      // `codexRequests` turns a failed call into `{ error }` so one unsupported
      // method cannot lose the batch; report that rather than showing zero.
      const failed = (rows as { error?: string })?.error;
      if (failed) {
        unavailable.push({ kind, reason: failed });
        return;
      }
      const list = flattenCodexRows(rows, kind);
      if (!list.length) unavailable.push({ kind, reason: "codex reported none" });
      for (const row of list) {
        const r = row as Record<string, unknown>;
        // Hooks have no name — they are identified by the event they fire on.
        const name = String(r.name ?? r.id ?? r.title ?? r.eventName ?? "").trim();
        if (!name) continue;
        caps.push({
          kind,
          name,
          source:
            typeof r.source === "string"
              ? r.source
              : typeof r.sourcePath === "string"
                ? r.sourcePath
                : typeof r.scope === "string"
                  ? r.scope
                  : typeof r.command === "string"
                    ? r.command
                    : undefined,
          status: typeof r.status === "string" ? r.status : undefined,
          enabled: r.enabled !== false && r.status !== "disabled",
        });
      }
    };
    push("skill", answers["skills/list"]);
    push("plugin", answers["plugin/installed"]);
    push("hook", answers["hooks/list"]);
    push("mcp", answers["mcpServerStatus/list"]);
    return { cli: "codex", installed: true, capabilities: caps, unavailable, checkedAt: Date.now() };
  } catch (err) {
    return {
      cli: "codex",
      installed: true,
      capabilities: [],
      unavailable: [{ kind: "skill", reason: err instanceof Error ? err.message : "app-server request failed" }],
      checkedAt: Date.now(),
    };
  }
}

/** Everything one agent brings, cached for a minute. */
export async function agentCapabilities(cli: LocalCliId, force = false): Promise<AgentCapabilities> {
  const hit = cache()[cli];
  if (!force && hit && Date.now() - hit.checkedAt < CACHE_MS) return hit;

  const bin = detectLocalCli(cli);
  if (!bin) {
    const missing: AgentCapabilities = { cli, installed: false, capabilities: [], unavailable: [], checkedAt: Date.now() };
    cache()[cli] = missing;
    return missing;
  }

  const started = Date.now();
  const result = cli === "grok" ? await readGrok(bin) : cli === "claude" ? await readClaude(bin) : await readCodex();
  logEvent({
    kind: "cli:exit",
    actor: cli,
    message: `capabilities: ${result.capabilities.length} found`,
    durationMs: Date.now() - started,
    data: {
      byKind: result.capabilities.reduce<Record<string, number>>((acc, c) => {
        acc[c.kind] = (acc[c.kind] ?? 0) + 1;
        return acc;
      }, {}),
    },
  });
  cache()[cli] = result;
  return result;
}

/** All local agents, in a stable order. */
export async function allAgentCapabilities(force = false): Promise<AgentCapabilities[]> {
  const ids: LocalCliId[] = ["claude", "codex", "grok"];
  return Promise.all(ids.map((id) => agentCapabilities(id, force)));
}
