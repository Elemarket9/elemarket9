-- Return policy: a default window for every listing and a faulty-item guarantee.
--
-- Defect fixed: listings were created with return_window_days NULL. The return
-- checks compared now() with delivered_at + NULL, which is NULL, so every return
-- was refused, and product pages showed "0 days". The wallet meanwhile released
-- merchant earnings 24 hours after delivery.
--
-- Policy (one row, adjustable by staff):
--   default_window_days  window applied when a listing does not set one
--   faulty_item_days     minimum window for wrong, damaged, defective, not-as-described
--                        or incomplete items. It applies to every product, including
--                        ones marked non-returnable for change of mind (hygiene etc.)
-- Merchant earnings are released only after the longest window that could still
-- apply to the order has closed (never sooner than 24 hours after handover).

create table if not exists marketplace_return_policy (
  id boolean primary key default true check (id),
  default_window_days integer not null default 7 check (default_window_days between 0 and 90),
  faulty_item_days integer not null default 7 check (faulty_item_days between 1 and 90),
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into marketplace_return_policy(id) values (true) on conflict (id) do nothing;

create or replace function elemarket_return_policy() returns marketplace_return_policy
language sql stable as $$ select * from marketplace_return_policy where id $$;

create or replace function elemarket_is_faulty_return_reason(p_reason_code text) returns boolean
language sql immutable as $$
  select p_reason_code in ('wrong_item','damaged','defective','not_as_described','missing_parts')
$$;

-- The window in days for one product and one reason; NULL when no return is allowed.
create or replace function elemarket_return_window_days(p_returnable boolean, p_window integer, p_reason_code text)
returns integer language sql stable as $$
  select case
    when elemarket_is_faulty_return_reason(p_reason_code)
      then greatest(case when p_returnable then coalesce(p_window, (elemarket_return_policy()).default_window_days) else 0 end,
                    (elemarket_return_policy()).faulty_item_days)
    when p_returnable then coalesce(p_window, (elemarket_return_policy()).default_window_days)
    else null
  end
$$;

-- Deadline for returning one order item for one reason; NULL when not returnable
-- for that reason or not yet delivered.
create or replace function elemarket_item_return_deadline(p_order_item_id bigint, p_reason_code text)
returns timestamptz language sql stable as $$
  select elemarket_order_delivered_at(oi.order_id)
         + make_interval(days => elemarket_return_window_days(p.returnable, p.return_window_days, p_reason_code))
    from order_items oi join products p on p.id = oi.product_id
   where oi.id = p_order_item_id
$$;

-- When the merchant's earnings for an order may be released: after the longest
-- window any item could still be returned in, and never under 24 hours.
create or replace function elemarket_order_release_at(p_order_id text)
returns timestamptz language sql stable as $$
  select elemarket_order_delivered_at(p_order_id) + greatest(
           interval '24 hours',
           make_interval(days => coalesce((
             select max(elemarket_return_window_days(p.returnable, p.return_window_days, 'damaged'))
               from order_items oi join products p on p.id = oi.product_id
              where oi.order_id = p_order_id), (elemarket_return_policy()).faulty_item_days)))
$$;

-- New listings without a window get the policy default, so the window a customer
-- sees at purchase is stored with the product.
create or replace function products_return_window_default() returns trigger language plpgsql as $$
begin
  if new.return_window_days is null then
    new.return_window_days := (elemarket_return_policy()).default_window_days;
  end if;
  return new;
end $$;
drop trigger if exists products_aa_return_window_default on products;
create trigger products_aa_return_window_default before insert on products
  for each row execute function products_return_window_default();

-- Customer return request (order page). Same as 0214 except the window check,
-- which now goes through the policy and the reason.
create or replace function request_order_return(
  p_order_id text,
  p_order_item_id bigint,
  p_customer_id text,
  p_reason_code text,
  p_reason text,
  p_quantity integer
) returns jsonb language plpgsql as $$
declare
  v_order record; v_item record; v_existing record; v_id text; v_deadline timestamptz;
begin
  if p_customer_id is null or length(trim(p_customer_id)) < 1 then raise exception 'customer identity required'; end if;
  if p_reason_code not in ('changed_mind','wrong_item','damaged','defective','not_as_described','missing_parts','other') then raise exception 'invalid return reason'; end if;
  if p_reason is null or length(trim(p_reason)) < 8 or length(trim(p_reason)) > 2000 then raise exception 'return reason must be 8-2000 characters'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then raise exception 'invalid return quantity'; end if;

  select o.* into v_order from orders o where o.id=p_order_id and o.user_id=p_customer_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.status not in ('delivered','completed') then raise exception 'only delivered orders can be returned'; end if;
  if exists(select 1 from customer_order_disputes d where d.order_id=v_order.id and d.status in ('open','under_review')) then raise exception 'resolve the active order dispute before creating a return'; end if;

  select oi.*,p.returnable,p.return_window_days,p.merchant_id,p.name into v_item
    from order_items oi join products p on p.id=oi.product_id
   where oi.id=p_order_item_id and oi.order_id=p_order_id for update;
  if not found then raise exception 'order item not found'; end if;
  if p_quantity > v_item.quantity then raise exception 'return quantity exceeds purchased quantity'; end if;
  if elemarket_order_delivered_at(v_order.id) is null then raise exception 'return window has not started'; end if;
  v_deadline := elemarket_item_return_deadline(p_order_item_id, p_reason_code);
  if v_deadline is null then raise exception 'this item is not returnable'; end if;
  if now() > v_deadline then raise exception 'return window has expired'; end if;

  select id,status into v_existing from return_requests where order_item_id=p_order_item_id and status in ('requested','approved','received','refund_pending') limit 1 for update;
  if found then
    return jsonb_build_object('returnId',v_existing.id,'status',v_existing.status,'existing',true);
  end if;

  v_id:='ret_'||replace(gen_random_uuid()::text,'-','');
  insert into return_requests(id,order_id,order_item_id,customer_id,merchant_id,reason_code,reason,quantity)
  values(v_id,p_order_id,p_order_item_id,p_customer_id,v_item.merchant_id,p_reason_code,left(trim(p_reason),2000),p_quantity);
  perform record_audit_event('customer.return.requested','return_request',v_id,p_customer_id,'customer',null,'success',jsonb_build_object('orderId',p_order_id,'orderItemId',p_order_item_id,'merchantId',v_item.merchant_id,'reasonCode',p_reason_code,'quantity',p_quantity));
  return jsonb_build_object('returnId',v_id,'orderId',p_order_id,'orderItemId',p_order_item_id,'status','requested','existing',false);
end;
$$;

-- Wallet release. Same as 0217 except maturity, which now follows the return policy.
create or replace function release_matured_wallet_funds(p_limit integer default 200)
returns integer language plpgsql as $$
declare
  v_row record;
  v_count integer := 0;
  v_withheld numeric(12,2);
  v_owed numeric(12,2);
  v_repay numeric(12,2);
begin
  for v_row in
    select o.id as order_id, o.merchant_id
      from (select e.order_id
              from wallet_ledger_entries e
             where e.bucket = 'withheld' and e.order_id is not null
             group by e.order_id
            having sum(e.amount) > 0) w
      join orders o on o.id = w.order_id
     where o.status in ('delivered','completed')
       and not exists (select 1 from wallet_ledger_entries r where r.order_id = o.id and r.entry_type = 'release')
       and elemarket_order_delivered_at(o.id) is not null
       and now() >= elemarket_order_release_at(o.id)
       and not exists (select 1 from customer_order_disputes d
                        where d.order_id = o.id and d.status in ('open','under_review'))
       and not exists (select 1 from return_requests rr
                        where rr.order_id = o.id and rr.status in ('requested','approved','received','refund_pending'))
       and not exists (select 1 from provider_refund_requests pr
                        where pr.order_id = o.id and pr.status in ('requested','processing','needs_attention'))
     order by o.id
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_row.merchant_id, 0));
    -- Re-read under the merchant lock: a refund or another release may have run.
    if exists (select 1 from wallet_ledger_entries where order_id = v_row.order_id and entry_type = 'release') then continue; end if;
    select coalesce(sum(amount), 0) into v_withheld
      from wallet_ledger_entries where order_id = v_row.order_id and bucket = 'withheld';
    if v_withheld <= 0 then continue; end if;
    select coalesce(-sum(amount), 0) into v_owed
      from wallet_ledger_entries where merchant_id = v_row.merchant_id and bucket = 'recovery';
    v_repay := least(v_withheld, greatest(v_owed, 0));
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_row.merchant_id, 'release', 'withheld', -v_withheld, v_row.order_id, 'release:' || v_row.order_id || ':withheld');
    if v_repay > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
      values (v_row.merchant_id, 'release', 'recovery', v_repay, v_row.order_id, 'release:' || v_row.order_id || ':recovery');
    end if;
    if v_withheld - v_repay > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
      values (v_row.merchant_id, 'release', 'available', v_withheld - v_repay, v_row.order_id, 'release:' || v_row.order_id || ':available');
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Return guard (0205), extended for orders delivered without shipment records.
-- Defect fixed: nothing creates shipments for ordinary orders (they are delivered
-- through a delivery job and the rider-OTP handover), yet the guard demanded a
-- delivered shipment for every return, so no customer could ever return anything.
-- Orders that have shipments keep the strict per-shipment allocation checks.
-- Orders with none may be returned once the verified handover exists, up to the
-- purchased quantity across all live returns for that item.
create or replace function elemarket_guard_shipment_return() returns trigger language plpgsql as $$
declare allocated integer; returned bigint; candidates integer; v_has_shipments boolean;
begin
 perform 1 from orders where id=new.order_id and user_id=new.customer_id and merchant_id=new.merchant_id for update;
 if not found then raise exception 'return customer/order/merchant mismatch'; end if;
 if tg_op='INSERT' then
  select round((product_total/quantity)*new.quantity,2) into new.refund_amount from order_items where id=new.order_item_id and order_id=new.order_id;
  if new.payment_id is null then select id into new.payment_id from payments where order_id=new.order_id; end if;
 end if;
 v_has_shipments := exists(select 1 from shipments where order_id=new.order_id);
 if tg_op='INSERT' and new.shipment_id is null and v_has_shipments then
  select count(*) into candidates from shipment_items si join shipments s on s.id=si.shipment_id
   where si.order_item_id=new.order_item_id and s.order_id=new.order_id and s.delivered_at is not null;
  if candidates<>1 then raise exception 'return requires explicit received shipment'; end if;
  select si.shipment_id into new.shipment_id from shipment_items si join shipments s on s.id=si.shipment_id
   where si.order_item_id=new.order_item_id and s.order_id=new.order_id and s.delivered_at is not null;
 end if;
 if new.shipment_id is not null then
  perform 1 from shipments where id=new.shipment_id and order_id=new.order_id and delivered_at is not null for update;
  if not found then raise exception 'return requires verified shipment receipt'; end if;
  select quantity into allocated from shipment_items where shipment_id=new.shipment_id and order_item_id=new.order_item_id;
  select coalesce(sum(quantity),0) into returned from return_requests where shipment_id=new.shipment_id
    and order_item_id=new.order_item_id and id<>new.id and status not in ('rejected','cancelled');
 else
  if v_has_shipments then raise exception 'return requires explicit received shipment'; end if;
  if elemarket_order_delivered_at(new.order_id) is null then raise exception 'return requires verified delivery handover'; end if;
  select quantity into allocated from order_items where id=new.order_item_id and order_id=new.order_id;
  select coalesce(sum(quantity),0) into returned from return_requests where order_id=new.order_id
    and order_item_id=new.order_item_id and id<>new.id and status not in ('rejected','cancelled');
 end if;
 if allocated is null or returned+(case when new.status in ('rejected','cancelled') then 0 else new.quantity end)>allocated then raise exception 'return quantity exceeds received shipment allocation'; end if;
 if tg_op='UPDATE' and (new.order_id is distinct from old.order_id or new.customer_id is distinct from old.customer_id
  or new.order_item_id is distinct from old.order_item_id or new.shipment_id is distinct from old.shipment_id or new.quantity is distinct from old.quantity
  or new.payment_id is distinct from old.payment_id or new.refund_amount is distinct from old.refund_amount
  or new.client_request_key is distinct from old.client_request_key) then raise exception 'return fulfillment identity is immutable'; end if;
 if new.payment_id is not null and not exists(select 1 from payments where id=new.payment_id and order_id=new.order_id and user_id=new.customer_id) then raise exception 'return payment mismatch'; end if;
 if new.provider_refund_request_id is not null and not exists(select 1 from provider_refund_requests r where r.id=new.provider_refund_request_id
   and r.order_id=new.order_id and r.payment_id=new.payment_id) then raise exception 'return refund association mismatch'; end if;
 if new.status='refunded' and not exists(select 1 from provider_refund_requests r where r.id=new.provider_refund_request_id
   and r.order_id=new.order_id and r.payment_id=new.payment_id and r.status='processed' and r.provider_refund_id is not null and r.amount=new.refund_amount) then
   raise exception 'external provider refund evidence required'; end if;
 return new;
end $$;
