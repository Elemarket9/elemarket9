-- Provider-neutral push device registry. FCM is the first provider; provider
-- credentials never enter this table or the client bundle.
create table if not exists push_devices (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  token text not null,
  token_hash text not null unique,
  platform text not null check (platform in ('android','ios','web')),
  app_version text,
  device_id text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error text,
  disabled_at timestamptz
);

create index if not exists push_devices_user_idx on push_devices(user_id, disabled_at);
create index if not exists push_devices_platform_idx on push_devices(platform, disabled_at);

-- Do not retain raw provider delivery failures indefinitely.
insert into data_retention_policies(data_class, retention_days, notes)
values ('push_devices', 180, 'Registered push-device metadata and delivery state retained for active-device operations.')
on conflict (data_class) do nothing;
