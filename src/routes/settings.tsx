import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Blocks, KeyRound, Plug, Server, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AssistantsPanel } from "@/components/assistants-panel";
import { AccountsPanel } from "@/components/accounts-panel";
import { McpPanel } from "@/components/mcp-panel";
import { CapabilitiesPanel } from "@/components/capabilities-panel";
import { KeysPanel } from "@/components/keys-panel";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { LOBE_PROVIDER_CATALOG } from "@/lib/providers";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

type SectionId = "ranks" | "accounts" | "tools" | "keys" | "providers";

const SECTIONS: { id: SectionId; label: string; icon: typeof Users; blurb: string }[] = [
  { id: "ranks", label: "Ranks", icon: Users, blurb: "The seats you can bring to a chat." },
  { id: "accounts", label: "Accounts", icon: Server, blurb: "Agent CLIs on this machine, their logins and usage." },
  { id: "tools", label: "Tools", icon: Plug, blurb: "MCP servers, and what each agent already brings." },
  { id: "keys", label: "Provider keys", icon: KeyRound, blurb: "Keys held against your account." },
  { id: "providers", label: "Providers", icon: Blocks, blurb: "What can sit at the table." },
];

/**
 * Settings as a two-pane preference window: sections on the left, one panel of
 * content on the right.
 *
 * The page had grown into a single long scroll of six unrelated panels, which
 * buries everything below the fold and makes "where do I set X" a hunt.
 * Showing one section at a time also means only that section's data is
 * fetched — the accounts and capabilities panels each spawn CLI processes to
 * answer, and paying for all of them on every visit was waste.
 */
function SettingsPage() {
  const { user, isPending } = useCurrentUserState();
  const [section, setSection] = useState<SectionId>("ranks");

  if (isPending) {
    return (
      <div className="flex h-dvh bg-bg">
        <div className="hidden w-14 border-r border-border bg-bg-elevated md:block" />
        <div className="flex-1 animate-pulse bg-bg" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;

  const live = LOBE_PROVIDER_CATALOG.filter((p) => p.wired);
  const listed = LOBE_PROVIDER_CATALOG.filter((p) => !p.wired);
  const active = SECTIONS.find((s) => s.id === section)!;

  return (
    <AppShell section="settings">
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        {/* Sections: a scrollable strip on narrow screens, a rail on wide ones. */}
        <nav
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
        >
          <p className="hidden px-2 pb-1 text-xs font-medium tracking-wide text-fg-subtle uppercase md:block">
            Settings
          </p>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const on = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap",
                  on ? "bg-bg-subtle text-fg" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
            <h1 className="text-2xl font-semibold tracking-tight">{active.label}</h1>
            <p className="mt-1 text-sm text-fg-muted">{active.blurb}</p>

            {section === "ranks" && (
              <div className="mt-6">
                <AssistantsPanel />
              </div>
            )}

            {section === "accounts" && (
              <div className="mt-6">
                <AccountsPanel />
              </div>
            )}

            {section === "tools" && (
              <div className="mt-6 space-y-4">
                <McpPanel />
                <CapabilitiesPanel />
              </div>
            )}

            {section === "keys" && (
              <div className="mt-6">
                <p className="mb-4 text-xs text-fg-subtle">
                  Saved to {user.primaryEmail ?? "this account"}. We never show the secret again — only a short hint. A
                  signed-in <span className="font-mono">claude</span>, <span className="font-mono">codex</span> or{" "}
                  <span className="font-mono">grok</span> CLI already works without one.
                </p>
                <KeysPanel />
              </div>
            )}

            {section === "providers" && (
              <div className="mt-6 space-y-8 pb-10">
                <section>
                  <h2 className="text-sm font-medium">Live in Legion</h2>
                  <p className="mt-1 text-xs text-fg-subtle">These providers can sit at the table once connected.</p>
                  <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-bg-elevated">
                    {live.map((p) => (
                      <li key={p.name} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                        <span className="text-sm">{p.name}</span>
                        <span className="text-xs text-fg-subtle">{p.note}</span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section>
                  <h2 className="text-sm font-medium">Also in LobeChat</h2>
                  <p className="mt-1 text-xs text-fg-subtle">
                    Lobe lists these too. They are not wired as live seats here — most are regional gateways, clouds, or
                    image runtimes.
                  </p>
                  <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-bg-elevated">
                    {listed.map((p) => (
                      <li key={p.name} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                        <span className="text-sm">{p.name}</span>
                        <span className="text-xs text-fg-subtle">{p.note}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
