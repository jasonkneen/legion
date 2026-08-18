import { getSql } from "@/lib/db";
import { isModelId, MODEL_BY_ID, MODELS, type ModelId } from "@/lib/models";
import { newId, uniqueHandle } from "./ids";
import type { NewSeatInput, Seat } from "./types";

/**
 * Seating a rank, in one place.
 *
 * Two callers now: the human pressing the button, and an agent that has decided
 * the room needs someone it cannot be. They must agree about handles, the seat
 * limit and ordering, so the rule lives here rather than in each of them.
 */
export const MAX_SEATS = 8;

export async function seatAgent(
  userId: string,
  conversationId: string,
  input: NewSeatInput,
): Promise<Seat> {
  if (!isModelId(input.modelId)) throw new Error("Unknown model");

  const sql = await getSql();
  const owned = await sql<{ id: string }>`
    select id from conversations where id = ${conversationId} and user_id = ${userId} limit 1
  `;
  if (!owned.length) throw new Error("Conversation not found");

  const existing = await sql<{ handle: string; seat_order: number }>`
    select handle, seat_order
    from conversation_agents
    where conversation_id = ${conversationId} and user_id = ${userId}
  `;
  if (existing.length >= MAX_SEATS) throw new Error(`This chat is full (${MAX_SEATS} agents)`);

  const taken = new Set(existing.map((r) => r.handle));
  const handle = uniqueHandle(input.handle || input.displayName || input.modelId, taken);
  const seatOrder = existing.reduce((max, r) => Math.max(max, Number(r.seat_order)), -1) + 1;
  const id = newId();
  const displayName = input.displayName.trim() || handle;
  const role = input.role.trim();

  await sql`
    insert into conversation_agents
      (id, conversation_id, user_id, handle, display_name, model_id, role, seat_order)
    values
      (${id}, ${conversationId}, ${userId}, ${handle}, ${displayName}, ${input.modelId}, ${role}, ${seatOrder})
  `;
  await sql`
    update conversations set updated_at = now()
    where id = ${conversationId} and user_id = ${userId}
  `;

  return {
    id,
    conversationId,
    handle,
    displayName,
    modelId: input.modelId as ModelId,
    role,
    seatOrder,
    createdAt: new Date().toISOString(),
  } satisfies Seat;
}

/**
 * The ranks an agent could ask for, and whether each can actually speak.
 *
 * A model with no credential is worth naming rather than hiding: "we could
 * bring in Gemini but it has no key" is a useful thing for a seat to be able to
 * say, and better than it silently seating something mute.
 */
export async function availableRanks(
  userId: string,
  conversationId: string,
): Promise<{ modelId: string; name: string; vendor: string; blurb: string; configured: boolean; seated: boolean }[]> {
  const { listStatuses } = await import("./keys.server");
  const statuses = await listStatuses(userId).catch(() => []);
  const configured = new Set(statuses.filter((s) => s.configured).map((s) => s.id));

  const sql = await getSql();
  const seated = await sql<{ model_id: string }>`
    select model_id from conversation_agents
    where conversation_id = ${conversationId} and user_id = ${userId}
  `;
  const seatedModels = new Set(seated.map((r) => r.model_id));

  return MODELS.map((m) => ({
    modelId: m.id,
    name: m.name,
    vendor: m.vendor,
    blurb: m.blurb,
    configured: configured.has(m.provider),
    seated: seatedModels.has(m.id),
  }));
}

/** A one-line description of a rank, for an approval prompt. */
export function rankLabel(modelId: string): string {
  const model = MODEL_BY_ID[modelId as ModelId];
  return model ? `${model.name} (${model.vendor})` : modelId;
}
