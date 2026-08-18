import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { isModelId, providerForModel, type ModelId } from "@/lib/models";
import { newId, slugHandle, uniqueHandle, titleFromPrompt } from "./ids";
import { hasAskAll, parseMentions } from "./mentions";
import { jumpInPrompt, seatSystemPrompt, toProviderMessages } from "./prompts";
import type { ChatMessage, Conversation, ConversationDetail, NewSeatInput, Seat } from "./types";

type ConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type SeatRow = {
  id: string;
  conversation_id: string;
  handle: string;
  display_name: string;
  model_id: string;
  role: string;
  seat_order: number;
  created_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  author_type: string;
  agent_id: string | null;
  content: string;
  mentions_json: string;
  task: string | null;
  created_at: string;
};

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSeat(row: SeatRow): Seat {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    handle: row.handle,
    displayName: row.display_name,
    modelId: row.model_id as ModelId,
    role: row.role,
    seatOrder: Number(row.seat_order),
    createdAt: row.created_at,
  };
}

function mapMessage(row: MessageRow): ChatMessage {
  let mentions: string[] = [];
  try {
    const parsed = JSON.parse(row.mentions_json) as unknown;
    if (Array.isArray(parsed)) mentions = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    mentions = [];
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorType: row.author_type as ChatMessage["authorType"],
    agentId: row.agent_id,
    content: row.content,
    mentions,
    task: row.task,
    createdAt: row.created_at,
  };
}

async function ownedConversation(userId: string, conversationId: string) {
  const sql = await getSql();
  const rows = await sql<ConversationRow>`
    select id, title, created_at::text as created_at, updated_at::text as updated_at
    from conversations
    where id = ${conversationId} and user_id = ${userId}
    limit 1
  `;
  return rows[0] ?? null;
}

export const listConversations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<ConversationRow>`
      select id, title, created_at::text as created_at, updated_at::text as updated_at
      from conversations
      where user_id = ${context.userId}
      order by updated_at desc
    `;
    return rows.map(mapConversation);
  });

export const getConversation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }): Promise<ConversationDetail | null> => {
    const convo = await ownedConversation(context.userId, id);
    if (!convo) return null;
    const sql = await getSql();
    const seats = await sql<SeatRow>`
      select id, conversation_id, handle, display_name, model_id, role, seat_order,
             created_at::text as created_at
      from conversation_agents
      where conversation_id = ${id} and user_id = ${context.userId}
      order by seat_order asc, created_at asc
    `;
    const messages = await sql<MessageRow>`
      select id, conversation_id, author_type, agent_id, content, mentions_json, task,
             created_at::text as created_at
      from messages
      where conversation_id = ${id} and user_id = ${context.userId}
      order by created_at asc
    `;
    return {
      conversation: mapConversation(convo),
      seats: seats.map(mapSeat),
      messages: messages.map(mapMessage),
    };
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { title?: string; seats?: NewSeatInput[] }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const id = newId();
    const title = (data.title ?? "New chat").trim() || "New chat";
    await sql`
      insert into conversations (id, user_id, title)
      values (${id}, ${context.userId}, ${title})
    `;

    const taken = new Set<string>();
    const seats: Seat[] = [];
    for (const [index, seat] of (data.seats ?? []).entries()) {
      if (!isModelId(seat.modelId)) continue;
      const handle = uniqueHandle(seat.handle || seat.displayName || seat.modelId, taken);
      taken.add(handle);
      const seatId = newId();
      const displayName = seat.displayName.trim() || handle;
      const role = seat.role.trim();
      await sql`
        insert into conversation_agents
          (id, conversation_id, user_id, handle, display_name, model_id, role, seat_order)
        values
          (${seatId}, ${id}, ${context.userId}, ${handle}, ${displayName}, ${seat.modelId}, ${role}, ${index})
      `;
      seats.push({
        id: seatId,
        conversationId: id,
        handle,
        displayName,
        modelId: seat.modelId,
        role,
        seatOrder: index,
        createdAt: new Date().toISOString(),
      });
    }

    return {
      conversation: {
        id,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      seats,
    };
  });

export const renameConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; title: string }) => input)
  .handler(async ({ context, data }) => {
    const title = data.title.trim().slice(0, 80) || "New chat";
    const sql = await getSql();
    await sql`
      update conversations
      set title = ${title}, updated_at = now()
      where id = ${data.id} and user_id = ${context.userId}
    `;
    return { ok: true as const };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const sql = await getSql();
    await sql`delete from messages where conversation_id = ${id} and user_id = ${context.userId}`;
    await sql`delete from conversation_agents where conversation_id = ${id} and user_id = ${context.userId}`;
    await sql`delete from conversations where id = ${id} and user_id = ${context.userId}`;

    // The rows cascade; the memory does not. A turn parked on an approval or a
    // question would otherwise wait out its timeout for an answer that can no
    // longer be given, and the room's plan and its session grants would sit in
    // this process for as long as it runs.
    const { abandonConversation } = await import("./approvals.server");
    const { abandonQuestions } = await import("./questions.server");
    const { clearTodos } = await import("./todos.server");
    const { logEvent } = await import("@/lib/log.server");
    const released = abandonConversation(id) + abandonQuestions(id);
    clearTodos(id);
    if (released) {
      logEvent({
        kind: "tool:error",
        conversationId: id,
        message: `chamber deleted; released ${released} unanswerable prompt(s)`,
      });
    }
    return { ok: true as const };
  });

export const addSeat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { conversationId: string } & NewSeatInput) => input)
  .handler(async ({ context, data }) => {
    const { seatAgent } = await import("./seats.server");
    return seatAgent(context.userId, data.conversationId, data);
  });

export const removeSeat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { conversationId: string; seatId: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await sql`
      delete from conversation_agents
      where id = ${data.seatId}
        and conversation_id = ${data.conversationId}
        and user_id = ${context.userId}
    `;
    return { ok: true as const };
  });

export const updateSeat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { conversationId: string; seatId: string; displayName: string; role: string }) => input)
  .handler(async ({ context, data }) => {
    const displayName = data.displayName.trim().slice(0, 40);
    const role = data.role.trim().slice(0, 400);
    if (!displayName) throw new Error("Name required");
    const sql = await getSql();
    await sql`
      update conversation_agents
      set display_name = ${displayName}, role = ${role}
      where id = ${data.seatId}
        and conversation_id = ${data.conversationId}
        and user_id = ${context.userId}
    `;
    return { ok: true as const };
  });

export function normalizeHandleInput(value: string): string {
  return slugHandle(value);
}

export const postUserMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      conversationId: string;
      content: string;
      askAll?: boolean;
      targetHandles?: string[];
      task?: string | null;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const content = data.content.trim();
    if (!content) throw new Error("Message is empty");
    if (content.length > 8000) throw new Error("Message is too long");

    const convo = await ownedConversation(context.userId, data.conversationId);
    if (!convo) throw new Error("Conversation not found");

    const sql = await getSql();
    const seatRows = await sql<SeatRow>`
      select id, conversation_id, handle, display_name, model_id, role, seat_order,
             created_at::text as created_at
      from conversation_agents
      where conversation_id = ${data.conversationId} and user_id = ${context.userId}
      order by seat_order asc, created_at asc
    `;
    const seats = seatRows.map(mapSeat);
    if (seats.length === 0) throw new Error("Seat a rank first");

    const countRows = await sql<{ n: number }>`
      select count(*)::int as n from messages
      where conversation_id = ${data.conversationId} and user_id = ${context.userId}
    `;
    const historyCount = Number(countRows[0]?.n ?? 0);

    const mentions = parseMentions(content);
    const askAll = Boolean(data.askAll) || hasAskAll(content);
    const forced = (data.targetHandles ?? []).map((h) => h.toLowerCase());
    const byHandle = new Map(seats.map((s) => [s.handle, s]));

    let targets: Seat[] = [];
    /** Handles the human addressed that nobody in this chat answers to. */
    let unknownHandles: string[] = [];
    if (forced.length) {
      targets = forced.map((h) => byHandle.get(h)).filter((s): s is Seat => Boolean(s));
    } else if (askAll) {
      targets = [...seats];
    } else {
      const addressed = mentions.filter((h) => h !== "all");
      const named = addressed.map((h) => byHandle.get(h)).filter((s): s is Seat => Boolean(s));
      unknownHandles = addressed.filter((h) => !byHandle.has(h));
      // Addressing nobody in particular means "whoever holds the room", so the
      // first seat answers. But naming a rank who is not seated must NOT quietly
      // hand the turn to a different one — a rank replying under someone else's
      // handle makes the whole thread untrustworthy. Say they are not here.
      if (named.length) targets = named;
      else if (unknownHandles.length) targets = [];
      else targets = [seats[0]!];
    }

    const userMessage: ChatMessage = {
      id: newId(),
      conversationId: data.conversationId,
      authorType: "user",
      agentId: null,
      content,
      mentions: targets.map((s) => s.handle),
      task: data.task ?? null,
      createdAt: new Date().toISOString(),
    };

    await sql`
      insert into messages (id, conversation_id, user_id, author_type, agent_id, content, mentions_json, task)
      values (
        ${userMessage.id}, ${data.conversationId}, ${context.userId}, 'user', null, ${content},
        ${JSON.stringify(userMessage.mentions)}, ${data.task ?? null}
      )
    `;

    const shouldTitle = (convo.title === "New chat" || convo.title === "New chamber") && historyCount === 0;
    const title = shouldTitle ? titleFromPrompt(content) : convo.title;
    if (shouldTitle) {
      await sql`
        update conversations set title = ${title}, updated_at = now()
        where id = ${data.conversationId} and user_id = ${context.userId}
      `;
    } else {
      await sql`
        update conversations set updated_at = now()
        where id = ${data.conversationId} and user_id = ${context.userId}
      `;
    }

    return {
      userMessage,
      title,
      targetHandles: targets.map((s) => s.handle),
      unknownHandles,
      leftoverHandles: seats.filter((s) => !targets.some((t) => t.id === s.id)).map((s) => s.handle),
    };
  });

export const generateSeatReply = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      conversationId: string;
      handle: string;
      task?: string | null;
      jumpIn?: boolean;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const convo = await ownedConversation(context.userId, data.conversationId);
    if (!convo) throw new Error("Conversation not found");

    const sql = await getSql();
    const seatRows = await sql<SeatRow>`
      select id, conversation_id, handle, display_name, model_id, role, seat_order,
             created_at::text as created_at
      from conversation_agents
      where conversation_id = ${data.conversationId} and user_id = ${context.userId}
      order by seat_order asc, created_at asc
    `;
    const seats = seatRows.map(mapSeat);
    const seat = seats.find((s) => s.handle === data.handle);
    if (!seat) throw new Error("That agent is not in this chat");

    const provider = providerForModel(seat.modelId);
    const { completeForProvider } = await import("./complete.server");

    const messageRows = await sql<MessageRow>`
      select id, conversation_id, author_type, agent_id, content, mentions_json, task,
             created_at::text as created_at
      from messages
      where conversation_id = ${data.conversationId} and user_id = ${context.userId}
      order by created_at asc
    `;
    const history = messageRows.map(mapMessage);
    const system = data.jumpIn ? jumpInPrompt(seat) : seatSystemPrompt(seat, seats, data.task ?? null);

    const result = await completeForProvider(
      context.userId,
      provider,
      [{ role: "system", content: system }, ...toProviderMessages(history, seats)],
      {
        maxTokens: data.jumpIn ? 280 : 1400,
        // Names the human and the room, so a write tool knows who to ask.
        toolContext: { userId: context.userId, conversationId: data.conversationId, actor: seat.handle },
        // The jump-in check must answer immediately (usually "SKIP"); handing it
        // tools would turn a cheap interjection into an inspection round.
        tools: !data.jumpIn,
        temperature: data.task?.toLowerCase().includes("review") ? 0.4 : 0.7,
      },
    );

    if (!result.ok) {
      return {
        skipped: Boolean(data.jumpIn && result.missing),
        error: result.error,
        missing: result.missing ?? null,
        message: null as ChatMessage | null,
        followUpHandles: [] as string[],
      };
    }

    const trimmed = result.text.trim();
    if (data.jumpIn && (!trimmed || /^skip\b/i.test(trimmed))) {
      return { skipped: true, error: null, missing: null, message: null as ChatMessage | null, followUpHandles: [] as string[] };
    }

    const message: ChatMessage = {
      id: newId(),
      conversationId: data.conversationId,
      authorType: "agent",
      agentId: seat.id,
      content: trimmed || "…",
      mentions: parseMentions(trimmed),
      task: data.jumpIn ? "jump-in" : (data.task ?? null),
      createdAt: new Date().toISOString(),
    };

    await sql`
      insert into messages (id, conversation_id, user_id, author_type, agent_id, content, mentions_json, task)
      values (
        ${message.id}, ${data.conversationId}, ${context.userId}, 'agent', ${seat.id}, ${message.content},
        ${JSON.stringify(message.mentions)}, ${message.task}
      )
    `;
    await sql`
      update conversations set updated_at = now()
      where id = ${data.conversationId} and user_id = ${context.userId}
    `;

    const followUpHandles = message.mentions.filter(
      (h) => h !== "all" && h !== seat.handle && seats.some((s) => s.handle === h),
    );

    return { skipped: false, error: null, missing: null, message, followUpHandles };
  });
