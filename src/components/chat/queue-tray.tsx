import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Pencil, SendHorizontal, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A message typed while the league was still answering. */
export type QueuedMessage = {
  id: string;
  text: string;
  askAll: boolean;
};

/**
 * The tray above the composer.
 *
 * A turn can take a minute when a seat is shelling out to a local CLI, and the
 * human should not have to sit on their hands: anything typed meanwhile lands
 * here and is sent when the room goes quiet. Empty renders nothing at all, one
 * item renders as itself, and several collapse behind a count so a long queue
 * cannot push the composer off screen.
 */
export function QueueTray({
  queue,
  draining,
  onEdit,
  onSendNow,
  onRemove,
  onClear,
}: {
  queue: QueuedMessage[];
  /**
   * A seat is mid-turn. Shown as a hint only — rows stay editable, since
   * reordering and rewording what has *not* been sent is the point of a queue.
   */
  draining: boolean;
  onEdit: (id: string, text: string) => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  // An item can leave the queue underneath an open editor (sent, or removed in
  // another tab); drop the editor rather than write into a row that is gone.
  useEffect(() => {
    if (editing && !queue.some((q) => q.id === editing.id)) setEditing(null);
    if (queue.length === 0) setCollapsed(true);
  }, [queue, editing]);

  if (queue.length === 0) return null;

  const expanded = queue.length === 1 || !collapsed || editing !== null;

  const saveEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text) onEdit(editing.id, text);
    setEditing(null);
  };

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-bg-subtle/60">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-medium text-fg-muted">
          {queue.length === 1 ? "1 message queued" : `${queue.length} messages queued`}
        </span>
        {draining && <span className="text-xs text-fg-subtle">sending…</span>}
        <div className="flex-1" />
        {queue.length > 1 && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-bg-subtle hover:text-fg"
            aria-expanded={expanded}
          >
            {collapsed ? "Show" : "Hide"}
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="rounded-md px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-bg-subtle hover:text-fg"
        >
          Clear
        </button>
      </div>

      {expanded && (
        <ul className="space-y-1 px-2 pb-2">
          {queue.map((item, index) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5"
            >
              <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">{index + 1}</span>

              {editing?.id === item.id ? (
                <input
                  autoFocus
                  value={editing.text}
                  onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveEdit();
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={saveEdit}
                  className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
                  {item.askAll && <span className="mr-1 text-xs text-fg-subtle">(all)</span>}
                  {item.text}
                </span>
              )}

              {editing?.id === item.id ? (
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(null)} aria-label="Cancel edit">
                  <X />
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditing({ id: item.id, text: item.text })}
                    aria-label="Edit queued message"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onSendNow(item.id)}
                    aria-label="Send this one next"
                  >
                    <SendHorizontal />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onRemove(item.id)}
                    aria-label="Remove from queue"
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
