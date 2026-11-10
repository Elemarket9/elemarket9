-- Checkout, inventory and refund correctness.
-- New unpaid orders expire. Failed payments and pre-shipment refunds put stock
-- back. Authorized discounts are charged in exact pesewas. A free basket can
-- still pay for delivery. Returns require a real delivery timestamp.

alter table order_items drop constraint if exists order_items_unit_price_nonnegative;
alter table order_items drop constraint if exists order_items_product_total_nonnegative;
do $$
declare r record;
begin
  for r in
    select distinct con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'order_items'::regclass
       and con.contype = 'c'
       and att.attname in ('unit_price', 'product_total')
       and pg_get_constraintdef(con.oid) like '%>%'
  loop
    execute format('alter table order_items drop constraint %I', r.conname);
  end loop;
end $$;
alter table order_items add constraint order_items_unit_price_nonnegative check (unit_price >= 0);
alter table order_items add constraint order_items_product_total_nonnegative check (product_total >= 0);

-- Pending orders created before deadlines were recorded become eligible for the
-- next expiry sweep. In-flight provider attempts are left for reconciliation.
update orders
   set payment_deadline = created_at + interval '15 minutes'
 where status = 'payment_pending'
   and payment_deadline is null;

create or replace function elemarket_restore_reservation_stock(p_order_id text, p_from_status text)
returns void language plpgsql as $$
declare r record;
begin
  if p_from_status not in ('reserved','consumed') then
    raise exception 'invalid reservation release status';
  end if;
  for r in
    select * from order_stock_reservations
     where order_id = p_order_id and status = p_from_status
     order by product_id, variant_id nulls first, id
     for update
  loop
    if r.variant_id is not null then
      update product_variants set stock = stock + r.quantity, updated_at = now() where id = r.variant_id;
      if not found then raise exception 'reserved variant not found'; end if;
    else
      update products set stock = stock + r.quantity where id = r.product_id;
      if not found then raise exception 'reserved product not found'; end if;
    end if;
    update order_stock_reservations
       set status = 'released', released_at = now()
     where id = r.id and status = p_from_status;
  end loop;
end;
$$;
revoke all on function elemarket_restore_reservation_stock(text, text) from public;

create or replace function expire_payment_pending_orders(p_limit integer default 100)
returns integer language plpgsql as $$
declare
  r record;
  v_order record;
  v_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid expiry batch size';
  end if;
  for r in
    select o.id
      from orders o
     where o.status = 'payment_pending'
       and (
         (o.payment_deadline is not null and o.payment_deadline <= now())
         or (o.payment_deadline is null and o.created_at <= now() - interval '15 minutes')
       )
       and not exists (
         select 1
           from payments pay
           join payment_attempts pa on pa.payment_id = pay.id
          where pay.order_id = o.id
            and pa.status in ('initiated','pending','authorized')
       )
     order by o.payment_deadline nulls first, o.id
     limit p_limit
  loop
    perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || r.id, 0));
    select id, status, payment_deadline, created_at
      into v_order
      from orders
     where id = r.id
     for update;
    if not found
       or v_order.status <> 'payment_pending'
       or not (
         (v_order.payment_deadline is not null and v_order.payment_deadline <= now())
         or (v_order.payment_deadline is null and v_order.created_at <= now() - interval '15 minutes')
       )
       or exists (
         select 1
           from payments pay
           join payment_attempts pa on pa.payment_id = pay.id
          where pay.order_id = v_order.id
            and pa.status in ('initiated','pending','authorized')
       )
    then
      continue;
    end if;
    perform elemarket_restore_reservation_stock(r.id, 'reserved');
    update orders
       set status = 'cancelled', updated_at = now()
     where id = r.id and status = 'payment_pending';
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
comment on function expire_payment_pending_orders(integer) is
  'Cancels overdue unpaid orders that are not waiting on a provider attempt, and returns their reserved stock.';

create or replace function apply_payment_webhook(
  p_provider_key text, p_event_id text, p_event_type text, p_provider_reference text,
  p_status text, p_amount numeric, p_currency text, p_payload_hash text,
  p_provider_refund_id text default null
) returns jsonb
language plpgsql
as $$
declare
  v_event record;
  v_payment record;
  v_order record;
  v_provider record;
  v_new_status text;
  v_refund_status text := null;
  v_refund_event boolean := false;
  v_consumed integer;
  v_expected integer;
begin
  if p_provider_key is null or p_event_id is null or p_event_type is null or p_payload_hash is null then
    raise exception 'invalid webhook';
  end if;
  if p_status not in ('authorized','completed','failed','refunded') then
    raise exception 'unsupported payment status';
  end if;
  if p_currency <> 'GHS' or p_amount is null or p_amount <= 0 then
    raise exception 'invalid payment amount';
  end if;

  select provider_key,status into v_provider
    from payment_providers
   where provider_key=p_provider_key;
  if not found or v_provider.status <> 'active' then
    raise exception 'payment provider is not active';
  end if;

  insert into payment_webhook_events(
    provider_key,event_id,event_type,provider_reference,payload_hash,
    signature_verified,processing_status
  ) values (
    p_provider_key,p_event_id,p_event_type,p_provider_reference,p_payload_hash,
    true,'received'
  ) on conflict(provider_key,event_id) do nothing;

  select * into v_event
    from payment_webhook_events
   where provider_key=p_provider_key and event_id=p_event_id
   for update;

  if v_event.payload_hash <> p_payload_hash then
    return reject_payment_webhook(p_provider_key,p_event_id,p_payload_hash,'event_payload_mismatch');
  end if;

  if v_event.processing_status='rejected' then
    return jsonb_build_object('rejected',true,'errorCode',v_event.error_code,'duplicate',true);
  end if;
  if v_event.processing_status in ('processed','ignored')
     and not (v_event.processing_status='ignored' and v_event.error_code='order_already_resolved' and p_status='completed') then
    return jsonb_build_object('duplicate',true,'status',v_event.processing_status);
  end if;

  select p.* into v_payment
    from payment_attempts pa
    join payments p on p.id=pa.payment_id
   where pa.provider_key=p_provider_key
     and pa.provider_reference=p_provider_reference
   order by pa.created_at desc
   limit 1;

  if not found then
    update payment_webhook_events
       set processing_status='received',error_code='payment_not_yet_bound',processed_at=null
     where id=v_event.id;
    return jsonb_build_object('retryable',true,'errorCode','payment_not_yet_bound');
  end if;

  if round(v_payment.amount,2) <> round(p_amount,2) or v_payment.currency <> p_currency then
    update payment_webhook_events
       set processing_status='rejected',error_code='amount_mismatch',processed_at=now()
     where id=v_event.id;
    return reject_payment_webhook(p_provider_key,p_event_id,p_payload_hash,'amount_mismatch');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:'||v_payment.order_id,0));
  select * into v_payment from payments where id=v_payment.id for update;
  select * into v_order from orders where id=v_payment.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_payment.user_id<>v_order.user_id then raise exception 'payment/order owner mismatch'; end if;

  -- Refund lifecycle events describe the provider's refund operation, not a
  -- new payment state. Only refund.processed changes payments -> refunded.
  if left(p_event_type,7)='refund.' then
    v_refund_event := true;
    v_refund_status := case p_event_type
      when 'refund.pending' then 'requested'
      when 'refund.processing' then 'processing'
      when 'refund.needs-attention' then 'needs_attention'
      when 'refund.failed' then 'failed'
      when 'refund.processed' then 'processed'
      else null
    end;
    if v_refund_status is null then
      update payment_webhook_events
         set processing_status='ignored',error_code='unsupported_refund_event',processed_at=now()
       where id=v_event.id;
      return jsonb_build_object('duplicate',false,'ignored',true,'paymentId',v_payment.id,'orderId',v_order.id,'status',v_payment.status);
    end if;

    if v_refund_status='processed' then
      v_new_status := 'refunded';
    else
      v_new_status := v_payment.status;
    end if;
  else
    v_new_status := p_status;
  end if;

  if not v_refund_event and p_status='completed' then
    insert into payment_provider_evidence(provider_key,event_id,payment_id,provider_reference,event_type,amount,currency,payload_hash)
    values(p_provider_key,p_event_id,v_payment.id,p_provider_reference,p_event_type,p_amount,p_currency,p_payload_hash)
    on conflict do nothing;

    -- A replay of success must never regress a provider-confirmed refund.
    if v_payment.status='refunded' then
      update payment_webhook_events set processing_status='ignored',processed_at=now() where id=v_event.id;
      return jsonb_build_object('ignored',true,'status','refunded');
    end if;

    if v_order.status='cancelled' then
      -- Keep the existing state machine: failed payments require manual reconciliation,
      -- while initiated/authorized payments can accurately record completion.
      if validate_payment_transition(v_payment.status,'completed') then
        update payments set status='completed',provider_reference=coalesce(provider_reference,p_provider_reference),updated_at=now() where id=v_payment.id;
        if v_payment.status<>'completed' then
          insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
          values(v_payment.id,v_payment.status,'completed','provider_webhook',p_event_id);
        end if;
      end if;
      insert into marketplace_reconciliation_cases(id,merchant_id,order_id,external_reference,case_type,severity,dedupe_key,details)
      values('mrc_'||replace(gen_random_uuid()::text,'-',''),v_order.merchant_id,v_order.id,p_provider_reference,'payment','high',
        'late-payment:'||v_payment.id,jsonb_build_object('reason','late_successful_payment','paymentId',v_payment.id,
        'providerKey',p_provider_key,'providerReference',p_provider_reference,'amount',p_amount,'currency',p_currency,
        'resolution','provider_refund_or_operator_reconciliation','eventId',p_event_id,'payloadHash',p_payload_hash))
      on conflict(dedupe_key) where dedupe_key is not null do nothing;
      perform record_audit_event('payment.late_success_requires_reconciliation','payment',v_payment.id,null,'system',null,'success',
        jsonb_build_object('providerKey',p_provider_key,'eventId',p_event_id,'orderId',v_order.id));
      update payment_webhook_events set processing_status='processed',error_code=null,processed_at=now() where id=v_event.id;
      return jsonb_build_object('reconciliationRequired',true,'paymentId',v_payment.id,'orderId',v_order.id,'orderStatus','cancelled');
    end if;
    if v_payment.status<>'completed' and v_order.status<>'payment_pending' then
      update payment_webhook_events set processing_status='rejected',error_code='order_not_payment_pending',processed_at=now() where id=v_event.id;
      return reject_payment_webhook(p_provider_key,p_event_id,p_payload_hash,'order_not_payment_pending');
    end if;
  end if;

  if not validate_payment_transition(v_payment.status,v_new_status) then
    update payment_webhook_events
       set processing_status='rejected',error_code='invalid_state_transition',processed_at=now()
     where id=v_event.id;
    return reject_payment_webhook(p_provider_key,p_event_id,p_payload_hash,'invalid_state_transition');
  end if;

  if v_new_status='completed' and v_payment.status<>'completed' then
    select count(*) into v_expected from order_items where order_id=v_order.id;
    update order_stock_reservations
       set status='consumed'
     where order_id=v_order.id and status='reserved';
    get diagnostics v_consumed=row_count;
    if v_consumed<>v_expected then raise exception 'reservation integrity failure'; end if;
  elsif v_new_status='refunded' and v_order.status in ('paid','confirmed','refund_pending') then
    -- Goods have not shipped. Put the consumed units back on sale.
    perform elemarket_restore_reservation_stock(v_order.id, 'consumed');
  elsif v_new_status='refunded' then
    update order_stock_reservations
       set status='released',released_at=now()
     where order_id=v_order.id and status='consumed';
  elsif v_new_status='failed' and not v_refund_event and v_order.status='payment_pending' then
    perform elemarket_restore_reservation_stock(v_order.id, 'reserved');
  end if;

  update payments
     set provider_reference=coalesce(p_provider_reference,provider_reference),status=v_new_status,updated_at=now()
   where id=v_payment.id;

  if not v_refund_event then
    update payment_attempts
       set status=case
             when v_new_status='completed' then 'completed'
             when v_new_status='authorized' then 'authorized'
             when v_new_status='failed' then 'failed'
             else status
           end,
           updated_at=now()
     where payment_id=v_payment.id
       and status in ('initiated','pending','authorized');
  end if;

  if v_payment.status<>v_new_status then
    insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
    values(v_payment.id,v_payment.status,v_new_status,'provider_webhook',p_event_id);
  end if;

  if v_refund_event then
    update provider_refund_requests
       set status=v_refund_status,
           provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),
           processed_at=case when v_refund_status='processed' then now() else processed_at end,
           updated_at=now()
     where payment_id=v_payment.id
       and status in ('requested','processing','needs_attention','failed')
       and (p_provider_refund_id is null or provider_refund_id is null or provider_refund_id=p_provider_refund_id);
  end if;

  if v_new_status='completed' and v_payment.status<>'completed' then
    update orders set status='paid',updated_at=now()
     where id=v_order.id and status='payment_pending';
  elsif v_new_status='refunded' then
    update orders set status='refunded',updated_at=now()
     where id=v_order.id
       and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','refund_pending');
  elsif v_new_status='failed' and not v_refund_event then
    update orders set status='cancelled',updated_at=now()
     where id=v_order.id and status='payment_pending';
  end if;

  update payment_webhook_events
     set processing_status='processed',error_code=null,processed_at=now()
   where id=v_event.id;

  return jsonb_build_object(
    'duplicate',false,
    'ignored',v_payment.status=v_new_status and not v_refund_event,
    'refundEvent',v_refund_event,
    'refundStatus',v_refund_status,
    'paymentId',v_payment.id,
    'orderId',v_order.id,
    'status',v_new_status
  );
end;
$$;

create or replace function sync_flash_sale_after_order_status()
returns trigger language plpgsql as $$
declare
  r record;
  q record;
begin
  if old.status='payment_pending' and new.status='cancelled' then
    for q in
      select fsi.id,oi.quantity
        from flash_sale_redemptions fsr
        join flash_sale_items fsi on fsi.flash_sale_id=fsr.flash_sale_id
        join order_items oi on oi.order_id=new.id and oi.product_id=fsi.product_id
          and ((fsi.variant_id is not null and oi.variant_id=fsi.variant_id) or (fsi.variant_id is null and oi.variant_id is null))
       where fsr.order_id=new.id and fsr.status='reserved'
       for update of fsi
    loop
      update flash_sale_items
         set reserved_quantity=greatest(reserved_quantity-q.quantity,0),updated_at=now()
       where id=q.id;
    end loop;
    update flash_sale_redemptions
       set status='released',released_at=coalesce(released_at,now())
     where order_id=new.id and status='reserved';
  elsif old.status='payment_pending' and new.status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed') then
    for q in
      select fsi.id,oi.quantity
        from flash_sale_redemptions fsr
        join flash_sale_items fsi on fsi.flash_sale_id=fsr.flash_sale_id
        join order_items oi on oi.order_id=new.id and oi.product_id=fsi.product_id
          and ((fsi.variant_id is not null and oi.variant_id=fsi.variant_id) or (fsi.variant_id is null and oi.variant_id is null))
       where fsr.order_id=new.id and fsr.status='reserved'
       for update of fsi
    loop
      update flash_sale_items
         set reserved_quantity=greatest(reserved_quantity-q.quantity,0),
             sold_quantity=sold_quantity+q.quantity,updated_at=now()
       where id=q.id;
    end loop;
    update flash_sale_redemptions
       set status='consumed',consumed_at=coalesce(consumed_at,now())
     where order_id=new.id and status='reserved';
  elsif old.status in ('paid','confirmed','refund_pending') and new.status='refunded' then
    -- The customer already used their per-customer flash entry. Return the unit
    -- to the sale so someone else can buy it; do not reopen this redemption.
    for q in
      select fsi.id,oi.quantity
        from flash_sale_redemptions fsr
        join flash_sale_items fsi on fsi.flash_sale_id=fsr.flash_sale_id
        join order_items oi on oi.order_id=new.id and oi.product_id=fsi.product_id
          and ((fsi.variant_id is not null and oi.variant_id=fsi.variant_id) or (fsi.variant_id is null and oi.variant_id is null))
       where fsr.order_id=new.id and fsr.status='consumed'
       for update of fsi
    loop
      update flash_sale_items
         set sold_quantity=greatest(sold_quantity-q.quantity,0),updated_at=now()
       where id=q.id;
    end loop;
  end if;
  return new;
end;
$$;

create or replace function request_order_return(
  p_order_id text,
  p_order_item_id bigint,
  p_customer_id text,
  p_reason_code text,
  p_reason text,
  p_quantity integer
) returns jsonb language plpgsql as $$
declare
  v_order record; v_item record; v_product record; v_existing record; v_id text;
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
  if v_item.returnable is not true then raise exception 'this item is not returnable'; end if;
  if elemarket_order_delivered_at(v_order.id) is null then raise exception 'return window has not started'; end if;
  if v_item.return_window_days is null or now() > elemarket_order_delivered_at(v_order.id) + make_interval(days=>v_item.return_window_days) then raise exception 'return window has expired'; end if;

  select id,status into v_existing from return_requests where order_item_id=p_order_item_id and status in ('requested','approved','received','refund_pending') limit 1 for update;
  if found then
    return jsonb_build_object('returnId',v_existing.id,'status',v_existing.status,'existing',true);
  end if;

  if p_quantity > v_item.quantity then raise exception 'invalid return quantity'; end if;
  v_id:='ret_'||replace(gen_random_uuid()::text,'-','');
  insert into return_requests(id,order_id,order_item_id,customer_id,merchant_id,reason_code,reason,quantity)
  values(v_id,p_order_id,p_order_item_id,p_customer_id,v_item.merchant_id,p_reason_code,left(trim(p_reason),2000),p_quantity);
  perform record_audit_event('customer.return.requested','return_request',v_id,p_customer_id,'customer',null,'success',jsonb_build_object('orderId',p_order_id,'orderItemId',p_order_item_id,'merchantId',v_item.merchant_id,'reasonCode',p_reason_code,'quantity',p_quantity));
  return jsonb_build_object('returnId',v_id,'orderId',p_order_id,'orderItemId',p_order_item_id,'status','requested','existing',false);
end;
$$;


CREATE OR REPLACE FUNCTION public.create_pending_order(p_user_id text, p_idem text, p_fingerprint text, p_items jsonb, p_quotes jsonb, p_address text, p_method text, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_existing record;
  v_group text;
  v_item record;
  v_product record;
  v_variant record;
  v_lines jsonb;
  v_order_item_id bigint;
  v_quote record;
  v_merchant text;
  v_item_merchant text;
  v_category text;
  v_line numeric(12,2);
  v_line_fee numeric(12,2);
  v_unit numeric(12,2);
  v_original_unit numeric(12,2);
  v_product_total numeric(12,2);
  v_platform_fee numeric(12,2);
  v_delivery numeric(12,2);
  v_order text;
  v_pay text;
  v_orders jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_count integer;
  v_claimed_user text := current_setting('app.user_id', true);
  v_provider_key text;
  v_rate_bps integer;
  v_promo record;
  v_promo_id text;
  v_promo_discount numeric(12,2) := 0;
  v_eligible_subtotal numeric(12,2) := 0;
  v_cart_subtotal numeric(12,2) := 0;
  v_remaining_discount numeric(12,2) := 0;
  v_line_discount numeric(12,2) := 0;
  v_has_product_scope boolean := false;
  v_has_category_scope boolean := false;
  v_eligible boolean := false;
  v_prior_orders integer := 0;
  v_redemption text;
  v_flash_sale_id text;
  v_flash_sale record;
  v_flash_item record;
  v_flash_discount numeric(12,2) := 0;
  v_flash_redemption text;
  v_flash_ids text[] := '{}';
  v_cart_merchant_count integer := 0;
  v_idx integer;
  v_last jsonb;
  v_absorb numeric(12,2);
  v_line_total numeric(12,2);
begin
  if p_user_id is null or char_length(p_user_id) < 3 or v_claimed_user is null or v_claimed_user <> p_user_id then raise exception 'unauthorized'; end if;
  if p_idem is null or char_length(p_idem) < 16 or char_length(p_idem) > 128 then raise exception 'invalid idempotency key'; end if;
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 then raise exception 'invalid request fingerprint'; end if;
  if p_address is null or char_length(trim(p_address)) < 8 or char_length(trim(p_address)) > 400 then raise exception 'delivery address is required'; end if;
  if p_method not in ('mobile_money', 'card', 'bank_transfer') then raise exception 'unsupported payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then raise exception 'invalid cart'; end if;
  if jsonb_typeof(p_quotes) <> 'array' or jsonb_array_length(p_quotes) < 1 or jsonb_array_length(p_quotes) > 40 then raise exception 'invalid delivery quotes'; end if;
  if p_promo_code is not null and char_length(trim(p_promo_code)) > 64 then raise exception 'invalid promotion code'; end if;
  if p_promo_code is not null and trim(p_promo_code) <> '' and trim(p_promo_code) !~ '^[A-Za-z0-9_-]{4,64}$' then raise exception 'invalid promotion code'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:checkout:' || p_user_id, 0));


  select * into v_existing from order_idempotency where idem = p_idem;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.fingerprint <> p_fingerprint then raise exception 'idempotency conflict'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('orderId',o.id,'merchantId',o.merchant_id,'grandTotal',o.grand_total,'status',o.status,'paymentId',p.id) order by o.id),'[]'::jsonb)
      into v_orders from orders o left join payments p on p.order_id=o.id where o.group_id=v_existing.group_id;
    return jsonb_build_object('replay',true,'groupId',v_existing.group_id,'orders',v_orders);
  end if;

  -- Advisory user lock above serializes checkout attempts, including pending-order quotas.
  select count(*) into v_count from orders where user_id=p_user_id and status='payment_pending';
  if v_count + (select count(distinct p.merchant_id) from products p join (select distinct elem->>'productId' as product_id from jsonb_array_elements(p_items) elem) i on i.product_id=p.id) > 3 then raise exception 'too many unpaid orders'; end if;
  if (select coalesce(sum(oi.quantity),0) from order_items oi join orders o on o.id=oi.order_id where o.user_id=p_user_id and o.status='payment_pending') + (select coalesce(sum((elem->>'quantity')::integer),0) from jsonb_array_elements(p_items) elem) > 40 then raise exception 'too many reserved units'; end if;

  select count(*) into v_count from orders where user_id=p_user_id and created_at > v_now - interval '1 minute';
  if v_count >= 8 then raise exception 'too many checkouts; retry shortly'; end if;

  select count(distinct p.merchant_id) into v_cart_merchant_count from products p join (select distinct elem->>'productId' product_id from jsonb_array_elements(p_items) elem) i on i.product_id=p.id;
  -- Quote objects must describe exactly one valid quote for each merchant.
  -- Reject ghost/duplicate entries from native or untrusted clients.
  if v_cart_merchant_count<>jsonb_array_length(p_quotes)
     or v_cart_merchant_count<>(select count(distinct trim(elem->>'merchantId')) from jsonb_array_elements(p_quotes) elem)
  then raise exception 'delivery quotes do not match cart merchants'; end if;
  if nullif(trim(p_promo_code),'') is not null and v_cart_merchant_count > 1 then
    raise exception 'multi-merchant promotions require separate merchant checkouts';
  end if;

  v_group := 'grp_' || replace(gen_random_uuid()::text, '-', '');
  insert into order_groups(id,user_id) values (v_group,p_user_id);
  insert into order_idempotency(idem,user_id,fingerprint,group_id) values (p_idem,p_user_id,p_fingerprint,v_group);

  -- Lock every product/variant in deterministic order before any stock mutation.
  for v_item in
    select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
      from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
  loop
    if v_item.product_id is null or v_item.product_id='' or v_item.qty is null or v_item.qty<1 or v_item.qty>20 then raise exception 'invalid cart item'; end if;
    select p.id,p.merchant_id,p.price,p.stock,p.currency,p.name,p.category,p.status as product_status,m.status as merchant_status,m.verified
      into v_product from products p join merchants m on m.id=p.merchant_id where p.id=v_item.product_id for update of p;
    if not found then raise exception 'product not found'; end if;
    if v_product.merchant_status<>'active' or v_product.verified is not true then raise exception 'merchant is not eligible'; end if;
    if v_product.product_status<>'active' then raise exception 'product is not available'; end if;
    if v_item.variant_id is not null then
      select pv.* into v_variant from product_variants pv where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' for update;
      if not found then raise exception 'variant not found'; end if;
      if v_variant.stock<v_item.qty then raise exception 'insufficient variant stock'; end if;
    else
      if exists (select 1 from product_variants pv where pv.product_id=v_item.product_id and pv.status='active') then
        raise exception 'variant selection required for this product';
      end if;
      if v_product.stock<v_item.qty then raise exception 'insufficient stock'; end if;
    end if;
    if v_product.currency<>'GHS' then raise exception 'unsupported currency'; end if;
  end loop;

  for v_merchant in
    select distinct p.merchant_id from products p join (select distinct trim(elem->>'productId') as product_id from jsonb_array_elements(p_items) elem) i on i.product_id=p.id order by 1
  loop
    select q.* into v_quote from delivery_quotes q where q.id=(select trim(elem->>'quoteId') from jsonb_array_elements(p_quotes) elem where trim(elem->>'merchantId')=v_merchant limit 1) for update;
    if not found then raise exception 'delivery quote missing for merchant'; end if;
    if v_quote.user_id<>p_user_id or v_quote.merchant_id<>v_merchant then raise exception 'delivery quote ownership mismatch'; end if;
    if v_quote.expires_at<=v_now then raise exception 'delivery quote expired'; end if;
    if v_quote.dest_address<>trim(p_address) then raise exception 'delivery quote does not match this address'; end if;

    -- Promotions are evaluated only after the authoritative merchant is known.
    v_promo_id := null;
    v_promo_discount := 0;
    v_eligible_subtotal := 0;
    v_cart_subtotal := 0;
    v_remaining_discount := 0;

    -- Always snapshot the authoritative pre-discount merchandise subtotal.
    for v_item in
      select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
        from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
    loop
      if v_item.variant_id is not null then
        select pv.price,p.merchant_id into v_unit,v_item_merchant from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active';
      else
        select p.price,p.merchant_id into v_unit,v_item_merchant from products p where p.id=v_item.product_id;
      end if;
      if v_item_merchant<>v_quote.merchant_id then continue; end if;
      v_cart_subtotal:=v_cart_subtotal+round(v_unit*v_item.qty,2);
    end loop;

    -- Flash sales are automatic, scarce inventory promotions. Never stack a coupon
    -- on top of an active flash sale. The sale campaign is locked so eligibility,
    -- per-customer usage and allocation are evaluated atomically.
    select array_agg(distinct fs.id order by fs.id) into v_flash_ids
      from flash_sales fs
      join flash_sale_items fsi on fsi.flash_sale_id=fs.id
      left join product_variants pv on pv.id=fsi.variant_id
      where fs.merchant_id=v_merchant and fs.status='active'
        and fs.starts_at<=v_now and fs.ends_at>v_now
        and ((fsi.variant_id is not null and exists (select 1 from jsonb_array_elements(p_items) e where trim(e->>'variantId')=fsi.variant_id and trim(e->>'productId')=fsi.product_id))
          or (fsi.variant_id is null and exists (select 1 from jsonb_array_elements(p_items) e where trim(e->>'productId')=fsi.product_id and nullif(trim(e->>'variantId'),'') is null)));
    if coalesce(array_length(v_flash_ids,1),0)>1 then
      raise exception 'multiple flash sales cannot be combined in one checkout';
    end if;
    v_flash_sale_id:=case when coalesce(array_length(v_flash_ids,1),0)=1 then v_flash_ids[1] else null end;
    if v_flash_sale_id is not null then
      select * into v_flash_sale from flash_sales where id=v_flash_sale_id for update;
      if p_promo_code is not null and trim(p_promo_code)<>'' then
        raise exception 'promotion cannot be combined with a flash sale';
      end if;
      if (select count(*) from flash_sale_redemptions where flash_sale_id=v_flash_sale_id and user_id=p_user_id and status in ('reserved','consumed')) >= v_flash_sale.per_customer_limit then
        raise exception 'flash sale customer limit reached';
      end if;
    end if;

    if p_promo_code is not null and trim(p_promo_code)<>'' then
      select * into v_promo from promotions where upper(trim(code))=upper(trim(p_promo_code)) for update;
      if not found or v_promo.status<>'active' or v_promo.starts_at>v_now or v_promo.ends_at<=v_now then raise exception 'promotion is not available'; end if;
      if v_promo.currency<>'GHS' then raise exception 'promotion currency mismatch'; end if;
      if v_promo.merchant_id is not null and v_promo.merchant_id<>v_merchant then raise exception 'promotion is not valid for this merchant'; end if;
      if v_promo.usage_limit is not null and (select count(*) from promotion_redemptions where promotion_id=v_promo.id and status in ('reserved','applied'))>=v_promo.usage_limit then raise exception 'promotion usage limit reached'; end if;
      if (select count(*) from promotion_redemptions where promotion_id=v_promo.id and user_id=p_user_id and status in ('reserved','applied'))>=v_promo.per_customer_limit then raise exception 'promotion customer limit reached'; end if;
      if v_promo.first_order_only or v_promo.new_customer_only then
        select count(*) into v_prior_orders from orders where user_id=p_user_id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed');
        if v_prior_orders>0 then raise exception 'promotion is for new customers only'; end if;
      end if;
      select exists(select 1 from promotion_products where promotion_id=v_promo.id),exists(select 1 from promotion_categories where promotion_id=v_promo.id) into v_has_product_scope,v_has_category_scope;
      for v_item in
        select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
          from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
      loop
        if v_item.variant_id is not null then
          select pv.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active';
        else
          select p.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from products p where p.id=v_item.product_id;
        end if;
        if v_item_merchant<>v_quote.merchant_id then continue; end if;
        v_line:=round(v_unit*v_item.qty,2);
        v_eligible:=true;
        if v_has_product_scope and not exists(select 1 from promotion_products where promotion_id=v_promo.id and product_id=v_item.product_id) then v_eligible:=false; end if;
        if v_has_category_scope and not exists(select 1 from promotion_categories where promotion_id=v_promo.id and category=v_category) then v_eligible:=false; end if;
        if v_eligible then v_eligible_subtotal:=v_eligible_subtotal+v_line; end if;
      end loop;
      if v_eligible_subtotal < v_promo.min_subtotal then raise exception 'promotion minimum basket not reached'; end if;
      if v_eligible_subtotal<=0 then raise exception 'promotion does not apply to this cart'; end if;
      if v_promo.discount_type='percentage' then
        v_promo_discount:=round(v_eligible_subtotal*v_promo.discount_value/100.0,2);
      else
        v_promo_discount:=least(v_promo.discount_value,v_eligible_subtotal);
      end if;
      if v_promo.max_discount is not null then v_promo_discount:=least(v_promo_discount,v_promo.max_discount); end if;
      v_promo_discount:=greatest(least(v_promo_discount,v_eligible_subtotal),0);
      v_remaining_discount:=v_promo_discount;
      v_promo_id:=v_promo.id;
    end if;

    v_lines:='[]'::jsonb;
    v_product_total:=0;
    v_platform_fee:=0;
    v_flash_discount:=0;
    v_order:='ord_'||replace(gen_random_uuid()::text,'-','');
    for v_item in
      select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
        from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
    loop
      select p.price,p.merchant_id,p.category into v_original_unit,v_item_merchant,v_category from products p where p.id=v_item.product_id;
      v_unit:=v_original_unit;
      if v_item.variant_id is not null then
        select pv.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' for update of pv;
        if not found then raise exception 'variant not found'; end if;
        v_original_unit:=v_unit;
      end if;
      if v_item_merchant<>v_quote.merchant_id then continue; end if;
      v_line:=round(v_original_unit*v_item.qty,2);
      v_line_discount:=0;
      if v_flash_sale_id is not null then
        select fsi.*,fs.status as sale_status,fs.starts_at,fs.ends_at,fs.per_customer_limit
          into v_flash_item
          from flash_sale_items fsi join flash_sales fs on fs.id=fsi.flash_sale_id
         where fsi.flash_sale_id=v_flash_sale_id
           and fsi.product_id=v_item.product_id
           and ((fsi.variant_id is not null and fsi.variant_id=v_item.variant_id) or (fsi.variant_id is null and v_item.variant_id is null))
         for update of fsi;
        if found then
          if v_flash_item.sale_status<>'active' or v_flash_item.starts_at>v_now or v_flash_item.ends_at<=v_now then
            raise exception 'flash sale is no longer active';
          end if;
          if v_flash_item.quantity_limit is not null and v_flash_item.reserved_quantity + v_flash_item.sold_quantity + v_item.qty > v_flash_item.quantity_limit then
            raise exception 'flash sale allocation exhausted';
          end if;
          v_line_discount:=greatest(round((v_original_unit-v_flash_item.sale_price)*v_item.qty,2),0);
          if v_line_discount<=0 or v_flash_item.sale_price>v_original_unit then
            raise exception 'invalid flash sale price';
          end if;
          update flash_sale_items
             set reserved_quantity=reserved_quantity+v_item.qty, updated_at=now()
           where flash_sale_id=v_flash_sale_id and product_id=v_item.product_id
             and ((variant_id is not null and variant_id=v_item.variant_id) or (variant_id is null and v_item.variant_id is null))
             and (quantity_limit is null or reserved_quantity+sold_quantity+v_item.qty<=quantity_limit);
          if not found then raise exception 'flash sale allocation exhausted'; end if;
          v_flash_discount:=v_flash_discount+v_line_discount;
        end if;
      end if;
      v_eligible:=v_promo_id is not null and v_flash_sale_id is null;
      if v_eligible then
        if v_has_product_scope and not exists(select 1 from promotion_products where promotion_id=v_promo_id and product_id=v_item.product_id) then v_eligible:=false; end if;
        if v_has_category_scope and not exists(select 1 from promotion_categories where promotion_id=v_promo_id and category=v_category) then v_eligible:=false; end if;
        if v_eligible and v_eligible_subtotal>0 then
          if v_promo.discount_type='percentage' then
            v_line_discount:=round(v_line*v_promo.discount_value/100.0,2);
            if v_promo.max_discount is not null then v_line_discount:=least(v_line_discount,v_promo.max_discount); end if;
            -- Cap the aggregate discount at the promotion's authoritative total.
            v_line_discount:=least(v_line_discount,v_remaining_discount);
          else
            v_line_discount:=least(v_line,v_remaining_discount);
          end if;
          v_remaining_discount:=greatest(v_remaining_discount-v_line_discount,0);
        end if;
      end if;
      if v_item.variant_id is not null then
        update product_variants set stock=stock-v_item.qty,updated_at=now() where id=v_item.variant_id and stock>=v_item.qty and status='active';
        if not found then raise exception 'insufficient variant stock'; end if;
      else
        update products set stock=stock-v_item.qty where id=v_item.product_id and stock>=v_item.qty;
        if not found then raise exception 'insufficient stock'; end if;
      end if;
      -- Charge the exact authorized net. unit_price is the per-unit display
      -- of that net; product_total is authoritative when it does not divide evenly.
      v_line:=round(greatest(v_line-v_line_discount,0),2);
      v_unit:=case when v_item.qty<1 then 0 else round(v_line/v_item.qty,2) end;
      v_line_discount:=round(greatest(round(v_original_unit*v_item.qty,2)-v_line,0),2);
      if v_line<0 or v_line>round(v_original_unit*v_item.qty,2) then raise exception 'invalid promotion calculation'; end if;
      v_line_fee:=round(v_line*get_commission_rate_bps(v_quote.merchant_id,v_item.product_id,v_category)/10000.0,2);
      v_rate_bps:=get_commission_rate_bps(v_quote.merchant_id,v_item.product_id,v_category);
      v_product_total:=v_product_total+v_line;
      v_platform_fee:=v_platform_fee+v_line_fee;
      v_lines:=v_lines || jsonb_build_array(jsonb_build_object(
        'product_id',v_item.product_id,'variant_id',v_item.variant_id,'quantity',v_item.qty,
        'unit_price',v_unit,'original_unit_price',v_original_unit,
        'product_total',v_line,'discount_total',v_line_discount));
    end loop;
    -- Per-line rounding can leave a pesewa of the authorized discount unapplied.
    -- Give it back to lines that still have a charge, then recompute commission.
    if v_promo_id is not null and v_remaining_discount > 0 and jsonb_array_length(v_lines) > 0 then
      for v_idx in reverse jsonb_array_length(v_lines) - 1 .. 0 loop
        exit when v_remaining_discount <= 0;
        v_last := v_lines -> v_idx;
        v_line_total := round((v_last->>'product_total')::numeric, 2);
        v_absorb := least(v_remaining_discount, v_line_total);
        if v_absorb > 0 then
          v_line_total := round(v_line_total - v_absorb, 2);
          v_last := jsonb_set(v_last, '{product_total}', to_jsonb(v_line_total));
          v_last := jsonb_set(v_last, '{discount_total}', to_jsonb(round((v_last->>'discount_total')::numeric + v_absorb, 2)));
          v_last := jsonb_set(v_last, '{unit_price}', to_jsonb(round(v_line_total / greatest((v_last->>'quantity')::numeric, 1), 2)));
          v_lines := jsonb_set(v_lines, array[v_idx::text], v_last);
          v_product_total := round(v_product_total - v_absorb, 2);
          v_remaining_discount := round(v_remaining_discount - v_absorb, 2);
        end if;
      end loop;
      v_platform_fee := 0;
      for v_item in select * from jsonb_to_recordset(v_lines) as line(product_id text, product_total numeric) loop
        select p.category into v_category from products p where p.id = v_item.product_id;
        v_platform_fee := v_platform_fee + round(v_item.product_total * get_commission_rate_bps(v_quote.merchant_id, v_item.product_id, v_category) / 10000.0, 2);
      end loop;
    end if;
    if jsonb_array_length(v_lines) < 1 then raise exception 'empty merchant order'; end if;
    if v_product_total < 0 or v_product_total + v_delivery <= 0 then raise exception 'empty merchant order'; end if;
    if v_flash_sale_id is not null then
      v_promo_discount:=round(v_cart_subtotal-v_product_total,2);
      if v_promo_discount<>round(v_flash_discount,2) then raise exception 'flash sale discount integrity failure'; end if;
    end if;
    -- Rounding invariant: line-level discounts must equal the authoritative promotion amount.
    if v_promo_id is not null then
      v_promo_discount:=round(v_cart_subtotal-v_product_total,2);
      if v_promo_discount<0 then raise exception 'invalid promotion total'; end if;
      if v_promo_discount > v_eligible_subtotal then raise exception 'promotion exceeds eligible subtotal'; end if;
    end if;
    v_delivery:=v_quote.price;
    insert into orders(id,group_id,user_id,merchant_id,status,currency,product_total,delivery_total,platform_fee,merchant_net,grand_total,delivery_tier,delivery_quote_id,address,promo_discount,promo_code,promo_id,flash_sale_id,original_product_total,payment_deadline)
    values(v_order,v_group,p_user_id,v_quote.merchant_id,'payment_pending','GHS',v_product_total,v_delivery,v_platform_fee,v_product_total-v_platform_fee,v_product_total+v_delivery,v_quote.tier,v_quote.id,trim(p_address),v_promo_discount,nullif(upper(trim(p_promo_code)),''),v_promo_id,v_flash_sale_id,v_cart_subtotal,v_now + interval '15 minutes');

    for v_item in select * from jsonb_to_recordset(v_lines) as line(
      product_id text,variant_id text,quantity integer,unit_price numeric,
      original_unit_price numeric,product_total numeric,discount_total numeric)
    loop
      insert into order_items(order_id,product_id,variant_id,quantity,unit_price,original_unit_price,currency,product_total,discount_total)
      values(v_order,v_item.product_id,v_item.variant_id,v_item.quantity,v_item.unit_price,v_item.original_unit_price,'GHS',v_item.product_total,v_item.discount_total)
      returning id into v_order_item_id;
      insert into order_stock_reservations(order_id,order_item_id,product_id,variant_id,quantity)
      values(v_order,v_order_item_id,v_item.product_id,v_item.variant_id,v_item.quantity);
    end loop;

    if v_promo_id is not null then
      v_redemption:='pr_'||replace(gen_random_uuid()::text,'-','');
      insert into promotion_redemptions(id,promotion_id,order_id,user_id,code_snapshot,discount_amount,status)
      values(v_redemption,v_promo_id,v_order,p_user_id,upper(trim(p_promo_code)),v_promo_discount,'reserved');
    end if;

    if v_flash_sale_id is not null then
      v_flash_redemption:='fsr_'||replace(gen_random_uuid()::text,'-','');
      insert into flash_sale_redemptions(id,flash_sale_id,order_id,user_id,discount_amount,status)
      values(v_flash_redemption,v_flash_sale_id,v_order,p_user_id,round(v_cart_subtotal-v_product_total,2),'reserved');
    end if;

    insert into order_commission_snapshots(order_id,product_id,merchant_id,product_total,rate_bps,commission_amount)
    select oi.order_id,oi.product_id,v_quote.merchant_id,oi.product_total,get_commission_rate_bps(v_quote.merchant_id,oi.product_id,p.category),round(oi.product_total*get_commission_rate_bps(v_quote.merchant_id,oi.product_id,p.category)/10000.0,2)
      from order_items oi join products p on p.id=oi.product_id where oi.order_id=v_order;

    select pp.provider_key into v_provider_key from payment_providers pp where pp.method=p_method and pp.status='active' order by pp.provider_key limit 1;
    if v_provider_key is null then raise exception 'No active payment provider configured for %',p_method; end if;
    v_pay:='pay_'||replace(gen_random_uuid()::text,'-','');
    insert into payments(id,order_id,user_id,amount,currency,method,status,provider_key,client_reference)
    values(v_pay,v_order,p_user_id,v_product_total+v_delivery,'GHS',p_method,'initiated',v_provider_key,v_pay);
    v_orders:=v_orders||jsonb_build_array(jsonb_build_object('orderId',v_order,'merchantId',v_quote.merchant_id,'grandTotal',v_product_total+v_delivery,'productTotal',v_product_total,'deliveryTotal',v_delivery,'promoDiscount',v_promo_discount,'promoCode',nullif(upper(trim(p_promo_code)),''),'status','payment_pending','paymentId',v_pay));
  end loop;

  if jsonb_array_length(v_orders)<1 then raise exception 'checkout produced no orders'; end if;
  return jsonb_build_object('replay',false,'groupId',v_group,'orders',v_orders);
end;
$function$;
