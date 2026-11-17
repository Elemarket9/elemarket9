-- Merchant payouts: the ELEMARKET wallet is the default, and enterprise merchants
-- are paid instantly.
--
-- 1. New merchants start on the wallet (settlement_model 'platform_wallet'):
--    each sale is held until delivery and the return window pass, then can be
--    withdrawn. Existing merchants keep their current model; staff move them
--    from the Finance page.
-- 2. Enterprise merchants run their own returns and customer service, so
--    ELEMARKET does not hold their money. An enterprise merchant is paid either
--    through a Paystack subaccount (settlement_model 'enterprise_direct',
--    unchanged), or through the wallet, where each sale is released the moment
--    the customer's payment is confirmed. A refund after release is taken from
--    the available balance and anything left is recorded as owed, recovered
--    from the merchant's next sales (existing wallet_apply_refund behaviour).
-- 3. "Enterprise" is now the merchant tier, not the payment route, so the
--    enterprise catalogue and order-event integration work on either route.
-- 4. Fix: enterprise_enqueue_order_event (since 0087) inserted six columns with
--    five values (idempotency_key missing), so every enterprise order event
--    failed with "INSERT has more target columns than expressions".

alter table merchants alter column settlement_model set default 'platform_wallet';

-- When an order's withheld sale may be released to the merchant's available balance.
create or replace function wallet_order_release_due(p_order_id text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (
    select 1 from orders o join merchants m on m.id = o.merchant_id
     where o.id = p_order_id
       and not exists (select 1 from provider_refund_requests pr
                        where pr.order_id = o.id and pr.status in ('requested','processing','needs_attention'))
       and (
         -- Enterprise: instantly once paid; the merchant handles returns and disputes.
         (m.tier = 'enterprise' and o.status not in ('payment_pending','cancelled','refund_pending','refunded'))
         or
         -- Everyone else: after delivery, the hold and the return window, with no open case.
         (o.status in ('delivered','completed')
          and elemarket_order_delivered_at(o.id) is not null
          and now() >= elemarket_order_release_at(o.id)
          and not exists (select 1 from customer_order_disputes d
                           where d.order_id = o.id and d.status in ('open','under_review'))
          and not exists (select 1 from return_requests rr
                           where rr.order_id = o.id and rr.status in ('requested','approved','received','refund_pending')))
       )
  );
$$;

-- Release one order's withheld sale (same ledger entries as before: repay any
-- amount owed first, the rest becomes available). Idempotent per order.
create or replace function wallet_release_order(p_order_id text, p_payment_confirmed boolean default false) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare
  v_merchant text;
  v_withheld numeric(12,2);
  v_owed numeric(12,2);
  v_repay numeric(12,2);
begin
  select merchant_id into v_merchant from orders where id = p_order_id;
  if v_merchant is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_merchant, 0));
  -- Re-check under the merchant lock: a refund or another release may have run.
  if exists (select 1 from wallet_ledger_entries where order_id = p_order_id and entry_type = 'release') then return false; end if;
  -- p_payment_confirmed: called from the payment-completed trigger for an enterprise
  -- merchant, before the order row itself is marked paid.
  if p_payment_confirmed then
    if not exists (select 1 from orders o join merchants m on m.id = o.merchant_id
                    where o.id = p_order_id and m.tier = 'enterprise'
                      and o.status not in ('cancelled','refund_pending','refunded')) then return false; end if;
  elsif not wallet_order_release_due(p_order_id) then return false; end if;
  select coalesce(sum(amount), 0) into v_withheld
    from wallet_ledger_entries where order_id = p_order_id and bucket = 'withheld';
  if v_withheld <= 0 then return false; end if;
  select coalesce(-sum(amount), 0) into v_owed
    from wallet_ledger_entries where merchant_id = v_merchant and bucket = 'recovery';
  v_repay := least(v_withheld, greatest(v_owed, 0));
  insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
  values (v_merchant, 'release', 'withheld', -v_withheld, p_order_id, 'release:' || p_order_id || ':withheld');
  if v_repay > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'release', 'recovery', v_repay, p_order_id, 'release:' || p_order_id || ':recovery');
  end if;
  if v_withheld - v_repay > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'release', 'available', v_withheld - v_repay, p_order_id, 'release:' || p_order_id || ':available');
  end if;
  return true;
end $$;

create or replace function release_matured_wallet_funds(p_limit integer default 200) returns integer
language plpgsql as $$
declare
  v_order text;
  v_count integer := 0;
begin
  for v_order in
    select w.order_id
      from (select e.order_id from wallet_ledger_entries e
             where e.bucket = 'withheld' and e.order_id is not null
             group by e.order_id having sum(e.amount) > 0) w
     where not exists (select 1 from wallet_ledger_entries r where r.order_id = w.order_id and r.entry_type = 'release')
       and wallet_order_release_due(w.order_id)
     order by w.order_id
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    if wallet_release_order(v_order) then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

-- Credit the sale when payment completes; enterprise sales are released at once.
create or replace function wallet_credit_completed_payment() returns trigger
language plpgsql as $$
declare v_order record;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  if new.settlement_model is distinct from 'platform_wallet' then return new; end if;
  select o.id, o.merchant_id, o.merchant_net, m.tier into v_order
    from orders o join merchants m on m.id = o.merchant_id where o.id = new.order_id;
  if not found or coalesce(v_order.merchant_net, 0) <= 0 then
    return new;
  end if;
  insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
  values (v_order.merchant_id, 'sale', 'withheld', v_order.merchant_net, v_order.id, 'sale:' || v_order.id)
  on conflict (source_key) do nothing;
  if v_order.tier = 'enterprise' then
    perform wallet_release_order(v_order.id, true);
  end if;
  return new;
end $$;

-- Staff may move an enterprise merchant from its Paystack subaccount to the wallet too.
create or replace function wallet_enable_for_merchant(p_merchant_id text, p_admin_id text) returns jsonb
language plpgsql as $$
declare v_old text;
begin
  select settlement_model into v_old from merchants where id = p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  if v_old = 'platform_wallet' then return jsonb_build_object('merchantId', p_merchant_id, 'settlementModel', v_old, 'changed', false); end if;
  if v_old not in ('provider_direct','enterprise_direct') then raise exception 'only Paystack-split merchants can move to the wallet'; end if;
  if exists (select 1 from orders where merchant_id = p_merchant_id and status = 'payment_pending') then
    raise exception 'merchant has unpaid checkouts; retry after they complete or expire';
  end if;
  update merchants set settlement_model = 'platform_wallet' where id = p_merchant_id;
  perform record_audit_event('admin.merchant.wallet_enabled', 'merchant', p_merchant_id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('previousSettlementModel', v_old));
  return jsonb_build_object('merchantId', p_merchant_id, 'settlementModel', 'platform_wallet', 'changed', true);
end $$;

create or replace function enterprise_enqueue_order_event(p_order_id text, p_event_type text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  v_order record;
  v_id text := 'eoo_'||replace(gen_random_uuid()::text,'-','');
  v_key text;
begin
  if p_event_type not in ('order.created','order.cancelled','order.status_changed','order.return_requested') then
    raise exception 'unsupported enterprise order event';
  end if;
  select o.id,o.merchant_id,m.catalog_source,m.settlement_model,m.tier
    into v_order
    from orders o join merchants m on m.id=o.merchant_id
   where o.id=p_order_id;
  if not found then raise exception 'order not found'; end if;
  -- Enterprise is the tier, not the payment route: an enterprise merchant may be
  -- paid through a Paystack subaccount or the ELEMARKET wallet.
  if v_order.catalog_source <> 'enterprise_api' or v_order.tier <> 'enterprise' then
    return null;
  end if;
  v_key := p_order_id||':'||p_event_type||':'||coalesce(p_payload->>'transitionKey',p_order_id);
  insert into enterprise_order_outbox(id,merchant_id,order_id,event_type,idempotency_key,payload)
  values(v_id,v_order.merchant_id,p_order_id,p_event_type,v_key,p_payload)
  on conflict(merchant_id,idempotency_key) do nothing;
  return v_id;
end;
$function$;
