import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { SeatAvatar } from "@/components/seat-avatar";
import { BrandMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { createConversation } from "@/lib/chat/actions";
import { APP_BLURB, APP_TAGLINE } from "@/lib/brand";
import { ASSISTANTS, SEAT_PRESETS } from "@/lib/models";
import { cn } from "@/lib/utils";

export function EmptyChamber() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  async function openPreset(id: string) {
    const preset = SEAT_PRESETS.find((p) => p.id === id);
    const assistant = ASSISTANTS.find((a) => a.id === id);
    if ((!preset && !assistant) || busy) return;
    setBusy(id);
    try {
      const seats = preset
        ? preset.seats.map((s) => ({
            modelId: s.modelId,
            displayName: s.name,
            handle: s.handle,
            role: s.role,
          }))
        : [
            {
              modelId: assistant!.modelId,
              displayName: assistant!.name,
              handle: assistant!.handle,
              role: assistant!.role,
            },
          ];
      const created = await createConversation({
        data: { title: preset?.label ?? assistant?.name ?? "New chat", seats },
      });
      await navigate({ to: "/c/$id", params: { id: created.conversation.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open a chat");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-2xl text-center">
        <BrandMark className="mx-auto size-12 rounded-[14px] [&>svg]:size-8" />
        <h1 className="mt-5 text-4xl font-semibold tracking-tight md:text-5xl">{APP_TAGLINE}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-fg-muted">
          {APP_BLURB} Seat a rank or a whole league. We share one thread and @ each other.
        </p>

        <div className="mt-8 grid gap-2 text-left sm:grid-cols-2">
          {[...SEAT_PRESETS].map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void openPreset(preset.id)}
              className={cn(
                "rounded-xl border border-border bg-bg-elevated p-3.5 text-left transition-colors hover:bg-bg-subtle disabled:opacity-60",
              )}
            >
              <div className="flex -space-x-1.5">
                {preset.seats.map((s) => (
                  <SeatAvatar key={s.handle} modelId={s.modelId} name={s.name} size="sm" className="ring-2 ring-bg-elevated" />
                ))}
              </div>
              <div className="mt-3 text-sm font-medium">{preset.label}</div>
              <div className="mt-1 text-xs leading-relaxed text-fg-subtle">{preset.description}</div>
            </button>
          ))}
        </div>

        <div className="mt-8">
          <Button onClick={() => void openPreset("solo-grok")} disabled={Boolean(busy)}>
            {busy ? "Opening…" : "Assemble"}
          </Button>
        </div>
      </div>
    </div>
  );
}
