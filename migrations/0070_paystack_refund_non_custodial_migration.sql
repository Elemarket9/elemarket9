-- v1.50: migrate marketplace dispute/cancellation money flows from the legacy
-- local escrow model to provider-executed refunds.
-- ELEMARKET is non-custodial: it records order/payment/refund state only.

-- Stop creating local escrow rows when a payment completes.
drop trigger if exists payment_completed_escrow_create on payments;
drop trigger if exists payment_refund_escrow_guard on payments;
drop trigger if exists payment_refunded_escrow_finalize on payments;
drop trigger if exists payment_refund_escrow_sync on payments;

-- Historical escrow tables remain for audit/backward-compatible reads, but are
-- no longer part of the live payment lifecycle.
alter table if exists escrows add column if not exists legacy_non_operational boolean not null default true;
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in (
  'payment_pending','paid','confirmed','fulfilling','shipped','delivered','completed',
  'cancelled','disputed','refund_pending','refunded'
));

update escrows set legacy_non_operational=true where legacy_non_operational is distinct from true;

-- Disputes are now bound directly to the order/payment they concern. Existing
-- records are backfilled once from their historical escrow relationship.
alter table escrow_disputes add column if not exists order_id text references orders(id) on delete restrict;
alter table escrow_disputes add column if not exists payment_id text references payments(id) on delete restrict;
update escrow_disputes d
set order_id=e.order_id,
    payment_id=e.payment_id
from escrows e
where d.escrow_id=e.id
  and (d.order_id is null or d.payment_id is null);
create index if not exists escrow_disputes_order_idx on escrow_disputes(order_id);
create index if not exists escrow_disputes_payment_idx on escrow_disputes(payment_id);

create table if not exists provider_refund_requests (
  id text primary key,
  payment_id text not null references payments(id) on delete restrict,
  order_id text not null references orders(id) on delete restrict,
  provider_key text not null,
  provider_reference text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null check (currency='GHS'),
  status text not null default 'requested' check (status in (
    'requested','processing','processed','needs_attention','failed','cancelled'
  )),
  provider_refund_id text,
  reason text,
  customer_note text,
  merchant_note text,
  requested_by text,
  provider_response jsonb,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists provider_refund_requests_payment_active_uq
  on provider_refund_requests(payment_id)
  where status in ('requested','processing','needs_attention');
create unique index if not exists provider_refund_requests_provider_ref_uq
  on provider_refund_requests(provider_key,provider_reference)
  where provider_reference is not null;
create index if not exists provider_refund_requests_order_idx
  on provider_refund_requests(order_id,requested_at desc);

-- A dispute refund is now a provider-refund request. No local release state,
-- merchant settlement, or escrow balance is changed.
create or replace function prepare_provider_refund_for_dispute(
  p_dispute_id text,
  p_admin_id text,
  p_note text default ''
) returns jsonb language plpgsql as $$
declare
  v_d record;
  v_payment record;
  v_request text := 'prr_'||replace(gen_random_uuid()::text,'-','');
  v_existing record;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  select * into v_d from escrow_disputes where id=p_dispute_id for update;
  if not found then raise exception 'dispute not found'; end if;
  if v_d.status not in ('open','under_review') then raise exception 'dispute already resolved'; end if;
  if v_d.payment_id is null or v_d.order_id is null then raise exception 'dispute is not bound to a payment'; end if;

  select p.* into v_payment from payments p where p.id=v_d.payment_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.order_id <> v_d.order_id then raise exception 'dispute payment/order mismatch'; end if;
  if v_payment.status <> 'completed' then raise exception 'only completed payments can be refunded'; end if;
  if v_payment.provider_reference is null then raise exception 'payment has no provider reference'; end if;

  select * into v_existing from provider_refund_requests
   where payment_id=v_payment.id and status in ('requested','processing','needs_attention')
   order by requested_at desc limit 1 for update;
  if found then
    return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'providerReference',v_existing.provider_reference,'amount',v_existing.amount,'currency',v_existing.currency,'existing',true);
  end if;

  insert into provider_refund_requests(
    id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,
    reason,customer_note,merchant_note,requested_by
  ) values (
    v_request,v_payment.id,v_payment.order_id,v_payment.provider_key,v_payment.provider_reference,
    v_payment.amount,v_payment.currency,'requested','admin_dispute_refund',p_note,p_note,p_admin_id
  );

  update escrow_disputes
     set status='resolved_refund',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now()
   where id=v_d.id;

  update orders set status='refund_pending', updated_at=now()
   where id=v_d.order_id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed');

  perform record_audit_event(
    'admin.dispute.refund_requested','escrow_dispute',v_d.id,p_admin_id,'admin',null,'success',
    jsonb_build_object('providerRefundRequestId',v_request,'paymentId',v_payment.id,'providerKey',v_payment.provider_key)
  );

  return jsonb_build_object('requestId',v_request,'status','requested','providerReference',v_payment.provider_reference,'amount',v_payment.amount,'currency',v_payment.currency,'existing',false);
end;
$$;

comment on table provider_refund_requests is 'Provider-executed refund requests. ELEMARKET never holds or releases customer funds.';
comment on function prepare_provider_refund_for_dispute(text,text,text) is 'Prepares a provider refund request; external provider executes the actual refund.';

create or replace function prepare_provider_refund_for_payment(
  p_payment_id text,
  p_actor_id text,
  p_reason text default 'customer_order_cancellation'
) returns jsonb language plpgsql as $$
declare
  v_payment record;
  v_existing record;
  v_request text := 'prr_'||replace(gen_random_uuid()::text,'-','');
begin
  select * into v_payment from payments where id=p_payment_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.status <> 'completed' then raise exception 'only completed payments can be refunded'; end if;
  if v_payment.provider_reference is null then raise exception 'payment has no provider reference'; end if;
  select * into v_existing from provider_refund_requests where payment_id=v_payment.id and status in ('requested','processing','needs_attention','processed') order by requested_at desc limit 1 for update;
  if found then return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'existing',true); end if;
  insert into provider_refund_requests(id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,reason,requested_by)
  values(v_request,v_payment.id,v_payment.order_id,v_payment.provider_key,v_payment.provider_reference,v_payment.amount,v_payment.currency,'requested',p_reason,p_actor_id);
  update orders set status='refund_pending',updated_at=now() where id=v_payment.order_id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed');
  return jsonb_build_object('requestId',v_request,'status','requested','existing',false);
end;
$$;

-- Remove live merchant fund-release mechanics. The tables are retained only as
-- historical compatibility records; no new request may be created.
create or replace function create_merchant_fund_release_request(p_merchant_id text,p_amount numeric,p_merchant_note text default '')
returns jsonb language plpgsql as $$ begin raise exception 'merchant fund release is disabled; settlement is controlled by the payment provider'; end; $$;
create or replace function review_merchant_fund_release_request(p_request_id text,p_decision text,p_admin_id text,p_note text default '')
returns jsonb language plpgsql as $$ begin raise exception 'merchant fund release is disabled; settlement is controlled by the payment provider'; end; $$;

comment on table escrows is 'LEGACY ONLY. ELEMARKET does not custody, hold, release, or settle customer funds. Provider settlement/refunds are authoritative.';
comment on table merchant_fund_release_requests is 'LEGACY ONLY. No new requests are accepted. Payment provider controls settlement.';


-- Reconcile provider refund webhooks without consulting the legacy escrow ledger.
create or replace function apply_payment_webhook(
  p_provider_key text, p_event_id text, p_event_type text, p_provider_reference text,
  p_status text, p_amount numeric, p_currency text, p_payload_hash text,
  p_provider_refund_id text default null
) returns jsonb language plpgsql as $$
declare
  v_event record; v_payment record; v_order record; v_provider record;
  v_new_status text; v_consumed integer; v_expected integer;
begin
  if p_provider_key is null or p_event_id is null or p_event_type is null or p_payload_hash is null then raise exception 'invalid webhook'; end if;
  if p_status not in ('authorized','completed','failed','refunded') then raise exception 'unsupported payment status'; end if;
  if p_currency <> 'GHS' or p_amount is null or p_amount <= 0 then raise exception 'invalid payment amount'; end if;
  select provider_key,status into v_provider from payment_providers where provider_key=p_provider_key;
  if not found or v_provider.status <> 'active' then raise exception 'payment provider is not active'; end if;
  insert into payment_webhook_events(provider_key,event_id,event_type,provider_reference,payload_hash,signature_verified,processing_status)
  values(p_provider_key,p_event_id,p_event_type,p_provider_reference,p_payload_hash,true,'received')
  on conflict(provider_key,event_id) do nothing;
  select * into v_event from payment_webhook_events where provider_key=p_provider_key and event_id=p_event_id for update;
  if v_event.payload_hash <> p_payload_hash then
    update payment_webhook_events set processing_status='rejected',error_code='event_payload_mismatch',processed_at=now() where id=v_event.id;
    raise exception 'webhook event replay with different payload';
  end if;
  if v_event.processing_status in ('processed','ignored','rejected') then return jsonb_build_object('duplicate',true,'status',v_event.processing_status); end if;
  -- Bind first to the payment attempt. The provider can send the webhook immediately
  -- after initialization, before the application has copied the reference onto payments.
  select p.* into v_payment
    from payment_attempts pa
    join payments p on p.id=pa.payment_id
   where pa.provider_key=p_provider_key
     and pa.provider_reference=p_provider_reference
   order by pa.created_at desc
   limit 1
   for update of p;
  if not found then
    update payment_webhook_events set processing_status='received',error_code='payment_not_yet_bound',processed_at=null where id=v_event.id;
    raise exception 'payment not yet bound';
  end if;
  if round(v_payment.amount,2) <> round(p_amount,2) or v_payment.currency <> p_currency then
    update payment_webhook_events set processing_status='rejected',error_code='amount_mismatch',processed_at=now() where id=v_event.id;
    raise exception 'payment amount mismatch';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:'||v_payment.order_id,0));
  select * into v_order from orders where id=v_payment.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_payment.user_id<>v_order.user_id then raise exception 'payment/order owner mismatch'; end if;
  v_new_status:=p_status;
  if p_event_type like 'refund.%' then
    if p_event_type='refund.processed' then
      update provider_refund_requests set status='processed',provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),processed_at=now(),updated_at=now() where payment_id=v_payment.id and status in ('requested','processing','needs_attention');
      update order_stock_reservations set status='released',released_at=now() where order_id=v_order.id and status='consumed';
      update payments set status='refunded',updated_at=now() where id=v_payment.id;
      insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id) values(v_payment.id,v_payment.status,'refunded','provider_webhook',p_event_id);
      update orders set status='refunded',updated_at=now() where id=v_order.id and status='refund_pending';
    elsif p_event_type='refund.failed' then
      update provider_refund_requests set status='failed',provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),updated_at=now() where payment_id=v_payment.id and status in ('requested','processing','needs_attention');
      update orders set status='paid',updated_at=now() where id=v_order.id and status='refund_pending';
    elsif p_event_type='refund.needs-attention' then
      update provider_refund_requests set status='needs_attention',provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),updated_at=now() where payment_id=v_payment.id and status in ('requested','processing','needs_attention');
    else
      update provider_refund_requests set status=case when p_event_type='refund.processing' then 'processing' else 'requested' end,provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),updated_at=now() where payment_id=v_payment.id and status in ('requested','processing','needs_attention');
    end if;
    update payment_webhook_events set processing_status='processed',processed_at=now(),error_code=null where id=v_event.id;
    return jsonb_build_object('duplicate',false,'paymentId',v_payment.id,'orderId',v_order.id,'status',case when p_event_type='refund.processed' then 'refunded' else p_event_type end);
  end if;
  if not validate_payment_transition(v_payment.status,v_new_status) then
    update payment_webhook_events set processing_status='rejected',error_code='invalid_state_transition',processed_at=now() where id=v_event.id;
    raise exception 'invalid payment state transition';
  end if;
  if v_new_status='completed' and v_payment.status<>'completed' then
    if v_order.status <> 'payment_pending' then
      update payment_webhook_events set processing_status='rejected',error_code='order_not_payment_pending',processed_at=now() where id=v_event.id;
      raise exception 'order is not payment pending';
    end if;
    select count(*) into v_expected from order_items where order_id=v_order.id;
    update order_stock_reservations set status='consumed' where order_id=v_order.id and status='reserved';
    get diagnostics v_consumed=row_count;
    if v_consumed<>v_expected then raise exception 'reservation integrity failure'; end if;
  elsif v_new_status='refunded' then
    update order_stock_reservations set status='released',released_at=now() where order_id=v_order.id and status='consumed';
    update provider_refund_requests set status='processed',provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),processed_at=now(),updated_at=now() where payment_id=v_payment.id and status in ('requested','processing','needs_attention');
  end if;
  update payments set provider_reference=coalesce(p_provider_reference,provider_reference),status=v_new_status,updated_at=now() where id=v_payment.id;
  if v_payment.status<>v_new_status then insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id) values(v_payment.id,v_payment.status,v_new_status,'provider_webhook',p_event_id); end if;
  if v_new_status='completed' and v_payment.status<>'completed' then update orders set status='paid',updated_at=now() where id=v_order.id and status='payment_pending';
  elsif v_new_status='refunded' then update orders set status='refunded',updated_at=now() where id=v_order.id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','refund_pending'); end if;
  update payment_webhook_events set processing_status=case when v_payment.status=v_new_status then 'ignored' else 'processed' end,processed_at=now(),error_code=null where id=v_event.id;
  return jsonb_build_object('duplicate',false,'ignored',v_payment.status=v_new_status,'paymentId',v_payment.id,'orderId',v_order.id,'status',v_new_status);
end; $$;


-- Preserve compatibility for existing SQL callers while routing all webhook
-- processing through the provider-refund-aware implementation.
drop function if exists apply_payment_webhook(text,text,text,text,text,numeric,text,text);
create function apply_payment_webhook(
  p_provider_key text, p_event_id text, p_event_type text, p_provider_reference text,
  p_status text, p_amount numeric, p_currency text, p_payload_hash text
) returns jsonb language sql as $$
  select apply_payment_webhook($1,$2,$3,$4,$5,$6,$7,$8,null::text);
$$;

-- Settlement model migration: all live merchants are provider-settled. The
-- legacy marketplace_escrow value is retained only in old migration history.
-- Drop the legacy constraint BEFORE backfilling provider_direct; otherwise the
-- old constraint rejects the new value and aborts the migration.
alter table merchants drop constraint if exists merchants_settlement_model_check;
update merchants set settlement_model='provider_direct' where settlement_model='marketplace_escrow';
alter table merchants add constraint merchants_settlement_model_check
  check (settlement_model in ('provider_direct','enterprise_direct')) not valid;
alter table merchants validate constraint merchants_settlement_model_check;
alter table merchants alter column settlement_model set default 'provider_direct';
comment on column merchants.settlement_model is 'Live settlement is provider-managed. provider_direct uses the configured PSP/subaccount; enterprise_direct also uses external provider settlement. ELEMARKET does not custody funds.';

-- The function was originally created by 0062 with p_admin_id as the
-- second input parameter. PostgreSQL does not allow CREATE OR REPLACE to
-- rename an input parameter, even when the SQL types are identical. Drop the
-- old signature first so both fresh databases and databases that reached 0069
-- can apply this migration deterministically.
drop function if exists admin_set_merchant_enterprise_mode(text,text,boolean,text);

create function admin_set_merchant_enterprise_mode(
  p_merchant_id text, p_admin_id text, p_enabled boolean, p_reason text
) returns jsonb language plpgsql as $$
declare v_old record; v_new_model text; v_new_catalog text;
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant required'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'reason required'; end if;
  select id,tier,settlement_model,catalog_source,status into v_old from merchants where id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  v_new_model := case when p_enabled then 'enterprise_direct' else 'provider_direct' end;
  v_new_catalog := case when p_enabled then 'enterprise_api' else 'native' end;
  update merchants set tier=case when p_enabled then 'enterprise' else 'merchant' end,settlement_model=v_new_model,catalog_source=v_new_catalog where id=p_merchant_id;
  perform record_audit_event(case when p_enabled then 'admin.merchant.enterprise_enabled' else 'admin.merchant.enterprise_disabled' end,'merchant',p_merchant_id,p_admin_id,'admin',null,'success',jsonb_build_object('reason',left(trim(p_reason),2000),'previousTier',v_old.tier,'newTier',case when p_enabled then 'enterprise' else 'merchant' end,'previousSettlementModel',v_old.settlement_model,'newSettlementModel',v_new_model,'previousCatalogSource',v_old.catalog_source,'newCatalogSource',v_new_catalog));
  return jsonb_build_object('merchantId',p_merchant_id,'settlementModel',v_new_model,'catalogSource',v_new_catalog);
end;
$$;

create or replace function release_escrow(p_escrow_id text,p_reference text)
returns jsonb language plpgsql as $$ begin raise exception 'local escrow is disabled; settlement is controlled by the payment provider'; end; $$;
create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$ begin raise exception 'local escrow is disabled; provider settlement is authoritative'; end; $$;
create or replace function resolve_escrow_dispute(p_dispute_id text,p_resolution text,p_admin_id text,p_note text default '')
returns jsonb language plpgsql as $$ begin raise exception 'local escrow is disabled; use provider refund workflow'; end; $$;
