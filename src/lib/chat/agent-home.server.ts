import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@/lib/data-dir";

/**
 * Home directories that Legion owns, one per CLI it seats.
 *
 * Left alone, a CLI seat is the workstation's CLI: it loads whatever the human
 * has configured. Measured, that meant a grok seat starting seven MCP servers
 * scanned out of `~/.claude.json`, and a codex seat with blender, infinitty,
 * hermes-tools and node_repl attached. None of it was chosen for a chat seat,
 * and none of it passes through Legion's approval gate, because those tools
 * belong to the CLI rather than to us.
 *
 * Writing our server into the user's own config was the first attempt and it
 * does not hold: `grok mcp add` wrote the entry and a later grok invocation
 * rewrote the file without it. A home we own cannot be edited out from under
 * us, and it leaves the human's setup exactly as they left it.
 *
 * The login stays theirs — `auth.json` is symlinked, never copied, so a token
 * refresh on their side is immediately true here and no credential is
 * duplicated on disk.
 */
const MARKER = "# Managed by Legion. Edits are overwritten.";

function ensureHome(name: string, authFile: string, config: string): string {
  const home = join(dataDir(), name);
  mkdirSync(home, { recursive: true });

  const link = join(home, "auth.json");
  const real = join(homedir(), authFile);
  if (!existsSync(link) && existsSync(real)) {
    try {
      symlinkSync(real, link);
    } catch {
      // A racing or stale link is not worth failing a turn over.
    }
  }

  const path = join(home, "config.toml");
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = "";
  }
  if (current !== config) {
    if (current && !current.startsWith(MARKER)) writeFileSync(`${path}.bak`, current);
    writeFileSync(path, config);
  }
  return home;
}

/** The MCP server that lends a seat Legion's own tools. */
function bridgeCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(process.cwd(), "scripts", "legion-mcp-bridge.mjs")] };
}

export function grokHome(): string {
  const { command, args } = bridgeCommand();
  return ensureHome(
    "grok-home",
    ".grok/auth.json",
    `${MARKER}
#
# A chat seat, not the workstation's grok.

[ui]
permission_mode = "default"

[mcp_servers.legion]
command = ${JSON.stringify(command)}
args = [${JSON.stringify(args[0])}]

# Without these, grok scans ~/.claude.json and starts every MCP server it finds
# there — tools Legion never chose and cannot gate.
[compat.claude]
mcps = false
sessions = false
agents = false

[compat.cursor]
mcps = false
sessions = false

[compat.codex]
mcps = false
sessions = false
`,
  );
}

/**
 * Codex's home. The MCP server is passed per turn on the command line instead
 * of written here, because it carries that turn's token; an empty home is what
 * keeps the workstation's servers from being merged in alongside it.
 */
export function codexHome(): string {
  return ensureHome(
    "codex-home",
    ".codex/auth.json",
    `${MARKER}
#
# A chat seat, not the workstation's codex. Legion passes its own MCP server on
# the command line per turn; this file exists to make sure nothing else is here
# to be merged with it.
`,
  );
}

/**
 * An MCP config file pointing a CLI at Legion's bridge for one turn.
 *
 * For CLIs that take a config path rather than a home of their own. The token
 * is written into the file, so the file is per-turn and removed with it.
 */
export function writeBridgeConfig(
  cli: string,
  token: string,
  legionUrl: string,
): { path: string; dispose: () => void } {
  const { command, args } = bridgeCommand();
  const dir = mkdtempSync(join(tmpdir(), `legion-${cli}-`));
  const path = join(dir, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify(
      { mcpServers: { legion: { command, args, env: { LEGION_URL: legionUrl, LEGION_SEAT_TOKEN: token } } } },
      null,
      2,
    ),
  );
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
