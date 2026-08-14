import { MODEL_BY_ID, type ModelId, type ModelTone } from "@/lib/models";
import { cn } from "@/lib/utils";

const TONE: Record<ModelTone, string> = {
  grok: "bg-seat-grok text-seat-grok-fg",
  gpt: "bg-seat-gpt text-seat-gpt-fg",
  claude: "bg-seat-claude text-seat-claude-fg",
  gemini: "bg-seat-gemini text-seat-gemini-fg",
  deepseek: "bg-seat-deepseek text-seat-deepseek-fg",
  kimi: "bg-seat-kimi text-seat-kimi-fg",
  minimax: "bg-seat-minimax text-seat-minimax-fg",
};

export function seatTone(modelId: string): ModelTone {
  return MODEL_BY_ID[modelId as ModelId]?.tone ?? "grok";
}

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
  const model = MODEL_BY_ID[modelId as ModelId];
  const initials = model?.initials ?? name.slice(0, 1).toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium tracking-tight",
        TONE[seatTone(modelId)],
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-10 text-sm",
        className,
      )}
      aria-hidden
    >
      {initials}
    </span>
  );
}
