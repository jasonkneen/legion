-- The room's shared plan, kept across restarts.
--
-- Same reasoning as activity_events: seats now depend on this list to coordinate
-- with each other, so losing it on a server restart loses the thread of the work
-- rather than just some scrollback.

create table if not exists conversation_todos (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  seq int not null,
  text text not null,
  status text not null default 'pending',
  actor text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists conversation_todos_convo_seq
  on conversation_todos (conversation_id, seq);
