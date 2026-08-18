import { useEffect, useState } from "react";
import { ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listStandingDecisions, setStandingApproval } from "@/lib/chat/approval-actions";
import { cn } from "@/lib/utils";

/**
 * Standing "always allow" and "always deny" decisions, and how to take them back.
 *
 * Every other approval scope expires: `once` on the next call, `session` when
 * the chamber closes. `always` is the one that outlives everything, and until
 * now it was a one-way door — the grant was recorded and nothing in the app ever
 * showed it again. A permission you cannot review is a permission you have lost
 * track of, so this lists them plainly and lets each one be revoked.
 */
export function StandingApprovals() {
  const [decisions, setDecisions] = useState<Record<string, "always" | "deny">>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    void listStandingDecisions()
      .then((rows) => {
        if (!stopped) setDecisions(rows);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, []);

  const entries = Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b));

  const revoke = async (tool: string) => {
    setBusy(tool);
    try {
      await setStandingApproval({ data: { tool, decision: null } });
      setDecisions((prev) => {
        const next = { ...prev };
        delete next[tool];
        return next;
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-bg-elevated">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Standing decisions</h2>
        <p className="mt-0.5 text-xs text-fg-muted">
          Tools you chose to allow or refuse for good. Everything else asks each time.
        </p>
      </header>
      <div className="px-4 py-3">
        {loading ? (
          <p className="text-xs text-fg-subtle">Reading…</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-fg-subtle">
            None yet. "Always allow" on an approval prompt adds one here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map(([tool, decision]) => (
              <li key={tool} className="flex items-center gap-2">
                {decision === "always" ? (
                  <ShieldCheck className="size-3.5 shrink-0 text-accent" />
                ) : (
                  <ShieldX className="size-3.5 shrink-0 text-danger" />
                )}
                <span className="font-mono text-xs">{tool}</span>
                <span
                  className={cn(
                    "text-xs",
                    decision === "always" ? "text-fg-muted" : "text-danger",
                  )}
                >
                  {decision === "always" ? "runs without asking" : "always refused"}
                </span>
                <div className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy === tool}
                  onClick={() => void revoke(tool)}
                >
                  <Trash2 className="size-3.5" />
                  {busy === tool ? "Revoking…" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
