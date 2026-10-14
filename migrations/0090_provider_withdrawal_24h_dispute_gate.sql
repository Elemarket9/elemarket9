-- v1.60: provider settlement withdrawal eligibility hardening.
-- ELEMARKET remains non-custodial. This migration creates only an eligibility
-- gate/audit path; it never holds, releases, or transfers customer funds.
--
-- Rule:
--   A merchant sale becomes withdraw-eligible only when:
--   1) the order reached delivered/completed;
--   2) at least 24 hours have elapsed since the recorded delivered transition;
--   3) no customer dispute was filed during that 24-hour window;
--   4) no currently-open/under-review dispute exists for the order;
--   5) the order has not entered a refund/cancelled state.
--
-- The same order row is locked by both the customer-dispute and withdrawal
-- eligibility paths so a dispute/withdrawal race cannot bypass the rule.

alter table if exists escrow_disputes
  alter column escrow_id drop not null;

create index if not exists escrow_disputes_order_created_idx
  on escrow_disputes(order_id, created_at desc);

create or replace function elemarket_order_delivered_at(p_order_id text)
returns timestamptz
language sql
stable
as $$
  select max(h.created_at)
    from merchant_order_status_history h
   where h.order_id = p_order_id
     and h.to_status = 'delivered'
$$;

create or replace function merchant_order_withdrawal_eligibility(
  p_merchant_id text,
  p_order_id text
) returns jsonb
language plpgsql
as $$
declare
  v_order record;
  v_delivered_at timestamptz;
  v_eligible_at timestamptz;
  v_dispute_at timestamptz;
  v_active_dispute boolean := false;
  v_reason text := null;
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then
    raise exception 'merchant required';
  end if;
  if p_order_id is null or length(trim(p_order_id)) < 1 then
    raise exception 'order required';
  end if;

  -- Serialize eligibility evaluation against customer dispute creation.
  select o.id,o.merchant_id,o.status,o.merchant_net,o.currency,o.updated_at
    into v_order
    from orders o
   where o.id=p_order_id and o.merchant_id=p_merchant_id
   for update;

  if not found then
    raise exception 'order not found';
  end if;

  v_delivered_at := elemarket_order_delivered_at(v_order.id);
  if v_delivered_at is null then
    return jsonb_build_object(
      'eligible',false,
      'reason','order_not_delivered',
      'orderId',v_order.id,
      'merchantNet',v_order.merchant_net,
      'currency',v_order.currency
    );
  end if;

  v_eligible_at := v_delivered_at + interval '24 hours';

  select exists(
    select 1 from escrow_disputes d
     where d.order_id=v_order.id
       and d.status in ('open','under_review')
  ) into v_active_dispute;

  select min(d.created_at) into v_dispute_at
    from escrow_disputes d
   where d.order_id=v_order.id
     and d.created_at <= v_eligible_at;

  if v_order.status in ('cancelled','refund_pending','refunded','disputed') then
    v_reason := 'order_not_withdrawable';
  elsif v_active_dispute then
    v_reason := 'active_customer_dispute';
  elsif v_dispute_at is not null then
    v_reason := 'customer_dispute_filed_within_24_hours';
  elsif now() < v_eligible_at then
    v_reason := '24_hour_customer_dispute_window';
  else
    v_reason := 'eligible';
  end if;

  return jsonb_build_object(
    'eligible', v_reason='eligible',
    'reason', v_reason,
    'orderId', v_order.id,
    'merchantNet', v_order.merchant_net,
    'currency', v_order.currency,
    'deliveredAt', v_delivered_at,
    'eligibleAt', v_eligible_at,
    'disputeFiledAt', v_dispute_at
  );
end;
$$;

create or replace function merchant_provider_withdrawal_eligibility(
  p_merchant_id text
) returns jsonb
language plpgsql
as $$
declare
  v_eligible numeric(12,2) := 0;
  v_count integer := 0;
  v_pending_disputes integer := 0;
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then
    raise exception 'merchant required';
  end if;

  -- Lock all candidate orders while calculating the authoritative snapshot.
  with candidate as (
    select o.id
      from orders o
     where o.merchant_id=p_merchant_id
       and o.status in ('delivered','completed')
       and elemarket_order_delivered_at(o.id) is not null
       and now() >= elemarket_order_delivered_at(o.id) + interval '24 hours'
     for update
  )
  select
    coalesce(sum(o.merchant_net) filter (
      where not exists (
        select 1 from escrow_disputes d
         where d.order_id=o.id
           and d.status in ('open','under_review')
      )
      and not exists (
        select 1 from escrow_disputes d
         where d.order_id=o.id
           and d.created_at <= elemarket_order_delivered_at(o.id) + interval '24 hours'
      )
    ),0)::numeric(12,2),
    count(*) filter (
      where not exists (
        select 1 from escrow_disputes d
         where d.order_id=o.id
           and d.status in ('open','under_review')
      )
      and not exists (
        select 1 from escrow_disputes d
         where d.order_id=o.id
           and d.created_at <= elemarket_order_delivered_at(o.id) + interval '24 hours'
      )
    )::int
  into v_eligible,v_count
  from candidate c
  join orders o on o.id=c.id;

  select count(*)::int into v_pending_disputes
    from escrow_disputes d
    join orders o on o.id=d.order_id
   where o.merchant_id=p_merchant_id
     and d.status in ('open','under_review');

  return jsonb_build_object(
    'eligibleAmount',v_eligible,
    'eligibleOrders',v_count,
    'activeDisputes',v_pending_disputes,
    'currency','GHS',
    'custodyBoundary','external_provider',
    'withdrawalAction','provider_managed'
  );
end;
$$;

create or replace function open_customer_order_dispute(
  p_order_id text,
  p_customer_id text,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  v_order record;
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
  if v_order.status in ('cancelled','refund_pending','refunded') then
    raise exception 'order cannot be disputed in its current state';
  end if;

  select id,status into v_existing
    from escrow_disputes
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

  insert into escrow_disputes(
    id,escrow_id,order_id,payment_id,opened_by,reason,status,created_at
  )
  select v_dispute,null,v_order.id,p.id,p_customer_id,left(trim(p_reason),2000),'open',now()
    from payments p
   where p.order_id=v_order.id
   limit 1;

  if not found then
    raise exception 'paid order has no payment record';
  end if;

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

comment on function merchant_order_withdrawal_eligibility(text,text) is
  'Authoritative 24-hour delivered-order/provider-settlement eligibility gate. Never moves money.';
comment on function merchant_provider_withdrawal_eligibility(text) is
  'Returns provider-settlement withdrawal eligibility. ELEMARKET never holds or transfers funds.';
comment on function open_customer_order_dispute(text,text,text) is
  'Customer dispute entry point. Locks the order before marking it disputed so withdrawal eligibility cannot race past it.';
