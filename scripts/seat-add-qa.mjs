/**
 * A seat bringing in another agent, for real.
 *
 * The failure this guards is specific and was seen in the wild: asked to "add
 * claude in", grok replied "@claude — you're in" and nothing happened. A model
 * narrating an action it cannot take is worse than one refusing, because the
 * human believes it.
 *
 *   LEGION_TOOLS_ROOT=/tmp/ws node scripts/seat-add-qa.mjs
 */
import { createServer as createVite } from "vite";
import { createServer as createHttp } from "node:http";

const vite = await createVite({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { completeForProvider } = await vite.ssrLoadModule("/src/lib/chat/complete.server.ts");
const approvals = await vite.ssrLoadModule("/src/lib/chat/approvals.server.ts");
const { readSeatGrant } = await vite.ssrLoadModule("/src/lib/chat/seat-grant.server.ts");
const { runTool, TOOL_DEFS, ROOM_TOOLS } = await vite.ssrLoadModule("/src/lib/chat/tools.server.ts");
const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
const { seatAgent } = await vite.ssrLoadModule("/src/lib/chat/seats.server.ts");
const { seatSystemPrompt } = await vite.ssrLoadModule("/src/lib/chat/prompts.ts");

// grok reaches Legion's tools over MCP, so the callback must land in this process.
const http = createHttp((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const p = JSON.parse(body || "{}");
    if (process.env.TRACE) console.log("BRIDGE ->", p.op ?? "?", p.name ?? "", p.token ? "token ok" : "NO TOKEN");
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
await new Promise((r) => http.listen(3998, r));
process.env.LEGION_URL = "http://localhost:3998";

const sql = await getSql();
const convo = "seat-add-qa";
await sql`delete from conversations where id = ${convo}`;
await sql`insert into conversations (id, user_id, title) values (${convo}, 'seat-qa', 'Seat add')`;
await seatAgent("seat-qa", convo, { modelId: "grok-4.6", handle: process.env.SEAT_ACTOR ?? "grok", displayName: "Seat", role: "" })
  .catch(async () => {
    const { MODELS } = await vite.ssrLoadModule("/src/lib/models.ts");
    const g = MODELS.find((m) => m.handle === "grok");
    return seatAgent("seat-qa", convo, { modelId: g.id, handle: "grok", displayName: "Grok", role: "" });
  });

const ctx = { userId: "seat-qa", conversationId: convo, actor: process.env.SEAT_ACTOR ?? "grok" };
const asked = [];
const w = setInterval(() => {
  for (const a of approvals.pendingApprovals(convo)) {
    asked.push(a.tool);
    void approvals.decideApproval(ctx.userId, a.id, "once");
  }
}, 200);

const provider = process.env.SEAT_PROVIDER ?? "xai";
const r = await completeForProvider(ctx.userId, provider, [
  // The real prompt, not a stand-in: it is what tells a seat these tools exist.
  { role: "system", content: seatSystemPrompt(
      { id: "s", conversationId: convo, handle: ctx.actor, displayName: ctx.actor,
        modelId: "grok-4.6", role: "", seatOrder: 0, createdAt: "" },
      [], null) },
  { role: "user", content: process.env.SEAT_ASK ?? "add claude in" },
], { maxTokens: 700, toolContext: ctx });
clearInterval(w);

const seats = await sql`select handle, model_id from conversation_agents where conversation_id = ${convo} order by seat_order`;
const seated = seats.map((s) => s.handle);
const ok = asked.includes("add_seat") && seated.length > 1;
console.log("approvals asked:", asked.length ? asked.join(", ") : "NONE");
console.log("seats now:", seated.join(", "));
console.log("reply:", (r.ok ? r.text : r.error).replace(/\n+/g, " ").slice(0, 140));
console.log(ok ? "\nPASS — the agent was actually seated" : "\nFAIL — nothing was seated");
await sql`delete from conversations where id = ${convo}`;
http.close(); await vite.close();
process.exit(ok ? 0 : 1);
