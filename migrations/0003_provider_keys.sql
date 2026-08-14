-- Per-user bring-your-own API keys. Values never leave the server after save.

create table if not exists provider_keys (
  user_id text not null,
  provider text not null,
  api_key text not null,
  model text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
