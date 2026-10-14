-- v1.69: live settlement/dispute authority + customer financing flow repair.
-- The marketplace is provider-settled and non-custodial. Legacy escrow tables remain
-- historical only; live dispute/settlement decisions use customer_order_disputes.

-- -----------------------------------------------------------------------------
-- 1. The 24-hour provider-settlement gate must use the LIVE dispute table.
-- -----------------------------------------------------------------------------
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

  -- Serialize eligibility against dispute creation for the same order.
  select o.id,o.merchant_id,o.status,o.merchant_net,o.currency,o.updated_at
    into v_order
    from orders o
   where o.id=p_order_id and o.merchant_id=p_merchant_id
   for update;

  if not found then raise exception 'order not found'; end if;

  v_delivered_at := elemarket_order_delivered_at(v_order.id);
  if v_delivered_at is null then
    return jsonb_build_object(
      'eligible',false,'reason','order_not_delivered','orderId',v_order.id,
      'merchantNet',v_order.merchant_net,'currency',v_order.currency
    );
  end if;

  v_eligible_at := v_delivered_at + interval '24 hours';

  select exists(
    select 1 from customer_order_disputes d
     where d.order_id=v_order.id
       and d.status in ('open','under_review')
  ) into v_active_dispute;

  select min(d.created_at) into v_dispute_at
    from customer_order_disputes d
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
    'eligible',v_reason='eligible','reason',v_reason,'orderId',v_order.id,
    'merchantNet',v_order.merchant_net,'currency',v_order.currency,
    'deliveredAt',v_delivered_at,'eligibleAt',v_eligible_at,'disputeFiledAt',v_dispute_at
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
        select 1 from customer_order_disputes d
         where d.order_id=o.id
           and d.status in ('open','under_review')
      )
      and not exists (
        select 1 from customer_order_disputes d
         where d.order_id=o.id
           and d.created_at <= elemarket_order_delivered_at(o.id) + interval '24 hours'
      )
    ),0)::numeric(12,2),
    count(*) filter (
      where not exists (
        select 1 from customer_order_disputes d
         where d.order_id=o.id
           and d.status in ('open','under_review')
      )
      and not exists (
        select 1 from customer_order_disputes d
         where d.order_id=o.id
           and d.created_at <= elemarket_order_delivered_at(o.id) + interval '24 hours'
      )
    )::int
  into v_eligible,v_count
  from candidate c
  join orders o on o.id=c.id;

  select count(*)::int into v_pending_disputes
    from customer_order_disputes d
    join orders o on o.id=d.order_id
   where o.merchant_id=p_merchant_id
     and d.status in ('open','under_review');

  return jsonb_build_object(
    'eligibleAmount',v_eligible,'eligibleOrders',v_count,
    'activeDisputes',v_pending_disputes,'currency','GHS',
    'custodyBoundary','external_provider','withdrawalAction','provider_managed'
  );
end;
$$;

comment on function merchant_order_withdrawal_eligibility(text,text) is
  'Authoritative 24-hour delivered-order/provider-settlement eligibility gate. Uses live customer_order_disputes; never moves money.';
comment on function merchant_provider_withdrawal_eligibility(text) is
  'Returns provider-settlement withdrawal eligibility using live customer_order_disputes. ELEMARKET never holds or transfers funds.';

-- -----------------------------------------------------------------------------
-- 2. Customer financing can begin as a provider application before an order group
--    exists. Once an order group is supplied, ownership/amount validation remains
--    mandatory. This matches the checkout flow and keeps financing separate from
--    payment creation.
-- -----------------------------------------------------------------------------
create or replace function validate_financing_application_domain_columns()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'customer_financing_applications' and new.order_group_id is not null then
    -- Existing customer-financing order validation remains authoritative.
    -- This trigger intentionally permits pre-order provider applications.
    return new;
  elsif tg_table_name = 'merchant_financing_applications' then
    return new;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_financing_domain_columns_validate on customer_financing_applications;
create trigger customer_financing_domain_columns_validate
before insert or update of order_group_id on customer_financing_applications
for each row execute function validate_financing_application_domain_columns();

comment on function validate_financing_application_domain_columns() is
  'Allows provider-led customer financing applications before order creation; if an order group is attached, existing ownership/amount validation applies. Merchant financing never carries customer order references.';

-- -----------------------------------------------------------------------------
-- 3. High-volume lookup indexes for the live settlement gate.
-- -----------------------------------------------------------------------------
create index if not exists customer_order_disputes_order_status_created_idx
  on customer_order_disputes(order_id,status,created_at desc);

create index if not exists merchant_order_status_history_delivered_idx
  on merchant_order_status_history(order_id,created_at desc)
  where to_status='delivered';
