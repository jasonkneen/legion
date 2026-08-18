import { Blobatar } from "blobatar/react";
import "blobatar/motion.css";
import { MODEL_BY_ID, type ModelId, type ModelTone } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * Each rank's hue, taken from the seat colour it already wears elsewhere.
 *
 * The blobatar's shape comes from the seat's name, so two Claudes in one room
 * are visibly different people; pinning the hue is what keeps them both
 * recognisably Claude. Measured from `--seat-*` in styles.css so the avatar and
 * the rest of the interface do not drift apart.
 *
 * Grok and Kimi are near-greys there — a hue read off them means nothing, so
 * they take the one their brand actually reads as rather than a number from an
 * almost-colourless swatch.
 */
const TONE_HUE: Record<ModelTone, number> = {
  grok: 240,
  gpt: 175,
  claude: 17,
  gemini: 224,
  deepseek: 215,
  kimi: 30,
  minimax: 86,
};

const PX: Record<"sm" | "md" | "lg", number> = { sm: 24, md: 32, lg: 40 };

/** How far the figure spills past its box, now that nothing is drawn behind it. */
const OVERSIZE = 1.38;

/**
 * The edge that separates overlapping faces in a stack.
 *
 * Not a ring: a ring traces the element's box, and a blob is not its box, so
 * overlapping avatars each got a rectangle drawn round them. A drop-shadow
 * follows the shape that was actually drawn, which is the only thing that works
 * once the backdrop plate is gone. Doubled because one pass is too faint to
 * read against a card.
 */
export const SEAT_STACK_EDGE =
  "[filter:drop-shadow(0_0_1.5px_var(--color-bg-elevated))_drop-shadow(0_0_1.5px_var(--color-bg-elevated))]";

export function seatTone(modelId: string): ModelTone {
  return MODEL_BY_ID[modelId as ModelId]?.tone ?? "grok";
}

/**
 * A seat's face.
 *
 * Deterministic from the seat's name, so the same rank looks the same in the
 * rail, on its messages, and in the picker without anything being stored. It
 * used to be two initials in a coloured circle, which meant every Claude-shaped
 * thing looked identical and a room of six was a row of near-identical discs.
 *
 * No backdrop: the plate the library can draw behind the figure left a pale
 * disc inside every dark chip. Without it the blob is the whole avatar, and it
 * is rendered a little over its box so it fills the space the disc used to.
 *
 * `working` is for the seat that is answering right now — it breathes, which is
 * a better sign of life than a spinner beside a still face. Everything else
 * animates on hover, which is cheap because these appear in tens, not hundreds.
 */
export function SeatAvatar({
  modelId,
  name,
  size = "md",
  working = false,
  className,
}: {
  modelId: string;
  name: string;
  size?: "sm" | "md" | "lg";
  /** This seat is mid-turn: animate without waiting to be hovered. */
  working?: boolean;
  className?: string;
}) {
  const px = PX[size];
  return (
    <Blobatar
      // Both parts matter: the name so two seats differ, the model so renaming
      // a seat does not hand it somebody else's face at random.
      name={`${modelId}:${name}`}
      hue={TONE_HUE[seatTone(modelId)]}
      size={px}
      background={false}
      animate={working ? "always" : "hover"}
      // Rendered over its nominal box, so the figure fills the room the backdrop
      // used to take up rather than floating in the middle of it. The negative
      // margin keeps the surrounding layout on the box it was built for.
      style={{ width: px * OVERSIZE, height: px * OVERSIZE, margin: (px * (OVERSIZE - 1)) / -2 }}
      className={cn("shrink-0 overflow-visible", className)}
      aria-hidden
    />
  );
}
