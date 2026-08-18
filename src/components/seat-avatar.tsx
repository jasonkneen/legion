import { Blobatar } from "blobatar/react";
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
 */
export function SeatAvatar({
  modelId,
  name,
  size = "md",
  className,
}: {
  modelId: string;
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <Blobatar
      // Both parts matter: the name so two seats differ, the model so renaming
      // a seat does not hand it somebody else's face at random.
      name={`${modelId}:${name}`}
      hue={TONE_HUE[seatTone(modelId)]}
      size={PX[size]}
      background="circle"
      className={cn("shrink-0 rounded-full", className)}
      alt=""
      aria-hidden
    />
  );
}
