-- Chamber: per-user conversations, seated agents, shared messages.

create table if not exists conversations (
  id text primary key,
  user_id text not null,
  title text not null default 'New chamber',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_updated
  on conversations (user_id, updated_at desc);

create table if not exists conversation_agents (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  user_id text not null,
  handle text not null,
  display_name text not null,
  model_id text not null,
  role text not null default '',
  seat_order int not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists conversation_agents_handle
  on conversation_agents (conversation_id, handle);

create index if not exists conversation_agents_convo
  on conversation_agents (conversation_id, seat_order);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  user_id text not null,
  author_type text not null,
  agent_id text,
  content text not null,
  mentions_json text not null default '[]',
  task text,
  created_at timestamptz not null default now()
);

create index if not exists messages_convo_created
  on messages (conversation_id, created_at);
