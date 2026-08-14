import { useMemo, useState } from "react";
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
import { SeatAvatar } from "@/components/seat-avatar";
import { MODELS, ROLE_PRESETS, type ModelId } from "@/lib/models";
import { slugHandle } from "@/lib/chat/ids";
import type { NewSeatInput, Seat } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

export type AfterSeat = "wait" | "introduce" | "review";

export function AddSeatDialog({
  open,
  onOpenChange,
  existing,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: Seat[];
  onAdd: (seat: NewSeatInput, after: AfterSeat) => Promise<void>;
}) {
  const [modelId, setModelId] = useState<ModelId>("grok-4.6");
  const [name, setName] = useState("Grok");
  const [handle, setHandle] = useState("grok");
  const [handleTouched, setHandleTouched] = useState(false);
  const [role, setRole] = useState<string>(ROLE_PRESETS[0].text);
  const [after, setAfter] = useState<AfterSeat>("wait");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taken = useMemo(() => new Set(existing.map((s) => s.handle)), [existing]);
  const model = MODELS.find((m) => m.id === modelId)!;
  const sameModelCount = existing.filter((s) => s.modelId === modelId).length;

  function pickModel(id: ModelId) {
    const next = MODELS.find((m) => m.id === id)!;
    setModelId(id);
    const suggestedName =
      sameModelCount === 0 && id === modelId ? next.name.split(" ")[0]! : next.name.split(" ")[0]!;
    const baseName = existing.some((s) => s.displayName === suggestedName)
      ? `${suggestedName} ${sameModelCount + 1}`
      : suggestedName;
    setName(baseName);
    if (!handleTouched) setHandle(slugHandle(next.handle === "grok" && sameModelCount > 0 ? `${next.handle}${sameModelCount + 1}` : next.handle));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onAdd(
        {
          modelId,
          displayName: name.trim() || model.name,
          handle: handle.trim() || model.handle,
          role: role.trim(),
        },
        after,
      );
      onOpenChange(false);
      setAfter("wait");
      setHandleTouched(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add seat");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Seat a rank</DialogTitle>
          <DialogDescription>
            Bring another agent into this league. Same model, different charge is fine — we @ them by name.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => pickModel(m.id)}
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

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="seat-name">Name</Label>
            <Input
              id="seat-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!handleTouched) setHandle(slugHandle(e.target.value));
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="seat-handle">Handle</Label>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle">
                @
              </span>
              <Input
                id="seat-handle"
                className="pl-7"
                value={handle}
                onChange={(e) => {
                  setHandleTouched(true);
                  setHandle(slugHandle(e.target.value));
                }}
              />
            </div>
            {taken.has(slugHandle(handle)) && (
              <p className="text-[11px] text-fg-subtle">That handle is taken — it will get a suffix.</p>
            )}
          </div>
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
          <Textarea value={role} onChange={(e) => setRole(e.target.value)} rows={3} />
        </div>

        <div className="grid gap-1.5">
          <Label>After seating</Label>
          <div className="grid gap-1.5">
            {(
              [
                ["wait", "Wait — we'll @ them"],
                ["introduce", "Have them introduce this rank"],
                ["review", "Ask them to review the latest reply"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="after-seat"
                  checked={after === value}
                  onChange={() => setAfter(value)}
                  className="accent-fg"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? "Seating…" : "Add seat"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
