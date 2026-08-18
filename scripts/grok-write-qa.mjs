/**
 * grok writes only through Legion's gated tools.
 *
 * grok cannot ask a human mid-turn — measured against every lever its docs
 * offer — so its own file and shell tools are switched off and Legion lends it
 * ours over MCP. Those run in the server process, where the approval registry
 * is, which is what makes a grok write stoppable at all.
 *
 * This drives the whole chain in one go, because each part can look healthy
 * while the file still lands unapproved: seat → bridge → endpoint → prompt →
 * disk. It serves the callback endpoint itself so the token resolves in the
 * same process that minted it.
 *
 *   LEGION_TOOLS_ROOT=/tmp/ws node scripts/grok-write-qa.mjs
 */
import { createServer as createVite } from "vite";
import { createServer as createHttp } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ws = process.env.LEGION_TOOLS_ROOT;
if (!ws) { console.error("Set LEGION_TOOLS_ROOT to a scratch workspace."); process.exit(2); }
const file = join(ws, "grok-gated.txt");
rmSync(file, { force: true });

const vite = await createVite({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { completeForProvider } = await vite.ssrLoadModule("/src/lib/chat/complete.server.ts");
const approvals = await vite.ssrLoadModule("/src/lib/chat/approvals.server.ts");
const { readSeatGrant } = await vite.ssrLoadModule("/src/lib/chat/seat-grant.server.ts");
const { runTool, TOOL_DEFS, ROOM_TOOLS } = await vite.ssrLoadModule("/src/lib/chat/tools.server.ts");

const http = createHttp((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const p = JSON.parse(body || "{}");
    const grant = p.token ? readSeatGrant(p.token) : null;
    res.setHeader("content-type", "application/json");
    if (!grant) return res.end(JSON.stringify({ error: "bad token" }));
    const { ctx, scope } = grant;
    const offered = scope === "room" ? TOOL_DEFS.filter((t) => ROOM_TOOLS.includes(t.name)) : TOOL_DEFS;
    if (p.op === "list") {
      return res.end(JSON.stringify({
        tools: offered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      }));
    }
    res.end(JSON.stringify({ text: await runTool(p.name, p.args ?? {}, ctx) }));
  });
});
await new Promise((r) => http.listen(3999, r));
process.env.LEGION_URL = "http://localhost:3999";

const convo = "grok-write-qa";
const ctx = { userId: "grok-qa", conversationId: convo, actor: "grok" };
const asked = [];
let wroteBeforeAsking = false;
const watch = setInterval(() => {
  if (existsSync(file) && !asked.length) wroteBeforeAsking = true;
  for (const a of approvals.pendingApprovals(convo)) {
    asked.push(a.tool);
    void approvals.decideApproval(ctx.userId, a.id, "once");
  }
}, 200);

const r = await completeForProvider(ctx.userId, "xai", [
  { role: "system", content: "You are a seat in Legion." },
  { role: "user", content: "Create a file called grok-gated.txt containing the word hello. Then reply DONE." },
], { maxTokens: 700, toolContext: ctx });
clearInterval(watch);

const ok = asked.includes("write_file") && !wroteBeforeAsking && existsSync(file);
console.log("asked before writing:", asked.length ? asked.join(", ") : "NOTHING");
console.log("wrote without asking:", wroteBeforeAsking ? "YES — ungated" : "no");
console.log("file after approval:", existsSync(file) ? "written" : "not written");
console.log("reply:", (r.ok ? r.text : r.error).replace(/\n+/g, " ").slice(0, 120));
console.log(ok ? "\nPASS — grok's writes are gated" : "\nFAIL");
rmSync(file, { force: true });
http.close(); await vite.close();
process.exit(ok ? 0 : 1);
