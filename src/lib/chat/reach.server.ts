import { PROVIDER_BY_ID, type ProviderId } from "@/lib/providers";
import { localCliFor, resolveCreds } from "./keys.server";
import { GROK_READONLY_TOOLS } from "./local-cli.server";
import { TOOL_DEFS } from "./tools.server";
import type { LocalCliId } from "./local-cli.server";

/**
 * What one seat can actually do, and whether it can be stopped.
 *
 * Seats look interchangeable in the chat — same avatar, same box — but their
 * reach is not: an API seat and the Claude Code seat can write with permission,
 * the grok seat is read-only because it cannot ask, and pi/hermes/qwen have no
 * tools at all. That difference decides whether "@seat fix the file" will work,
 * so it belongs in front of the human rather than in the source.
 *
 * Everything here is derived from the same constants the run path uses. A tool
 * added to `TOOL_DEFS` or `GROK_READONLY_TOOLS` shows up here without a second
 * edit, which is the only way this stays true.
 */
export type SeatReach = {
  provider: ProviderId;
  /** Where the turn actually goes: the vendor's API, or a CLI on this machine. */
  route: "api" | "cli";
  cli: LocalCliId | null;
  /** Tools the seat may use, by name. */
  reads: string[];
  writes: string[];
  /** Whether it can change the workstation at all, with permission. */
  canWrite: boolean;
  /** How permission works for this seat, or why writing is off. */
  note: string;
};

/** Claude Code's write set, mirrored for display. Kept short on purpose. */
const CLAUDE_WRITE_DISPLAY = ["Edit", "Write", "Bash", "Task"];
const CLAUDE_READ_DISPLAY = ["Read", "Glob", "Grep", "publish_plan"];

export async function seatReach(userId: string, provider: ProviderId): Promise<SeatReach> {
  const creds = await resolveCreds(userId, provider);
  const cli = creds?.authKind === "local_cli" ? localCliFor(provider) : null;
  const name = PROVIDER_BY_ID[provider]?.name ?? provider;

  if (!creds) {
    return {
      provider,
      route: "api",
      cli: null,
      reads: [],
      writes: [],
      canWrite: false,
      note: `No ${name} credential yet, so this seat cannot answer at all.`,
    };
  }

  if (!cli) {
    return {
      provider,
      route: "api",
      cli: null,
      reads: TOOL_DEFS.filter((t) => t.risk !== "write").map((t) => t.name),
      writes: TOOL_DEFS.filter((t) => t.risk === "write").map((t) => t.name),
      canWrite: true,
      note: "Reads run straight away; anything that writes or runs a command asks you first.",
    };
  }

  if (cli === "claude") {
    return {
      provider,
      route: "cli",
      cli,
      reads: CLAUDE_READ_DISPLAY,
      writes: CLAUDE_WRITE_DISPLAY,
      canWrite: true,
      note:
        "Claude Code asks before it writes or runs anything that changes your machine. " +
        "Harmless read-only commands it classifies as safe run unattended — those still " +
        "show up in the session activity.",
    };
  }

  if (cli === "codex") {
    return {
      provider,
      route: "cli",
      cli,
      reads: ["read", "search", "list"],
      writes: ["apply_patch", "shell"],
      canWrite: true,
      note: "Codex runs sandboxed and read-only; each edit it wants comes back here as an approval.",
    };
  }

  if (cli === "grok") {
    return {
      provider,
      route: "cli",
      cli,
      reads: GROK_READONLY_TOOLS.filter((t) => t !== "todo_write"),
      writes: ["write_file", "run_command"],
      canWrite: true,
      // grok has no way to ask permission itself, so it does not get to decide.
      // Its own writers are off and Legion lends it ours over MCP; those run in
      // the server, where the approval prompt comes from. See GROK_DENY_RULES.
      note:
        "grok cannot ask permission itself, so its own file and shell tools are switched off. " +
        "It writes through Legion's tools instead, which stop and ask you first.",
    };
  }

  return {
    provider,
    route: "cli",
    cli,
    reads: [],
    writes: [],
    canWrite: false,
    note: `The ${cli} CLI answers in one shot with no tool channel, so this seat can only talk.`,
  };
}
