import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { newId } from "@/lib/chat/ids";
import { parseMentions } from "@/lib/chat/mentions";
import { jumpInPrompt, seatSystemPrompt, toProviderMessages } from "@/lib/chat/prompts";
import { providerForModel, type ModelId } from "@/lib/models";
import { streamTurn, type TurnEvent } from "@/lib/chat/stream.server";
import type { ChatMessage, Seat } from "@/lib/chat/types";

/**
 * Server-sent events for one seat's reply.
 *
 * A server function returns once; a turn has several things to say while it
 * runs — which tool it is using, then the answer arriving word by word — so
 * this is a route rather than a `createServerFn`. The finished message is
 * persisted here too, exactly as the non-streaming path does, so a streamed
 * reply is indistinguishable from a blocking one once it lands.
 */
export const Route = createFileRoute("/api/reply")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
        const userId = session.user.id;

        const body = (await request.json()) as {
          conversationId: string;
          handle: string;
          task?: string | null;
          jumpIn?: boolean;
        };

        const sql = await getSql();
        const convo = await sql<{ id: string }>`
          select id from conversations where id = ${body.conversationId} and user_id = ${userId} limit 1
        `;
        if (!convo.length) return new Response("Not found", { status: 404 });

        const seatRows = await sql<{
          id: string;
          conversation_id: string;
          handle: string;
          display_name: string;
          model_id: string;
          role: string;
          seat_order: number;
          created_at: string;
        }>`
          select id, conversation_id, handle, display_name, model_id, role, seat_order,
                 created_at::text as created_at
          from conversation_agents
          where conversation_id = ${body.conversationId} and user_id = ${userId}
          order by seat_order asc, created_at asc
        `;
        const seats: Seat[] = seatRows.map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          handle: r.handle,
          displayName: r.display_name,
          modelId: r.model_id as ModelId,
          role: r.role,
          seatOrder: Number(r.seat_order),
          createdAt: r.created_at,
        }));
        const seat = seats.find((s) => s.handle === body.handle);
        if (!seat) return new Response("That agent is not in this chat", { status: 404 });

        const messageRows = await sql<{
          id: string;
          conversation_id: string;
          author_type: string;
          agent_id: string | null;
          content: string;
          mentions_json: string;
          task: string | null;
          created_at: string;
        }>`
          select id, conversation_id, author_type, agent_id, content, mentions_json, task,
                 created_at::text as created_at
          from messages
          where conversation_id = ${body.conversationId} and user_id = ${userId}
          order by created_at asc
        `;
        const history: ChatMessage[] = messageRows.map((r) => {
          let mentions: string[] = [];
          try {
            const parsed = JSON.parse(r.mentions_json) as unknown;
            if (Array.isArray(parsed)) mentions = parsed.filter((x): x is string => typeof x === "string");
          } catch {
            mentions = [];
          }
          return {
            id: r.id,
            conversationId: r.conversation_id,
            authorType: r.author_type as ChatMessage["authorType"],
            agentId: r.agent_id,
            content: r.content,
            mentions,
            task: r.task,
            createdAt: r.created_at,
          };
        });

        const system = body.jumpIn ? jumpInPrompt(seat) : seatSystemPrompt(seat, seats, body.task ?? null);
        const provider = providerForModel(seat.modelId);

        const encoder = new TextEncoder();
        // One controller for the whole turn: the browser hanging up (a Stop
        // press, a closed tab) must reach the provider, or generation carries
        // on invisibly and is still billed.
        const abort = new AbortController();
        request.signal?.addEventListener("abort", () => abort.abort());

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: TurnEvent | { type: "message"; message: ChatMessage; followUpHandles: string[] }) => {
              // Once the reader has gone, enqueuing throws. That is expected
              // after a stop, and must not turn into a second failure while
              // handling the first.
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                /* the client is no longer listening */
              }
            };

            try {
              let text = "";
              for await (const event of streamTurn(
                userId,
                provider,
                [{ role: "system", content: system }, ...toProviderMessages(history, seats)],
                {
                  maxTokens: body.jumpIn ? 280 : 1400,
                  temperature: body.task?.toLowerCase().includes("review") ? 0.4 : 0.7,
                  tools: !body.jumpIn,
                  toolContext: { userId, conversationId: body.conversationId, actor: seat.handle },
                  signal: abort.signal,
                },
              )) {
                if (event.type === "delta") text += event.text;
                if (event.type === "done") text = event.text || text;
                send(event);
              }

              const stopped = abort.signal.aborted;
              const trimmed = text.trim();
              // A jump-in that decides not to speak leaves no message behind.
              if (body.jumpIn && (!trimmed || /^skip\b/i.test(trimmed))) {
                send({ type: "status", text: "skipped" });
                controller.close();
                return;
              }
              if (!trimmed) {
                controller.close();
                return;
              }

              const message: ChatMessage = {
                id: newId(),
                conversationId: body.conversationId,
                authorType: "agent",
                agentId: seat.id,
                // Half an answer is still worth keeping — but it must be
                // labelled, or a truncated reply reads as the seat's own view.
                content: stopped ? `${trimmed}\n\n_(stopped)_` : trimmed,
                mentions: parseMentions(trimmed),
                task: body.jumpIn ? "jump-in" : (body.task ?? null),
                createdAt: new Date().toISOString(),
              };
              await sql`
                insert into messages (id, conversation_id, user_id, author_type, agent_id, content, mentions_json, task)
                values (
                  ${message.id}, ${body.conversationId}, ${userId}, 'agent', ${seat.id}, ${message.content},
                  ${JSON.stringify(message.mentions)}, ${message.task}
                )
              `;
              await sql`
                update conversations set updated_at = now()
                where id = ${body.conversationId} and user_id = ${userId}
              `;

              send({
                type: "message",
                message,
                followUpHandles: message.mentions.filter(
                  (h) => h !== "all" && h !== seat.handle && seats.some((s) => s.handle === h),
                ),
              });
            } catch (err) {
              send({ type: "error", error: err instanceof Error ? err.message : "The seat went quiet." });
            } finally {
              try {
                controller.close();
              } catch {
                /* already closed by the cancel handler */
              }
            }
          },
          cancel() {
            // The reader went away: stop the turn rather than letting it run on.
            abort.abort();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Proxies that buffer would defeat the point of streaming.
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
