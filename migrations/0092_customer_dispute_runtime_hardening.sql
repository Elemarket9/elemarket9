-- v1.61: customer dispute runtime hardening.
-- ELEMARKET is non-custodial: customer disputes are marketplace records only;
-- provider_refund_requests remains the sole live money-movement/refund record.
-- Historical escrow tables remain untouched for migration/audit compatibility.

create table if not exists customer_order_disputes (
  id text primary key,
  order_id text not null references orders(id) on delete restrict,
  payment_id text not null references payments(id) on delete restrict,
  customer_id text not null,
  reason text not null check (char_length(trim(reason)) between 8 and 2000),
  status text not null default 'open' check (status in ('open','under_review','resolved_refund','closed')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_order_disputes_order_created_idx
  on customer_order_disputes(order_id, created_at desc);
create index if not exists customer_order_disputes_customer_created_idx
  on customer_order_disputes(customer_id, created_at desc);
create index if not exists customer_order_disputes_payment_idx
  on customer_order_disputes(payment_id, created_at desc);
create unique index if not exists customer_order_disputes_active_order_uq
  on customer_order_disputes(order_id)
  where status in ('open','under_review');

-- Preserve historical customer disputes in the new provider-neutral runtime table.
-- A legacy release resolution is represented as closed: it is historical only and
-- does not create or imply a local ELEMARKET settlement.
insert into customer_order_disputes(
  id, order_id, payment_id, customer_id, reason, status,
  resolution_note, resolved_by, resolved_at, created_at, updated_at
)
select
  d.id,
  d.order_id,
  d.payment_id,
  d.opened_by,
  d.reason,
  case when d.status in ('open','under_review','resolved_refund','closed') then d.status else 'closed' end,
  case when d.status='resolved_release'
       then coalesce(d.resolution_note,'Historical legacy release resolution; no ELEMARKET funds were released.')
       else d.resolution_note end,
  d.resolved_by,
  d.resolved_at,
  d.created_at,
  coalesce(d.resolved_at,d.created_at)
from escrow_disputes d
where d.order_id is not null
  and d.payment_id is not null
  and d.opened_by is not null
on conflict (id) do nothing;

create or replace function open_customer_order_dispute(
  p_order_id text,
  p_customer_id text,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  v_order record;
  v_payment record;
  v_dispute text;
  v_existing record;
begin
  if p_customer_id is null or length(trim(p_customer_id)) < 1 then
    raise exception 'customer identity required';
  end if;
  if p_reason is null or length(trim(p_reason)) < 8 or length(trim(p_reason)) > 2000 then
    raise exception 'dispute reason must be 8-2000 characters';
  end if;

  select o.id,o.user_id,o.status
    into v_order
    from orders o
   where o.id=p_order_id
   for update;

  if not found then raise exception 'order not found'; end if;
  if v_order.user_id <> p_customer_id then raise exception 'customer does not own order'; end if;
  if v_order.status in ('payment_pending','cancelled','refund_pending','refunded') then
    raise exception 'order cannot be disputed in its current state';
  end if;

  select p.id,p.status,p.order_id
    into v_payment
    from payments p
   where p.order_id=v_order.id
   order by p.created_at desc
   limit 1
   for update;
  if not found then raise exception 'paid order has no payment record'; end if;
  if v_payment.status <> 'completed' then raise exception 'only completed payments can be disputed'; end if;
  if v_payment.order_id <> v_order.id then raise exception 'payment/order mismatch'; end if;

  select id,status into v_existing
    from customer_order_disputes
   where order_id=p_order_id
     and status in ('open','under_review')
   limit 1
   for update;

  if found then
    return jsonb_build_object(
      'disputeId',v_existing.id,
      'status',v_existing.status,
      'existing',true
    );
  end if;

  v_dispute := 'dsp_'||replace(gen_random_uuid()::text,'-','');
  insert into customer_order_disputes(
    id,order_id,payment_id,customer_id,reason,status,created_at,updated_at
  ) values (
    v_dispute,v_order.id,v_payment.id,p_customer_id,left(trim(p_reason),2000),'open',now(),now()
  );

  update orders
     set status='disputed',updated_at=now()
   where id=v_order.id;

  return jsonb_build_object(
    'disputeId',v_dispute,
    'orderId',v_order.id,
    'status','open',
    'existing',false
  );
end;
$$;

-- Keep the historical function name so existing administrative integrations do
-- not break, but resolve only the new provider-neutral dispute record.
create or replace function prepare_provider_refund_for_dispute(
  p_dispute_id text,
  p_admin_id text,
  p_note text default ''
) returns jsonb
language plpgsql
as $$
declare
  v_d record;
  v_payment record;
  v_request text := 'prr_'||replace(gen_random_uuid()::text,'-','');
  v_existing record;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;

  select * into v_d
    from customer_order_disputes
   where id=p_dispute_id
   for update;
  if not found then raise exception 'dispute not found'; end if;
  if v_d.status not in ('open','under_review') then raise exception 'dispute already resolved'; end if;

  select p.* into v_payment
    from payments p
   where p.id=v_d.payment_id
   for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.order_id <> v_d.order_id then raise exception 'dispute payment/order mismatch'; end if;
  if v_payment.status <> 'completed' then raise exception 'only completed payments can be refunded'; end if;
  if v_payment.provider_reference is null then raise exception 'payment has no provider reference'; end if;

  select * into v_existing
    from provider_refund_requests
   where payment_id=v_payment.id
     and status in ('requested','processing','needs_attention')
   order by requested_at desc
   limit 1
   for update;
  if found then
    return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'providerReference',v_existing.provider_reference,'amount',v_existing.amount,'currency',v_existing.currency,'existing',true);
  end if;

  insert into provider_refund_requests(
    id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,
    reason,customer_note,merchant_note,requested_by
  ) values (
    v_request,v_payment.id,v_payment.order_id,v_payment.provider_key,v_payment.provider_reference,
    v_payment.amount,v_payment.currency,'requested','customer_dispute_refund',p_note,p_note,p_admin_id
  );

  update customer_order_disputes
     set status='resolved_refund',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now(),updated_at=now()
   where id=v_d.id;

  update orders set status='refund_pending',updated_at=now()
   where id=v_d.order_id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed');

  return jsonb_build_object('requestId',v_request,'status','requested','disputeId',v_d.id,'orderId',v_d.order_id,'existing',false);
end;
$$;

comment on table customer_order_disputes is
  'LIVE customer marketplace disputes. No ELEMARKET custody or settlement; provider_refund_requests is the money-flow record.';
comment on function open_customer_order_dispute(text,text,text) is
  'Provider-neutral customer dispute entry point; locks the order and binds the dispute to the completed payment.';
comment on function prepare_provider_refund_for_dispute(text,text,text) is
  'Administrative provider-refund preparation for a marketplace dispute. Does not release or settle ELEMARKET funds.';
