import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, FileDiff, Terminal, Wrench, Zap } from "lucide-react";
import { getFileDiff, type ActivityEvent } from "@/lib/chat/activity-actions";
import { usePulse } from "@/lib/chat/use-pulse";
import type { FileChange } from "@/lib/chat/tools.server";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<string, typeof Wrench> = {
  tool: Wrench,
  cli: Terminal,
  provider: Zap,
  turn: Zap,
};

function iconFor(kind: string, actor: string) {
  if (actor.endsWith(":subagent")) return Bot;
  return KIND_ICON[kind.split(":")[0]] ?? Wrench;
}

/** "1.2s" / "340ms" — durations are the point of a tool log. */
function ms(value?: number): string {
  if (value == null) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

/**
 * What the session actually did: every tool call with its duration, each CLI
 * spawn, and the files the workspace gained or lost.
 *
 * Seats can write with permission now, so a transcript alone is not evidence —
 * this reads the log and `git status` instead of the models' own account of
 * themselves. Collapsed by default; it is a debugging surface, not the chat.
 */
export function ActivityPanel({ conversationId, live }: { conversationId: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  // Diffs are fetched per file on demand: a session can touch dozens, and
  // nobody wants every patch streamed into a poll.
  const [openDiff, setOpenDiff] = useState<{ path: string; patch: string } | null>(null);

  // Both of these are expensive — the file list shells out to git — so they are
  // fetched only while this panel is showing them or a turn is running, and on
  // the chamber's single shared poll rather than a timer of this panel's own.
  const wanted = open || live;
  const pulse = usePulse(conversationId, live, { activity: wanted, changes: wanted });
  const events: ActivityEvent[] = pulse?.activity ?? [];
  const changes: FileChange[] = pulse?.changes ?? [];

  const toolRuns = events.filter((e) => e.kind === "tool:end" || e.kind === "tool:error");
  const subagents = events.filter((e) => e.actor.endsWith(":subagent") && e.kind === "cli:spawn");
  const summary = [
    toolRuns.length ? `${toolRuns.length} tool ${toolRuns.length === 1 ? "call" : "calls"}` : null,
    subagents.length ? `${subagents.length} subagent${subagents.length === 1 ? "" : "s"}` : null,
    changes.length ? `${changes.length} file ${changes.length === 1 ? "change" : "changes"}` : null,
  ].filter(Boolean);

  if (!summary.length && !open) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-bg-subtle/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        aria-expanded={open}
      >
        <FileDiff className="size-3.5 text-fg-subtle" />
        <span className="text-xs font-medium text-fg-muted">
          Session activity{summary.length ? ` · ${summary.join(" · ")}` : ""}
        </span>
        <div className="flex-1" />
        {open ? (
          <ChevronUp className="size-3.5 text-fg-subtle" />
        ) : (
          <ChevronDown className="size-3.5 text-fg-subtle" />
        )}
      </button>

      {open && (
        <div className="max-h-72 space-y-3 overflow-y-auto border-t border-border px-3 py-2">
          {changes.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
                Workspace changes
              </p>
              <ul className="space-y-0.5">
                {changes.map((c) => (
                  <li key={c.path} className="font-mono text-xs">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-0.5 py-0.5 text-left hover:bg-bg-subtle"
                      onClick={() => {
                        if (openDiff?.path === c.path) return setOpenDiff(null);
                        setOpenDiff({ path: c.path, patch: "loading…" });
                        void getFileDiff({ data: c.path })
                          .then((patch) => setOpenDiff({ path: c.path, patch }))
                          .catch(() =>
                            setOpenDiff({ path: c.path, patch: "could not read that diff" }),
                          );
                      }}
                    >
                      <span
                        className={cn(
                          "w-6 shrink-0 text-center",
                          c.status === "??"
                            ? "text-accent"
                            : c.status === "D"
                              ? "text-danger"
                              : "text-fg-muted",
                        )}
                      >
                        {c.status || "M"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-fg-muted">{c.path}</span>
                      {(c.added > 0 || c.removed > 0) && (
                        <span className="shrink-0 tabular-nums text-[11px]">
                          <span className="text-accent">+{c.added}</span>{" "}
                          <span className="text-danger">−{c.removed}</span>
                        </span>
                      )}
                    </button>
                    {openDiff?.path === c.path && (
                      <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-bg-subtle px-2 py-1.5 text-[11px] leading-relaxed">
                        {openDiff.patch.split("\n").map((line, i) => (
                          <div
                            key={i}
                            className={cn(
                              line.startsWith("+") && !line.startsWith("+++") && "text-accent",
                              line.startsWith("-") && !line.startsWith("---") && "text-danger",
                              line.startsWith("@@") && "text-fg-subtle",
                            )}
                          >
                            {line || " "}
                          </div>
                        ))}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
              Events
            </p>
            {events.length === 0 ? (
              <p className="text-xs text-fg-subtle">Nothing yet this session.</p>
            ) : (
              <ul className="space-y-0.5">
                {events
                  .slice()
                  .reverse()
                  .map((e) => {
                    const Icon = iconFor(e.kind, e.actor);
                    return (
                      <li key={e.id} className="flex items-start gap-2 text-xs">
                        <Icon
                          className={cn(
                            "mt-0.5 size-3 shrink-0",
                            e.kind.endsWith(":error") ? "text-danger" : "text-fg-subtle",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-fg-muted">{e.message}</span>
                          {e.detail && (
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-fg-subtle">
                              {e.detail}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums text-[11px] text-fg-subtle">
                          {ms(e.durationMs)}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
