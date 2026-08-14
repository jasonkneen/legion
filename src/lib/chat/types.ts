import type { ModelId } from "@/lib/models";

export type AuthorType = "user" | "agent" | "system";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Seat = {
  id: string;
  conversationId: string;
  handle: string;
  displayName: string;
  modelId: ModelId;
  role: string;
  seatOrder: number;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  authorType: AuthorType;
  agentId: string | null;
  content: string;
  mentions: string[];
  task: string | null;
  createdAt: string;
};

export type ConversationDetail = {
  conversation: Conversation;
  seats: Seat[];
  messages: ChatMessage[];
};

export type NewSeatInput = {
  modelId: ModelId;
  displayName: string;
  handle: string;
  role: string;
};

export type ChatRequest = {
  conversationId: string;
  content: string;
  askAll?: boolean;
  targetHandles?: string[];
  task?: string | null;
};

export type SseEvent =
  | { event: "user"; data: ChatMessage }
  | { event: "agent_start"; data: ChatMessage }
  | { event: "token"; data: { id: string; delta: string } }
  | { event: "agent_end"; data: { id: string; content: string; skipped?: boolean } }
  | { event: "title"; data: { title: string } }
  | { event: "error"; data: { message: string } }
  | { event: "done"; data: Record<string, never> };
