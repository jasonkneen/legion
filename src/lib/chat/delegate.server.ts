/**
 * One seat borrowing another seat's capabilities (server-only).
 *
 * The seats in a room are not equally equipped: Claude Code and grok can read
 * the workspace, an API seat behind a plain key cannot; one has 500 skills, the
 * next has none; one has an MCP server the others lack. Rather than trying to
 * copy capabilities between them, a seat can simply ask a peer to do the part
 * it cannot, and gets the answer back as a tool result.
 *
 * Depth is capped at one hop. A delegating a task to B who delegates back to A
 * is a loop that burns a subscription, and two hops is already hard for a human
 * to follow in a transcript.
 */
import { getSql } from "@/lib/db";
import { logEvent } from "@/lib/log.server";
import { providerForModel, type ModelId } from "@/lib/models";
import type { ToolContext } from "./tools.server";

/** Conversations currently running a delegated turn, to stop recursion. */
const globalRef = globalThis as typeof globalThis & { __legionDelegating__?: Set<string> };
function inFlight(): Set<string> {
  globalRef.__legionDelegating__ ??= new Set();
  return globalRef.__legionDelegating__;
}

type SeatRow = { handle: string; display_name: string; model_id: string; role: string };

/** Seats in this conversation, so a delegate can be named and validated. */
export async function seatsInConversation(userId: string, conversationId: string): Promise<SeatRow[]> {
  const sql = await getSql();
  return sql<SeatRow>`
    select handle, display_name, model_id, role
    from conversation_agents
    where conversation_id = ${conversationId} and user_id = ${userId}
    order by seat_order asc
  `;
}

/**
 * Ask another seat to do something and return what it said.
 *
 * The delegate answers with no tools of its own beyond what its provider gives
 * it, and without the room's history: it is being asked one focused question,
 * not joining the conversation. Its reply is the tool result, so the asking
 * seat stays the one talking to the human.
 */
export async function delegateToSeat(
  ctx: ToolContext,
  handle: string,
  request: string,
): Promise<string> {
  const key = `${ctx.conversationId}`;
  if (inFlight().has(key)) {
    return "Delegation is already in progress for this turn; answer with what you have instead of chaining another hop.";
  }

  const target = handle.replace(/^@/, "").trim().toLowerCase();
  if (target === ctx.actor.toLowerCase()) return "You cannot delegate to yourself.";

  const seats = await seatsInConversation(ctx.userId, ctx.conversationId);
  const seat = seats.find((s) => s.handle.toLowerCase() === target);
  if (!seat) {
    return `@${target} is not seated in this chat. Seated: ${seats.map((s) => `@${s.handle}`).join(", ") || "(none)"}.`;
  }

  const provider = providerForModel(seat.model_id as ModelId);
  const started = Date.now();
  logEvent({
    kind: "tool:start",
    actor: ctx.actor,
    conversationId: ctx.conversationId,
    message: `delegated to @${seat.handle}: ${request.slice(0, 120)}`,
  });

  inFlight().add(key);
  try {
    const { completeForProvider } = await import("./complete.server");
    const result = await completeForProvider(
      ctx.userId,
      provider,
      [
        {
          role: "system",
          content:
            `You are ${seat.display_name} (@${seat.handle}). Another seat in the room has asked you to do one ` +
            `specific thing because you can and they cannot. Do exactly that and answer plainly — no preamble, ` +
            `no asking for clarification, no @mentions. If you cannot, say so in one line.`,
        },
        { role: "user", content: request },
      ],
      {
        maxTokens: 1200,
        // The delegate gets tools (that is usually the whole point) but the
        // asking seat's turn is still the one a human is watching.
        toolContext: { ...ctx, actor: seat.handle },
      },
    );

    logEvent({
      kind: "tool:end",
      actor: ctx.actor,
      conversationId: ctx.conversationId,
      message: `@${seat.handle} answered the delegation`,
      durationMs: Date.now() - started,
    });

    if (!result.ok) return `@${seat.handle} could not help: ${result.error}`;
    return `@${seat.handle} says:\n\n${result.text}`;
  } finally {
    inFlight().delete(key);
  }
}
