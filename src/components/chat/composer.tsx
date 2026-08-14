import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeatAvatar } from "@/components/seat-avatar";
import { splitMentionQuery } from "@/lib/chat/mentions";
import type { Seat } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

export function Composer({
  seats,
  disabled,
  placeholder,
  onSend,
  onAddSeat,
}: {
  seats: Seat[];
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string, askAll: boolean) => void;
  onAddSeat?: () => void;
}) {
  const [value, setValue] = useState("");
  const [askAll, setAskAll] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const caret = areaRef.current?.selectionStart ?? value.length;
  const mention = splitMentionQuery(value, caret);
  const mentionOptions = useMemo(() => {
    if (!mention.active) return [];
    const q = mention.query.toLowerCase();
    const rows: { handle: string; label: string; seat?: Seat }[] = [
      { handle: "all", label: "The whole league" },
      ...seats.map((s) => ({ handle: s.handle, label: s.displayName, seat: s })),
    ];
    return rows.filter((r) => r.handle.startsWith(q) || r.label.toLowerCase().includes(q));
  }, [mention.active, mention.query, seats]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mention.query, mention.active]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  function insertMention(handle: string) {
    const el = areaRef.current;
    const pos = el?.selectionStart ?? value.length;
    const { start } = splitMentionQuery(value, pos);
    if (start < 0) return;
    const next = `${value.slice(0, start)}@${handle} ${value.slice(pos)}`;
    setValue(next);
    requestAnimationFrame(() => {
      const caretTo = start + handle.length + 2;
      el?.focus();
      el?.setSelectionRange(caretTo, caretTo);
    });
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text, askAll);
    setValue("");
  }

  return (
    <div className="relative">
      {mention.active && mentionOptions.length > 0 && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-bg-elevated p-1 shadow-composer">
          {mentionOptions.map((opt, i) => (
            <button
              key={opt.handle}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(opt.handle);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                i === mentionIndex ? "bg-bg-subtle" : "hover:bg-bg-subtle",
              )}
            >
              {opt.seat ? (
                <SeatAvatar modelId={opt.seat.modelId} name={opt.seat.displayName} size="sm" />
              ) : (
                <span className="grid size-6 place-items-center rounded-full bg-bg-subtle text-[10px] font-medium">
                  *
                </span>
              )}
              <span className="font-medium">@{opt.handle}</span>
              <span className="truncate text-xs text-fg-subtle">{opt.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-elevated shadow-composer">
        <textarea
          ref={areaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? "Message the table. Use @ to call a seat."}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (mention.active && mentionOptions.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionOptions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(mentionOptions[mentionIndex]?.handle ?? "all");
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                areaRef.current?.blur();
                areaRef.current?.focus();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-44 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] text-fg outline-none placeholder:text-fg-subtle disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            {onAddSeat && (
              <Button type="button" variant="ghost" size="icon-sm" onClick={onAddSeat} aria-label="Add a seat">
                <Plus />
              </Button>
            )}
            <button
              type="button"
              onClick={() => setAskAll((v) => !v)}
              className={cn(
                "h-8 rounded-full px-2.5 text-xs font-medium",
                askAll ? "bg-bg-subtle text-fg" : "text-fg-subtle hover:bg-bg-subtle hover:text-fg",
              )}
            >
              Ask all
            </button>
          </div>
          <Button
            type="button"
            size="icon-sm"
            onClick={submit}
            disabled={disabled || !value.trim()}
            aria-label="Send"
            className="rounded-full"
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}
