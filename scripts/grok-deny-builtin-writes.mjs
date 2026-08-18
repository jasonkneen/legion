#!/usr/bin/env node
/**
 * Refuse grok's own write tools, so the only way it can change anything is
 * through Legion's gated ones.
 *
 * grok's ACP sessions auto-approve their built-in tools — measured, and not
 * fixable from the client: `--permission-mode`, a private `GROK_HOME`, its own
 * leader socket and `_meta.yoloMode` all leave it approving its own writes.
 * Hooks are the one documented mechanism that still applies in that state, so
 * this is what actually holds the line.
 *
 * The seat is not left unable to work: `mcp__legion__write_file` and
 * `mcp__legion__run_command` do the same jobs and park for a human first.
 */
const DENIED = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "search_replace",
  "multi_edit",
  "delete_file",
  "move_file",
  "run_terminal_command",
  "run_command",
  "bash",
  "spawn_subagent",
]);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let name = "";
  try {
    name = String(JSON.parse(raw || "{}").toolName ?? "");
  } catch {
    // A payload we cannot read is not a reason to block the turn.
  }
  if (DENIED.has(name.toLowerCase())) {
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason:
          `${name} is off for a Legion seat. Use mcp__legion__write_file or ` +
          "mcp__legion__run_command instead — those ask the human first.",
      }),
    );
  } else {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
  process.exit(0);
});
