import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PendingQuestion } from "@/lib/chat/questions.server";
import { cn } from "@/lib/utils";

/**
 * A seat's question to the human, as tabs — one per question.
 *
 * Docked above the composer like the approval prompt, for the same reason: the
 * turn is parked on it and it only makes sense beside the conversation that
 * raised it. Every question also accepts free text, because a fixed list of
 * options is the model's guess at the answer space, not the truth.
 */
export function QuestionForm({
  request,
  onSubmit,
  onDismiss,
}: {
  request: PendingQuestion;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const active = request.questions[tab];
  if (!active) return null;

  const chosen = answers[active.header] ?? [];

  const pick = (label: string) => {
    setAnswers((prev) => {
      const current = prev[active.header] ?? [];
      if (active.multiSelect) {
        return {
          ...prev,
          [active.header]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
        };
      }
      return { ...prev, [active.header]: [label] };
    });
  };

  /** A question counts as answered by a selection or by free text. */
  const answeredCount = request.questions.filter(
    (q) => (answers[q.header]?.length ?? 0) > 0 || (other[q.header] ?? "").trim(),
  ).length;

  const submit = async () => {
    setBusy(true);
    try {
      const payload: Record<string, string> = {};
      for (const q of request.questions) {
        const picks = answers[q.header] ?? [];
        const free = (other[q.header] ?? "").trim();
        const parts = [...picks, ...(free ? [free] : [])];
        if (parts.length) payload[q.header] = parts.join(", ");
      }
      await onSubmit(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border-strong bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <HelpCircle className="size-4 shrink-0 text-accent" />
        <span className="text-sm font-medium">@{request.actor} needs a decision</span>
        <div className="flex-1" />
        <span className="text-[11px] text-fg-subtle">
          {answeredCount}/{request.questions.length} answered
        </span>
      </div>

      {request.questions.length > 1 && (
        <div className="flex gap-1 border-b border-border px-2 py-1.5">
          {request.questions.map((q, i) => {
            const done = (answers[q.header]?.length ?? 0) > 0 || (other[q.header] ?? "").trim();
            return (
              <button
                key={q.header}
                type="button"
                onClick={() => setTab(i)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs",
                  i === tab ? "bg-bg-subtle text-fg" : "text-fg-subtle hover:text-fg",
                  done && i !== tab && "text-accent",
                )}
              >
                {q.header}
              </button>
            );
          })}
        </div>
      )}

      <div className="px-3 py-2.5">
        <p className="text-sm text-fg">{active.question}</p>
        {active.multiSelect && <p className="mt-0.5 text-[11px] text-fg-subtle">Pick as many as apply.</p>}

        <div className="mt-2 space-y-1.5">
          {active.options.map((opt) => {
            const on = chosen.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => pick(opt.label)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left",
                  on ? "border-accent bg-accent/10" : "border-border hover:bg-bg-subtle",
                )}
              >
                <span className="text-sm font-medium text-fg">{opt.label}</span>
                {opt.description && <span className="text-xs text-fg-muted">{opt.description}</span>}
              </button>
            );
          })}
        </div>

        <Input
          value={other[active.header] ?? ""}
          onChange={(e) => setOther((prev) => ({ ...prev, [active.header]: e.target.value }))}
          placeholder="Or say something else"
          className="mt-2 h-8 text-sm"
        />
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onDismiss()}>
          Skip — use your judgement
        </Button>
        <div className="flex-1" />
        {tab < request.questions.length - 1 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setTab(tab + 1)}>
            Next
          </Button>
        )}
        <Button type="button" size="sm" disabled={busy || answeredCount === 0} onClick={() => void submit()}>
          {busy ? "Sending…" : "Send answers"}
        </Button>
      </div>
    </div>
  );
}
