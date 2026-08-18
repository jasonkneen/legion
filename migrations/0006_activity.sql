-- Session activity: what the agents actually did, kept across restarts.
--
-- The in-memory ring in log.server is still the live path; this is the history
-- behind it, so reopening a chamber tomorrow shows the tool calls, CLI spawns
-- and subagents from today rather than an empty panel.

create table if not exists activity_events (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  actor text not null default '',
  message text not null,
  duration_ms int,
  data_json text
);

create index if not exists activity_events_convo_at
  on activity_events (conversation_id, at);
