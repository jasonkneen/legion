import type { ChatMessage } from "./types";

/** What the browser sees while a seat answers. */
export type ReplyEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; model: string }
  | { type: "error"; error: string }
  | { type: "message"; message: ChatMessage; followUpHandles: string[] };

/**
 * Consume one seat's reply from `/api/reply`, calling back per event.
 *
 * `fetch` rather than `EventSource`: the request needs a POST body and the
 * session cookie, and EventSource can do neither. The response is read as a
 * stream and split on the SSE frame separator.
 */
export async function streamReply(
  input: { conversationId: string; handle: string; task?: string | null; jumpIn?: boolean },
  onEvent: (event: ReplyEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok || !res.body) {
    onEvent({ type: "error", error: `The seat could not be reached (${res.status}).` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; anything after the last one is a
    // partial frame and stays in the buffer.
    let split = buffer.indexOf("\n\n");
    for (; split >= 0; split = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ReplyEvent);
      } catch {
        // Ignore a frame we cannot parse rather than killing the stream.
      }
    }
  }
}
