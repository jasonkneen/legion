import { useState } from "react";
import type { ChatMessage, Seat } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * A dial down the side of the chat.
 *
 * One tick per message, evenly spaced, so the column reads as a ruler of the
 * whole conversation. The long ticks are the things the human said; everything
 * the agents replied is a short one. That is the entire signal — no colour, no
 * active state, nothing that moves as you scroll. A dial you can read at a
 * glance is worth more than one that keeps telling you where you already are.
 *
 * Hovering a tick shows what was said there, because a mark on a ruler is not
 * enough to choose by. Clicking jumps to it.
 */
export function MessageDial({
  messages,
  seats,
  scroller,
}: {
  messages: ChatMessage[];
  seats: Seat[];
  /** The scrolling element the ticks navigate. */
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  // System notices are not part of the conversation's shape.
  const marks = messages.filter((m) => m.authorType !== "system");
  if (marks.filter((m) => m.authorType === "user").length < 2) return null;

  const jump = (id: string) => {
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>(`[data-msg="${id}"]`);
    if (!el || !row) return;
    // Deliberately not `scrollIntoView`: that walks up and scrolls every
    // scrollable ancestor it finds, which dragged the whole app shell — side
    // rail and all — off the top of the window. Setting scrollTop on the
    // message list moves the messages and nothing else.
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
  };

  // The dial has to fit the panel however long the chamber gets, so the spacing
  // closes up as messages accumulate rather than running off the bottom. Below
  // about forty messages nothing changes; past that the ticks pack together the
  // way marks on a real dial do.
  const gap = marks.length <= 40 ? 5 : Math.max(1, Math.floor(220 / marks.length));

  return (
    <div
      className="absolute top-1/2 left-1 z-20 flex -translate-y-1/2 flex-col"
      style={{ gap: `${gap}px` }}
      onMouseLeave={() => setHovered(null)}
      aria-label="Jump to a message"
    >
      {marks.map((message, i) => {
        const isQuestion = message.authorType === "user";
        const seat = message.agentId ? seats.find((s) => s.id === message.agentId) : undefined;
        return (
          <button
            key={message.id}
            type="button"
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setHovered(i)}
            onClick={() => jump(message.id)}
            aria-label={`${isQuestion ? "You" : (seat?.handle ?? "Reply")}: ${message.content
              .replace(/\s+/g, " ")
              .slice(0, 60)}`}
            // A generous hit area over a hairline mark: the tick is 1px tall and
            // nobody should have to aim for that.
            style={{ height: `${Math.max(2, gap)}px` }}
            className="group flex w-7 items-center outline-none"
          >
            <span
              className={cn(
                "block h-px rounded-full bg-fg",
                // Length is the whole language of the dial: long for what the
                // human said, short for what came back.
                isQuestion ? "w-5 opacity-70" : "w-2.5 opacity-25",
                "group-hover:opacity-100 group-focus-visible:opacity-100",
              )}
            />
          </button>
        );
      })}

      {hovered !== null && marks[hovered] && (
        <MessagePreview
          message={marks[hovered]}
          seat={
            marks[hovered].agentId ? seats.find((s) => s.id === marks[hovered].agentId) : undefined
          }
          // Sits beside the tick being hovered rather than at a fixed height.
          offset={`${((hovered + 0.5) / marks.length) * 100}%`}
        />
      )}
    </div>
  );
}

/** What was said at this mark, enough of it to recognise. */
function MessagePreview({
  message,
  seat,
  offset,
}: {
  message: ChatMessage;
  seat?: Seat;
  offset: string;
}) {
  const who = message.authorType === "user" ? "You" : `@${seat?.handle ?? "seat"}`;
  return (
    <div
      className="pointer-events-none absolute left-9 w-72 -translate-y-1/2 rounded-xl border border-border bg-bg-elevated p-3 shadow-lg"
      style={{ top: offset }}
    >
      <p className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{who}</p>
      <p className="mt-1 text-sm leading-snug text-fg">
        {message.content.replace(/\s+/g, " ").slice(0, 180)}
        {message.content.length > 180 ? "…" : ""}
      </p>
    </div>
  );
}
