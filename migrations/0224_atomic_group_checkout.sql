-- One provider charge for a marketplace group of distinct merchant orders.
-- All monetary allocations originate in authoritative order rows, not a client.
-- This migration is additive; historical per-order checkout remains intact.
create table if not exists checkout_group_charges (
  id text primary key,
  group_id text not null unique references order_groups(id) on delete restrict,
  user_id text not null,
  provider_key text not null,
  method text not null check (method in ('mobile_money','card','bank_transfer')),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  amount numeric(12,2) not null check (amount > 0),
  settlement_model text not null check (settlement_model in ('provider_split','platform_wallet')),
  split_snapshot jsonb not null check (jsonb_typeof(split_snapshot)='object'),
  provider_reference text not null unique,
  status text not null default 'initializing'
    check (status in ('initializing','pending','completed','failed','needs_attention')),
  checkout_url text,
  initiation_token text,
  initiation_lease_until timestamptz,
  confirmed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists checkout_group_charges_unsettled
  on checkout_group_charges(created_at) where status in ('initializing','pending','needs_attention');

create table if not exists checkout_group_charge_members (
  charge_id text not null references checkout_group_charges(id) on delete restrict,
  order_id text not null unique references orders(id) on delete restrict,
  payment_id text not null unique references payments(id) on delete restrict,
  merchant_id text not null references merchants(id) on delete restrict,
  provider_account_ref text,
  amount numeric(12,2) not null check (amount > 0),
  merchant_net numeric(12,2) not null check (merchant_net >= 0),
  primary key (charge_id, order_id),
  unique (charge_id, merchant_id)
);
create index if not exists checkout_group_charge_members_charge
  on checkout_group_charge_members(charge_id);

-- Signed external webhook or independently verified provider read-back evidence.
create table if not exists checkout_group_charge_events (
  id bigserial primary key,
  charge_id text not null references checkout_group_charges(id) on delete restrict,
  provider_key text not null,
  event_id text not null,
  event_type text not null,
  payload_hash text not null,
  status text not null check (status in ('processed','ignored','rejected')),
  created_at timestamptz not null default now(),
  unique (provider_key,event_id)
);
create index if not exists checkout_group_charge_events_charge
  on checkout_group_charge_events(charge_id,created_at desc);

-- Make it impossible to create a separate provider attempt for a charge member.
-- A buyer cannot accidentally pay both once-per-merchant and once-per-group.
create or replace function elemarket_forbid_group_member_payment_attempt()
returns trigger language plpgsql as $$
begin
  if exists(select 1 from checkout_group_charge_members where payment_id=new.payment_id) then
    raise exception 'payment is owned by a single-charge merchant group';
  end if;
  return new;
end $$;
drop trigger if exists group_charge_member_single_attempt on payment_attempts;
create trigger group_charge_member_single_attempt before insert on payment_attempts
for each row execute function elemarket_forbid_group_member_payment_attempt();

-- Pay-on-delivery is mutually exclusive with an initiated group charge.
create or replace function elemarket_forbid_group_charge_pay_on_delivery()
returns trigger language plpgsql as $$
begin
  if new.payment_timing='on_delivery' and old.payment_timing is distinct from new.payment_timing
     and exists(select 1 from checkout_group_charge_members m
                  join checkout_group_charges g on g.id=m.charge_id
                 where m.order_id=new.id) then
    raise exception 'group payment has already been initiated';
  end if;
  return new;
end $$;
drop trigger if exists group_charge_pay_on_delivery_guard on orders;
create trigger group_charge_pay_on_delivery_guard before update of payment_timing on orders
for each row execute function elemarket_forbid_group_charge_pay_on_delivery();

-- All-or-none group application. Called only after the server independently
-- authenticates a PSP notification AND verifies reference, gross and currency.
-- Keep the same merchant order IDs and wallet credit triggers as ordinary sales.
create or replace function apply_checkout_group_charge_event(
  p_provider_key text, p_event_id text, p_type text, p_reference text,
  p_status text, p_amount numeric, p_currency text, p_payload_hash text
) returns jsonb language plpgsql as $$
declare
  g checkout_group_charges%rowtype;
  m record;
  v_member_count integer := 0;
  v_expected integer;
  v_consumed integer;
  v_status_ok boolean;
begin
  if p_provider_key is null or p_event_id is null or p_reference is null
     or p_payload_hash is null or length(p_event_id)>256
     or p_status not in ('completed','failed') then
    raise exception 'invalid group payment evidence';
  end if;
  select * into g from checkout_group_charges
   where provider_key=p_provider_key and provider_reference=p_reference for update;
  if not found then return jsonb_build_object('retryable',true,'reason','unknown_group_reference'); end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:group-charge:'||g.group_id,0));

  if p_currency is distinct from g.currency or p_amount is distinct from g.amount then
    update checkout_group_charges set status='needs_attention',
           failure_reason='provider amount/currency differs from frozen group charge',
           updated_at=now() where id=g.id and status<>'completed';
    insert into checkout_group_charge_events(charge_id,provider_key,event_id,event_type,payload_hash,status)
    values(g.id,p_provider_key,p_event_id,p_type,p_payload_hash,'rejected')
    on conflict(provider_key,event_id) do nothing;
    return jsonb_build_object('reconciliationRequired',true,'reason','amount_mismatch');
  end if;

  -- Exact event replay is harmless. An event ID reused with a different body
  -- cannot be treated as success.
  if exists(select 1 from checkout_group_charge_events
     where provider_key=p_provider_key and event_id=p_event_id and payload_hash<>p_payload_hash) then
    return jsonb_build_object('rejected',true,'reason','event_payload_mismatch');
  end if;
  if exists(select 1 from checkout_group_charge_events
     where provider_key=p_provider_key and event_id=p_event_id and status in ('processed','ignored')) then
    return jsonb_build_object('duplicate',true,'status',g.status);
  end if;

  if g.status in ('completed','failed') then
    insert into checkout_group_charge_events(charge_id,provider_key,event_id,event_type,payload_hash,status)
    values(g.id,p_provider_key,p_event_id,p_type,p_payload_hash,'ignored')
    on conflict(provider_key,event_id) do nothing;
    return jsonb_build_object('duplicate',true,'status',g.status,
      'reconciliationRequired',g.status='failed' and p_status='completed');
  end if;

  select count(*) into v_expected from checkout_group_charge_members where charge_id=g.id;
  if v_expected<2 or v_expected>3
     or (select coalesce(sum(amount),0) from checkout_group_charge_members where charge_id=g.id)<>g.amount
     or (select count(distinct merchant_id) from checkout_group_charge_members where charge_id=g.id)<>v_expected then
    raise exception 'frozen group charge allocation is inconsistent';
  end if;
  -- All orders must be payable, not silently partially delivered or cancelled.
  select bool_and(p.status='initiated' and o.status='payment_pending'
                and o.payment_timing='upfront'
                and p.user_id=g.user_id and o.user_id=g.user_id
                and p.provider_key=g.provider_key
                and p.settlement_model=g.settlement_model
                and p.amount=m.amount and o.grand_total=m.amount)
    into v_status_ok
    from checkout_group_charge_members m
    join payments p on p.id=m.payment_id
    join orders o on o.id=m.order_id and o.id=p.order_id and o.group_id=g.group_id
   where m.charge_id=g.id;
  if v_status_ok is distinct from true then
    update checkout_group_charges set status='needs_attention',
        failure_reason='merchant order or payment changed before group confirmation',
        updated_at=now() where id=g.id;
    return jsonb_build_object('reconciliationRequired',true,'reason','member_not_pending');
  end if;

  -- Lock rows in a deterministic order, compatible with refund/dispatch locks.
  for m in
    select cm.order_id,cm.payment_id from checkout_group_charge_members cm
    where cm.charge_id=g.id order by cm.order_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('elemarket:order:'||m.order_id,0));
    perform 1 from orders where id=m.order_id for update;
    perform 1 from payments where id=m.payment_id for update;
    v_member_count:=v_member_count+1;
    if p_status='completed' then
      select count(*) into v_expected from order_items where order_id=m.order_id;
      update order_stock_reservations set status='consumed'
       where order_id=m.order_id and status='reserved';
      get diagnostics v_consumed=row_count;
      if v_consumed<>v_expected then raise exception 'group reservation integrity failure'; end if;
      -- Wallet sale credit is triggered exactly once only for platform-wallet mode.
      update payments set status='completed',updated_at=now()
       where id=m.payment_id and status='initiated';
      insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
      values(m.payment_id,'initiated','completed','provider_webhook',p_event_id);
      update orders set status='paid',updated_at=now()
       where id=m.order_id and status='payment_pending';
    else
      perform elemarket_restore_reservation_stock(m.order_id,'reserved');
      update payments set status='failed',updated_at=now()
       where id=m.payment_id and status='initiated';
      insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
      values(m.payment_id,'initiated','failed','provider_webhook',p_event_id);
      update orders set status='cancelled',updated_at=now()
       where id=m.order_id and status='payment_pending';
    end if;
  end loop;
  if v_member_count<2 then raise exception 'group is missing its member orders'; end if;
  update checkout_group_charges set status=case when p_status='completed' then 'completed' else 'failed' end,
      confirmed_at=case when p_status='completed' then now() else confirmed_at end,
      initiation_token=null,initiation_lease_until=null,updated_at=now()
   where id=g.id;
  insert into checkout_group_charge_events(charge_id,provider_key,event_id,event_type,payload_hash,status)
  values(g.id,p_provider_key,p_event_id,p_type,p_payload_hash,'processed')
  on conflict(provider_key,event_id) do nothing;
  return jsonb_build_object('chargeId',g.id,'groupId',g.group_id,'status',p_status,'orders',v_member_count);
end $$;

-- A refund of one group member must be bound to that merchant's exact request,
-- never inferred from the group reference or amount alone.
create or replace function apply_checkout_group_refund_event(
  p_provider_key text,p_event_id text,p_type text,p_reference text,
  p_amount numeric,p_currency text,p_refund_id text,p_payload_hash text
) returns jsonb language plpgsql as $$
declare
  g checkout_group_charges%rowtype;
  r provider_refund_requests%rowtype;
  v_order record;
  v_total numeric(12,2);
  v_new_status text;
begin
  select * into g from checkout_group_charges
   where provider_key=p_provider_key and provider_reference=p_reference for update;
  if not found then return jsonb_build_object('retryable',true,'reason','unknown_group_reference'); end if;
  if p_refund_id is null or length(trim(p_refund_id))<1 then
    return jsonb_build_object('retryable',true,'reason','missing_provider_refund_id');
  end if;
  if p_currency is distinct from g.currency then
    return jsonb_build_object('rejected',true,'reason','refund_currency_mismatch');
  end if;
  select * into r from provider_refund_requests
   where provider_key=p_provider_key and provider_reference=p_reference
     and provider_refund_id=p_refund_id
   for update;
  if not found then return jsonb_build_object('retryable',true,'reason','refund_not_bound'); end if;
  if not exists(select 1 from checkout_group_charge_members cm
     where cm.charge_id=g.id and cm.payment_id=r.payment_id and cm.order_id=r.order_id) then
    return jsonb_build_object('rejected',true,'reason','refund_not_in_group');
  end if;
  if p_amount is distinct from r.amount then
    return jsonb_build_object('rejected',true,'reason','refund_amount_mismatch');
  end if;
  if exists(select 1 from checkout_group_charge_events
    where provider_key=p_provider_key and event_id=p_event_id and payload_hash<>p_payload_hash) then
    return jsonb_build_object('rejected',true,'reason','event_payload_mismatch');
  end if;
  if exists(select 1 from checkout_group_charge_events
    where provider_key=p_provider_key and event_id=p_event_id) then
    return jsonb_build_object('duplicate',true,'status',r.status);
  end if;
  v_new_status:=case p_type
    when 'refund.pending' then 'requested'
    when 'refund.processing' then 'processing'
    when 'refund.needs-attention' then 'needs_attention'
    when 'refund.failed' then 'failed'
    when 'refund.processed' then 'processed'
    else null end;
  if v_new_status is null then return jsonb_build_object('rejected',true,'reason','refund_event_invalid'); end if;
  if r.status='processed' then
    insert into checkout_group_charge_events(charge_id,provider_key,event_id,event_type,payload_hash,status)
    values(g.id,p_provider_key,p_event_id,p_type,p_payload_hash,'ignored')
    on conflict(provider_key,event_id) do nothing;
    return jsonb_build_object('duplicate',true,'status','processed');
  end if;
  if v_new_status='processed' then
    -- Source-linked ledger triggers deduct only this seller's entitlement.
    update provider_refund_requests set status='processed',processed_at=now(),updated_at=now()
     where id=r.id and status<>'processed';
    select coalesce(sum(amount),0) into v_total from provider_refund_requests
     where payment_id=r.payment_id and status='processed';
    select o.id, o.status, p.amount into v_order
      from payments p join orders o on o.id=p.order_id
     where p.id=r.payment_id for update of p,o;
    if v_total >= v_order.amount and v_order.status not in ('cancelled','refunded') then
      if v_order.status in ('paid','confirmed','refund_pending') then
        perform elemarket_restore_reservation_stock(v_order.id,'consumed');
      else
        update order_stock_reservations set status='released',released_at=now()
         where order_id=v_order.id and status='consumed';
      end if;
      update payments set status='refunded',updated_at=now()
       where id=r.payment_id and status='completed';
      update orders set status='refunded',updated_at=now()
       where id=v_order.id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','refund_pending');
      insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
      values(r.payment_id,'completed','refunded','provider_webhook',p_event_id);
    end if;
  else
    update provider_refund_requests set status=v_new_status,updated_at=now()
     where id=r.id and status not in ('processed');
  end if;
  insert into checkout_group_charge_events(charge_id,provider_key,event_id,event_type,payload_hash,status)
  values(g.id,p_provider_key,p_event_id,p_type,p_payload_hash,'processed')
  on conflict(provider_key,event_id) do nothing;
  return jsonb_build_object('chargeId',g.id,'refundRequestId',r.id,
     'orderId',r.order_id,'status',v_new_status);
end $$;
revoke all on function apply_checkout_group_charge_event(text,text,text,text,text,numeric,text,text) from public;
revoke all on function apply_checkout_group_refund_event(text,text,text,text,numeric,text,text,text) from public;
