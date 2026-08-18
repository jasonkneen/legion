import { Dial, scrollToChild, type DialItem } from "@/components/ui/dial";
import type { ChatMessage, Seat } from "@/lib/chat/types";

/**
 * The chat's dial: one tick per message, long ones for what the human asked.
 *
 * A long chamber is mostly agent output, and the questions that shaped it are
 * buried in it — scrolling to find "the one where I asked about auth" means
 * reading everything in between. This is those questions in order, one click
 * away, with a preview so a mark on the ruler is enough to choose by.
 *
 * The dial itself is generic; this decides only what counts as a mark.
 */
export function MessageDial({
  messages,
  seats,
  scroller,
}: {
  messages: ChatMessage[];
  seats: Seat[];
  /** The scrolling element the ticks navigate. Must be a sibling, not a parent. */
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  // System notices are not part of the conversation's shape.
  const marks = messages.filter((m) => m.authorType !== "system");
  if (marks.filter((m) => m.authorType === "user").length < 2) return null;

  const items: DialItem[] = marks.map((message) => {
    const asked = message.authorType === "user";
    const seat = message.agentId ? seats.find((s) => s.id === message.agentId) : undefined;
    const who = asked ? "You" : `@${seat?.handle ?? "seat"}`;
    const text = message.content.replace(/\s+/g, " ");
    return {
      id: message.id,
      major: asked,
      label: `${who}: ${text.slice(0, 60)}`,
      preview: (
        <>
          <p className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{who}</p>
          <p className="mt-1 text-sm leading-snug text-fg">
            {text.slice(0, 180)}
            {text.length > 180 ? "…" : ""}
          </p>
        </>
      ),
    };
  });

  return (
    <Dial
      items={items}
      ariaLabel="Jump to a message"
      onSelect={(id) => scrollToChild(scroller.current, `[data-msg="${id}"]`)}
    />
  );
}
