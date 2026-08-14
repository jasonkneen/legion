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
);
