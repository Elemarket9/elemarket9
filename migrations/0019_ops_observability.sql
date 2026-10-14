-- v1.40.0 operations/observability foundation.
-- Append-only-ish event records + atomic counters for reservation/payment telemetry.
create table if not exists observability_events (
  id bigserial primary key,
  event_name text not null check (char_length(event_name) between 2 and 160),
  severity text not null default 'info' check (severity in ('debug','info','warn','error')),
  request_id text,
  user_id text,
  entity_id text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists observability_events_name_time_idx on observability_events(event_name, created_at desc);
create index if not exists observability_events_entity_time_idx on observability_events(entity_id, created_at desc);

create table if not exists observability_counters (
  metric_key text not null,
  bucket_start timestamptz not null,
  value bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(metric_key, bucket_start)
);
create index if not exists observability_counters_bucket_idx on observability_counters(bucket_start desc);

create or replace function record_observability_event(
  p_event_name text,
  p_severity text default 'info',
  p_request_id text default null,
  p_user_id text default null,
  p_entity_id text default null,
  p_duration_ms integer default null,
  p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql as $$
begin
  insert into observability_events(event_name,severity,request_id,user_id,entity_id,duration_ms,metadata)
  values(p_event_name,p_severity,p_request_id,p_user_id,p_entity_id,p_duration_ms,coalesce(p_metadata,'{}'::jsonb));
end; $$;

create or replace function increment_observability_counter(p_metric_key text, p_delta bigint default 1)
returns void language plpgsql as $$
declare v_bucket timestamptz := date_trunc('minute', now());
begin
  insert into observability_counters(metric_key,bucket_start,value)
  values(p_metric_key,v_bucket,p_delta)
  on conflict(metric_key, bucket_start) do update set value=observability_counters.value + excluded.value, updated_at=now();
end; $$;


-- Database-native telemetry for the two most important money/inventory boundaries.
create or replace function observe_reservation_change() returns trigger language plpgsql as $$
begin
  perform record_observability_event(
    case when tg_op = 'INSERT' then 'reservation.acquired' else 'reservation.status_changed' end,
    'info', null, null, new.order_id, null,
    jsonb_build_object('reservationId', new.id, 'orderItemId', new.order_item_id, 'status', new.status, 'quantity', new.quantity)
  );
  perform increment_observability_counter(case when tg_op = 'INSERT' then 'reservation.acquired' else 'reservation.status_changed' end, 1);
  return new;
end; $$;

drop trigger if exists order_stock_reservation_observe on order_stock_reservations;
create trigger order_stock_reservation_observe
after insert or update of status on order_stock_reservations
for each row execute function observe_reservation_change();

create or replace function observe_payment_transition() returns trigger language plpgsql as $$
begin
  perform record_observability_event(
    'payment.state_transition', 'info', new.provider_event_id, null, new.payment_id, null,
    jsonb_build_object('from', new.from_status, 'to', new.to_status, 'source', new.source)
  );
  perform increment_observability_counter('payment.state_transition', 1);
  return new;
end; $$;

drop trigger if exists payment_state_transition_observe on payment_state_transitions;
create trigger payment_state_transition_observe
after insert on payment_state_transitions
for each row execute function observe_payment_transition();
