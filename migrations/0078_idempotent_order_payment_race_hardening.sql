-- Idempotent order/payment terminal-state race hardening.
--
-- Cancellation, expiry, and provider webhooks all serialize on the same
-- order-scoped advisory lock. A transaction that loses the race must treat
-- an already-resolved order as a harmless no-op instead of raising a state
-- transition error. This keeps retries/concurrent workers safe while
-- preserving the payment-initialization cancellation guard from 0071.

create or replace function release_order_stock(p_order_id text, p_user_id text)
returns void
language plpgsql
as $$
declare
  r record;
  v_payment record;
  v_order record;
  v_open_attempt integer;
  v_claimed_user text := current_setting('app.user_id', true);
begin
  if v_claimed_user is null or v_claimed_user <> p_user_id then
    raise exception 'unauthorized';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || p_order_id, 0));

  -- Lock and re-check the order after acquiring the same lock used by payment
  -- completion and expiry. If another transaction already resolved it, this
  -- cancellation is simply an idempotent no-op.
  select * into v_order
  from orders
  where id = p_order_id
  for update;

  if not found or v_order.user_id <> p_user_id then
    raise exception 'order not found';
  end if;

  if v_order.status <> 'payment_pending' then
    return;
  end if;

  select * into v_payment
  from payments
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'payment not found';
  end if;

  select count(*) into v_open_attempt
  from payment_attempts
  where payment_id = v_payment.id
    and status in ('initiated', 'pending', 'authorized');

  if v_open_attempt > 0 then
    raise exception 'payment is already being initialized or processed; cancellation is blocked until payment settles or fails';
  end if;

  if v_payment.status not in ('initiated', 'failed') then
    raise exception 'payment is already with the provider; cancellation is blocked until payment settles or fails';
  end if;

  for r in
    select * from order_stock_reservations
    where order_id = p_order_id and status = 'reserved'
    order by id
    for update
  loop
    if r.variant_id is not null then
      update product_variants
         set stock = stock + r.quantity, updated_at = now()
       where id = r.variant_id;
      if not found then raise exception 'reserved variant not found'; end if;
    else
      update products
         set stock = stock + r.quantity, updated_at = now()
       where id = r.product_id;
      if not found then raise exception 'reserved product not found'; end if;
    end if;

    update order_stock_reservations
       set status = 'released', released_at = now()
     where id = r.id and status = 'reserved';
  end loop;

  update orders
     set status = 'cancelled', updated_at = now()
   where id = p_order_id and status = 'payment_pending';
end;
$$;

comment on function release_order_stock(text,text) is
'Order cancellation is serialized with payment completion/expiry. Already-resolved orders are idempotent no-ops; open provider attempts remain protected.';

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
  where provider_key = p_provider_key;
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
  where provider_key = p_provider_key and event_id = p_event_id
  for update;

  if v_event.payload_hash <> p_payload_hash then
    update payment_webhook_events
       set processing_status='rejected', error_code='event_payload_mismatch', processed_at=now()
     where id=v_event.id;
    raise exception 'webhook event replay with different payload';
  end if;

  if v_event.processing_status in ('processed','ignored','rejected') then
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
       set processing_status='received', error_code='payment_not_yet_bound', processed_at=null
     where id=v_event.id;
    raise exception 'payment not yet bound';
  end if;

  if round(v_payment.amount,2) <> round(p_amount,2) or v_payment.currency <> p_currency then
    update payment_webhook_events
       set processing_status='rejected', error_code='amount_mismatch', processed_at=now()
     where id=v_event.id;
    raise exception 'payment amount mismatch';
  end if;

  -- This is the same order-scoped lock used by cancellation and expiry.
  -- Acquire it before taking the payment row lock so all order/payment state
  -- transitions use the same lock order and cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:'||v_payment.order_id,0));
  select * into v_payment from payments where id=v_payment.id for update;
  select * into v_order from orders where id=v_payment.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_payment.user_id<>v_order.user_id then raise exception 'payment/order owner mismatch'; end if;

  v_new_status:=p_status;

  -- A cancellation/expiry that already won the order-scoped race makes this
  -- webhook stale. Do not mutate the payment or reservations after the order
  -- has left payment_pending; record the webhook as ignored and return cleanly.
  if v_new_status='completed' and v_payment.status<>'completed' and v_order.status <> 'payment_pending' then
    update payment_webhook_events
       set processing_status='ignored', error_code='order_already_resolved', processed_at=now()
     where id=v_event.id;
    return jsonb_build_object(
      'duplicate',false,
      'ignored',true,
      'paymentId',v_payment.id,
      'orderId',v_order.id,
      'status',v_order.status
    );
  end if;

  if not validate_payment_transition(v_payment.status,v_new_status) then
    update payment_webhook_events
       set processing_status='rejected',error_code='invalid_state_transition',processed_at=now()
     where id=v_event.id;
    raise exception 'invalid payment state transition';
  end if;

  if v_new_status='completed' and v_payment.status<>'completed' then
    select count(*) into v_expected from order_items where order_id=v_order.id;
    update order_stock_reservations
       set status='consumed'
     where order_id=v_order.id and status='reserved';
    get diagnostics v_consumed=row_count;
    if v_consumed<>v_expected then raise exception 'reservation integrity failure'; end if;
  elsif v_new_status='refunded' then
    update order_stock_reservations
       set status='released',released_at=now()
     where order_id=v_order.id and status='consumed';
    update provider_refund_requests
       set status='processed',
           provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),
           processed_at=now(),updated_at=now()
     where payment_id=v_payment.id and status in ('requested','processing','needs_attention');
  end if;

  update payments
     set provider_reference=coalesce(p_provider_reference,provider_reference),
         status=v_new_status,updated_at=now()
   where id=v_payment.id;

  if v_payment.status<>v_new_status then
    insert into payment_state_transitions(
      payment_id,from_status,to_status,source,provider_event_id
    ) values(
      v_payment.id,v_payment.status,v_new_status,'provider_webhook',p_event_id
    );
  end if;

  if v_new_status='completed' and v_payment.status<>'completed' then
    update orders set status='paid',updated_at=now()
     where id=v_order.id and status='payment_pending';
  elsif v_new_status='refunded' then
    update orders set status='refunded',updated_at=now()
     where id=v_order.id
       and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','refund_pending');
  end if;

  update payment_webhook_events
     set processing_status=case when v_payment.status=v_new_status then 'ignored' else 'processed' end,
         processed_at=now(),error_code=null
   where id=v_event.id;

  return jsonb_build_object(
    'duplicate',false,
    'ignored',v_payment.status=v_new_status,
    'paymentId',v_payment.id,
    'orderId',v_order.id,
    'status',v_new_status
  );
end;
$$;

comment on function apply_payment_webhook(text,text,text,text,text,numeric,text,text,text) is
'Provider webhook processing serialized with cancellation/expiry. Late completion after an order is already terminal is recorded as ignored and never raises a race-condition error.';
