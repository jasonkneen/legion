import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listAgentCapabilities } from "@/lib/chat/capability-actions";
import type { AgentCapabilities, CapabilityKind } from "@/lib/chat/capabilities.server";
import { cn } from "@/lib/utils";

const CLI_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok" };
const KINDS: { kind: CapabilityKind; label: string }[] = [
  { kind: "skill", label: "Skills" },
  { kind: "plugin", label: "Plugins" },
  { kind: "mcp", label: "MCP" },
  { kind: "hook", label: "Hooks" },
];

/**
 * Everything the local agents can already do.
 *
 * These inventories are large — one CLI here reports 511 skills — so the panel
 * opens as counts and only lists names once a kind is selected, with a filter.
 * Where a CLI cannot report a kind, that is stated rather than shown as zero:
 * "none" and "cannot tell" are different answers.
 */
export function CapabilitiesPanel() {
  const [rows, setRows] = useState<AgentCapabilities[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ cli: string; kind: CapabilityKind } | null>(null);
  const [filter, setFilter] = useState("");

  const load = (force: boolean) => {
    setBusy(true);
    void listAgentCapabilities({ data: force })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load(false);
  }, []);

  const listed = useMemo(() => {
    if (!open || !rows) return [];
    const agent = rows.find((r) => r.cli === open.cli);
    if (!agent) return [];
    const q = filter.trim().toLowerCase();
    return agent.capabilities
      .filter((c) => c.kind === open.kind)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.source ?? "").toLowerCase().includes(q));
  }, [open, rows, filter]);

  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Agent capabilities</span>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={() => load(true)} aria-label="Rescan">
          <RefreshCw className={cn(busy && "animate-spin")} />
        </Button>
      </div>

      {rows === null ? (
        <div className="p-3">
          <div className="h-16 animate-pulse rounded-lg bg-bg-subtle" />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((agent) => {
            const counts = agent.capabilities.reduce<Record<string, number>>((acc, c) => {
              acc[c.kind] = (acc[c.kind] ?? 0) + 1;
              return acc;
            }, {});
            return (
              <li key={agent.cli} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{CLI_LABEL[agent.cli] ?? agent.cli}</span>
                  {!agent.installed && (
                    <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-subtle">
                      not installed
                    </span>
                  )}
                  <div className="flex-1" />
                  {agent.installed &&
                    KINDS.map(({ kind, label }) => {
                      const count = counts[kind] ?? 0;
                      const missing = agent.unavailable.find((u) => u.kind === kind);
                      const active = open?.cli === agent.cli && open.kind === kind;
                      return (
                        <button
                          key={kind}
                          type="button"
                          title={missing?.reason}
                          disabled={count === 0}
                          onClick={() => {
                            setFilter("");
                            setOpen(active ? null : { cli: agent.cli, kind });
                          }}
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px]",
                            active ? "bg-accent/15 text-accent" : "bg-bg-subtle text-fg-muted",
                            count === 0 && "opacity-50",
                          )}
                        >
                          {label} {missing && count === 0 ? "—" : count}
                        </button>
                      );
                    })}
                </div>

                {agent.unavailable.length > 0 && open?.cli === agent.cli && (
                  <ul className="mt-1.5 space-y-0.5">
                    {agent.unavailable.map((u) => (
                      <li key={u.kind} className="text-[11px] text-fg-subtle">
                        {u.kind}: {u.reason}
                      </li>
                    ))}
                  </ul>
                )}

                {open?.cli === agent.cli && (
                  <div className="mt-2">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Search className="size-3.5 text-fg-subtle" />
                      <Input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder={`Filter ${open.kind}s`}
                        className="h-7 text-xs"
                      />
                      <span className="shrink-0 text-[11px] text-fg-subtle">{listed.length}</span>
                    </div>
                    <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg bg-bg-subtle/50 p-2">
                      {listed.slice(0, 400).map((c, i) => (
                        <li key={`${c.name}-${i}`} className="flex items-baseline gap-2 text-xs">
                          <span className={cn("truncate", c.enabled ? "text-fg-muted" : "text-fg-subtle line-through")}>
                            {c.name}
                          </span>
                          {c.source && <span className="truncate text-[11px] text-fg-subtle">{c.source}</span>}
                          {c.status && <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">{c.status}</span>}
                        </li>
                      ))}
                      {listed.length === 0 && <li className="text-xs text-fg-subtle">Nothing matches.</li>}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
