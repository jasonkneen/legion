import { MoreHorizontal } from "lucide-react";
import { RichText } from "@/components/markdown";
import { SeatAvatar } from "@/components/seat-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MODEL_BY_ID, type ModelId } from "@/lib/models";
import type { ChatMessage, Seat } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

function highlightMentions(text: string, seats: Seat[]) {
  const handles = new Set(["all", ...seats.map((s) => s.handle)]);
  const parts = text.split(/(@[a-z0-9_]{1,24})/gi);
  return parts.map((part, i) => {
    if (part.startsWith("@") && handles.has(part.slice(1).toLowerCase())) {
      return (
        <span key={i} className="font-medium text-fg">
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function MessageItem({
  message,
  seat,
  seats,
  streaming,
  onAsk,
}: {
  message: ChatMessage;
  seat?: Seat;
  seats: Seat[];
  streaming?: boolean;
  onAsk?: (handle: string, task: string, prompt: string) => void;
}) {
  if (message.authorType === "system") {
    return (
      <div className="mx-auto max-w-2xl px-1 py-2 text-center text-xs text-fg-subtle">{message.content}</div>
    );
  }

  if (message.authorType === "user") {
    return (
      <div className="mx-auto flex w-full max-w-2xl justify-end px-1 py-3">
        <div className="max-w-[min(40rem,92%)] rounded-xl bg-bg-subtle px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
          {highlightMentions(message.content, seats)}
        </div>
      </div>
    );
  }

  const model = seat ? MODEL_BY_ID[seat.modelId as ModelId] : undefined;

  return (
    <article className="mx-auto w-full max-w-2xl px-1 py-4">
      <header className="mb-2 flex items-center gap-2">
        <SeatAvatar modelId={seat?.modelId ?? "grok-4.6"} name={seat?.displayName ?? "Seat"} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{seat?.displayName ?? "Seat"}</span>
            <span className="text-xs text-fg-subtle">
              @{seat?.handle}
              {model ? ` · ${model.name}` : ""}
            </span>
          </div>
        </div>
        {onAsk && seats.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="grid size-8 place-items-center rounded-md text-fg-subtle hover:bg-bg-subtle hover:text-fg">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Ask another seat</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Ask a seat about this</DropdownMenuLabel>
              {seats.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() =>
                    onAsk(
                      s.handle,
                      "Review this reply.",
                      `@${s.handle} Review the last reply from ${seat?.displayName ?? "the other seat"}. Be specific about what works, what is wrong, and what to change.`,
                    )
                  }
                >
                  @{s.handle} review
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {seats.map((s) => (
                <DropdownMenuItem
                  key={`${s.id}-jump`}
                  onSelect={() =>
                    onAsk(
                      s.handle,
                      "Jump in and help.",
                      `@${s.handle} Jump in. Add what the last reply missed, or take the next step.`,
                    )
                  }
                >
                  @{s.handle} jump in
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div className={cn(streaming && !message.content && "min-h-6")}>
        {message.content ? (
          <RichText content={message.content} />
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-fg-subtle">
            <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle" />
            thinking
          </span>
        )}
        {streaming && message.content && (
          <span className="ml-0.5 inline-block h-4 w-1 translate-y-0.5 animate-pulse bg-fg/70" />
        )}
      </div>
    </article>
  );
}
