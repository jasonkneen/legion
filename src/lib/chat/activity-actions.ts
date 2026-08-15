import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { recentEvents, type LogEvent } from "@/lib/log.server";
import { fileDiff, workspaceChanges, type FileChange } from "./tools.server";

/** One row in the activity panel. Mirrors LogEvent, minus anything unserialisable. */
export type ActivityEvent = {
  id: number;
  at: number;
  kind: string;
  actor: string;
  message: string;
  durationMs?: number;
  /** Short preview of the tool result or payload. */
  detail?: string;
};

/**
 * What has happened in this session: tool calls, provider requests, CLI spawns.
 *
 * Read from the in-memory ring in `log.server`, so it is cheap enough to poll
 * while a turn runs and disappears when the server restarts — this is a live
 * view of the current session, not an audit trail.
 */
export const listActivity = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((conversationId?: string) => conversationId ?? "")
  .handler(async ({ data: conversationId }): Promise<ActivityEvent[]> =>
    recentEvents(conversationId || undefined, 200).map((e: LogEvent) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      actor: e.actor ?? "",
      message: e.message,
      durationMs: e.durationMs,
      detail: typeof e.data?.preview === "string" ? e.data.preview : undefined,
    })),
  );

/**
 * Files the workspace has gained, lost or changed, against git HEAD.
 *
 * Seats can now write with permission, so "what did this session actually do to
 * my disk" needs an answer that does not depend on trusting the transcript.
 */
export const listWorkspaceChanges = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async (): Promise<FileChange[]> => workspaceChanges());

/** The patch for one file, fetched only when the human expands it. */
export const getFileDiff = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((path: string) => path)
  .handler(async ({ data: path }): Promise<string> => fileDiff(path));
