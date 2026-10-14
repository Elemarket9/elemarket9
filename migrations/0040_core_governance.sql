-- ELEMARKET v1.57 core-governance hardening.
-- Adapters provide external capabilities; authorization, ownership, state,
-- auditability and lifecycle policy remain application/database responsibilities.

create table if not exists audit_events (
  id bigserial primary key,
  event_type text not null check (char_length(event_type) between 2 and 160),
  actor_user_id text,
  actor_role text check (actor_role is null or actor_role in ('customer','merchant','admin','system')),
  resource_type text not null check (char_length(resource_type) between 2 and 80),
  resource_id text,
  request_id text,
  outcome text not null default 'success' check (outcome in ('success','denied','failed')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists audit_events_actor_time_idx
  on audit_events(actor_user_id, created_at desc);
create index if not exists audit_events_resource_time_idx
  on audit_events(resource_type, resource_id, created_at desc);
create index if not exists audit_events_type_time_idx
  on audit_events(event_type, created_at desc);

create or replace function record_audit_event(
  p_event_type text,
  p_resource_type text,
  p_resource_id text default null,
  p_actor_user_id text default null,
  p_actor_role text default null,
  p_request_id text default null,
  p_outcome text default 'success',
  p_metadata jsonb default '{}'::jsonb
) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  if p_actor_role is not null and p_actor_role not in ('customer','merchant','admin','system') then
    raise exception 'invalid audit actor role';
  end if;
  if p_outcome not in ('success','denied','failed') then
    raise exception 'invalid audit outcome';
  end if;
  insert into audit_events(event_type,resource_type,resource_id,actor_user_id,actor_role,request_id,outcome,metadata)
  values (
    left(trim(p_event_type),160),
    left(trim(p_resource_type),80),
    nullif(trim(p_resource_id),''),
    nullif(trim(p_actor_user_id),''),
    p_actor_role,
    nullif(trim(p_request_id),''),
    p_outcome,
    coalesce(p_metadata,'{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Audit records are append-only from the application perspective. Operational
-- retention deliberately excludes this table; financial/security evidence must
-- not be silently purged by the ephemeral-data cleanup routine.
create or replace function reject_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_no_update on audit_events;
create trigger audit_events_no_update
before update on audit_events
for each row execute function reject_audit_mutation();

drop trigger if exists audit_events_no_delete on audit_events;
create trigger audit_events_no_delete
before delete on audit_events
for each row execute function reject_audit_mutation();

create table if not exists merchant_verification_checks (
  id text primary key,
  application_id text not null references merchant_applications(id) on delete cascade,
  check_type text not null check (check_type in ('email','phone','identity','business','document','payout')),
  status text not null default 'pending' check (status in ('pending','verified','rejected','expired')),
  provider_key text,
  provider_reference text,
  evidence_ref text,
  reviewed_by text,
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(application_id, check_type)
);

create index if not exists merchant_verification_checks_application_idx
  on merchant_verification_checks(application_id, status);

create or replace function seed_merchant_verification_checks()
returns trigger language plpgsql as $$
begin
  insert into merchant_verification_checks(id,application_id,check_type)
  values
    ('mvc_'||replace(gen_random_uuid()::text,'-',''),new.id,'email'),
    ('mvc_'||replace(gen_random_uuid()::text,'-',''),new.id,'phone')
  on conflict(application_id,check_type) do nothing;
  return new;
end;
$$;

drop trigger if exists merchant_application_verification_seed on merchant_applications;
create trigger merchant_application_verification_seed
after insert on merchant_applications
for each row execute function seed_merchant_verification_checks();

create or replace function review_merchant_application(
  p_application_id text,
  p_admin_id text,
  p_action text,
  p_reason text default null
) returns jsonb language plpgsql as $$
declare
  v_app record;
  v_new_status text;
  v_email_ok boolean;
  v_phone_ok boolean;
  v_merchant_id text;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then
    raise exception 'admin identity required';
  end if;
  if p_action not in ('start_review','approve','reject') then
    raise exception 'invalid merchant review action';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:merchant-application:'||p_application_id, 0));
  select * into v_app from merchant_applications where id=p_application_id for update;
  if not found then raise exception 'merchant application not found'; end if;

  if p_action='start_review' then
    if v_app.status <> 'pending' then raise exception 'application is not pending'; end if;
    v_new_status := 'reviewing';
  elsif p_action='approve' then
    if v_app.status <> 'reviewing' then raise exception 'application must be under review'; end if;
    select exists(
      select 1 from merchant_verification_checks
       where application_id=v_app.id and check_type='email' and status='verified'
    ), exists(
      select 1 from merchant_verification_checks
       where application_id=v_app.id and check_type='phone' and status='verified'
    ) into v_email_ok, v_phone_ok;
    if not v_email_ok or not v_phone_ok then
      raise exception 'email and phone verification are required before merchant approval';
    end if;
    v_new_status := 'approved';
  else
    if v_app.status <> 'reviewing' then raise exception 'application must be under review'; end if;
    if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'rejection reason required'; end if;
    v_new_status := 'rejected';
  end if;

  update merchant_applications
     set status=v_new_status,
         updated_at=now()
   where id=v_app.id;

  -- Approval authorizes the application; it does not invent missing merchant
  -- location/KYC/payout data. Merchant creation/activation remains a separate
  -- trusted workflow once the required business profile is complete.
  if v_new_status='approved' then
    v_merchant_id := null;
  end if;

  perform record_audit_event(
    'merchant.application.'||v_new_status,
    'merchant_application',
    v_app.id,
    p_admin_id,
    'admin',
    null,
    'success',
    jsonb_build_object('action',p_action,'reason',nullif(trim(coalesce(p_reason,'')),''),'merchantId',v_merchant_id)
  );

  return jsonb_build_object('applicationId',v_app.id,'status',v_new_status,'merchantId',v_merchant_id);
end;
$$;



-- Database-level state transitions are also auditable even when a transition is
-- initiated by a webhook, scheduled job, or another trusted database workflow.
create or replace function audit_payment_state_transition()
returns trigger language plpgsql as $$
begin
  perform record_audit_event(
    'payment.state_transition', 'payment', new.payment_id, null, 'system',
    new.provider_event_id, 'success',
    jsonb_build_object('from',new.from_status,'to',new.to_status,'source',new.source)
  );
  return new;
end;
$$;
drop trigger if exists payment_state_transition_audit on payment_state_transitions;
create trigger payment_state_transition_audit
after insert on payment_state_transitions
for each row execute function audit_payment_state_transition();

create or replace function audit_inventory_reservation_change()
returns trigger language plpgsql as $$
begin
  perform record_audit_event(
    'inventory.reservation_state', 'order_stock_reservation', new.id::text, null, 'system', null, 'success',
    jsonb_build_object('orderId',new.order_id,'status',new.status,'quantity',new.quantity)
  );
  return new;
end;
$$;
drop trigger if exists reservation_state_audit on order_stock_reservations;
create trigger reservation_state_audit
after insert or update of status on order_stock_reservations
for each row execute function audit_inventory_reservation_change();

create or replace function audit_merchant_application_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    perform record_audit_event(
      'merchant.application_state', 'merchant_application', new.id, new.user_id, null, null, 'success',
      jsonb_build_object('from',case when tg_op='INSERT' then null else old.status end,'to',new.status)
    );
  end if;
  return new;
end;
$$;
drop trigger if exists merchant_application_state_audit on merchant_applications;
create trigger merchant_application_state_audit
after insert or update of status on merchant_applications
for each row execute function audit_merchant_application_change();

create or replace function audit_escrow_dispute_change()
returns trigger language plpgsql as $$
begin
  perform record_audit_event(
    'escrow.dispute_state', 'escrow_dispute', new.id, null, 'system', null, 'success',
    jsonb_build_object('escrowId',new.escrow_id,'status',new.status)
  );
  return new;
end;
$$;
drop trigger if exists escrow_dispute_state_audit on escrow_disputes;
create trigger escrow_dispute_state_audit
after insert or update of status on escrow_disputes
for each row execute function audit_escrow_dispute_change();

create or replace function audit_settlement_change()
returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' or old.status is distinct from new.status then
    perform record_audit_event(
      'settlement.state_transition', 'merchant_settlement', new.id, null, 'system', null, 'success',
      jsonb_build_object('from',case when tg_op='INSERT' then null else old.status end,'to',new.status,'merchantId',new.merchant_id)
    );
  end if;
  return new;
end;
$$;
drop trigger if exists merchant_settlement_state_audit on merchant_settlements;
create trigger merchant_settlement_state_audit
after insert or update of status on merchant_settlements
for each row execute function audit_settlement_change();

create table if not exists data_retention_policies (
  data_class text primary key,
  retention_days integer not null check (retention_days >= 1),
  notes text not null default '',
  updated_at timestamptz not null default now()
);

insert into data_retention_policies(data_class,retention_days,notes) values
  ('api_rate_limit_buckets', 2, 'Ephemeral abuse-control state; never used as business evidence.'),
  ('otp_challenges', 30, 'Terminal OTP challenges only; active challenges are retained until terminal state.'),
  ('observability_events', 90, 'Operational telemetry; extend according to deployment requirements.'),
  ('observability_counters', 90, 'Operational aggregate telemetry; extend according to deployment requirements.')
on conflict(data_class) do nothing;

create or replace function purge_operational_retention_data(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  v_rate integer := 0;
  v_otp integer := 0;
  v_events integer := 0;
  v_counters integer := 0;
  v_days integer;
begin
  select retention_days into v_days from data_retention_policies where data_class='api_rate_limit_buckets';
  delete from api_rate_limit_buckets where expires_at < p_now - make_interval(days=>coalesce(v_days,2))::interval;
  get diagnostics v_rate = row_count;

  select retention_days into v_days from data_retention_policies where data_class='otp_challenges';
  delete from otp_challenges
   where status <> 'pending'
     and updated_at < p_now - make_interval(days=>coalesce(v_days,30))::interval;
  get diagnostics v_otp = row_count;

  select retention_days into v_days from data_retention_policies where data_class='observability_events';
  delete from observability_events where created_at < p_now - make_interval(days=>coalesce(v_days,90))::interval;
  get diagnostics v_events = row_count;

  select retention_days into v_days from data_retention_policies where data_class='observability_counters';
  delete from observability_counters where bucket_start < p_now - make_interval(days=>coalesce(v_days,90))::interval;
  get diagnostics v_counters = row_count;

  perform record_audit_event(
    'data.retention.purge', 'system', null, null, 'system', null, 'success',
    jsonb_build_object('rateLimitBuckets',v_rate,'otpChallenges',v_otp,'observabilityEvents',v_events,'observabilityCounters',v_counters)
  );
  return jsonb_build_object('rateLimitBuckets',v_rate,'otpChallenges',v_otp,'observabilityEvents',v_events,'observabilityCounters',v_counters);
end;
$$;

comment on table audit_events is 'Append-only application audit evidence. Financial/security evidence is excluded from operational retention purge.';
comment on table merchant_verification_checks is 'Provider-neutral merchant verification state; external providers remain adapters.';
comment on table data_retention_policies is 'Deployment-controlled retention policy for ephemeral/operational data only; legal/financial retention requirements take precedence.';
