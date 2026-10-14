-- ELEMARKET v1.39.0 CTO angry-audit fixes.
--
-- 1) Normalize lock ordering across cancellation, expiry and payment webhook.
--    Previous versions could deadlock because expiry/cancellation could lock an
--    order row before the order advisory lock while payment completion did the
--    reverse. Every order critical path now uses:
--      advisory order lock -> order row FOR UPDATE -> reservation rows FOR UPDATE
--    This migration also moves the user checkout lock to the 64-bit hash.
--
-- 2) Enforce reservation-to-order-item integrity at the database boundary.
--    A reservation must point at the exact product/variant and quantity captured
--    by its order item. This prevents a count-only reservation check from being
--    fooled by malformed rows.

create or replace function release_order_stock(p_order_id text, p_user_id text)
returns void
language plpgsql
as $$
declare
  v_claimed_user text := current_setting('app.user_id', true);
  v_order record;
  r record;
begin
  if v_claimed_user is null or v_claimed_user <> p_user_id then
    raise exception 'unauthorized';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || p_order_id, 0));

  select id, user_id, status
    into v_order
    from orders
   where id = p_order_id
   for update;
  if not found or v_order.user_id <> p_user_id then
    raise exception 'order not found';
  end if;

  for r in
    select *
      from order_stock_reservations
     where order_id = p_order_id
       and status = 'reserved'
     order by id
     for update
  loop
    if r.variant_id is not null then
      update product_variants
         set stock = stock + r.quantity,
             updated_at = now()
       where id = r.variant_id;
      if not found then raise exception 'reserved variant not found'; end if;
    else
      update products
         set stock = stock + r.quantity
       where id = r.product_id;
      if not found then raise exception 'reserved product not found'; end if;
    end if;

    update order_stock_reservations
       set status = 'released', released_at = now()
     where id = r.id
       and status = 'reserved';
  end loop;

  update orders
     set status = 'cancelled', updated_at = now()
   where id = p_order_id
     and status = 'payment_pending';
end;
$$;

create or replace function expire_payment_pending_orders(p_limit integer default 100)
returns integer
language plpgsql
as $$
declare
  r record;
  v_order record;
  v_count integer := 0;
  v_res record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid expiry batch size';
  end if;

  -- Do not lock the order row before acquiring the advisory lock. Doing so would
  -- invert the lock order used by payment completion and cancellation.
  for r in
    select id
      from orders
     where status = 'payment_pending'
       and payment_deadline is not null
       and payment_deadline <= now()
     order by payment_deadline, id
     limit p_limit
  loop
    perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || r.id, 0));

    select id, status, payment_deadline
      into v_order
      from orders
     where id = r.id
     for update;
    if not found
       or v_order.status <> 'payment_pending'
       or v_order.payment_deadline is null
       or v_order.payment_deadline > now() then
      continue;
    end if;

    for v_res in
      select *
        from order_stock_reservations
       where order_id = r.id
         and status = 'reserved'
       order by id
       for update
    loop
      if v_res.variant_id is not null then
        update product_variants
           set stock = stock + v_res.quantity,
               updated_at = now()
         where id = v_res.variant_id;
        if not found then raise exception 'reserved variant not found'; end if;
      else
        update products
           set stock = stock + v_res.quantity
         where id = v_res.product_id;
        if not found then raise exception 'reserved product not found'; end if;
      end if;

      update order_stock_reservations
         set status = 'released', released_at = now()
       where id = v_res.id
         and status = 'reserved';
    end loop;

    update orders
       set status = 'cancelled', updated_at = now()
     where id = r.id
       and status = 'payment_pending';

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- Upgrade the checkout user lock to the same 64-bit primitive. This is a
-- contention/collision hardening change; the user-scoped lock domain is kept.
create or replace function create_pending_order(
  p_user_id text,
  p_idem text,
  p_fingerprint text,
  p_items jsonb,
  p_quotes jsonb,
  p_address text,
  p_method text
) returns jsonb
language plpgsql
as $$
declare
  v_existing record;
  v_group text;
  v_item record;
  v_product record;
  v_quote record;
  v_merchant text;
  v_item_merchant text;
  v_line numeric(12,2);
  v_unit numeric(12,2);
  v_product_total numeric(12,2);
  v_delivery numeric(12,2);
  v_order text;
  v_pay text;
  v_orders jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_count integer;
  v_claimed_user text := current_setting('app.user_id', true);
begin
  if p_user_id is null or char_length(p_user_id) < 3 or v_claimed_user is null or v_claimed_user <> p_user_id then raise exception 'unauthorized'; end if;
  if p_idem is null or char_length(p_idem) < 16 or char_length(p_idem) > 128 then raise exception 'invalid idempotency key'; end if;
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 then raise exception 'invalid request fingerprint'; end if;
  if p_address is null or char_length(trim(p_address)) < 8 or char_length(p_address) > 400 then raise exception 'delivery address is required'; end if;
  if p_method not in ('mobile_money', 'card', 'bank_transfer') then raise exception 'unsupported payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then raise exception 'invalid cart'; end if;
  if jsonb_typeof(p_quotes) <> 'array' or jsonb_array_length(p_quotes) < 1 or jsonb_array_length(p_quotes) > 40 then raise exception 'invalid delivery quotes'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:checkout:' || p_user_id, 0));

  select * into v_existing from order_idempotency where idem = p_idem;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.fingerprint <> p_fingerprint then raise exception 'idempotency conflict'; end if;
    select jsonb_agg(jsonb_build_object('orderId', o.id, 'merchantId', o.merchant_id, 'grandTotal', o.grand_total, 'status', o.status)) into v_orders from orders o where o.group_id = v_existing.group_id;
    return jsonb_build_object('replay', true, 'groupId', v_existing.group_id, 'orders', coalesce(v_orders, '[]'::jsonb));
  end if;

  select count(*) into v_count from orders where user_id = p_user_id and created_at > v_now - interval '1 minute';
  if v_count >= 8 then raise exception 'too many checkouts; retry shortly'; end if;

  v_group := 'grp_' || replace(gen_random_uuid()::text, '-', '');
  insert into order_groups(id, user_id) values (v_group, p_user_id);
  insert into order_idempotency(idem, user_id, fingerprint, group_id) values (p_idem, p_user_id, p_fingerprint, v_group);

  for v_item in
    select trim(elem->>'productId') as product_id,
           nullif(trim(elem->>'variantId'), '') as variant_id,
           sum((elem->>'quantity')::int) as qty
      from jsonb_array_elements(p_items) elem
     group by 1, 2
     order by 1, 2
  loop
    if v_item.product_id is null or v_item.product_id = '' or v_item.qty is null or v_item.qty < 1 or v_item.qty > 20 then raise exception 'invalid cart item'; end if;
    select p.id, p.merchant_id, p.price, p.stock, p.currency, p.name, m.status, m.verified
      into v_product
      from products p join merchants m on m.id = p.merchant_id
     where p.id = v_item.product_id
     for update of p;
    if not found then raise exception 'product not found'; end if;
    if v_product.status <> 'active' or v_product.verified is not true then raise exception 'merchant is not eligible'; end if;
    if v_item.variant_id is not null then
      select pv.* into v_product from product_variants pv where pv.id = v_item.variant_id and pv.product_id = v_item.product_id and pv.status = 'active' for update;
      if not found then raise exception 'variant not found'; end if;
      if v_product.stock < v_item.qty then raise exception 'insufficient variant stock'; end if;
    elsif v_product.stock < v_item.qty then raise exception 'insufficient stock for %', v_product.name;
    end if;
    if v_product.currency <> 'GHS' then raise exception 'unsupported currency'; end if;
  end loop;

  for v_merchant in
    select distinct p.merchant_id
      from products p
      join (select trim(elem->>'productId') as product_id from jsonb_array_elements(p_items) elem) i on i.product_id = p.id
     order by 1
  loop
    select q.* into v_quote from delivery_quotes q where q.id = (select trim(elem->>'quoteId') from jsonb_array_elements(p_quotes) elem where trim(elem->>'merchantId') = v_merchant limit 1) for update;
    if not found then raise exception 'delivery quote missing for merchant'; end if;
    if v_quote.user_id <> p_user_id or v_quote.merchant_id <> v_merchant then raise exception 'delivery quote ownership mismatch'; end if;
    if v_quote.expires_at <= v_now then raise exception 'delivery quote expired'; end if;
    if v_quote.dest_address <> trim(p_address) then raise exception 'delivery quote does not match this address'; end if;

    v_product_total := 0;
    v_order := 'ord_' || replace(gen_random_uuid()::text, '-', '');

    for v_item in
      select trim(elem->>'productId') as product_id, nullif(trim(elem->>'variantId'), '') as variant_id, sum((elem->>'quantity')::int) as qty
        from jsonb_array_elements(p_items) elem group by 1, 2 order by 1, 2
    loop
      select p.price, p.merchant_id into v_unit, v_item_merchant from products p where p.id = v_item.product_id;
      if v_item.variant_id is not null then
        select pv.price, p.merchant_id into v_unit, v_item_merchant from product_variants pv join products p on p.id = pv.product_id where pv.id = v_item.variant_id and pv.product_id = v_item.product_id and pv.status = 'active' for update of pv;
        if not found then raise exception 'variant not found'; end if;
      end if;
      if v_item_merchant <> v_quote.merchant_id then continue; end if;
      if v_item.variant_id is not null then
        update product_variants set stock = stock - v_item.qty, updated_at = now() where id = v_item.variant_id and stock >= v_item.qty and status = 'active';
        if not found then raise exception 'insufficient variant stock'; end if;
      else
        update products set stock = stock - v_item.qty where id = v_item.product_id and stock >= v_item.qty;
        if not found then raise exception 'insufficient stock'; end if;
      end if;
      v_line := round(v_unit * v_item.qty, 2);
      v_product_total := v_product_total + v_line;
      insert into order_items(order_id, product_id, variant_id, quantity, unit_price, currency, product_total) values (v_order, v_item.product_id, v_item.variant_id, v_item.qty, v_unit, 'GHS', v_line);
      insert into order_stock_reservations(order_id, order_item_id, product_id, variant_id, quantity) values (v_order, currval(pg_get_serial_sequence('order_items','id')), v_item.product_id, v_item.variant_id, v_item.qty);
    end loop;

    if v_product_total <= 0 then raise exception 'empty merchant order'; end if;
    v_delivery := v_quote.price;
    insert into orders(id, group_id, user_id, merchant_id, status, currency, product_total, delivery_total, platform_fee, merchant_net, grand_total, delivery_tier, delivery_quote_id, address)
    values (v_order, v_group, p_user_id, v_quote.merchant_id, 'payment_pending', 'GHS', v_product_total, v_delivery, 0, v_product_total, v_product_total + v_delivery, v_quote.tier, v_quote.id, trim(p_address));
    v_pay := 'pay_' || replace(gen_random_uuid()::text, '-', '');
    insert into payments(id, order_id, user_id, amount, currency, method, status, provider_key, client_reference)
    values (v_pay, v_order, p_user_id, v_product_total + v_delivery, 'GHS', p_method, 'initiated', case p_method when 'mobile_money' then 'external-mobile-money' when 'card' then 'external-card' when 'bank_transfer' then 'external-bank-transfer' end, v_pay);
    v_orders := v_orders || jsonb_build_array(jsonb_build_object('orderId', v_order, 'merchantId', v_quote.merchant_id, 'grandTotal', v_product_total + v_delivery, 'status', 'payment_pending', 'paymentId', v_pay));
  end loop;

  if jsonb_array_length(v_orders) < 1 then raise exception 'checkout produced no orders'; end if;
  return jsonb_build_object('replay', false, 'groupId', v_group, 'orders', v_orders);
end;
$$;

create or replace function validate_reservation_integrity()
returns trigger
language plpgsql
as $$
declare
  v_item record;
begin
  select oi.order_id, oi.product_id, oi.variant_id, oi.quantity
    into v_item
    from order_items oi
   where oi.id = new.order_item_id;

  if not found then raise exception 'reservation order item not found'; end if;
  if v_item.order_id <> new.order_id then raise exception 'reservation order mismatch'; end if;
  if v_item.product_id <> new.product_id then raise exception 'reservation product mismatch'; end if;
  if coalesce(v_item.variant_id, '') <> coalesce(new.variant_id, '') then raise exception 'reservation variant mismatch'; end if;
  if v_item.quantity <> new.quantity then raise exception 'reservation quantity mismatch'; end if;
  return new;
end;
$$;

drop trigger if exists order_stock_reservation_integrity_validate on order_stock_reservations;
create trigger order_stock_reservation_integrity_validate
before insert or update of order_id, order_item_id, product_id, variant_id, quantity
on order_stock_reservations
for each row execute function validate_reservation_integrity();

create index if not exists order_stock_reservations_item_status_idx
  on order_stock_reservations(order_item_id, status);
