import { createFileRoute } from "@tanstack/react-router";
import { readSeatGrant } from "@/lib/chat/seat-grant.server";
import { ROOM_TOOLS, runTool, TOOL_DEFS } from "@/lib/chat/tools.server";

/**
 * The tool endpoint an external agent process calls back into.
 *
 * Deliberately not behind the session cookie: the caller is a CLI subprocess on
 * this machine, not a browser. Authority comes from the turn-scoped token
 * instead, which names the chamber and seat the call is allowed to act as, and
 * expires with the turn. A token cannot widen its own reach — the context is
 * looked up here, never taken from the request body.
 *
 * Everything runs through `runTool`, so a write from grok parks for approval on
 * exactly the same registry as a write from any other seat.
 */
export const Route = createFileRoute("/api/seat-tools")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          token?: string;
          op?: "list" | "call";
          name?: string;
          args?: Record<string, unknown>;
        };

        const grant = body.token ? readSeatGrant(body.token) : null;
        if (!grant) return Response.json({ error: "That token is not valid for any live turn." }, { status: 401 });
        const { ctx, scope } = grant;

        // The scope is read from the grant, never from the request: a token is
        // the authority, and a caller must not be able to widen its own reach.
        const offered = scope === "room" ? TOOL_DEFS.filter((t) => ROOM_TOOLS.includes(t.name)) : TOOL_DEFS;

        if (body.op === "list") {
          return Response.json({
            tools: offered.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          });
        }

        if (!body.name) return Response.json({ error: "No tool named." }, { status: 400 });
        if (!offered.some((t) => t.name === body.name)) {
          return Response.json({ text: `${body.name} is not available to this seat.` });
        }
        const text = await runTool(body.name, body.args ?? {}, ctx);
        return Response.json({ text });
      },
    },
  },
});
