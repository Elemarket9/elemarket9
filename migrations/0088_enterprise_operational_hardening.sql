-- Enterprise operational hardening: crash recovery, durable webhook workers,
-- delivery attempt history, replay safety, and operational diagnostics.

alter table enterprise_catalog_connections
  add column if not exists active_sync_run_id text,
  add column if not exists active_sync_generation bigint,
  add column if not exists sync_next_cursor text,
  add column if not exists sync_pages_completed integer not null default 0 check (sync_pages_completed >= 0),
  add column if not exists consecutive_sync_failures integer not null default 0 check (consecutive_sync_failures >= 0);

alter table enterprise_webhook_events
  drop constraint if exists enterprise_webhook_events_status_check;
alter table enterprise_webhook_events
  add constraint enterprise_webhook_events_status_check
  check (status in ('received','processing','processed','failed','ignored','dead'));
alter table enterprise_webhook_events
  add column if not exists locked_at timestamptz,
  add column if not exists locked_token text,
  add column if not exists completed_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists event_schema_version integer not null default 1 check (event_schema_version > 0);
create index if not exists enterprise_webhook_events_worker_idx
  on enterprise_webhook_events(status,next_attempt_at,received_at)
  where status in ('received','failed','processing');

alter table enterprise_order_outbox
  add column if not exists delivery_attempt_id text,
  add column if not exists response_status integer,
  add column if not exists response_hash text,
  add column if not exists locked_token text,
  add column if not exists next_attempt_at timestamptz;
update enterprise_order_outbox set next_attempt_at=available_at where next_attempt_at is null;
create index if not exists enterprise_order_outbox_recovery_idx
  on enterprise_order_outbox(status,locked_at)
  where status='processing';

create table if not exists enterprise_order_delivery_attempts (
  id text primary key,
  outbox_id text not null references enterprise_order_outbox(id) on delete cascade,
  attempt_no integer not null check (attempt_no > 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('started','sent','failed','timed_out')),
  response_status integer,
  response_hash text,
  error_code text,
  error_message text,
  unique(outbox_id,attempt_no)
);
create index if not exists enterprise_order_delivery_attempts_outbox_idx
  on enterprise_order_delivery_attempts(outbox_id,attempt_no desc);

create table if not exists enterprise_integration_audit (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  connection_id text references enterprise_catalog_connections(id) on delete set null,
  kind text not null check (kind in ('connection_test','catalog_sync','webhook','order_delivery','credential_rotation','replay')),
  severity text not null default 'info' check (severity in ('info','warning','error','critical')),
  status text not null check (status in ('started','succeeded','failed','replayed')),
  correlation_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists enterprise_integration_audit_merchant_idx
  on enterprise_integration_audit(merchant_id,created_at desc);
create index if not exists enterprise_integration_audit_correlation_idx
  on enterprise_integration_audit(correlation_id)
  where correlation_id is not null;

comment on table enterprise_order_delivery_attempts is 'Immutable-ish operational record of every enterprise order delivery attempt.';
comment on table enterprise_integration_audit is 'Tenant-scoped enterprise integration operational audit trail; secrets and raw credentials must never be written here.';

alter table enterprise_catalog_connections add column if not exists order_webhook_secret_encrypted text;

-- Recover workers that crashed after claiming a row. The recovery window is deliberately
-- longer than the HTTP timeout so a slow but healthy request is not duplicated prematurely.
create or replace function recover_enterprise_order_outbox_claims(p_age_seconds integer default 120)
returns integer language sql as $$
  with recovered as (
    update enterprise_order_outbox
       set status='retry',
           available_at=now(),
           next_attempt_at=now(),
           locked_at=null,
           locked_token=null,
           updated_at=now()
     where status='processing'
       and locked_at < now() - make_interval(secs => greatest(p_age_seconds,30))
     returning 1
  ) select count(*)::int from recovered;
$$;

create or replace function recover_enterprise_webhook_claims(p_age_seconds integer default 120)
returns integer language sql as $$
  with recovered as (
    update enterprise_webhook_events
       set status='failed',
           next_attempt_at=now(),
           locked_at=null,
           locked_token=null
     where status='processing'
       and locked_at < now() - make_interval(secs => greatest(p_age_seconds,30))
     returning 1
  ) select count(*)::int from recovered;
$$;
