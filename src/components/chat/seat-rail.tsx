import { useEffect, useState } from "react";
import { Eye, Pencil, Plus, X } from "lucide-react";
import { SeatAvatar } from "@/components/seat-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MODEL_BY_ID, providerForModel, type ModelId } from "@/lib/models";
import { listSeatReach } from "@/lib/chat/capability-actions";
import type { SeatReach } from "@/lib/chat/reach.server";
import type { Seat } from "@/lib/chat/types";

export function SeatRail({
  seats,
  missingHandles,
  onAdd,
  onRemove,
  onAsk,
}: {
  seats: Seat[];
  missingHandles?: Set<string>;
  onAdd: () => void;
  onRemove: (seat: Seat) => void;
  onAsk: (handle: string, task: string, prompt: string) => void;
}) {
  // What each seat can actually do differs — one can edit files with your
  // permission, the next cannot touch the disk at all. Fetched once for the
  // whole rail rather than per menu, and only when there are seats to describe.
  const [reach, setReach] = useState<Record<string, SeatReach>>({});
  const providers = [...new Set(seats.map((s) => providerForModel(s.modelId)))].sort().join(",");
  useEffect(() => {
    if (!providers) return;
    let stopped = false;
    void listSeatReach({ data: providers.split(",") })
      .then((rows) => {
        if (stopped) return;
        setReach(Object.fromEntries(rows.map((r) => [r.provider, r])));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [providers]);

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {seats.map((seat) => {
        const model = MODEL_BY_ID[seat.modelId as ModelId];
        const missing = missingHandles?.has(seat.handle);
        return (
          <DropdownMenu key={seat.id}>
            <DropdownMenuTrigger className="relative flex items-center gap-1.5 rounded-full border border-border bg-bg-elevated py-1 pr-2.5 pl-1 hover:bg-bg-subtle">
              <SeatAvatar modelId={seat.modelId} name={seat.displayName} size="sm" />
              <span className="text-xs font-medium whitespace-nowrap">{seat.displayName}</span>
              {missing && <span className="absolute top-0 right-0 size-2 rounded-full bg-danger" />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>
                @{seat.handle}
                {model ? ` · ${model.name}` : ""}
              </DropdownMenuLabel>
              {seat.role && <p className="px-2 pb-1.5 text-xs leading-relaxed text-fg-muted">{seat.role}</p>}
              {missing && (
                <p className="px-2 pb-1.5 text-xs text-danger">No API key for {model?.vendor ?? "this provider"}.</p>
              )}
              <SeatReachNote reach={reach[providerForModel(seat.modelId)]} />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  onAsk(
                    seat.handle,
                    "Review the latest reply.",
                    `@${seat.handle} Review the latest reply in this chat. Be specific.`,
                  )
                }
              >
                Ask to review
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  onAsk(seat.handle, "Jump in and help.", `@${seat.handle} Jump in and help with whatever is on the table.`)
                }
              >
                Ask to jump in
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger" onSelect={() => onRemove(seat)}>
                <X className="size-3.5" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      <Button variant="ghost" size="icon-sm" onClick={onAdd} aria-label="Seat a rank" className="rounded-full">
        <Plus />
      </Button>
    </div>
  );
}

/**
 * One line on what this seat can reach, so "@seat fix the file" is not a guess.
 *
 * Nothing is rendered until the answer arrives: a menu that first claims
 * read-only and then changes its mind is worse than one that waits a beat.
 */
function SeatReachNote({ reach }: { reach?: SeatReach }) {
  if (!reach) return null;
  const Icon = reach.canWrite ? Pencil : Eye;
  return (
    <div className="px-2 pb-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <Icon className="size-3 shrink-0" />
        {reach.canWrite ? "Can edit with your approval" : "Read-only"}
        {reach.route === "cli" && reach.cli ? ` · ${reach.cli} CLI` : ""}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{reach.note}</p>
    </div>
  );
}
