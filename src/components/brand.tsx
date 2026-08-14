import { cn } from "@/lib/utils";

/** Three stacked chevrons — a legion standard. Reads at 16px. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <path
        d="M8 12.1 16 6.4l8 5.7-2.05 2.85L16 10.5l-5.95 4.45L8 12.1Zm0 6.35L16 12.75l8 5.7-2.05 2.85-5.95-4.45-5.95 4.45L8 18.45Zm0 6.35L16 19.1l8 5.7-2.05 2.85L16 23.2l-5.95 4.45L8 24.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-8 place-items-center rounded-[10px] bg-accent text-accent-fg",
        className,
      )}
      aria-hidden
    >
      <BrandGlyph className="size-[22px]" />
    </span>
  );
}

export function BrandWord({ className }: { className?: string }) {
  return (
    <span className={cn("text-[15px] font-semibold tracking-tight", className)}>Legion</span>
  );
}

export function BrandLockup({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark className={markClassName} />
      <BrandWord />
    </span>
  );
}
