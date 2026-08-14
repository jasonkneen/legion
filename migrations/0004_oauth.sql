alter table provider_keys add column if not exists auth_kind text not null default 'api_key';
alter table provider_keys add column if not exists refresh_token text;
alter table provider_keys add column if not exists account_id text;
alter table provider_keys add column if not exists expires_at timestamptz;
alter table provider_keys add column if not exists extra_json text not null default '{}';
