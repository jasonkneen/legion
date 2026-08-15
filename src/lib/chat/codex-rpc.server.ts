/**
 * Minimal `codex app-server` JSON-RPC client for one-shot queries (server-only).
 *
 * Codex exposes its inventory (skills, plugins, hooks, MCP status, models) over
 * the same stdio protocol it uses to run turns, so reading it means speaking
 * JSON-RPC rather than parsing a subcommand's output. This client exists for
 * the short read-only calls; the turn path in `local-cli.server.ts` keeps its
 * own connection because it also has to stream notifications.
 */
import { spawn } from "node:child_process";
import { detectLocalCli } from "./local-cli.server";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Run a batch of requests against one short-lived app-server process.
 *
 * MCP servers are disabled: these calls only read Codex's own configuration,
 * and starting the workstation's MCP fleet to list a few names costs seconds.
 */
export async function codexRequests(
  calls: { method: string; params: Record<string, unknown> }[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const bin = detectLocalCli("codex");
  if (!bin) throw new Error("The codex CLI is not installed on this machine.");

  const child = spawn(bin, ["app-server", "-c", "mcp_servers={}"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let buffer = "";
  let stderr = "";

  const send = (payload: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });

  child.stderr.on("data", (c: Buffer) => {
    stderr = `${stderr}${c.toString()}`.slice(-1000);
  });

  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString();
    let newline = buffer.indexOf("\n");
    for (; newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id == null) continue; // notification — nothing to correlate
      if (msg.method) {
        // A request from the server; nothing here can answer one.
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no interactive client" } });
        continue;
      }
      const waiter = pending.get(Number(msg.id));
      if (!waiter) continue;
      pending.delete(Number(msg.id));
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "codex app-server error"));
      else waiter.resolve(msg.result ?? {});
    }
  });

  const died = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`codex app-server exited (${code})${stderr ? `: ${stderr.slice(-200)}` : ""}`)));
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("codex app-server timed out")), timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        await request("initialize", {
          clientInfo: { name: "legion", title: "Legion", version: "0.1.0" },
          capabilities: {},
        });
        send({ jsonrpc: "2.0", method: "initialized" });

        const out: Record<string, unknown> = {};
        for (const call of calls) {
          // One bad method must not lose the whole batch — an older Codex may
          // simply not implement it.
          out[call.method] = await request(call.method, call.params).catch((err) => ({
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        return out;
      })(),
      died,
      timeout,
    ]);
  } finally {
    child.kill();
  }
}
