import { getBearerToken } from "@/lib/auth/client";
import type { ChatMessage, ChatRequest, SseEvent } from "./types";

export async function streamChat(
  body: ChatRequest,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getBearerToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Chat failed (${res.status})`);
  }
  if (!res.body) throw new Error("Empty response");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventName = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      try {
        const data = JSON.parse(payload) as SseEvent["data"];
        onEvent({ event: eventName, data } as SseEvent);
      } catch {
        // skip
      }
      eventName = "message";
    }
  }
}

export function applyToken(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m));
}
