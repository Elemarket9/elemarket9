-- Resend webhook event ledger. The raw payload is retained for operational debugging;
-- access must remain server-side and retention policy should be applied by operations.
create table if not exists email_events (
  id text primary key,
  event_type text not null,
  email_id text not null,
  recipient text,
  subject text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  received_at timestamptz not null default now()
);

create index if not exists email_events_email_id_idx on email_events(email_id, created_at desc);
create index if not exists email_events_type_idx on email_events(event_type, created_at desc);

insert into data_retention_policies(data_class, retention_days, notes)
values ('email_events', 30, 'Resend webhook events retained for operational diagnostics.')
on conflict (data_class) do nothing;
