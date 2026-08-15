import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApprovalScope, PendingApprovalView } from "@/lib/chat/approvals.server";

/**
 * The approval prompt, docked above the composer.
 *
 * Deliberately not a modal: the request only makes sense next to the
 * conversation that produced it, and a turn is parked waiting on this, so it
 * has to be visible without stealing focus from the thread. One request at a
 * time — a seat asks, gets an answer, then continues.
 */
export function ApprovalPanel({
  request,
  onDecide,
}: {
  request: PendingApprovalView;
  onDecide: (id: string, scope: ApprovalScope) => Promise<void>;
}) {
  const [busy, setBusy] = useState<ApprovalScope | null>(null);

  const choose = async (scope: ApprovalScope) => {
    setBusy(scope);
    try {
      await onDecide(request.id, scope);
    } finally {
      setBusy(null);
    }
  };

  const detail = request.detail;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border-strong bg-bg-elevated">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">
            @{request.actor} wants to run <span className="font-mono text-[13px]">{request.tool}</span>
          </p>
          <p className="mt-0.5 text-sm text-fg-muted">{request.reason}</p>
          {detail && (
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-bg-subtle px-2 py-1.5 font-mono text-xs text-fg-muted">
              {detail}
            </pre>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void choose("once")}>
          {busy === "once" ? "Allowing…" : "Allow once"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void choose("session")}
        >
          Allow for this chat
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void choose("always")}
        >
          Always allow
        </Button>
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void choose("deny")}
        >
          {busy === "deny" ? "Declining…" : "Decline"}
        </Button>
      </div>
    </div>
  );
}
