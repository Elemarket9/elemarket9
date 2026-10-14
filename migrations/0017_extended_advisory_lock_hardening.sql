-- ELEMARKET v1.38.0: widen concurrency lock keys from 32-bit hashtext to
-- PostgreSQL's 64-bit hashtextextended. This reduces unrelated-key lock
-- collisions while preserving the existing order/payment lock domains.
--
-- IMPORTANT: 0016 remains immutable. These replacements are intentionally
-- isolated in a new migration so already-applied migration history remains
-- reproducible.

create or replace function release_order_stock(p_order_id text, p_user_id text)
returns void language plpgsql as $$
declare
  v_claimed_user text := current_setting('app.user_id', true);
  r record;
begin
  if v_claimed_user is null or v_claimed_user <> p_user_id then raise exception 'unauthorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || p_order_id, 0));
  if not exists (select 1 from orders where id = p_order_id and user_id = p_user_id) then raise exception 'order not found'; end if;
  for r in select * from order_stock_reservations where order_id = p_order_id and status = 'reserved' order by id for update loop
    if r.variant_id is not null then
      update product_variants set stock = stock + r.quantity, updated_at = now() where id = r.variant_id;
    else
      update products set stock = stock + r.quantity where id = r.product_id;
    end if;
    update order_stock_reservations set status = 'released', released_at = now() where id = r.id and status = 'reserved';
  end loop;
  update orders set status = 'cancelled', updated_at = now() where id = p_order_id and status = 'payment_pending';
end;
$$;

create or replace function expire_payment_pending_orders(p_limit integer default 100)
returns integer language plpgsql as $$
declare
  r record;
  v_count integer := 0;
  v_res record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then raise exception 'invalid expiry batch size'; end if;
  for r in
    select id from orders
     where status = 'payment_pending' and payment_deadline is not null and payment_deadline <= now()
     order by payment_deadline, id limit p_limit for update skip locked
  loop
    perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || r.id, 0));
    if not exists (select 1 from orders where id = r.id and status = 'payment_pending' and payment_deadline is not null and payment_deadline <= now()) then continue; end if;
    for v_res in select * from order_stock_reservations where order_id = r.id and status = 'reserved' order by id for update loop
      if v_res.variant_id is not null then
        update product_variants set stock = stock + v_res.quantity, updated_at = now() where id = v_res.variant_id;
      else
        update products set stock = stock + v_res.quantity where id = v_res.product_id;
      end if;
      update order_stock_reservations set status = 'released', released_at = now() where id = v_res.id and status = 'reserved';
    end loop;
    update orders set status = 'cancelled', updated_at = now() where id = r.id and status = 'payment_pending';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

-- Reuse the exact v1.37 payment webhook state machine, changing only its
-- order-scoped lock primitive to the 64-bit lock key.
create or replace function apply_payment_webhook(
  p_provider_key text, p_event_id text, p_event_type text, p_provider_reference text,
  p_status text, p_amount numeric, p_currency text, p_payload_hash text
) returns jsonb language plpgsql as $$
declare
  v_event record; v_payment record; v_order record; v_provider record;
  v_new_status text; v_consumed integer; v_expected integer;
begin
  if p_provider_key is null or p_event_id is null or p_event_type is null or p_payload_hash is null then raise exception 'invalid webhook'; end if;
  if p_status not in ('authorized','completed','failed','refunded') then raise exception 'unsupported payment status'; end if;
  if p_currency <> 'GHS' or p_amount is null or p_amount <= 0 then raise exception 'invalid payment amount'; end if;
  select provider_key, status into v_provider from payment_providers where provider_key = p_provider_key;
  if not found or v_provider.status <> 'active' then raise exception 'payment provider is not active'; end if;
  insert into payment_webhook_events(provider_key,event_id,event_type,provider_reference,payload_hash,signature_verified,processing_status)
  values (p_provider_key,p_event_id,p_event_type,p_provider_reference,p_payload_hash,true,'received')
  on conflict (provider_key,event_id) do nothing;
  select * into v_event from payment_webhook_events where provider_key = p_provider_key and event_id = p_event_id for update;
  if v_event.payload_hash <> p_payload_hash then
    update payment_webhook_events set processing_status='rejected', error_code='event_payload_mismatch', processed_at=now() where id=v_event.id;
    raise exception 'webhook event replay with different payload';
  end if;
  if v_event.processing_status in ('processed','ignored','rejected') then
    return jsonb_build_object('duplicate', true, 'status', v_event.processing_status);
  end if;
  select p.* into v_payment from payments p
   where p.provider_key = p_provider_key and p.provider_reference is not null and p.provider_reference = p_provider_reference for update;
  if not found then
    update payment_webhook_events set processing_status='rejected', error_code='payment_not_found', processed_at=now() where id=v_event.id;
    raise exception 'payment not found';
  end if;
  if round(v_payment.amount,2) <> round(p_amount,2) or v_payment.currency <> p_currency then
    update payment_webhook_events set processing_status='rejected', error_code='amount_mismatch', processed_at=now() where id=v_event.id;
    raise exception 'payment amount mismatch';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || v_payment.order_id, 0));
  select * into v_order from orders where id = v_payment.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_payment.user_id <> v_order.user_id then raise exception 'payment/order owner mismatch'; end if;
  v_new_status := p_status;
  if not validate_payment_transition(v_payment.status, v_new_status) then
    update payment_webhook_events set processing_status='rejected', error_code='invalid_state_transition', processed_at=now() where id=v_event.id;
    raise exception 'invalid payment state transition';
  end if;
  if v_new_status = 'completed' and v_payment.status <> 'completed' then
    if v_order.status <> 'payment_pending' then
      update payment_webhook_events set processing_status='rejected', error_code='order_not_payment_pending', processed_at=now() where id=v_event.id;
      raise exception 'order is not payment pending';
    end if;
    select count(*) into v_expected from order_items where order_id = v_order.id;
    update order_stock_reservations set status='consumed' where order_id=v_order.id and status='reserved';
    get diagnostics v_consumed = row_count;
    if v_consumed <> v_expected then raise exception 'reservation integrity failure'; end if;
  end if;
  update payments set provider_reference=coalesce(p_provider_reference, provider_reference), status=v_new_status, updated_at=now() where id=v_payment.id;
  if v_payment.status <> v_new_status then
    insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
    values (v_payment.id,v_payment.status,v_new_status,'provider_webhook',p_event_id);
  end if;
  if v_new_status = 'completed' and v_payment.status <> 'completed' then
    update orders set status='paid', updated_at=now() where id=v_order.id and status='payment_pending';
  elsif v_new_status = 'refunded' then
    update orders set status='refunded', updated_at=now() where id=v_order.id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed');
  end if;
  update payment_webhook_events set processing_status=case when v_payment.status = v_new_status then 'ignored' else 'processed' end, processed_at=now() where id=v_event.id;
  return jsonb_build_object('duplicate',false,'ignored',v_payment.status = v_new_status,'paymentId',v_payment.id,'orderId',v_order.id,'status',v_new_status);
end;
$$;

create or replace function create_payment_attempt(
  p_payment_id text, p_provider_key text, p_amount numeric, p_currency text,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql as $$
declare
  v_payment record; v_provider record; v_attempt_no integer; v_attempt_id text;
begin
  if p_payment_id is null or p_provider_key is null or p_amount is null or p_amount <= 0 or p_currency <> 'GHS' then raise exception 'invalid payment attempt'; end if;
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.provider_key <> p_provider_key then raise exception 'payment provider mismatch'; end if;
  if round(v_payment.amount,2) <> round(p_amount,2) or v_payment.currency <> p_currency then raise exception 'payment amount mismatch'; end if;
  if v_payment.status <> 'initiated' then raise exception 'payment is not startable'; end if;
  select provider_key, status into v_provider from payment_providers where provider_key = p_provider_key;
  if not found or v_provider.status <> 'active' then raise exception 'payment provider is not active'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:payment-attempt:' || p_payment_id, 0));
  select coalesce(max(attempt_no),0) + 1 into v_attempt_no from payment_attempts where payment_id = p_payment_id;
  v_attempt_id := 'pat_' || replace(gen_random_uuid()::text, '-', '');
  insert into payment_attempts(id,payment_id,attempt_no,provider_key,amount,currency,status,metadata)
  values (v_attempt_id,p_payment_id,v_attempt_no,p_provider_key,p_amount,p_currency,'initiated',coalesce(p_metadata,'{}'::jsonb));
  return jsonb_build_object('paymentId',p_payment_id,'attemptId',v_attempt_id,'attemptNo',v_attempt_no,'status','initiated');
end;
$$;
