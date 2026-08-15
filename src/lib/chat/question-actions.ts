import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { answerQuestion, pendingQuestions, type PendingQuestion } from "./questions.server";

/** Questions a seat is waiting on, for this conversation. */
export const listPendingQuestions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((conversationId: string) => conversationId)
  .handler(async ({ data: conversationId }): Promise<PendingQuestion[]> => pendingQuestions(conversationId));

/** Send answers back, or null to dismiss and let the seat use its judgement. */
export const submitQuestionAnswers = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; answers: Record<string, string> | null }) => input)
  .handler(async ({ data }) => ({ ok: answerQuestion(data.id, data.answers) }));
