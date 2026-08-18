/**
 * Structured questions from a seat to the human (server-only).
 *
 * Same shape of problem as approvals — a turn has to park, publish, and wait —
 * but a different payload: several questions at once, each with options, which
 * the UI renders as tabs. Models are much better at "pick from these" than at
 * guessing, and this lets a seat ask before doing rather than after.
 *
 * Held on `globalThis` so a dev reload cannot strand a parked turn.
 */
import { logEvent } from "@/lib/log.server";

export type AskOption = {
  label: string;
  description: string;
};

export type AskQuestion = {
  /** Short chip label, e.g. "Auth method". */
  header: string;
  question: string;
  options: AskOption[];
  multiSelect: boolean;
};

export type PendingQuestion = {
  id: string;
  conversationId: string;
  actor: string;
  questions: AskQuestion[];
  createdAt: number;
};

/** One answer per question, in the same order. */
export type QuestionAnswers = Record<string, string>;

type Waiter = {
  pending: PendingQuestion;
  resolve: (answers: QuestionAnswers | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const globalRef = globalThis as typeof globalThis & { __legionQuestions__?: Map<string, Waiter> };
function waiting(): Map<string, Waiter> {
  globalRef.__legionQuestions__ ??= new Map();
  return globalRef.__legionQuestions__;
}

/** A question is a conversation, not a background job: wait longer than an approval. */
const WAIT_TIMEOUT_MS = 10 * 60_000;

export function pendingQuestions(conversationId?: string): PendingQuestion[] {
  const all = [...waiting().values()].map((w) => w.pending);
  return conversationId ? all.filter((q) => q.conversationId === conversationId) : all;
}

/**
 * Dismiss every question a deleted chamber was waiting on.
 *
 * Same reasoning as the approvals: the form lived in a chat that no longer
 * exists, so nobody can answer it. A dismissal is what the seat would have seen
 * had the human closed the form, which it already handles.
 */
export function abandonQuestions(conversationId: string): number {
  let released = 0;
  for (const [id, waiter] of [...waiting().entries()]) {
    if (waiter.pending.conversationId !== conversationId) continue;
    waiting().delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(null);
    released += 1;
  }
  return released;
}

/** Deliver the human's answers, or null when they dismissed the form. */
export function answerQuestion(id: string, answers: QuestionAnswers | null): boolean {
  const waiter = waiting().get(id);
  if (!waiter) return false;
  waiting().delete(id);
  clearTimeout(waiter.timer);
  logEvent({
    kind: "tool:end",
    actor: waiter.pending.actor,
    conversationId: waiter.pending.conversationId,
    message: answers ? `answered ${Object.keys(answers).length} question(s)` : "dismissed the question",
  });
  waiter.resolve(answers);
  return true;
}

/**
 * Ask, and wait. Returns null on dismissal or timeout — the caller turns that
 * into a sentence the model can act on rather than an exception.
 */
export async function askHuman(
  conversationId: string,
  actor: string,
  questions: AskQuestion[],
): Promise<QuestionAnswers | null> {
  const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending: PendingQuestion = { id, conversationId, actor, questions, createdAt: Date.now() };

  logEvent({
    kind: "tool:start",
    actor,
    conversationId,
    message: `asked the human: ${questions.map((q) => q.header).join(", ")}`,
  });

  return new Promise<QuestionAnswers | null>((resolve) => {
    const timer = setTimeout(() => {
      waiting().delete(id);
      logEvent({ kind: "tool:error", actor, conversationId, message: "question timed out" });
      resolve(null);
    }, WAIT_TIMEOUT_MS);
    waiting().set(id, { pending, resolve, timer });
  });
}

/**
 * Coerce whatever the model passed into the tool into a usable form.
 *
 * Models routinely send a single question instead of an array, or options as
 * bare strings. Repairing that here beats rejecting the call and burning a turn
 * on a schema argument.
 */
export function parseQuestions(raw: unknown): AskQuestion[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: AskQuestion[] = [];
  for (const item of list.slice(0, 4)) {
    const q = item as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: AskOption[] = rawOptions
      .slice(0, 6)
      .map((o) => {
        if (typeof o === "string") return { label: o.slice(0, 80), description: "" };
        const obj = (o ?? {}) as Record<string, unknown>;
        return {
          label: String(obj.label ?? "").slice(0, 80),
          description: String(obj.description ?? "").slice(0, 300),
        };
      })
      .filter((o) => o.label);
    if (options.length < 2) continue; // a question with one answer is not a question
    out.push({
      header: (typeof q.header === "string" && q.header.trim() ? q.header : question).slice(0, 24),
      question: question.slice(0, 300),
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}
