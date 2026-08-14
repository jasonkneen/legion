import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SeatAvatar } from "@/components/seat-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveAssistant } from "@/lib/chat/assistant-actions";
import { slugHandle } from "@/lib/chat/ids";
import { ASSISTANT_TAGS, MODELS, ROLE_PRESETS, type ModelId, type StoredAssistant } from "@/lib/models";
import { cn } from "@/lib/utils";

export function AssistantEditor({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: StoredAssistant | null;
}) {
  const creating = !initial;
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [modelId, setModelId] = useState<ModelId>("grok-4.6");
  const [tag, setTag] = useState<string>("Custom");
  const [blurb, setBlurb] = useState("");
  const [role, setRole] = useState<string>(ROLE_PRESETS[0].text);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setHandle(initial.handle);
      setHandleTouched(true);
      setModelId(initial.modelId);
      setTag(initial.tag);
      setBlurb(initial.blurb);
      setRole(initial.role);
    } else {
      setName("");
      setHandle("");
      setHandleTouched(false);
      setModelId("grok-4.6");
      setTag("Custom");
      setBlurb("");
      setRole(ROLE_PRESETS[0].text);
    }
  }, [open, initial]);

  async function submit() {
    setBusy(true);
    try {
      await saveAssistant({
        data: {
          id: initial?.id,
          name,
          handle,
          modelId,
          role,
          blurb,
          tag,
        },
      });
      window.dispatchEvent(new Event("chamber:assistants"));
      toast.success(creating ? "Rank seated" : "Rank updated");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save rank");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{creating ? "New rank" : `Edit ${initial.name}`}</DialogTitle>
          <DialogDescription>
            Name, model, and a charge. The charge is what this rank reads when it sits down. We, never I.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="asst-name">Name</Label>
            <Input
              id="asst-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!handleTouched) setHandle(slugHandle(e.target.value));
              }}
              placeholder="Reviewer"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="asst-handle">Handle</Label>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle">
                @
              </span>
              <Input
                id="asst-handle"
                className="pl-7"
                value={handle}
                onChange={(e) => {
                  setHandleTouched(true);
                  setHandle(slugHandle(e.target.value));
                }}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label>Model</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModelId(m.id)}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  modelId === m.id ? "border-border-strong bg-bg-subtle" : "border-border hover:bg-bg-subtle",
                )}
              >
                <SeatAvatar modelId={m.id} name={m.name} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{m.name}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">{m.vendor}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label>Tag</Label>
          <div className="flex flex-wrap gap-1.5">
            {ASSISTANT_TAGS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTag(t)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs",
                  tag === t ? "border-border-strong bg-bg-subtle" : "border-border text-fg-muted hover:bg-bg-subtle",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="asst-blurb">Short blurb</Label>
          <Input
            id="asst-blurb"
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            placeholder="Shown on the card"
          />
        </div>

        <div className="grid gap-1.5">
          <Label>Role</Label>
          <div className="flex flex-wrap gap-1.5">
            {ROLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setRole(preset.text)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs",
                  role === preset.text
                    ? "border-border-strong bg-bg-subtle"
                    : "border-border text-fg-muted hover:bg-bg-subtle",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <Textarea value={role} onChange={(e) => setRole(e.target.value)} rows={4} />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : creating ? "Create" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
