import { useEffect, useState } from "react";
import { Plug, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addMcp, deleteMcp, listMcpStatuses, toggleMcp } from "@/lib/chat/mcp-actions";
import type { McpTransport } from "@/lib/chat/mcp.server";
import { cn } from "@/lib/utils";

type Row = Awaited<ReturnType<typeof listMcpStatuses>>[number];

const TRANSPORTS: { value: McpTransport; label: string; hint: string }[] = [
  { value: "stdio", label: "Local command", hint: "npx -y @modelcontextprotocol/server-filesystem /path" },
  { value: "sse", label: "SSE URL", hint: "https://example.com/sse" },
  { value: "http", label: "HTTP URL", hint: "https://example.com/mcp" },
];

/**
 * MCP servers: register once, and every seat can use their tools.
 *
 * Tools arrive namespaced `mcp__<server>__<tool>`, and anything a server does
 * not annotate as read-only goes through the same approval prompt as a local
 * write — a third party's tool is the last thing to trust silently.
 */
export function McpPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    void listMcpStatuses()
      .then(setRows)
      .catch(() => setRows([]));
  };

  useEffect(load, []);

  const submit = async () => {
    if (!name.trim() || !target.trim()) return;
    setBusy(true);
    try {
      await addMcp({ data: { name, transport, target } });
      setName("");
      setTarget("");
      setAdding(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add that server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Plug className="size-3.5 text-fg-subtle" />
        <span className="text-sm font-medium">MCP servers</span>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
          <Plus /> Add
        </Button>
      </div>

      {adding && (
        <div className="space-y-2 border-b border-border bg-bg-subtle/40 p-3">
          <div className="flex flex-wrap gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (e.g. files)"
              className="w-40"
            />
            <div className="flex overflow-hidden rounded-lg border border-border">
              {TRANSPORTS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTransport(t.value)}
                  className={cn(
                    "px-2.5 py-1 text-xs",
                    transport === t.value ? "bg-bg-subtle text-fg" : "text-fg-subtle hover:text-fg",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={TRANSPORTS.find((t) => t.value === transport)?.hint}
            className="font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={busy || !name.trim() || !target.trim()} onClick={() => void submit()}>
              {busy ? "Connecting…" : "Add server"}
            </Button>
          </div>
        </div>
      )}

      {rows === null ? (
        <div className="p-3">
          <div className="h-10 animate-pulse rounded-lg bg-bg-subtle" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-fg-subtle">
          None yet. Add one and its tools appear to every seat, namespaced by server.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{row.name}</span>
                <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">{row.transport}</span>
                {row.enabled ? (
                  row.error ? (
                    <span className="text-[11px] text-danger">failed</span>
                  ) : (
                    <span className="text-[11px] text-fg-subtle">{row.toolCount} tools</span>
                  )
                ) : (
                  <span className="text-[11px] text-fg-subtle">off</span>
                )}
                <div className="flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void toggleMcp({ data: { id: row.id, enabled: !row.enabled } }).then(load)}
                >
                  {row.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${row.name}`}
                  onClick={() => void deleteMcp({ data: row.id }).then(load)}
                >
                  <Trash2 />
                </Button>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle">{row.target}</p>
              {row.error && <p className="mt-1 text-[11px] text-danger">{row.error}</p>}
              {row.tools.length > 0 && (
                <p className="mt-1 truncate text-[11px] text-fg-subtle">{row.tools.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
