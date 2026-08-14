import { getSql } from "@/lib/db";
import { ASSISTANTS, isModelId, type ModelId, type StoredAssistant } from "@/lib/models";
import { newId, slugHandle } from "./ids";

export type AssistantInput = {
  id?: string;
  name: string;
  handle: string;
  modelId: string;
  role: string;
  blurb: string;
  tag: string;
};

let tableReady: Promise<void> | null = null;

async function ensureTable() {
  tableReady ??= (async () => {
    const sql = await getSql();
    await sql.query(`
      create table if not exists assistants (
        id text not null,
        user_id text not null,
        name text not null,
        handle text not null,
        model_id text not null,
        role text not null default '',
        blurb text not null default '',
        tag text not null default 'Custom',
        hidden boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (user_id, id)
      )
    `);
  })().catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
}

type Row = {
  id: string;
  name: string;
  handle: string;
  model_id: string;
  role: string;
  blurb: string;
  tag: string;
  hidden: boolean;
};

function fromRow(row: Row, builtin: boolean): StoredAssistant {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    modelId: isModelId(row.model_id) ? row.model_id : "grok-4.6",
    role: row.role,
    blurb: row.blurb,
    tag: row.tag || "Custom",
    builtin,
    customized: true,
  };
}

export async function listForUser(userId: string): Promise<StoredAssistant[]> {
  await ensureTable();
  const sql = await getSql();
  const rows = await sql<Row>`
    select id, name, handle, model_id, role, blurb, tag, hidden
    from assistants
    where user_id = ${userId}
    order by updated_at desc
  `;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: StoredAssistant[] = [];

  for (const row of rows) {
    if (ASSISTANTS.some((a) => a.id === row.id)) continue;
    if (row.hidden) continue;
    out.push(fromRow(row, false));
  }

  for (const builtin of ASSISTANTS) {
    const row = byId.get(builtin.id);
    if (row?.hidden) continue;
    if (row) out.push(fromRow(row, true));
    else out.push({ ...builtin, builtin: true, customized: false });
  }

  return out;
}

export async function saveForUser(userId: string, input: AssistantInput): Promise<StoredAssistant[]> {
  await ensureTable();
  const name = input.name.trim();
  if (!name) throw new Error("Give this rank a name");
  const handle = slugHandle(input.handle || name);
  if (!isModelId(input.modelId)) throw new Error("Pick a model");
  const role = input.role.trim();
  if (!role) throw new Error("Write a role so the seat knows what to do");
  const blurb = input.blurb.trim() || role.slice(0, 80);
  const tag = input.tag.trim() || "Custom";
  const id = input.id?.trim() || newId();

  const sql = await getSql();
  await sql`
    insert into assistants (id, user_id, name, handle, model_id, role, blurb, tag, hidden, updated_at)
    values (${id}, ${userId}, ${name}, ${handle}, ${input.modelId}, ${role}, ${blurb}, ${tag}, false, now())
    on conflict (user_id, id)
    do update set
      name = excluded.name,
      handle = excluded.handle,
      model_id = excluded.model_id,
      role = excluded.role,
      blurb = excluded.blurb,
      tag = excluded.tag,
      hidden = false,
      updated_at = now()
  `;
  return listForUser(userId);
}

export async function removeForUser(userId: string, id: string): Promise<StoredAssistant[]> {
  await ensureTable();
  const sql = await getSql();
  await sql`delete from assistants where user_id = ${userId} and id = ${id}`;
  return listForUser(userId);
}

export function findMerged(list: StoredAssistant[], id: string): StoredAssistant | undefined {
  return list.find((a) => a.id === id);
}

export type { ModelId };
