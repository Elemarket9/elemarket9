-- v1.52 pre-live deep integrity hardening.
-- Replays of checkout idempotency must return the payment IDs so the client can
-- safely resume provider checkout instead of treating a valid replay as failure.
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
  v_provider_key text;
begin
  if p_user_id is null or char_length(p_user_id) < 3 or v_claimed_user is null or v_claimed_user <> p_user_id then raise exception 'unauthorized'; end if;
  if p_idem is null or char_length(p_idem) < 16 or char_length(p_idem) > 128 then raise exception 'invalid idempotency key'; end if;
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 then raise exception 'invalid request fingerprint'; end if;
  if p_address is null or char_length(trim(p_address)) < 8 or char_length(trim(p_address)) > 400 then raise exception 'delivery address is required'; end if;
  if p_method not in ('mobile_money', 'card', 'bank_transfer') then raise exception 'unsupported payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then raise exception 'invalid cart'; end if;
  if jsonb_typeof(p_quotes) <> 'array' or jsonb_array_length(p_quotes) < 1 or jsonb_array_length(p_quotes) > 40 then raise exception 'invalid delivery quotes'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:checkout:' || p_user_id, 0));

  if (select count(distinct p.merchant_id) from products p join (select distinct trim(elem->>'productId') as product_id from jsonb_array_elements(p_items) elem) i on i.product_id = p.id) > 1 then
    raise exception 'multi-merchant checkout requires separate merchant payment sessions';
  end if;

  select * into v_existing from order_idempotency where idem = p_idem;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.fingerprint <> p_fingerprint then raise exception 'idempotency conflict'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'orderId', o.id,
      'merchantId', o.merchant_id,
      'grandTotal', o.grand_total,
      'status', o.status,
      'paymentId', p.id
    ) order by o.id), '[]'::jsonb)
      into v_orders
      from orders o
      left join payments p on p.order_id=o.id
     where o.group_id = v_existing.group_id;
    return jsonb_build_object('replay', true, 'groupId', v_existing.group_id, 'orders', v_orders);
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
     group by 1, 2 order by 1, 2
  loop
    if v_item.product_id is null or v_item.product_id = '' or v_item.qty is null or v_item.qty < 1 or v_item.qty > 20 then raise exception 'invalid cart item'; end if;
    select p.id, p.merchant_id, p.price, p.stock, p.currency, p.name, m.status, m.verified
      into v_product
      from products p join merchants m on m.id = p.merchant_id
     where p.id = v_item.product_id for update of p;
    if not found then raise exception 'product not found'; end if;
    if v_product.status <> 'active' or v_product.verified is not true then raise exception 'merchant is not eligible'; end if;
    if v_item.variant_id is not null then
      select pv.* into v_product from product_variants pv where pv.id = v_item.variant_id and pv.product_id = v_item.product_id and pv.status = 'active' for update;
      if not found then raise exception 'variant not found'; end if;
      if v_product.stock < v_item.qty then raise exception 'insufficient variant stock'; end if;
    elsif v_product.stock < v_item.qty then raise exception 'insufficient stock'; end if;
    if v_product.currency <> 'GHS' then raise exception 'unsupported currency'; end if;
  end loop;

  for v_merchant in
    select distinct p.merchant_id
      from products p
      join (select distinct trim(elem->>'productId') as product_id from jsonb_array_elements(p_items) elem) i on i.product_id = p.id
     order by 1
  loop
    select q.* into v_quote
      from delivery_quotes q
     where q.id = (select trim(elem->>'quoteId') from jsonb_array_elements(p_quotes) elem where trim(elem->>'merchantId') = v_merchant limit 1)
     for update;
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
      insert into order_items(order_id, product_id, variant_id, quantity, unit_price, currency, product_total)
      values (v_order, v_item.product_id, v_item.variant_id, v_item.qty, v_unit, 'GHS', v_line);
      insert into order_stock_reservations(order_id, order_item_id, product_id, variant_id, quantity)
      values (v_order, currval(pg_get_serial_sequence('order_items','id')), v_item.product_id, v_item.variant_id, v_item.qty);
    end loop;
    if v_product_total <= 0 then raise exception 'empty merchant order'; end if;
    v_delivery := v_quote.price;
    insert into orders(id, group_id, user_id, merchant_id, status, currency, product_total, delivery_total, platform_fee, merchant_net, grand_total, delivery_tier, delivery_quote_id, address)
    values (v_order, v_group, p_user_id, v_quote.merchant_id, 'payment_pending', 'GHS', v_product_total, v_delivery, 0, v_product_total, v_product_total + v_delivery, v_quote.tier, v_quote.id, trim(p_address));
    select pp.provider_key into v_provider_key from payment_providers pp where pp.method = p_method and pp.status = 'active' order by pp.provider_key limit 1;
    if v_provider_key is null then raise exception 'No active payment provider configured for %', p_method; end if;
    v_pay := 'pay_' || replace(gen_random_uuid()::text, '-', '');
    insert into payments(id, order_id, user_id, amount, currency, method, status, provider_key, client_reference)
    values (v_pay, v_order, p_user_id, v_product_total + v_delivery, 'GHS', p_method, 'initiated', v_provider_key, v_pay);
    v_orders := v_orders || jsonb_build_array(jsonb_build_object('orderId', v_order, 'merchantId', v_quote.merchant_id, 'grandTotal', v_product_total + v_delivery, 'status', 'payment_pending', 'paymentId', v_pay));
  end loop;

  if jsonb_array_length(v_orders) < 1 then raise exception 'checkout produced no orders'; end if;
  return jsonb_build_object('replay', false, 'groupId', v_group, 'orders', v_orders);
end;
$$;

-- A successful provider webhook must not silently turn a custody-pending escrow
-- into HELD. The custody confirmation boundary remains explicit.
create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$
declare v_order record; v_escrow text;
begin
  if new.status <> 'completed' or old.status='completed' then return new; end if;
  select id,merchant_id,product_total,delivery_total,platform_fee,merchant_net,grand_total into v_order from orders where id=new.order_id for update;
  if not found then raise exception 'escrow order not found'; end if;
  if new.amount <> v_order.grand_total then raise exception 'escrow payment/order amount mismatch'; end if;
  v_escrow := 'esc_'||replace(gen_random_uuid()::text,'-','');
  insert into escrows(id,order_id,payment_id,merchant_id,gross_amount,delivery_amount,platform_fee,merchant_entitlement,state,created_at,updated_at)
  values(v_escrow,v_order.id,new.id,v_order.merchant_id,v_order.grand_total,v_order.delivery_total,v_order.platform_fee,v_order.merchant_net,'funding_pending',now(),now()) on conflict(order_id) do nothing;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'funding_pending','credit',e.gross_amount,new.id,jsonb_build_object('paymentId',new.id,'providerKey',new.provider_key)
    from escrows e where e.order_id=v_order.id on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists payment_completed_escrow_create on payments;
create trigger payment_completed_escrow_create after update of status on payments for each row execute function create_escrow_for_completed_payment();


-- A provider-confirmed refund must reconcile the escrow ledger. A refund can
-- never silently contradict a released/settled entitlement.
create or replace function sync_escrow_after_payment_refund()
returns trigger language plpgsql as $$
declare v_e record;
begin
  if new.status <> 'refunded' or old.status = 'refunded' then return new; end if;
  select * into v_e from escrows where payment_id=new.id for update;
  if not found then return new; end if;
  if v_e.state in ('released','settled') then
    raise exception 'released escrow requires post-settlement refund workflow';
  end if;
  if v_e.state = 'refunded' then return new; end if;
  update escrows set state='refunded', updated_at=now() where id=v_e.id;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'refund','debit',v_e.gross_amount,new.id,jsonb_build_object('source','provider_refund','providerKey',new.provider_key))
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists payment_refund_escrow_sync on payments;
create trigger payment_refund_escrow_sync
after update of status on payments for each row
execute function sync_escrow_after_payment_refund();
