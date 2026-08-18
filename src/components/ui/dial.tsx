import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A dial: a column of ticks standing in for a long list, pinned beside it.
 *
 * Length is the only language — long ticks are the marks worth finding, short
 * ones are everything between. Nothing recolours, nothing tracks the scroll
 * position, nothing moves. A dial you can read at a glance beats one that keeps
 * announcing where you already are, and it must be a sibling of the scrolling
 * element rather than a child, or it slides away with the content.
 *
 * Generic on purpose: it knows about ticks and previews, not about messages.
 * Anything long and skimmable — a transcript, a diff, a log — can wear one.
 */
export type DialItem = {
  id: string;
  /** Long tick or short. The long ones are what someone is looking for. */
  major?: boolean;
  /** Read out to screen readers, and the tooltip's fallback text. */
  label: string;
  /** Shown on hover. Omit for a tick with nothing to say. */
  preview?: ReactNode;
};

export function Dial({
  items,
  onSelect,
  side = "left",
  className,
  ariaLabel = "Jump to an item",
}: {
  items: DialItem[];
  onSelect: (id: string) => void;
  side?: "left" | "right";
  className?: string;
  ariaLabel?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (items.length < 2) return null;

  // The dial has to fit its panel however long the list gets, so the spacing
  // closes up rather than running off the bottom. Past about forty items the
  // ticks pack together the way marks on a real dial do.
  const gap = items.length <= 40 ? 5 : Math.max(1, Math.floor(220 / items.length));

  return (
    <div
      className={cn(
        "absolute top-1/2 z-20 flex -translate-y-1/2 flex-col",
        side === "left" ? "left-1" : "right-1",
        className,
      )}
      style={{ gap: `${gap}px` }}
      onMouseLeave={() => setHovered(null)}
      aria-label={ariaLabel}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          onMouseEnter={() => setHovered(i)}
          onFocus={() => setHovered(i)}
          onClick={() => onSelect(item.id)}
          aria-label={item.label}
          // A generous hit area over a hairline mark: the tick is 1px tall and
          // nobody should have to aim for that.
          style={{ height: `${Math.max(2, gap)}px` }}
          className="group flex w-7 items-center outline-none"
        >
          <span
            className={cn(
              "block h-px rounded-full bg-fg",
              item.major ? "w-5 opacity-70" : "w-2.5 opacity-25",
              "group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          />
        </button>
      ))}

      {hovered !== null && items[hovered]?.preview && (
        <div
          className={cn(
            "pointer-events-none absolute w-72 -translate-y-1/2 rounded-xl border border-border bg-bg-elevated p-3 shadow-lg",
            side === "left" ? "left-9" : "right-9",
          )}
          style={{ top: `${((hovered + 0.5) / items.length) * 100}%` }}
        >
          {items[hovered].preview}
        </div>
      )}
    </div>
  );
}

/**
 * Scroll a container to one of its children, without disturbing anything else.
 *
 * `scrollIntoView` walks up and scrolls every scrollable ancestor it finds,
 * which drags the whole app — side rail and all — off the top of the window.
 * Setting scrollTop on the one container moves what was asked for and nothing
 * more.
 */
export function scrollToChild(container: HTMLElement | null, selector: string, offset = 24): void {
  const row = container?.querySelector<HTMLElement>(selector);
  if (!container || !row) return;
  const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  container.scrollTo({ top: Math.max(0, top - offset), behavior: "smooth" });
}
