/**
 * Read-only inspection tools for chat seats (server-only).
 *
 * Seats run unattended: a turn fires without anyone watching, and there is no
 * UI to approve an action mid-reply. So this surface is deliberately narrow —
 * look, never touch. No writes, no shell, no network, everything confined to
 * one root, every result truncated.
 *
 * The definitions are provider-neutral; `complete.server.ts` translates them
 * into whichever schema a provider expects.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { logEvent } from "@/lib/log.server";

/** Most tool calls one turn may make before we stop feeding results back. */
export const MAX_TOOL_CALLS = 12;

/**
 * The tools that are about the chat rather than the workspace.
 *
 * A CLI seat brings its own file and shell tools; what it cannot have is a view
 * of the room — the shared plan, who could be brought in, and the means to
 * bring them. This is the set Legion lends such a seat, and the reason a Codex
 * seat is not handed a second `write_file` it does not need.
 */
export const ROOM_TOOLS = ["list_ranks", "add_seat", "todo_write", "ask_human", "ask_seat"];

/** Ceiling on a single tool result, in characters. */
const MAX_RESULT_CHARS = 8_000;

/** Directories never worth showing a model and expensive to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".output", ".nitro", ".data", ".vercel", ".tanstack"]);

export type ToolDef = {
  name: string;
  description: string;
  /**
   * `read` tools run unattended. `write` tools change the workstation or run
   * commands on it, so they park the turn for a human decision first — see
   * `approvals.server.ts`.
   */
  risk?: "read" | "write";
  /**
   * Checked before the approval gate. Return a message to refuse the call
   * outright, or null to let it proceed.
   *
   * The gate is the expensive step — it stops the turn and waits on a human —
   * so anything knowably wrong should be caught first. Asking someone to
   * approve seating an agent that has no credential wastes their attention on a
   * call that was always going to fail.
   */
  precheck?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | null>;
  /** JSON Schema for the arguments object. */
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
};

/**
 * The directory tools are allowed to see. Defaults to wherever the server was
 * started, which for `npm run dev` is the project root.
 */
export function toolsRoot(): string {
  const override = process.env.LEGION_TOOLS_ROOT?.trim();
  return realpathSync(override || process.cwd());
}

/**
 * Resolve a caller-supplied path inside the root, or throw.
 *
 * Checks the real path so a symlink pointing out of the tree is rejected too —
 * `..` segments are the obvious escape, symlinks are the one people forget.
 */
function safePath(input: string): string {
  const root = toolsRoot();
  const candidate = isAbsolute(input) ? input : join(root, input);
  const resolved = resolve(candidate);

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved; // Missing paths are the tool's problem to report, not an escape.
  }

  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace root: ${input}`);
  }
  return real;
}

function clip(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated, ${text.length - MAX_RESULT_CHARS} more characters]`;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_files",
    description:
      "List files and directories inside the workspace. Use this first to find out what exists before guessing at paths.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root. Defaults to the root." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace. Output is line-numbered and truncated if long.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        start_line: { type: "number", description: "1-indexed first line to return. Defaults to 1." },
        limit: { type: "number", description: "How many lines to return. Defaults to 400." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description:
      "Search file contents for a regular expression and return matching lines with their paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Directory to search under. Defaults to the workspace root." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "git_history",
    description: "Recent commits in the workspace repository, newest first, with the files each one touched.",
    parameters: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many commits to return. Defaults to 10, capped at 50." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Write a text file in the workspace, creating or replacing it. Requires the human to approve before it runs.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        content: { type: "string", description: "Full new contents of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace and return its output. Requires the human to approve before it runs.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_seat",
    description:
      "Ask another seat in this chat to do something you cannot — read a file, search the web, use a skill or an MCP "
      + "server they have and you do not. Their answer comes back to you as the result. One hop only.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The seat's handle, e.g. claude." },
        request: { type: "string", description: "Exactly what you need them to do, in one or two sentences." },
      },
      required: ["handle", "request"],
      additionalProperties: false,
    },
  },
  {
    name: "list_ranks",
    description:
      "List the agents that could be brought into this chat: which model each is, whether it has a working "
      + "credential, and whether it is already seated. Check this before asking for one.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "add_seat",
    description:
      "Bring another agent into this chat, so it can answer for itself from here on. Use it when the work needs a "
      + "capability no one seated has — a different model's judgement, a CLI's tools, a second opinion. The human is "
      + "asked first. For a one-off question to someone already seated, use ask_seat instead.",
    risk: "write",
    precheck: async (args, ctx) => {
      const modelId = typeof args.modelId === "string" ? args.modelId.trim() : "";
      if (!modelId) return "add_seat needs a modelId. Call list_ranks to see what there is.";
      const { availableRanks } = await import("./seats.server");
      const rank = (await availableRanks(ctx.userId, ctx.conversationId)).find((r) => r.modelId === modelId);
      if (!rank) return `There is no rank called ${modelId}. Call list_ranks for the list.`;
      if (rank.seated) return `${rank.name} is already in this chat.`;
      if (!rank.configured) {
        return `${rank.name} has no working credential, so it would sit there mute. Tell the human that rather than seating it.`;
      }
      return null;
    },
    parameters: {
      type: "object",
      properties: {
        modelId: { type: "string", description: "Which rank, from list_ranks, e.g. claude or gemini." },
        handle: { type: "string", description: "Short @handle for them in this chat. Optional." },
        displayName: { type: "string", description: "Name shown on their messages. Optional." },
        role: { type: "string", description: "One line on why they are here and what they own." },
      },
      required: ["modelId", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_write",
    description:
      "Publish or update the shared plan for this chat. Send the whole list every time: "
      + "[{text, status}] where status is pending, in_progress or completed. Every seat and the human see the same list.",
    parameters: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array of {text, status}." },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_human",
    description:
      "Ask the human a multiple-choice question and wait for their answer. Use this instead of guessing when a decision "
      + "would change what you build. Up to 4 questions at once, each with 2-6 options.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description:
            'Array of {header, question, options:[{label, description}], multiSelect}. Header is a short chip label.',
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "git_changes",
    description:
      "Uncommitted changes in the workspace: `git status` plus a diffstat. Pass full=true for the whole patch.",
    parameters: {
      type: "object",
      properties: {
        full: { type: "string", description: "Set to \"true\" to include the full diff instead of a diffstat." },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** A file the working tree has changed relative to git HEAD. */
export type FileChange = {
  path: string;
  /** Porcelain status, e.g. "M", "A", "??", "D". */
  status: string;
  added: number;
  removed: number;
};

/**
 * Changed files in the workspace, for the session activity panel.
 *
 * Diffstat covers tracked edits; untracked files never appear in `git diff`, so
 * they are collected separately — a seat creating a brand-new file is exactly
 * the change a human most wants to see.
 */
export async function workspaceChanges(): Promise<FileChange[]> {
  const [statusOut, statOut] = await Promise.all([
    git(["status", "--porcelain"]),
    git(["diff", "--numstat", "HEAD"]),
  ]);

  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of statOut.split("\n")) {
    const [added, removed, path] = line.trim().split(/\t/);
    if (!path) continue;
    counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }

  const changes: FileChange[] = [];
  for (const line of statusOut.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    const path = line.slice(3).trim();
    if (!path) continue;
    const count = counts.get(path);
    changes.push({ path, status, added: count?.added ?? 0, removed: count?.removed ?? 0 });
  }
  return changes;
}

/**
 * The patch for one changed file.
 *
 * Untracked files have no diff, so their contents are shown as an all-added
 * patch — otherwise a brand-new file, the most interesting change a seat can
 * make, would render as nothing at all.
 */
export async function fileDiff(path: string): Promise<string> {
  const safe = safePath(path);
  const rel = relative(toolsRoot(), safe);
  const tracked = await git(["ls-files", "--error-unmatch", rel]);
  if (/^git exited/.test(tracked)) {
    try {
      const body = readFileSync(safe, "utf8");
      const lines = body.split("\n").slice(0, 400);
      return `new file: ${rel}\n${lines.map((l) => `+${l}`).join("\n")}`;
    } catch {
      return `new file: ${rel} (unreadable)`;
    }
  }
  const patch = await git(["diff", "--", rel]);
  return patch === "(no output)" ? `${rel}: no unstaged changes` : patch;
}

/** Run `git` with a fixed argument list — no shell, so nothing to inject into. */
function git(args: string[]): Promise<string> {
  return new Promise((resolveOut) => {
    const child = spawn("git", args, { cwd: toolsRoot(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("error", (e) => resolveOut(`git could not run: ${e.message}`));
    child.on("close", (code) => {
      if (code === 0) resolveOut(out.trim() || "(no output)");
      else resolveOut(`git exited ${code}: ${(err || out).trim().slice(0, 500)}`);
    });
    setTimeout(() => child.kill(), 15_000);
  });
}

/**
 * Write a file inside the root. Creates parent directories, because a model
 * asked to add `src/lib/thing.ts` should not have to mkdir first.
 */
function writeFileTool(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  writeFileSync(path, content, "utf8");
  const lines = content.split("\n").length;
  return `${existed ? "Replaced" : "Created"} ${relative(toolsRoot(), path)} (${lines} lines, ${content.length} bytes)`;
}

/**
 * Run a command in the workspace.
 *
 * The human approved an exact command line, so that is what runs — re-parsing
 * it into argv here could execute something subtly different from what they
 * read. The safety property is the approval gate in `runTool`, not this
 * function; it must never be reachable without one.
 */
function runCommand(command: string): Promise<string> {
  return new Promise((resolveOut) => {
    const child = spawn(command, {
      cwd: toolsRoot(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString();
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveOut(`command could not run: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOut(`exit ${code}\n${out.trim() || "(no output)"}`);
    });
  });
}

function listFiles(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
    .filter((e) => !SKIP_DIRS.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const root = toolsRoot();
  const lines = entries.map((e) => {
    if (e.isDirectory()) return `${e.name}/`;
    try {
      return `${e.name}  (${statSync(join(dir, e.name)).size} bytes)`;
    } catch {
      return e.name;
    }
  });
  const header = relative(root, dir) || ".";
  return `${header}:\n${lines.join("\n") || "(empty)"}`;
}

function searchFiles(pattern: string, dir: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (err) {
    return `Not a valid regular expression: ${err instanceof Error ? err.message : pattern}`;
  }

  const root = toolsRoot();
  const hits: string[] = [];
  const MAX_HITS = 60;

  const walk = (current: string) => {
    if (hits.length >= MAX_HITS) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= MAX_HITS) return;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let content: string;
      try {
        if (statSync(full).size > 2_000_000) continue; // Skip anything binary-sized.
        content = readFileSync(full, "utf8");
      } catch {
        continue; // Unreadable or not text — not an error worth reporting.
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_HITS; i += 1) {
        if (regex.test(lines[i])) hits.push(`${relative(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  };
  walk(dir);

  if (!hits.length) return `No matches for /${pattern}/`;
  const capped = hits.length >= MAX_HITS ? `\n…[stopped at ${MAX_HITS} matches]` : "";
  return hits.join("\n") + capped;
}

function readFileTool(path: string, startLine: number, limit: number): string {
  const stats = statSync(path);
  if (stats.isDirectory()) return listFiles(path);

  const lines = readFileSync(path, "utf8").split("\n");
  const from = Math.max(1, startLine);
  const slice = lines.slice(from - 1, from - 1 + Math.max(1, limit));
  const numbered = slice.map((line, i) => `${from + i}\t${line}`).join("\n");
  const tail = from - 1 + slice.length < lines.length ? `\n…[${lines.length} lines total]` : "";
  return `${relative(toolsRoot(), path)}:\n${numbered}${tail}`;
}

/**
 * Execute one tool call. Never throws: a model handles "that path does not
 * exist" far better than a turn that dies with a stack trace.
 */
/** Who is running a tool, so a write can be attributed and approved. */
export type ToolContext = {
  userId: string;
  conversationId: string;
  /** Seat handle, for "@codex wants to run…". */
  actor: string;
};

/** Whether an MCP tool declared itself non-mutating; unknown means "no". */
async function mcpToolIsReadOnly(userId: string | undefined, qualifiedName: string): Promise<boolean> {
  if (!userId) return false;
  const { mcpToolsFor } = await import("./mcp.server");
  const { tools } = await mcpToolsFor(userId);
  return tools.find((t) => t.qualifiedName === qualifiedName)?.readOnly === true;
}

/** One-line risk summary shown in the approval prompt. */
function approvalReason(name: string, args: Record<string, unknown>): string {
  if (name === "write_file") return `Write ${String(args.path ?? "a file")} in your workspace`;
  if (name === "run_command") return `Run: ${String(args.command ?? "").slice(0, 200)}`;
  if (name === "add_seat") return `Bring ${String(args.modelId ?? "another agent")} into this chat`;
  if (name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__");
    return `Run ${rest.join("__")} on the ${server} MCP server`;
  }
  return `Run ${name}`;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const def = TOOL_DEFS.find((t) => t.name === name);

  // MCP tools are not in TOOL_DEFS — they arrive per user, per turn. Anything a
  // server does not annotate `readOnlyHint` is treated as mutating and gated,
  // because an unknown tool from a third party is the last thing to trust by
  // default.
  const isMcp = name.startsWith("mcp__");

  // Before anything is asked of a human: give the tool a chance to say this
  // call cannot work.
  if (def?.precheck && ctx) {
    const refusal = await def.precheck(args, ctx).catch(() => null);
    if (refusal) return refusal;
  }

  const needsApproval = def?.risk === "write" || (isMcp && !(await mcpToolIsReadOnly(ctx?.userId, name)));

  if (needsApproval) {
    // Without a context there is nobody to ask, and a tool that changes the
    // workstation must never fall back to "allow". Refusing is the safe default
    // and reads as a normal tool result to the model.
    if (!ctx) return `${name} needs an approval, and this turn has no one to ask. Refused.`;

    const { requestApproval } = await import("./approvals.server");
    const outcome = await requestApproval({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      actor: ctx.actor,
      tool: name,
      args,
      reason: approvalReason(name, args),
    });
    if (!outcome.allowed) {
      return outcome.scope === "timeout"
        ? `${name} was not approved in time. Refused — ask again if it is still needed.`
        : `${name} was declined by the human. Do not retry it, and do not achieve the same thing another way. ` +
          "Say what you would have done and carry on.";
    }
  }

  const started = Date.now();
  // Scope every event to the chat that caused it, so the activity panel can
  // show one conversation's work rather than the whole process's.
  const conversationId = ctx?.conversationId;
  logEvent({
    kind: "tool:start",
    actor: name,
    conversationId,
    message: `${ctx?.actor ? `@${ctx.actor} · ` : ""}${name} ${JSON.stringify(args)}`,
    data: args,
  });
  const finish = (out: string, failed = false) => {
    logEvent({
      kind: failed ? "tool:error" : "tool:end",
      actor: name,
      conversationId,
      message: failed ? out : `${name} returned ${out.length} chars`,
      durationMs: Date.now() - started,
      data: { preview: out.slice(0, 200) },
    });
    return out;
  };
  try {
    return finish(await execute(name, args, ctx));
  } catch (err) {
    return finish(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function execute(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  if (name.startsWith("mcp__")) {
    if (!ctx?.userId) return `${name} needs a signed-in user to resolve its MCP server.`;
    const { callMcpTool } = await import("./mcp.server");
    return clip(await callMcpTool(ctx.userId, name, args));
  }
  try {
    switch (name) {
      case "list_files":
        return clip(listFiles(safePath(asString(args.path, "."))));
      case "read_file":
        return clip(
          readFileTool(safePath(asString(args.path)), asNumber(args.start_line, 1), asNumber(args.limit, 400)),
        );
      case "search_files": {
        const pattern = asString(args.pattern);
        if (!pattern) return "search_files needs a pattern.";
        return clip(searchFiles(pattern, safePath(asString(args.path, "."))));
      }
      case "write_file": {
        const path = asString(args.path);
        if (!path) return "write_file needs a path.";
        return clip(writeFileTool(safePath(path), asString(args.content)));
      }
      case "run_command": {
        const command = asString(args.command);
        if (!command) return "run_command needs a command.";
        return clip(await runCommand(command));
      }
      case "list_ranks": {
        if (!ctx) return "list_ranks needs a live conversation.";
        const { availableRanks } = await import("./seats.server");
        const ranks = await availableRanks(ctx.userId, ctx.conversationId);
        const lines = ranks.map((r) => {
          const state = r.seated ? "already seated" : r.configured ? "available" : "no credential";
          return `${r.modelId} — ${r.name} (${r.vendor}) — ${state} — ${r.blurb}`;
        });
        return lines.join("\n");
      }

      case "add_seat": {
        if (!ctx) return "add_seat needs a live conversation.";
        const modelId = asString(args.modelId);
        if (!modelId) return "add_seat needs a modelId. Call list_ranks to see what there is.";
        const { seatAgent, availableRanks } = await import("./seats.server");

        // Seating a rank with no credential produces a seat that cannot speak,
        // which reads to the human as the app being broken.
        const ranks = await availableRanks(ctx.userId, ctx.conversationId);
        const rank = ranks.find((r) => r.modelId === modelId);
        if (!rank) return `There is no rank called ${modelId}. Call list_ranks for the list.`;
        if (rank.seated) return `${rank.name} is already in this chat.`;
        if (!rank.configured) {
          return `${rank.name} has no working credential, so it would sit there mute. Tell the human that rather than seating it.`;
        }

        try {
          const seat = await seatAgent(ctx.userId, ctx.conversationId, {
            modelId: modelId as never,
            handle: asString(args.handle),
            displayName: asString(args.displayName) || rank.name,
            role: asString(args.role),
          });
          return `@${seat.handle} (${rank.name}) is now in this chat. Address them by handle; they answer for themselves.`;
        } catch (err) {
          return `That seat could not be added: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "ask_seat": {
        if (!ctx) return "ask_seat needs a live conversation.";
        const handle = asString(args.handle);
        const request = asString(args.request);
        if (!handle || !request) return "ask_seat needs both a handle and a request.";
        const { delegateToSeat } = await import("./delegate.server");
        return clip(await delegateToSeat(ctx, handle, request));
      }
      case "todo_write": {
        if (!ctx) return "todo_write needs a conversation to write into.";
        const { writeTodos } = await import("./todos.server");
        const raw = Array.isArray(args.items) ? args.items : [];
        const items = raw.map((i) => {
          const row = (i ?? {}) as Record<string, unknown>;
          return { text: String(row.text ?? row.title ?? row.step ?? ""), status: row.status };
        });
        const written = writeTodos(ctx.conversationId, ctx.actor, items);
        return `Plan updated: ${written.length} item(s), ${written.filter((t) => t.status === "completed").length} done.`;
      }
      case "ask_human": {
        if (!ctx) return "ask_human needs a live conversation; nobody is here to answer.";
        const { askHuman, parseQuestions } = await import("./questions.server");
        const questions = parseQuestions(args.questions);
        if (!questions.length) {
          return "ask_human needs at least one question with two or more options.";
        }
        const answers = await askHuman(ctx.conversationId, ctx.actor, questions);
        if (!answers) return "The human did not answer. Proceed with your best judgement and say what you assumed.";
        return Object.entries(answers)
          .map(([header, choice]) => `${header}: ${choice}`)
          .join("\n");
      }
      case "git_history": {
        const count = Math.min(Math.max(asNumber(args.count, 10), 1), 50);
        return clip(await git(["log", `-${count}`, "--stat", "--date=short", "--pretty=format:%h %ad %an %s"]));
      }
      case "git_changes": {
        const status = await git(["status", "--short"]);
        const full = asString(args.full).toLowerCase() === "true";
        const diff = await git(full ? ["diff", "HEAD"] : ["diff", "--stat", "HEAD"]);
        return clip(`git status --short:\n${status}\n\ngit diff${full ? "" : " --stat"} HEAD:\n${diff}`);
      }
      default:
        return `No such tool: ${name}`;
    }
  } catch (err) {
    return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
