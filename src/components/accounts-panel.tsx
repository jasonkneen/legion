import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listAgentAccounts } from "@/lib/chat/account-actions";
import type { AgentAccount, UsageWindow } from "@/lib/chat/accounts.server";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

/** "in 4d 6h" / "in 41m" — a reset time is only useful as a distance. */
function untilLabel(at?: number): string | null {
  if (!at) return null;
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return "resetting now";
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Meter({ window }: { window: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, window.usedPercent));
  // A sliver for tiny non-zero usage, so "2%" is visible rather than blank.
  const width = pct > 0 ? Math.max(pct, 1.5) : 0;
  const reset = untilLabel(window.resetsAt);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-fg-muted">{window.label}</span>
        <span className="tabular-nums text-fg-subtle">
          {pct}%{reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-subtle">
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-danger" : "bg-accent")}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The agent accounts on this machine.
 *
 * Nothing to configure: if a CLI is installed and signed in, it shows up here
 * and its seat works. Usage is whatever that CLI's own login reports — Codex
 * exposes its rate-limit window over the app-server protocol, Claude through
 * the same endpoint its `/usage` view uses. Where a provider does not report
 * usage, this says so rather than drawing an empty meter that reads as zero.
 */
export function AccountsPanel() {
  const [rows, setRows] = useState<AgentAccount[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = (force: boolean) => {
    setRefreshing(true);
    void listAgentAccounts({ data: force })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    load(true);
  }, []);

  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Agent CLIs on this machine</span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => load(true)}
          disabled={refreshing}
          aria-label="Refresh accounts"
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      {rows === null ? (
        <div className="space-y-2 p-3">
          <div className="h-12 animate-pulse rounded-lg bg-bg-subtle" />
          <div className="h-12 animate-pulse rounded-lg bg-bg-subtle" />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.cli} className="px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{LABELS[row.cli] ?? row.cli}</span>
                {row.installed ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      row.signedIn ? "bg-accent/15 text-accent" : "bg-bg-subtle text-fg-muted",
                    )}
                  >
                    {row.signedIn ? "signed in" : "not signed in"}
                  </span>
                ) : (
                  <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-subtle">
                    not installed
                  </span>
                )}
                {row.plan && (
                  <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-muted uppercase">
                    {row.plan}
                  </span>
                )}
                <div className="flex-1" />
                {row.version && <span className="text-[11px] text-fg-subtle">v{row.version}</span>}
              </div>

              {(row.email || row.authMethod) && (
                <p className="mt-1 truncate text-xs text-fg-muted">
                  {row.email ?? "—"}
                  {row.authMethod ? ` · via ${row.authMethod}` : ""}
                </p>
              )}

              {row.usage?.windows.length ? (
                <div className="mt-2 flex flex-col gap-2">
                  {row.usage.windows.map((w) => (
                    <Meter key={w.label} window={w} />
                  ))}
                  {row.usage.lifetimeTokens != null && (
                    <p className="text-[11px] text-fg-subtle">
                      {(row.usage.lifetimeTokens / 1e9).toFixed(1)}B tokens all time
                      {row.usage.streakDays ? ` · ${row.usage.streakDays} day streak` : ""}
                    </p>
                  )}
                </div>
              ) : null}

              {row.note && <p className="mt-1.5 text-[11px] text-fg-subtle">{row.note}</p>}
              {row.installed && row.path && (
                <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle">{row.path}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
