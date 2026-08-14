import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { AddSeatDialog, type AfterSeat } from "@/components/add-seat-dialog";
import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { SeatRail } from "@/components/chat/seat-rail";
import { SeatAvatar } from "@/components/seat-avatar";
import { addSeat, generateSeatReply, getConversation, postUserMessage, removeSeat } from "@/lib/chat/actions";
import { listProviderStatuses } from "@/lib/chat/keys-actions";
import type { ChatMessage, Conversation, NewSeatInput, Seat } from "@/lib/chat/types";
import { MODEL_BY_ID, providerForModel, type ModelId } from "@/lib/models";
import { APP_TAGLINE } from "@/lib/brand";
import type { ProviderStatus } from "@/lib/providers";

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
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [workingHandle]);

  const readyByProvider = new Map(providers.map((p) => [p.id, p.configured]));
  const missingSeats = seats.filter((s) => !readyByProvider.get(providerForModel(s.modelId)));

  async function send(content: string, askAll: boolean, extras?: { targetHandles?: string[]; task?: string }) {
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

      const spoken = new Set<string>();
      const queue = [...posted.targetHandles];
      let hops = 0;
      while (queue.length && hops < 5) {
        const handle = queue.shift()!;
        if (spoken.has(handle)) continue;
        setWorkingHandle(handle);
        setStatus(`@${handle} is thinking`);
        const reply = await generateSeatReply({
          data: { conversationId, handle, task: extras?.task ?? null },
        });
        if (reply.missing) {
          const note: ChatMessage = {
            id: `need-${handle}-${Date.now()}`,
            conversationId,
            authorType: "system",
            agentId: null,
            content: `@${handle} needs ${reply.missing.name} connected in Settings before it can speak.`,
            mentions: [handle],
            task: "missing-key",
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, note]);
          continue;
        }
        if (reply.error && !reply.message) {
          const note: ChatMessage = {
            id: `err-${handle}-${Date.now()}`,
            conversationId,
            authorType: "system",
            agentId: null,
            content: `@${handle} — ${reply.error}`,
            mentions: [handle],
            task: "error",
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, note]);
          continue;
        }
        if (reply.message) {
          setMessages((prev) => [...prev, reply.message!]);
          spoken.add(handle);
          hops += 1;
          for (const next of reply.followUpHandles) {
            if (!spoken.has(next) && !queue.includes(next) && hops + queue.length < 5) {
              queue.push(next);
            }
          }
        }
      }

      for (const handle of posted.leftoverHandles.slice(0, 2)) {
        if (spoken.has(handle)) continue;
        setWorkingHandle(handle);
        setStatus(`@${handle} may jump in`);
        const reply = await generateSeatReply({
          data: { conversationId, handle, jumpIn: true },
        });
        if (reply.message) setMessages((prev) => [...prev, reply.message!]);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setSending(false);
      setWorkingHandle(null);
      setStatus(null);
    }
  }

  async function handleAdd(input: NewSeatInput, after: AfterSeat) {
    const seat = await addSeat({ data: { conversationId, ...input } });
    setSeats((prev) => [...prev, seat]);
    if (after === "introduce") {
      await send(`@${seat.handle} Introduce yourself in one short paragraph. Say how you'll help in this room.`, false, {
        targetHandles: [seat.handle],
      });
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
            {seats.length === 0 ? "No ranks seated yet" : seats.map((s) => `@${s.handle}`).join(" · ")}
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
          onAsk={(handle, task, prompt) => void send(prompt, false, { targetHandles: [handle], task })}
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
          messages.map((message) =>
            message.task === "missing-key" ? (
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
                key={message.id}
                message={message}
                seat={message.agentId ? seatById.get(message.agentId) : undefined}
                seats={seats}
                onAsk={(handle, task, prompt) => void send(prompt, false, { targetHandles: [handle], task })}
              />
            ),
          )
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
                <span className="lumen-dot size-1.5 rounded-full bg-accent" style={{ animationDelay: "0.15s" }} />
                <span className="lumen-dot size-1.5 rounded-full bg-accent" style={{ animationDelay: "0.3s" }} />
              </span>
              <span>{status ?? "thinking"}</span>
              <span className="tabular-nums text-fg-subtle">{elapsed}s</span>
            </div>
          </article>
        )}
      </div>

      <div className="px-3 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto max-w-2xl">
          <Composer
            seats={seats}
            disabled={sending || seats.length === 0}
            placeholder={
              seats.length === 0
                ? "Seat a rank before we write"
                : seats.length > 1
                  ? `The league · @${seats[0]?.handle ?? "name"} to call a rank`
                  : "Write to us. Enter to send"
            }
            onSend={(text, askAll) => void send(text, askAll)}
            onAddSeat={() => setAddOpen(true)}
          />
          <p className="mt-2 px-1 text-[11px] text-fg-subtle">
            {sending && status ? status : "Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      </div>

      <AddSeatDialog open={addOpen} onOpenChange={setAddOpen} existing={seats} onAdd={handleAdd} />
    </div>
  );
}
