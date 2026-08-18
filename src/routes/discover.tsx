import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AssistantEditor } from "@/components/assistant-editor";
import { SEAT_STACK_EDGE, SeatAvatar } from "@/components/seat-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { deleteAssistant, saveAssistant } from "@/lib/chat/assistant-actions";
import { createConversation } from "@/lib/chat/actions";
import { useAssistants } from "@/lib/chat/use-assistants";
import { MODEL_BY_ID, SEAT_PRESETS, type StoredAssistant } from "@/lib/models";

export const Route = createFileRoute("/discover")({ component: DiscoverPage });

function DiscoverPage() {
  const { user, isPending } = useCurrentUserState();
  const navigate = useNavigate();
  const { assistants, loading } = useAssistants();
  const [busy, setBusy] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<StoredAssistant | null>(null);

  if (isPending) {
    return (
      <div className="flex h-dvh bg-bg">
        <div className="hidden w-14 border-r border-border bg-bg-elevated md:block" />
        <div className="flex-1 animate-pulse bg-bg" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;

  const mine = assistants.filter((a) => !a.builtin);
  const featured = assistants.filter((a) => a.builtin);

  async function openAssistant(assistant: StoredAssistant) {
    if (busy) return;
    setBusy(assistant.id);
    try {
      const created = await createConversation({
        data: {
          title: assistant.name,
          seats: [
            {
              modelId: assistant.modelId,
              displayName: assistant.name,
              handle: assistant.handle,
              role: assistant.role,
            },
          ],
        },
      });
      await navigate({ to: "/c/$id", params: { id: created.conversation.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start chat");
    } finally {
      setBusy(null);
    }
  }

  async function openPreset(id: string) {
    const preset = SEAT_PRESETS.find((p) => p.id === id);
    if (!preset || busy) return;
    setBusy(id);
    try {
      const created = await createConversation({
        data: {
          title: preset.label,
          seats: preset.seats.map((s) => ({
            modelId: s.modelId,
            displayName: s.name,
            handle: s.handle,
            role: s.role,
          })),
        },
      });
      await navigate({ to: "/c/$id", params: { id: created.conversation.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start league");
    } finally {
      setBusy(null);
    }
  }

  function startCreate() {
    setEditing(null);
    setEditorOpen(true);
  }

  function startEdit(assistant: StoredAssistant) {
    setEditing(assistant);
    setEditorOpen(true);
  }

  async function duplicate(assistant: StoredAssistant) {
    try {
      await saveAssistant({
        data: {
          name: `${assistant.name} copy`,
          handle: `${assistant.handle}2`,
          modelId: assistant.modelId,
          role: assistant.role,
          blurb: assistant.blurb,
          tag: assistant.tag,
        },
      });
      window.dispatchEvent(new Event("chamber:assistants"));
      toast.success("Duplicated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not duplicate");
    }
  }

  async function remove(assistant: StoredAssistant) {
    try {
      await deleteAssistant({ data: { id: assistant.id } });
      window.dispatchEvent(new Event("chamber:assistants"));
      toast.success(assistant.builtin ? "Reset to default" : "Rank removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    }
  }

  return (
    <AppShell section="discover">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">Discover</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agents</h1>
              <p className="mt-2 max-w-xl text-sm text-fg-muted">
                Ranks we can seat. Edit a built-in, add our own, or open a league that shares one thread.
              </p>
            </div>
            <Button onClick={startCreate}>
              <Plus />
              New rank
            </Button>
          </div>

          {loading ? (
            <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="h-36 animate-pulse rounded-xl bg-bg-subtle" />
              <div className="h-36 animate-pulse rounded-xl bg-bg-subtle" />
              <div className="h-36 animate-pulse rounded-xl bg-bg-subtle" />
            </div>
          ) : (
            <>
              {mine.length > 0 && (
                <>
                  <h2 className="mt-8 mb-3 text-sm font-medium">Our ranks</h2>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {mine.map((a) => (
                      <AssistantCard
                        key={a.id}
                        assistant={a}
                        busy={Boolean(busy)}
                        onOpen={() => void openAssistant(a)}
                        onEdit={() => startEdit(a)}
                        onDuplicate={() => void duplicate(a)}
                        onRemove={() => void remove(a)}
                      />
                    ))}
                  </div>
                </>
              )}

              <h2 className="mt-8 mb-3 text-sm font-medium">The line</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {featured.map((a) => (
                  <AssistantCard
                    key={a.id}
                    assistant={a}
                    busy={Boolean(busy)}
                    onOpen={() => void openAssistant(a)}
                    onEdit={() => startEdit(a)}
                    onDuplicate={() => void duplicate(a)}
                    onRemove={() => void remove(a)}
                  />
                ))}
              </div>
            </>
          )}

          <h2 className="mt-10 mb-3 text-sm font-medium">Leagues</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {SEAT_PRESETS.filter((p) => p.seats.length > 1).map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void openPreset(p.id)}
                className="rounded-xl border border-border bg-bg-elevated p-4 text-left hover:bg-bg-subtle disabled:opacity-60"
              >
                <div className="flex -space-x-1.5">
                  {p.seats.map((s) => (
                    <SeatAvatar key={s.handle} modelId={s.modelId} name={s.name} size="sm" className={SEAT_STACK_EDGE} />
                  ))}
                </div>
                <div className="mt-3 text-sm font-medium">{p.label}</div>
                <div className="mt-1 text-xs text-fg-subtle">{p.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <AssistantEditor open={editorOpen} onOpenChange={setEditorOpen} initial={editing} />
    </AppShell>
  );
}

function AssistantCard({
  assistant,
  busy,
  onOpen,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  assistant: StoredAssistant;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const model = MODEL_BY_ID[assistant.modelId];
  return (
    <div className="group relative rounded-xl border border-border bg-bg-elevated p-4">
      <button
        type="button"
        disabled={busy}
        onClick={onOpen}
        className="w-full text-left disabled:opacity-60"
      >
        <div className="flex items-start justify-between gap-3 pr-16">
          <SeatAvatar modelId={assistant.modelId} name={assistant.name} />
          <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-subtle">{assistant.tag}</span>
        </div>
        <div className="mt-3 text-sm font-medium">{assistant.name}</div>
        <div className="mt-1 text-xs leading-relaxed text-fg-subtle">{assistant.blurb}</div>
        <div className="mt-3 text-[11px] text-fg-subtle">
          {model.name}
          {assistant.customized && assistant.builtin ? " · edited" : ""}
        </div>
      </button>
      <div className="absolute top-3 right-3 flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${assistant.name}`}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${assistant.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>Start chat</DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>Duplicate</DropdownMenuItem>
            {assistant.builtin ? (
              assistant.customized ? (
                <DropdownMenuItem onSelect={onRemove}>Reset default</DropdownMenuItem>
              ) : null
            ) : (
              <DropdownMenuItem onSelect={onRemove}>Delete</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
