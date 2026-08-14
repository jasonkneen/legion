import { Link } from "@tanstack/react-router";
import { MessageSquarePlus, Trash2, Users } from "lucide-react";
import { BrandMark, BrandWord } from "@/components/brand";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/lib/chat/types";
import { SEAT_PRESETS, type StoredAssistant } from "@/lib/models";
import { cn, relativeTime } from "@/lib/utils";

export function Sidebar({
  conversations,
  activeId,
  assistants,
  onNew,
  onOpenAssistant,
  onDelete,
  creating,
}: {
  conversations: Conversation[];
  activeId?: string;
  assistants: StoredAssistant[];
  onNew: () => void;
  onOpenAssistant: (id: string) => void;
  onDelete: (id: string) => void;
  creating?: boolean;
}) {
  const shown = assistants.slice(0, 8);
  const first = assistants[0];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-4 pb-2">
        <BrandWord />
        <Button variant="ghost" size="icon-sm" onClick={onNew} disabled={creating} aria-label="New chat">
          <MessageSquarePlus />
        </Button>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          disabled={creating}
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl bg-bg-subtle px-2.5 py-2 text-left hover:bg-bg-subtle/80 disabled:opacity-60"
        >
          <span className="shrink-0">
            <BrandMark className="size-8 rounded-[10px] [&>svg]:size-[22px]" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">The room</span>
            <span className="block truncate text-[11px] text-fg-subtle">
              {first && first.id === "just-chat" ? first.name : "Assemble"}
            </span>
          </span>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">Conversations</p>
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-sm text-fg-subtle">No chats yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((c) => (
              <li key={c.id} className="group relative">
                <Link
                  to="/c/$id"
                  params={{ id: c.id }}
                  className={cn(
                    "block rounded-lg px-2.5 py-2 pr-9 hover:bg-bg-subtle",
                    activeId === c.id && "bg-bg-subtle",
                  )}
                >
                  <div className="truncate text-sm font-medium">{c.title}</div>
                  <div className="text-xs text-fg-subtle">{relativeTime(c.updatedAt)}</div>
                </Link>
                <button
                  type="button"
                  aria-label={`Delete ${c.title}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                  className="absolute top-1/2 right-1.5 hidden size-7 -translate-y-1/2 place-items-center rounded-md text-fg-subtle hover:bg-bg hover:text-fg group-hover:grid"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="px-2 pt-5 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">Agents</p>
        <ul className="flex flex-col gap-0.5">
          {shown.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                disabled={creating}
                onClick={() => onOpenAssistant(a.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-bg-subtle disabled:opacity-60"
              >
                <span className="grid size-7 place-items-center rounded-lg bg-bg-subtle text-[10px] font-semibold">
                  {a.name.slice(0, 1)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{a.name}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">{a.tag}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="px-2 pt-5 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">Leagues</p>
        <ul className="flex flex-col gap-0.5">
          {SEAT_PRESETS.filter((p) => p.seats.length > 1).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={creating}
                onClick={() => onOpenAssistant(p.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-bg-subtle disabled:opacity-60"
              >
                <span className="grid size-7 place-items-center rounded-lg bg-bg-subtle text-fg-muted">
                  <Users className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{p.label}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">{p.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
