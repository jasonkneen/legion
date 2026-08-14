import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  clearProviderKey,
  listProviderStatuses,
  pollCodexLogin,
  saveClaudeAgentToken,
  saveCodexPaste,
  saveProviderKey,
  startCodexLogin,
} from "@/lib/chat/keys-actions";
import type { ProviderStatus } from "@/lib/providers";

export function KeysPanel() {
  const [rows, setRows] = useState<ProviderStatus[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    void listProviderStatuses()
      .then(setRows)
      .catch(() => {
        toast.error("Could not load provider keys");
        setRows([]);
      });
  }, []);

  const replace = useCallback((next: ProviderStatus) => {
    setRows((prev) => (prev ?? []).map((r) => (r.id === next.id ? next : r)));
    window.dispatchEvent(new Event("chamber:keys"));
  }, []);

  if (!rows) {
    return (
      <div className="space-y-3">
        <div className="h-28 animate-pulse rounded-xl bg-bg-subtle" />
        <div className="h-28 animate-pulse rounded-xl bg-bg-subtle" />
      </div>
    );
  }

  const featured = rows.filter((r) => r.featured);
  const rest = rows.filter((r) => !r.featured);
  const visible = showAll ? rows : featured;
  const saved = rows.filter((r) => Boolean(r.hint) && r.hint !== "local, no key");

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <p className="text-sm font-medium">
          {saved.length === 0
            ? "No keys on this account yet"
            : `${saved.length} ${saved.length === 1 ? "key" : "keys"} on this account`}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
          {saved.length === 0
            ? "Paste a key and hit Save. It stays on this sign-in — that is the point of the account."
            : saved.map((r) => r.name).join(" · ")}
        </p>
      </div>
      {visible.map((row) => (
        <ProviderCard key={row.id} row={row} onChange={replace} />
      ))}
      {rest.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show featured only" : `Show ${rest.length} more providers`}
        </Button>
      )}
    </div>
  );
}

function ProviderCard({
  row,
  onChange,
}: {
  row: ProviderStatus;
  onChange: (next: ProviderStatus) => void;
}) {
  if (row.id === "codex") return <CodexCard row={row} onChange={onChange} />;
  if (row.id === "anthropic") return <ClaudeCard row={row} onChange={onChange} />;
  return <KeyCard row={row} onChange={onChange} />;
}

function StatusChip({ row }: { row: ProviderStatus }) {
  if (!row.configured) {
    return <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-subtle">Not set</span>;
  }
  if (row.fromEnv) {
    return <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">Workspace key</span>;
  }
  return (
    <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">
      {row.authKind === "oauth" ? `Connected ${row.hint ?? ""}`.trim() : row.hint}
    </span>
  );
}

function CardShell({
  row,
  children,
}: {
  row: ProviderStatus;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-bg-elevated p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{row.name}</h3>
            <StatusChip row={row} />
          </div>
          <p className="mt-1 text-xs text-fg-subtle">{row.blurb}</p>
        </div>
        <a
          href={row.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-accent hover:underline"
        >
          {row.docsLabel}
        </a>
      </div>
      {children}
    </section>
  );
}

type CodexSession = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  interval: number;
  expiresAt: number;
};

function CodexCard({
  row,
  onChange,
}: {
  row: ProviderStatus;
  onChange: (next: ProviderStatus) => void;
}) {
  const [session, setSession] = useState<CodexSession | null>(null);
  const [paste, setPaste] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(row.model);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setModel(row.model);
  }, [row.model]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await pollCodexLogin();
        if (cancelled) return;
        if (result.status === "ready") {
          onChange(result.provider);
          setSession(null);
          toast.success("ChatGPT connected");
          return;
        }
        if (result.status === "expired") {
          setSession(null);
          toast.error("That code expired. Try again, or paste a token.");
          return;
        }
        timer = window.setTimeout(tick, Math.max(result.interval, 3) * 1000);
      } catch (err) {
        if (cancelled) return;
        setSession(null);
        toast.error(err instanceof Error ? err.message : "Codex login failed");
      }
    };
    timer = window.setTimeout(tick, Math.max(session.interval, 3) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session, onChange]);

  async function connect() {
    setBusy(true);
    try {
      const start = await startCodexLogin();
      setSession(start);
      try {
        await navigator.clipboard.writeText(start.userCode);
        toast.success("Code copied. Approve it in ChatGPT.");
      } catch {
        toast.message("Approve this code in ChatGPT");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start ChatGPT login. Paste a token instead.");
    } finally {
      setBusy(false);
    }
  }

  async function savePaste() {
    if (!paste.trim()) return;
    setBusy(true);
    try {
      const next = await saveCodexPaste({ data: { raw: paste, model } });
      setPaste("");
      onChange(next);
      toast.success("Codex connected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save Codex token");
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    try {
      const next = await saveProviderKey({
        data: { provider: "codex", apiKey: apiKey.trim() || undefined, model },
      });
      setApiKey("");
      onChange(next);
      toast.success("Codex saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save key");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const next = await clearProviderKey({ data: { provider: "codex" } });
      onChange(next);
      toast.success("Codex disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setBusy(false);
    }
  }

  const openUrl = session?.verificationUriComplete || session?.verificationUri;

  return (
    <CardShell row={row}>
      <div className="mt-3 rounded-lg border border-border bg-bg-subtle/60 p-3">
        <p className="text-xs font-medium">ChatGPT subscription</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
          Device login uses the official Codex client. If this preview cannot complete the handshake, paste{" "}
          <span className="font-mono">~/.codex/auth.json</span> or an access token from the Codex CLI.
        </p>
        {session ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-border-strong bg-bg-elevated px-2.5 py-1 font-mono text-sm tracking-wider">
                {session.userCode}
              </span>
              <a href={openUrl ?? "#"} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                Open ChatGPT
              </a>
            </div>
            <p className="text-xs text-fg-muted">Waiting for approval…</p>
            <Button size="sm" variant="ghost" onClick={() => setSession(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            <Button size="sm" onClick={() => void connect()} disabled={busy}>
              {busy ? "Starting…" : "Connect ChatGPT"}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-1.5">
        <Label htmlFor="codex-paste">Or paste auth.json / access token</Label>
        <Textarea
          id="codex-paste"
          rows={3}
          spellCheck={false}
          placeholder='{"tokens":{"access_token":"…"}} or eyJ…'
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="codex-key">Or OpenAI API key</Label>
          <Input
            id="codex-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="codex-model">Model id</Label>
          <Input id="codex-model" spellCheck={false} value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void savePaste()} disabled={busy || !paste.trim()}>
          Save paste
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void saveKey()}
          disabled={busy || (!apiKey.trim() && model === row.model)}
        >
          Save key
        </Button>
        {row.configured && !row.fromEnv && (
          <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
    </CardShell>
  );
}

function ClaudeCard({
  row,
  onChange,
}: {
  row: ProviderStatus;
  onChange: (next: ProviderStatus) => void;
}) {
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(row.model);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setModel(row.model);
  }, [row.model]);

  async function saveAgent() {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const next = await saveClaudeAgentToken({ data: { token, model } });
      setToken("");
      onChange(next);
      toast.success("Claude Agent token saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save token");
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    try {
      const next = await saveProviderKey({
        data: { provider: "anthropic", apiKey: apiKey.trim() || undefined, model },
      });
      setApiKey("");
      onChange(next);
      toast.success("Anthropic saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save key");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const next = await clearProviderKey({ data: { provider: "anthropic" } });
      onChange(next);
      toast.success("Anthropic disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell row={row}>
      <div className="mt-3 rounded-lg border border-border bg-bg-subtle/60 p-3">
        <p className="text-xs font-medium">Claude Agent / Max</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
          Anthropic does not allow third-party apps to offer Sign in with Claude. On your machine run{" "}
          <span className="font-mono">claude setup-token</span> and paste the{" "}
          <span className="font-mono">sk-ant-oat01-…</span> token here. That is the official Agent SDK path.
        </p>
        <div className="mt-3 grid gap-1.5">
          <Label htmlFor="claude-oat">Setup token</Label>
          <Input
            id="claude-oat"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-oat01-…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={() => void saveAgent()} disabled={busy || !token.trim()}>
            Save Agent token
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="claude-key">Or API key</Label>
          <Input
            id="claude-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-api03-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="claude-model">Model id</Label>
          <Input id="claude-model" spellCheck={false} value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void saveKey()}
          disabled={busy || (!apiKey.trim() && model === row.model)}
        >
          Save key
        </Button>
        {row.configured && !row.fromEnv && (
          <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
    </CardShell>
  );
}

function KeyCard({
  row,
  onChange,
}: {
  row: ProviderStatus;
  onChange: (next: ProviderStatus) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(row.model);
  const [busy, setBusy] = useState(false);
  const noKey = row.auth === "none";

  useEffect(() => {
    setModel(row.model);
  }, [row.model]);

  async function save() {
    setBusy(true);
    try {
      const next = await saveProviderKey({
        data: {
          provider: row.id,
          apiKey: apiKey.trim() || undefined,
          model,
        },
      });
      setApiKey("");
      onChange(next);
      toast.success(`${row.name} saved to this account`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save key");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const next = await clearProviderKey({ data: { provider: row.id } });
      setApiKey("");
      onChange(next);
      toast.success(`${row.name} key removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell row={row}>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {!noKey && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${row.id}-key`}>API key</Label>
            <Input
              id={`${row.id}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={row.configured ? (row.hint ?? row.placeholder) : row.placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={`${row.id}-model`}>{noKey ? "Model id (local)" : "Model id"}</Label>
          <Input
            id={`${row.id}-model`}
            spellCheck={false}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>

      {row.id === "github" && (
        <p className="mt-2 text-xs text-fg-subtle">
          Use a GitHub personal access token with Models access — not the Legion login session.
        </p>
      )}
      {noKey && (
        <p className="mt-2 text-xs text-fg-subtle">
          No key. Talks to a local Ollama at 127.0.0.1. Save only if you want to pin the model id.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy || (!noKey && !apiKey.trim() && model === row.model)}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        {row.configured && !row.fromEnv && (
          <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={busy}>
            Remove key
          </Button>
        )}
      </div>
    </CardShell>
  );
}
