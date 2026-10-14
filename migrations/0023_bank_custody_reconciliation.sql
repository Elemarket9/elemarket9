-- CTO aggressive hardening: regulated-custodian adapter and reconciliation boundary.
-- ELEMARKET never treats its own ledger as custody. A licensed bank/PSP remains
-- the source of truth for actual money movement.

create table if not exists custody_providers (
  id text primary key,
  provider_key text not null unique,
  name text not null check (char_length(name) between 2 and 160),
  provider_type text not null check (provider_type in ('bank','psp','emi')),
  status text not null default 'active' check (status in ('active','suspended')),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists escrow_custody_refs (
  id text primary key,
  escrow_id text not null unique references escrows(id) on delete restrict,
  provider_id text not null references custody_providers(id) on delete restrict,
  custody_reference text not null,
  status text not null default 'pending' check (status in ('pending','funded','released','refunded','exception')),
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  last_provider_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_id,custody_reference)
);

create table if not exists settlement_attempts (
  id text primary key,
  settlement_id text not null references merchant_settlements(id) on delete restrict,
  attempt_no integer not null check (attempt_no > 0),
  provider_id text not null references custody_providers(id) on delete restrict,
  idempotency_key text not null unique,
  status text not null default 'created' check (status in ('created','submitted','confirmed','failed','unknown')),
  provider_reference text,
  failure_code text,
  failure_message text,
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique(settlement_id,attempt_no)
);

create table if not exists reconciliation_runs (
  id text primary key,
  provider_id text not null references custody_providers(id) on delete restrict,
  as_of timestamptz not null,
  status text not null default 'started' check (status in ('started','completed','exception')),
  records_checked integer not null default 0 check (records_checked >= 0),
  mismatches integer not null default 0 check (mismatches >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists reconciliation_exceptions (
  id bigserial primary key,
  run_id text not null references reconciliation_runs(id) on delete restrict,
  escrow_id text references escrows(id) on delete restrict,
  settlement_id text references merchant_settlements(id) on delete restrict,
  provider_reference text,
  exception_type text not null check (exception_type in ('missing_provider_record','missing_internal_record','amount_mismatch','currency_mismatch','status_mismatch','duplicate_provider_reference')),
  expected_amount numeric(12,2),
  observed_amount numeric(12,2),
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now()
);
create index if not exists reconciliation_exceptions_run_idx on reconciliation_exceptions(run_id,created_at);
create index if not exists reconciliation_exceptions_open_idx on reconciliation_exceptions(created_at) where resolved_at is null;

-- Never store raw bank account numbers here. destination_ref must be an opaque
-- provider token/reference returned by the regulated provider.
comment on column merchant_payout_accounts.destination_ref is 'Opaque provider token/reference only; never store raw account or card numbers.';

insert into custody_providers(id,provider_key,name,provider_type,status)
values ('custody_sandbox','bank_sandbox','ELEMARKET Custody Sandbox','bank','active')
on conflict (provider_key) do nothing;

-- Atomic delivery confirmation: prevents a customer from jumping directly from
-- paid/confirmed to delivered and keeps order + escrow state in one transaction.
create or replace function confirm_order_delivery_for_escrow(p_order_id text,p_user_id text,p_is_admin boolean default false)
returns jsonb language plpgsql as $$
declare v_o record; v_e record;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:order-delivery:'||p_order_id));
  select * into v_o from orders where id=p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  if not p_is_admin and v_o.user_id <> p_user_id then raise exception 'order access denied'; end if;
  if p_is_admin then
    if v_o.status not in ('fulfilling','shipped') then raise exception 'order is not deliverable'; end if;
  else
    if v_o.status <> 'shipped' then raise exception 'customer can confirm delivery only after shipment'; end if;
  end if;
  select * into v_e from escrows where order_id=p_order_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if v_e.state not in ('held','fulfilling','delivered') then raise exception 'escrow cannot enter delivery release window'; end if;
  update orders set status='delivered',updated_at=now() where id=p_order_id;
  update escrows set state='release_pending',delivered_at=coalesce(delivered_at,now()),release_eligible_at=now()+interval '48 hours',updated_at=now() where id=v_e.id;
  return jsonb_build_object('orderId',p_order_id,'escrowId',v_e.id,'state','release_pending','releaseEligibleAt',now()+interval '48 hours');
end;
$$;

-- Release is never allowed without a verified payout destination. This does not
-- move funds; it creates an entitlement for the licensed provider adapter.
create or replace function release_escrow(p_escrow_id text,p_reference text)
returns jsonb language plpgsql as $$
declare v_e record; v_settlement text;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:escrow:'||p_escrow_id));
  select * into v_e from escrows where id=p_escrow_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if v_e.state <> 'release_pending' then raise exception 'escrow is not release eligible'; end if;
  if v_e.release_eligible_at is null or v_e.release_eligible_at > now() then raise exception 'buyer protection window is still active'; end if;
  if exists(select 1 from escrow_disputes where escrow_id=v_e.id and status in ('open','under_review')) then raise exception 'escrow is disputed'; end if;
  if not exists(select 1 from merchant_payout_accounts where merchant_id=v_e.merchant_id and status='verified') then raise exception 'merchant payout account is not verified'; end if;
  update escrows set state='released',released_at=now(),updated_at=now() where id=v_e.id;
  v_settlement := 'set_'||replace(gen_random_uuid()::text,'-','');
  insert into merchant_settlements(id,escrow_id,merchant_id,amount,status,payout_destination_ref)
  select v_settlement,v_e.id,v_e.merchant_id,v_e.merchant_entitlement,'eligible',mpa.destination_ref
  from merchant_payout_accounts mpa where mpa.merchant_id=v_e.merchant_id and mpa.status='verified' order by mpa.updated_at desc limit 1
  on conflict(escrow_id) do nothing;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'release','debit',v_e.merchant_entitlement,p_reference,jsonb_build_object('settlementId',v_settlement)) on conflict do nothing;
  return jsonb_build_object('escrowId',v_e.id,'settlementId',v_settlement,'amount',v_e.merchant_entitlement,'status','eligible');
end;
$$;

-- Idempotent provider settlement request. The same settlement may only have one
-- active attempt at a time; failed attempts get a new deterministic attempt key.
create or replace function create_settlement_attempt(p_settlement_id text,p_provider_key text)
returns jsonb language plpgsql as $$
declare v_s record; v_p record; v_attempt integer; v_id text; v_key text;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement:'||p_settlement_id));
  select * into v_s from merchant_settlements where id=p_settlement_id for update;
  if not found then raise exception 'settlement not found'; end if;
  if v_s.status <> 'eligible' then raise exception 'settlement is not eligible'; end if;
  select * into v_p from custody_providers where provider_key=p_provider_key and status='active';
  if not found then raise exception 'custody provider unavailable'; end if;
  select coalesce(max(attempt_no),0)+1 into v_attempt from settlement_attempts where settlement_id=v_s.id;
  v_id := 'sat_'||replace(gen_random_uuid()::text,'-','');
  v_key := 'settlement:'||v_s.id||':attempt:'||v_attempt;
  insert into settlement_attempts(id,settlement_id,attempt_no,provider_id,idempotency_key,status)
  values(v_id,v_s.id,v_attempt,v_p.id,v_key,'created');
  update merchant_settlements set status='processing',updated_at=now() where id=v_s.id;
  update settlement_attempts set status='submitted' where id=v_id;
  return jsonb_build_object('attemptId',v_id,'settlementId',v_s.id,'idempotencyKey',v_key,'amount',v_s.amount,'currency',v_s.currency,'destinationRef',v_s.payout_destination_ref);
end;
$$;

create or replace function confirm_settlement_attempt(p_attempt_id text,p_provider_reference text)
returns jsonb language plpgsql as $$
declare v_a record; v_s record; v_e record;
begin
  if p_provider_reference is null or length(trim(p_provider_reference)) < 3 then raise exception 'provider reference required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement-attempt:'||p_attempt_id));
  select * into v_a from settlement_attempts where id=p_attempt_id for update;
  if not found then raise exception 'settlement attempt not found'; end if;
  if v_a.status <> 'submitted' then raise exception 'settlement attempt is not awaiting confirmation'; end if;
  if exists(select 1 from settlement_attempts where provider_reference=trim(p_provider_reference) and id<>v_a.id) then raise exception 'provider reference already used'; end if;
  select * into v_s from merchant_settlements where id=v_a.settlement_id for update;
  select * into v_e from escrows where id=v_s.escrow_id for update;
  if v_s.status <> 'processing' or v_e.state <> 'released' then raise exception 'settlement state is not confirmable'; end if;
  update settlement_attempts set status='confirmed',provider_reference=trim(p_provider_reference),confirmed_at=now() where id=v_a.id;
  update merchant_settlements set status='paid',provider_reference=trim(p_provider_reference),processed_at=now(),updated_at=now() where id=v_s.id;
  update escrows set state='settled',settled_at=now(),updated_at=now() where id=v_e.id;
  return jsonb_build_object('attemptId',v_a.id,'settlementId',v_s.id,'status','paid');
end;
$$;

-- Prevent direct settlement confirmation from bypassing an attempt/provider.
create unique index if not exists settlement_provider_reference_uq on merchant_settlements(provider_reference) where provider_reference is not null;

-- Separate payment completion from custodian-confirmed funding. This prevents a
-- payment-provider callback from being treated as proof that the safeguarding
-- bank actually received the money.
alter table escrow_ledger_entries drop constraint if exists escrow_ledger_entries_entry_type_check;
alter table escrow_ledger_entries add constraint escrow_ledger_entries_entry_type_check check (entry_type in ('funding_pending','funded','fee_reserved','delivery_reserved','release','refund','dispute_hold','adjustment'));

create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$
declare v_order record; v_escrow text;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  select id, merchant_id, product_total, delivery_total, platform_fee, merchant_net, grand_total
    into v_order from orders where id=new.order_id for update;
  if not found then raise exception 'escrow order not found'; end if;
  if new.amount <> v_order.grand_total then raise exception 'escrow payment/order amount mismatch'; end if;
  v_escrow := 'esc_' || replace(gen_random_uuid()::text,'-','');
  insert into escrows(id,order_id,payment_id,merchant_id,gross_amount,delivery_amount,platform_fee,merchant_entitlement,state,created_at,updated_at)
  values(v_escrow,v_order.id,new.id,v_order.merchant_id,v_order.grand_total,v_order.delivery_total,v_order.platform_fee,v_order.merchant_net,'funding_pending',now(),now())
  on conflict(order_id) do nothing;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'funding_pending','credit',e.gross_amount,new.id,jsonb_build_object('paymentId',new.id,'providerKey',new.provider_key)
  from escrows e where e.order_id=v_order.id on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists payment_completed_escrow_create on payments;
create trigger payment_completed_escrow_create
after update of status on payments
for each row execute function create_escrow_for_completed_payment();

create or replace function confirm_escrow_funding(p_escrow_id text,p_provider_key text,p_custody_reference text)
returns jsonb language plpgsql as $$
declare v_e record; v_p record; v_ref text;
begin
  if p_custody_reference is null or length(trim(p_custody_reference)) < 3 then raise exception 'custody reference required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:escrow-funding:'||p_escrow_id));
  select * into v_e from escrows where id=p_escrow_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if v_e.state not in ('funding_pending','funded') then raise exception 'escrow is not awaiting funding confirmation'; end if;
  select * into v_p from custody_providers where provider_key=p_provider_key and status='active';
  if not found then raise exception 'custody provider unavailable'; end if;
  v_ref := trim(p_custody_reference);
  insert into escrow_custody_refs(id,escrow_id,provider_id,custody_reference,status,amount,currency,last_provider_event_at)
  values('ecf_'||replace(gen_random_uuid()::text,'-',''),v_e.id,v_p.id,v_ref,'funded',v_e.gross_amount,v_e.currency,now())
  on conflict(escrow_id) do update set provider_id=excluded.provider_id,custody_reference=excluded.custody_reference,status='funded',amount=excluded.amount,currency=excluded.currency,last_provider_event_at=now(),updated_at=now();
  update escrows set state='held',funded_at=coalesce(funded_at,now()),updated_at=now() where id=v_e.id;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'funded','credit',v_e.gross_amount,v_ref,jsonb_build_object('providerKey',p_provider_key,'custodyReference',v_ref)) on conflict do nothing;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'fee_reserved','debit',v_e.platform_fee,v_ref,jsonb_build_object('source','custody_confirmation')) on conflict do nothing;
  return jsonb_build_object('escrowId',v_e.id,'state','held','custodyReference',v_ref);
end;
$$;


create or replace function fail_settlement_attempt(p_attempt_id text,p_failure_code text,p_failure_message text default '')
returns jsonb language plpgsql as $$
declare v_a record;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement-attempt:'||p_attempt_id));
  select * into v_a from settlement_attempts where id=p_attempt_id for update;
  if not found then raise exception 'settlement attempt not found'; end if;
  if v_a.status <> 'submitted' then raise exception 'settlement attempt is not failed-state eligible'; end if;
  update settlement_attempts set status='failed',failure_code=left(coalesce(p_failure_code,'provider_failure'),120),failure_message=left(coalesce(p_failure_message,''),500) where id=v_a.id;
  update merchant_settlements set status='eligible',updated_at=now() where id=v_a.settlement_id and status='processing';
  return jsonb_build_object('attemptId',v_a.id,'status','failed');
end;
$$;

-- Admin-only database primitive for franchise/official-store verification. The
-- application layer must still authenticate the caller as an operations admin.
create or replace function verify_merchant_brand_authorization(p_authorization_id text,p_admin_id text,p_expires_at timestamptz default null)
returns jsonb language plpgsql as $$
declare v record;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  select mba.*,b.verification_status,b.status brand_status into v
  from merchant_brand_authorizations mba join brands b on b.id=mba.brand_id
  where mba.id=p_authorization_id for update;
  if not found then raise exception 'brand authorization not found'; end if;
  if v.brand_status <> 'active' then raise exception 'brand is suspended'; end if;
  if v.evidence_ref is null or length(trim(v.evidence_ref)) < 3 then raise exception 'verification evidence required'; end if;
  update merchant_brand_authorizations set status='verified',reviewed_by=trim(p_admin_id),reviewed_at=now(),expires_at=p_expires_at where id=v.id;
  return jsonb_build_object('authorizationId',v.id,'status','verified','brandId',v.brand_id,'relationship',v.relationship,'expiresAt',p_expires_at);
end;
$$;
