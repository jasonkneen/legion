import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { storedEvents, type LogEvent } from "@/lib/log.server";
import { getSql } from "@/lib/db";
import { fileDiff, workspaceChanges, type FileChange } from "./tools.server";

/** One row in the activity panel. Mirrors LogEvent, minus anything unserialisable. */
export type ActivityEvent = {
  id: string;
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
 * Persisted per chamber and merged with whatever this process has not written
 * yet, so the panel survives a restart instead of resetting to empty. Rows
 * outlive the session that made them, so ownership is checked here rather than
 * assumed from the caller having the id.
 */
export const listActivity = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((conversationId?: string) => conversationId ?? "")
  .handler(async ({ data: conversationId, context }): Promise<ActivityEvent[]> => {
    if (!conversationId) return [];
    const sql = await getSql();
    const owned = await sql<{ id: string }>`
      select id from conversations
      where id = ${conversationId} and user_id = ${context.userId} limit 1
    `;
    if (!owned.length) return [];
    const events = await storedEvents(conversationId, 200);
    return events.map((e: LogEvent) => ({
      id: e.key,
      at: e.at,
      kind: e.kind,
      actor: e.actor ?? "",
      message: e.message,
      durationMs: e.durationMs,
      detail: typeof e.data?.preview === "string" ? e.data.preview : undefined,
    }));
  });

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
