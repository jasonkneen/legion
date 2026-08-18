import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { AddSeatDialog, type AfterSeat } from "@/components/add-seat-dialog";
import { Composer } from "@/components/chat/composer";
import { QueueTray, type QueuedMessage } from "@/components/chat/queue-tray";
import { ApprovalPanel } from "@/components/chat/approval-panel";
import { ActivityPanel } from "@/components/chat/activity-panel";
import { TodoPanel } from "@/components/chat/todo-panel";
import { QuestionForm } from "@/components/chat/question-form";
import { submitQuestionAnswers } from "@/lib/chat/question-actions";
import type { PendingQuestion } from "@/lib/chat/questions.server";
import { answerApproval } from "@/lib/chat/approval-actions";
import { usePulse } from "@/lib/chat/use-pulse";
import type { ApprovalScope, PendingApprovalView } from "@/lib/chat/approvals.server";
import { MessageItem } from "@/components/chat/message-item";
import { SeatRail } from "@/components/chat/seat-rail";
import { MessageDial } from "@/components/chat/message-dial";
import { SeatAvatar } from "@/components/seat-avatar";
import { streamReply } from "@/lib/chat/stream-reply";
import {
  addSeat,
  getConversation,
  postUserMessage,
  removeSeat,
} from "@/lib/chat/actions";
import { listProviderStatuses } from "@/lib/chat/keys-actions";
import type { ChatMessage, Conversation, NewSeatInput, Seat } from "@/lib/chat/types";
import { MODEL_BY_ID, providerForModel, type ModelId } from "@/lib/models";
import { APP_TAGLINE } from "@/lib/brand";
import type { ProviderStatus } from "@/lib/providers";

/** Stable-enough id for a queue row; these never leave the browser. */
function newQueueId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function greeting() {
  return APP_TAGLINE;
}

export function ChatView({
  conversationId,
  onConversationMeta,
}: {
  conversationId: string;
  onConversationMeta?: (c: Conversation) => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("Chat");
  const [seats, setSeats] = useState<Seat[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  // Messages typed while a seat was working. Kept in the view rather than a
  // store: a queue belongs to the open conversation and should not outlive it.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Tool calls parked waiting on a decision. A parked turn holds a child
  // process open, so this is polled only while a seat is actually working.
  const [approvals, setApprovals] = useState<PendingApprovalView[]>([]);
  // The message being replied to, so the next send is addressed at its author.
  const [replyTo, setReplyTo] = useState<{ handle: string; excerpt: string } | null>(null);
  // Failed turns, by the id of the error row they left behind: enough to run
  // exactly the same turn again without asking the human to retype it.
  const [retryable, setRetryable] = useState<
    Record<string, { handle: string; options: { task?: string | null; jumpIn?: boolean } }>
  >({});
  // The turn currently in flight, so the human can stop it. Held in a ref
  // rather than state: aborting must not wait for a re-render.
  const abortRef = useRef<AbortController | null>(null);
  // The message being streamed into, so a stop can mark it as cut short. The
  // server persists the same marker, but the client closed the stream and so
  // never receives that final message event.
  const livePlaceholderRef = useRef<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // Questions a seat has parked on. Polled with the approvals, same reasoning.
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [workingHandle, setWorkingHandle] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getConversation({ data: conversationId })
      .then((detail) => {
        if (cancelled) return;
        if (!detail) {
          void navigate({ to: "/" });
          return;
        }
        setTitle(detail.conversation.title);
        setSeats(detail.seats);
        setMessages(detail.messages);
        onConversationMeta?.(detail.conversation);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load this chat");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, navigate, onConversationMeta]);

  useEffect(() => {
    void listProviderStatuses()
      .then(setProviders)
      .catch(() => setProviders([]));
    const onKeys = () => {
      void listProviderStatuses()
        .then(setProviders)
        .catch(() => undefined);
    };
    window.addEventListener("chamber:keys", onKeys);
    return () => window.removeEventListener("chamber:keys", onKeys);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: sending ? "smooth" : "auto" });
  }, [messages, sending, workingHandle, status]);

  useEffect(() => {
    if (!workingHandle) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [workingHandle]);

  // Approvals and questions arrive on the chamber's shared poll. They are only
  // read while a turn is running: nothing can be waiting on an answer otherwise,
  // and a chamber sitting open should not keep asking.
  const pulse = usePulse(conversationId, sending);
  useEffect(() => {
    if (!sending) {
      setApprovals([]);
      setQuestions([]);
      return;
    }
    if (!pulse) return;
    setApprovals(pulse.approvals);
    setQuestions(pulse.questions);
  }, [sending, pulse]);

  // A seat can arrive mid-turn: an agent may decide the work needs someone it
  // cannot be, and add them. Follow the server's list rather than only the
  // additions this browser made itself.
  useEffect(() => {
    const arrived = pulse?.seats;
    if (!arrived?.length) return;
    setSeats((prev) => {
      const known = new Set(prev.map((s) => s.id));
      const added = arrived.filter((s) => !known.has(s.id));
      if (!added.length) return prev;
      return [...prev, ...added].sort((a, b) => a.seatOrder - b.seatOrder);
    });
  }, [pulse]);

  const decideApprovalRequest = async (id: string, scope: ApprovalScope) => {
    setApprovals((rows) => rows.filter((r) => r.id !== id));
    await answerApproval({ data: { id, scope } }).catch(() => {
      toast.error("That approval had already expired");
    });
  };

  // Drain one queued message whenever the room goes quiet. One per pass:
  // `send` flips `sending` back on, which re-runs this effect for the next.
  useEffect(() => {
    if (sending || queue.length === 0 || seats.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void send(next.text, next.askAll);
    // `send` is stable enough for this: it only reads state it also sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, queue, seats.length]);

  const readyByProvider = new Map(providers.map((p) => [p.id, p.configured]));
  const missingSeats = seats.filter((s) => !readyByProvider.get(providerForModel(s.modelId)));

  /**
   * Run one seat's turn over the streaming endpoint.
   *
   * Text lands in a placeholder message that grows as deltas arrive, so the
   * thread shows the answer being written instead of a spinner. The server
   * persists the finished message and sends it back; the placeholder is
   * swapped for the real row so ids and timestamps match a reload.
   */
  async function runSeatTurn(
    handle: string,
    options: { task?: string | null; jumpIn?: boolean },
  ): Promise<{ message: ChatMessage | null; followUpHandles: string[] }> {
    const placeholderId = `live-${handle}-${Date.now()}`;
    let text = "";
    let created = false;
    let outcome: { message: ChatMessage | null; followUpHandles: string[] } = {
      message: null,
      followUpHandles: [],
    };

    const controller = new AbortController();
    abortRef.current = controller;
    livePlaceholderRef.current = placeholderId;

    await streamReply({ conversationId, handle, ...options }, (event) => {
      if (event.type === "status") {
        setStatus(`@${handle} · ${event.text}`);
        return;
      }
      if (event.type === "delta") {
        text += event.text;
        setMessages((prev) => {
          if (!created) {
            created = true;
            return [
              ...prev,
              {
                id: placeholderId,
                conversationId,
                authorType: "agent",
                agentId: seats.find((s) => s.handle === handle)?.id ?? null,
                content: text,
                mentions: [],
                task: options.jumpIn ? "jump-in" : (options.task ?? null),
                createdAt: new Date().toISOString(),
              },
            ];
          }
          return prev.map((m) => (m.id === placeholderId ? { ...m, content: text } : m));
        });
        return;
      }
      if (event.type === "message") {
        outcome = { message: event.message, followUpHandles: event.followUpHandles };
        setMessages((prev) =>
          created
            ? prev.map((m) => (m.id === placeholderId ? event.message : m))
            : [...prev, event.message],
        );
        return;
      }
      if (event.type === "error") {
        const errorId = `err-${handle}-${Date.now()}`;
        // A failed turn used to be a dead end: what was asked lived only in the
        // request that failed, so the human had to retype it. Keep the
        // arguments beside the row instead.
        setRetryable((prev) => ({ ...prev, [errorId]: { handle, options } }));
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== placeholderId),
          {
            id: errorId,
            conversationId,
            authorType: "system",
            agentId: null,
            content: `@${handle} — ${event.error}`,
            mentions: [handle],
            task: "error",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    }, controller.signal).catch((err) => {
      // An abort is the human pressing stop, not a failure worth reporting.
      if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
    });

    abortRef.current = null;
    livePlaceholderRef.current = null;
    return outcome;
  }

  /**
   * Stop the turn in flight.
   *
   * Aborting the fetch closes the stream, which the server treats as a cancel
   * and passes on to the provider — so this stops generation rather than just
   * looking away from it. Whatever streamed so far is kept and marked.
   */
  function stopTurn() {
    setStopping(true);
    const placeholderId = livePlaceholderRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    if (placeholderId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholderId && !m.content.endsWith("_(stopped)_")
            ? { ...m, content: `${m.content}\n\n_(stopped)_` }
            : m,
        ),
      );
    }
  }

  async function send(
    content: string,
    askAll: boolean,
    extras?: { targetHandles?: string[]; task?: string },
  ) {
    if (sending) return;
    const first =
      extras?.targetHandles?.[0] ??
      (askAll ? seats[0]?.handle : undefined) ??
      seats[0]?.handle ??
      null;

    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      conversationId,
      authorType: "user",
      agentId: null,
      content,
      mentions: extras?.targetHandles ?? [],
      task: extras?.task ?? null,
      createdAt: new Date().toISOString(),
    };

    setSending(true);
    setWorkingHandle(first);
    setStatus(first ? `@${first} is thinking` : "Sending");
    setMessages((prev) => [...prev, optimistic]);

    try {
      const posted = await postUserMessage({
        data: {
          conversationId,
          content,
          askAll,
          targetHandles: extras?.targetHandles,
          task: extras?.task ?? null,
        },
      });
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? posted.userMessage : m)));
      setTitle(posted.title);
      onConversationMeta?.({
        id: conversationId,
        title: posted.title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      window.dispatchEvent(new Event("chamber:updated"));

      // Naming a rank who is not seated used to be answered by whoever was
      // first, under the wrong handle. Now it is said out loud instead.
      if (posted.unknownHandles.length) {
        const names = posted.unknownHandles.map((h) => `@${h}`).join(", ");
        setMessages((prev) => [
          ...prev,
          {
            id: `unknown-${Date.now()}`,
            conversationId,
            authorType: "system",
            agentId: null,
            content: `${names} ${posted.unknownHandles.length > 1 ? "are" : "is"} not seated in this chat. Add ${posted.unknownHandles.length > 1 ? "them" : "them"} with the + button, or address a rank who is here.`,
            mentions: posted.unknownHandles,
            task: "unknown-handle",
            createdAt: new Date().toISOString(),
          },
        ]);
      }

      const spoken = new Set<string>();
      // Named for what it holds: seats still to speak this turn. Distinct from
      // the composer's message queue.
      const toSpeak = [...posted.targetHandles];
      let hops = 0;
      while (toSpeak.length && hops < 5) {
        const handle = toSpeak.shift()!;
        if (spoken.has(handle)) continue;
        setWorkingHandle(handle);
        setStatus(`@${handle} is thinking`);
        const reply = await runSeatTurn(handle, { task: extras?.task ?? null });
        if (reply.message) {
          spoken.add(handle);
          hops += 1;
          for (const next of reply.followUpHandles) {
            if (!spoken.has(next) && !toSpeak.includes(next) && hops + toSpeak.length < 5) {
              toSpeak.push(next);
            }
          }
        }
      }

      // Jumping in is for ranks who were not addressed while others were. If
      // the message addressed nobody who is here, an unasked rank answering
      // anyway is the same impersonation problem in a quieter form.
      const mayJumpIn = posted.targetHandles.length > 0;
      for (const handle of mayJumpIn ? posted.leftoverHandles.slice(0, 2) : []) {
        if (spoken.has(handle)) continue;
        setWorkingHandle(handle);
        setStatus(`@${handle} may jump in`);
        await runSeatTurn(handle, { jumpIn: true });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setSending(false);
      setWorkingHandle(null);
      setStatus(null);
      // Without this the hint reads "stopping" for the rest of the session.
      setStopping(false);
      abortRef.current = null;
    }
  }

  async function handleAdd(input: NewSeatInput, after: AfterSeat) {
    const seat = await addSeat({ data: { conversationId, ...input } });
    setSeats((prev) => [...prev, seat]);
    if (after === "introduce") {
      await send(
        `@${seat.handle} Introduce yourself in one short paragraph. Say how you'll help in this room.`,
        false,
        {
          targetHandles: [seat.handle],
        },
      );
    } else if (after === "review") {
      await send(
        `@${seat.handle} Review the latest reply in this chat. Be specific about correctness, gaps, and what to change.`,
        false,
        { targetHandles: [seat.handle], task: "Review the latest reply." },
      );
    }
  }

  const seatById = new Map(seats.map((s) => [s.id, s]));
  const workingSeat = seats.find((s) => s.handle === workingHandle);
  const lead = seats[0];
  const leadModel = lead ? MODEL_BY_ID[lead.modelId as ModelId] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2.5 md:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {lead && <SeatAvatar modelId={lead.modelId} name={lead.displayName} size="sm" />}
            <h1 className="truncate text-sm font-medium">{title}</h1>
            {leadModel && (
              <span className="hidden truncate rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-fg-muted sm:inline">
                {leadModel.name}
              </span>
            )}
          </div>
          <p className="truncate pl-8 text-xs text-fg-subtle">
            {seats.length === 0
              ? "No ranks seated yet"
              : seats.map((s) => `@${s.handle}`).join(" · ")}
          </p>
        </div>
        <SeatRail
          seats={seats}
          missingHandles={new Set(missingSeats.map((s) => s.handle))}
          onAdd={() => setAddOpen(true)}
          onRemove={(seat) => {
            void removeSeat({ data: { conversationId, seatId: seat.id } }).then(() => {
              setSeats((prev) => prev.filter((s) => s.id !== seat.id));
            });
          }}
          onAsk={(handle, task, prompt) =>
            void send(prompt, false, { targetHandles: [handle], task })
          }
        />
      </header>

      {missingSeats.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-3 py-2 text-xs text-fg-muted md:px-5">
          <KeyRound className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {missingSeats.map((s) => `@${s.handle}`).join(", ")} need a connection in Settings.
          </span>
          <Link to="/settings" className="shrink-0 font-medium text-accent hover:underline">
            Connect
          </Link>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
      <MessageDial messages={messages} seats={seats} scroller={scroller} />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-6 md:px-6">
        {loading ? (
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="h-16 animate-pulse rounded-xl bg-bg-subtle" />
            <div className="h-28 animate-pulse rounded-xl bg-bg-subtle" />
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto flex max-w-lg flex-col items-center pt-16 text-center">
            <p className="text-3xl font-semibold tracking-tight">{greeting()}</p>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-fg-muted">
              {seats.length > 1
                ? "A league. @ a rank to call them, or Ask all. We share one thread and pull each other in."
                : lead
                  ? `${lead.displayName} is seated. Write, or add ranks to the same league.`
                  : "Seat a rank to begin. We are Legion."}
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} data-msg={message.id}>
            {message.task === "missing-key" ? (
              <div
                key={message.id}
                className="mx-auto my-3 flex w-full max-w-2xl items-center gap-2 rounded-xl border border-border bg-bg-elevated px-3 py-2.5 text-sm"
              >
                <KeyRound className="size-4 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 text-fg-muted">{message.content}</span>
                <Link to="/settings" className="shrink-0 font-medium text-accent hover:underline">
                  Settings
                </Link>
              </div>
            ) : (
              <MessageItem
                onRetry={
                  retryable[message.id]
                    ? () => {
                        const spec = retryable[message.id];
                        // Drop the error row and its record first: a retry that
                        // fails again writes a fresh row, and two "try again"
                        // buttons for one question is a worse answer than none.
                        setMessages((prev) => prev.filter((row) => row.id !== message.id));
                        setRetryable((prev) => {
                          const next = { ...prev };
                          delete next[message.id];
                          return next;
                        });
                        void runSeatTurn(spec.handle, spec.options);
                      }
                    : undefined
                }
                onReply={(m, seat) =>
                  setReplyTo(
                    seat
                      ? {
                          handle: seat.handle,
                          excerpt: m.content.replace(/\s+/g, " ").slice(0, 80),
                        }
                      : null,
                  )
                }
                key={message.id}
                message={message}
                seat={message.agentId ? seatById.get(message.agentId) : undefined}
                seats={seats}
                onAsk={(handle, task, prompt) =>
                  void send(prompt, false, { targetHandles: [handle], task })
                }
              />
            )}
            </div>
          ))
        )}
        {workingSeat && (
          <article className="mx-auto w-full max-w-2xl px-1 py-4">
            <header className="mb-2 flex items-center gap-2">
              <SeatAvatar modelId={workingSeat.modelId} name={workingSeat.displayName} size="sm" />
              <div className="min-w-0">
                <span className="text-sm font-medium">{workingSeat.displayName}</span>
                <span className="ml-2 text-xs text-fg-subtle">@{workingSeat.handle}</span>
              </div>
            </header>
            <div className="flex items-center gap-2 text-sm text-fg-subtle">
              <span className="inline-flex items-center gap-1">
                <span className="lumen-dot size-1.5 rounded-full bg-accent" />
                <span
                  className="lumen-dot size-1.5 rounded-full bg-accent"
                  style={{ animationDelay: "0.15s" }}
                />
                <span
                  className="lumen-dot size-1.5 rounded-full bg-accent"
                  style={{ animationDelay: "0.3s" }}
                />
              </span>
              <span>{status ?? "thinking"}</span>
              <span className="tabular-nums text-fg-subtle">{elapsed}s</span>
            </div>
          </article>
        )}
      </div>
      </div>

      <div className="px-3 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto max-w-2xl">
          {/* One surface: panels above read as a drawer opening out of the
              input rather than as separate cards stacked on it. */}
          <div className="composer-dock">
            <TodoPanel conversationId={conversationId} live={sending} />
            <ActivityPanel conversationId={conversationId} live={sending} />
            {questions[0] && (
              <QuestionForm
                request={questions[0]}
                onSubmit={async (answers) => {
                  setQuestions((q) => q.slice(1));
                  await submitQuestionAnswers({ data: { id: questions[0].id, answers } });
                }}
                onDismiss={async () => {
                  setQuestions((q) => q.slice(1));
                  await submitQuestionAnswers({ data: { id: questions[0].id, answers: null } });
                }}
              />
            )}
            {approvals[0] && (
              <ApprovalPanel request={approvals[0]} onDecide={decideApprovalRequest} />
            )}
            <QueueTray
              queue={queue}
              draining={sending}
              onEdit={(id, text) =>
                setQueue((q) => q.map((row) => (row.id === id ? { ...row, text } : row)))
              }
              onSendNow={(id) =>
                setQueue((q) => [...q.filter((r) => r.id === id), ...q.filter((r) => r.id !== id)])
              }
              onRemove={(id) => setQueue((q) => q.filter((row) => row.id !== id))}
              onClear={() => setQueue([])}
            />
            <Composer
              seats={seats}
              // Only a room with no seats blocks typing. While a seat is working,
              // the composer stays live and Enter queues instead — see `submit`.
              disabled={seats.length === 0}
              queueing={sending}
              replyTo={replyTo}
              onClearReply={() => setReplyTo(null)}
              onStop={stopTurn}
              placeholder={
                seats.length === 0
                  ? "Seat a rank before we write"
                  : seats.length > 1
                    ? `The league · @${seats[0]?.handle ?? "name"} to call a rank`
                    : "Write to us. Enter to send"
              }
              onSend={(text, askAll) => {
                if (sending) {
                  setQueue((q) => [...q, { id: newQueueId(), text, askAll }]);
                  return;
                }
                void send(text, askAll);
              }}
              onAddSeat={() => setAddOpen(true)}
            />
          </div>
          <p className="mt-2 px-1 text-[11px] text-fg-subtle">
            {sending
              ? `${stopping ? "stopping" : (status ?? "working")} · Enter adds to the queue · ⏹ stops`
              : "Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      </div>

      <AddSeatDialog open={addOpen} onOpenChange={setAddOpen} existing={seats} onAdd={handleAdd} />
    </div>
  );
}
