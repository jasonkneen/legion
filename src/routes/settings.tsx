import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { AssistantsPanel } from "@/components/assistants-panel";
import { AccountsPanel } from "@/components/accounts-panel";
import { McpPanel } from "@/components/mcp-panel";
import { CapabilitiesPanel } from "@/components/capabilities-panel";
import { KeysPanel } from "@/components/keys-panel";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { LOBE_PROVIDER_CATALOG } from "@/lib/providers";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const { user, isPending } = useCurrentUserState();

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

  return (
    <AppShell section="settings">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-8 md:px-8">
          <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Language models</h1>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-fg-muted">
            Sign-in is the vault. Keys we save here live on this account — not this tab. Come back, sign in, they are
            still here. Codex can use ChatGPT. Claude Agent takes a{" "}
            <span className="font-mono text-xs">claude setup-token</span>. Everyone else is an API key. When Legion
            runs on a machine with the <span className="font-mono text-xs">claude</span> or{" "}
            <span className="font-mono text-xs">codex</span> CLI signed in, those seats use it and need no key at all.
          </p>
          <div className="mt-6">
            <AssistantsPanel />
          </div>
          <h2 className="mt-10 text-sm font-medium">Accounts</h2>
          <p className="mt-1 text-xs text-fg-subtle">
            Detected automatically. A signed-in CLI is a working seat — no key needed.
          </p>
          <div className="mt-4">
            <AccountsPanel />
          </div>

          <h2 className="mt-10 text-sm font-medium">Tools</h2>
          <p className="mt-1 text-xs text-fg-subtle">
            MCP servers extend every seat. Read-only tools run freely; anything else asks first.
          </p>
          <div className="mt-4">
            <McpPanel />
          </div>

          <div className="mt-4">
            <CapabilitiesPanel />
          </div>

          <h2 className="mt-10 text-sm font-medium">Provider keys</h2>
          <p className="mt-1 text-xs text-fg-subtle">
            Saved to {user.primaryEmail ?? "this account"}. We never show the secret again — only a short hint.
          </p>
          <div className="mt-4">
            <KeysPanel />
          </div>

          <section className="mt-10">
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

          <section className="mt-8 pb-10">
            <h2 className="text-sm font-medium">Also in LobeChat</h2>
            <p className="mt-1 text-xs text-fg-subtle">
              Lobe lists these too. They are not wired as live seats here — most are regional gateways, clouds, or image
              runtimes.
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
      </div>
    </AppShell>
  );
}
