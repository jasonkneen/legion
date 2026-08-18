import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Mic, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeatAvatar } from "@/components/seat-avatar";
import { splitMentionQuery, spokenMentions } from "@/lib/chat/mentions";
import type { Seat } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * A live level meter while dictating.
 *
 * It reads from the recogniser's own results rather than opening a second audio
 * stream: two consumers of one microphone is a good way to have neither work,
 * and what the human needs to know is "is it hearing me", which arriving
 * transcript answers exactly.
 */
function RecordingLevel({ heardAt }: { heardAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, []);
  const speaking = now - heardAt < 900;
  return (
    <span className="flex items-center gap-1.5 pl-0.5 text-xs text-danger" aria-live="polite">
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "w-[2px] rounded-full bg-danger transition-all duration-150",
              speaking ? "animate-pulse" : "opacity-50",
            )}
            style={{ height: speaking ? `${5 + ((i + (now % 3)) % 3) * 4}px` : "4px" }}
          />
        ))}
      </span>
      {speaking ? "listening" : "recording"}
    </span>
  );
}

export function Composer({
  seats,
  disabled,
  queueing,
  placeholder,
  replyTo,
  onClearReply,
  onSend,
  onStop,
  onAddSeat,
}: {
  seats: Seat[];
  disabled?: boolean;
  /** A seat is mid-turn: submitting adds to the queue instead of sending. */
  queueing?: boolean;
  placeholder?: string;
  /** The message being replied to, shown as a chip and addressed on send. */
  replyTo?: { handle: string; excerpt: string } | null;
  onClearReply?: () => void;
  onSend: (text: string, askAll: boolean) => void;
  /** Interrupt the seat that is currently answering. */
  onStop?: () => void;
  onAddSeat?: () => void;
}) {
  const [value, setValue] = useState("");
  const [askAll, setAskAll] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [listening, setListening] = useState(false);
  /** When speech last arrived, so the indicator can show it is hearing us. */
  const [heardAt, setHeardAt] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const caret = areaRef.current?.selectionStart ?? value.length;
  const mention = splitMentionQuery(value, caret);
  const mentionOptions = useMemo(() => {
    if (!mention.active) return [];
    const q = mention.query.toLowerCase();
    const rows: { handle: string; label: string; seat?: Seat }[] = [
      { handle: "all", label: "The whole league" },
      ...seats.map((s) => ({ handle: s.handle, label: s.displayName, seat: s })),
    ];
    return rows.filter((r) => r.handle.startsWith(q) || r.label.toLowerCase().includes(q));
  }, [mention.active, mention.query, seats]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mention.query, mention.active]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  function insertMention(handle: string) {
    const el = areaRef.current;
    const pos = el?.selectionStart ?? value.length;
    const { start } = splitMentionQuery(value, pos);
    if (start < 0) return;
    const next = `${value.slice(0, start)}@${handle} ${value.slice(pos)}`;
    setValue(next);
    requestAnimationFrame(() => {
      const caretTo = start + handle.length + 2;
      el?.focus();
      el?.setSelectionRange(caretTo, caretTo);
    });
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    // Replying addresses that rank, unless the text already names someone.
    const addressed = replyTo && !text.includes(`@${replyTo.handle}`) ? `@${replyTo.handle} ${text}` : text;
    onSend(addressed, askAll);
    setValue("");
    onClearReply?.();
  }

  /**
   * Dictation through the browser's own speech recognition.
   *
   * No audio leaves the page beyond whatever the browser already does for
   * recognition, and there is no key to configure. Unsupported browsers simply
   * do not show the button rather than offering one that fails.
   */
  function toggleDictation() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      setHeardAt(0);
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    // Keep the text typed before dictation started; append what is heard.
    const base = value ? `${value.trim()} ` : "";
    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let heard = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        heard += event.results[i][0]?.transcript ?? "";
      }
      setHeardAt(Date.now());
      setValue(`${base}${spokenMentions(heard, seats)}`.slice(0, 8000));
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognition.start();
    recognitionRef.current = recognition;
    setListening(true);
  }

  return (
    <div className="relative">
      {mention.active && mentionOptions.length > 0 && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-bg-elevated p-1 shadow-composer">
          {mentionOptions.map((opt, i) => (
            <button
              key={opt.handle}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(opt.handle);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                i === mentionIndex ? "bg-bg-subtle" : "hover:bg-bg-subtle",
              )}
            >
              {opt.seat ? (
                <SeatAvatar modelId={opt.seat.modelId} name={opt.seat.displayName} size="sm" />
              ) : (
                <span className="grid size-6 place-items-center rounded-full bg-bg-subtle text-[10px] font-medium">
                  *
                </span>
              )}
              <span className="font-medium">@{opt.handle}</span>
              <span className="truncate text-xs text-fg-subtle">{opt.label}</span>
            </button>
          ))}
        </div>
      )}

      {replyTo && (
        <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-bg-subtle/60 px-2.5 py-1.5">
          <span className="text-xs text-fg-muted">
            Replying to <span className="font-medium">@{replyTo.handle}</span>
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{replyTo.excerpt}</span>
          <button
            type="button"
            onClick={onClearReply}
            className="shrink-0 rounded p-0.5 text-fg-subtle hover:text-fg"
            aria-label="Cancel reply"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="composer-box rounded-md border border-border bg-bg-elevated shadow-composer">
        <textarea
          ref={areaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? "Message the table. Use @ to call a seat."}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (mention.active && mentionOptions.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionOptions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(mentionOptions[mentionIndex]?.handle ?? "all");
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                areaRef.current?.blur();
                areaRef.current?.focus();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-44 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] text-fg outline-none placeholder:text-fg-subtle disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            {onAddSeat && (
              <Button type="button" variant="ghost" size="icon-sm" onClick={onAddSeat} aria-label="Add a seat">
                <Plus />
              </Button>
            )}
            {speechRecognitionCtor() && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={toggleDictation}
                aria-label={listening ? "Stop dictation" : "Dictate"}
                className={cn("relative", listening && "text-danger")}
              >
                <Mic />
                {listening && (
                  // A red dot on the microphone, the way every recorder marks
                  // that it is live. Without it the only sign was a tinted icon,
                  // which is not enough to be sure your machine is listening.
                  <span className="absolute top-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-danger" />
                )}
              </Button>
            )}
            {listening && <RecordingLevel heardAt={heardAt} />}
            <button
              type="button"
              onClick={() => setAskAll((v) => !v)}
              className={cn(
                "h-8 rounded-full px-2.5 text-xs font-medium",
                askAll ? "bg-bg-subtle text-fg" : "text-fg-subtle hover:bg-bg-subtle hover:text-fg",
              )}
            >
              Ask all
            </button>
          </div>
          {queueing && onStop ? (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              onClick={onStop}
              aria-label="Stop the current reply"
              className="rounded-full"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-sm"
              onClick={submit}
              disabled={disabled || !value.trim()}
              aria-label={queueing ? "Add to queue" : "Send"}
              className="rounded-full"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Minimal shape of the Web Speech API we use. Typed here rather than pulling in
 * DOM lib types that vary by TypeScript version, and it keeps the feature
 * detection honest: no constructor, no button.
 */
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
