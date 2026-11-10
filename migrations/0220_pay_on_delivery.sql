-- Pay on delivery: mobile money at the door.
--
-- The customer chooses to pay when the parcel arrives. The order is confirmed and
-- dispatched without upfront payment; its stock stays reserved. At the door the
-- rider (or pickup attendant) asks the payment provider to send a mobile money
-- approval prompt to the customer's verified phone. The provider's signed
-- webhook completes the payment through the normal path, and only then can the
-- OTP handover happen. Funds go straight to the payment provider: neither
-- ELEMARKET nor the rider ever holds cash.
--
-- Abuse limits (staff-adjustable): feature switch, maximum order value, maximum
-- open pay-on-delivery orders per customer, and refused deliveries after which a
-- customer can no longer choose pay on delivery.

alter table orders add column if not exists payment_timing text not null default 'upfront';
alter table orders drop constraint if exists orders_payment_timing_check;
alter table orders add constraint orders_payment_timing_check check (payment_timing in ('upfront','on_delivery'));
create index if not exists orders_pay_on_delivery_user on orders(user_id, status) where payment_timing = 'on_delivery';

create table if not exists pay_on_delivery_policy (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  max_order_amount numeric(12,2) not null default 2000.00 check (max_order_amount > 0),
  max_open_orders integer not null default 2 check (max_open_orders between 1 and 20),
  max_refused_deliveries integer not null default 2 check (max_refused_deliveries between 1 and 20),
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into pay_on_delivery_policy(id) values (true) on conflict (id) do nothing;

-- Refused = a pay-on-delivery order cancelled after it was dispatched, unpaid.
create or replace function elemarket_pay_on_delivery_refusals(p_user_id text) returns integer
language sql stable as $$
  select count(*)::int from orders o
   where o.user_id = p_user_id and o.payment_timing = 'on_delivery' and o.status = 'cancelled'
     and exists(select 1 from delivery_jobs j where j.order_id = o.id)
     and not exists(select 1 from payments p where p.order_id = o.id and p.status in ('completed','refunded'))
$$;

-- Whether this customer may choose pay on delivery, and why not.
create or replace function elemarket_pay_on_delivery_eligibility(p_user_id text) returns jsonb
language plpgsql stable as $$
declare v_policy pay_on_delivery_policy; v_open integer;
begin
  select * into v_policy from pay_on_delivery_policy where id;
  if not v_policy.enabled then return jsonb_build_object('eligible',false,'reason','Pay on delivery is not available yet'); end if;
  if not exists(select 1 from profiles where user_id=p_user_id and phone ~ '^\+233[25][0-9]{8}$' and phone_verified_at is not null) then
    return jsonb_build_object('eligible',false,'reason','Verify your phone number to pay on delivery'); end if;
  if elemarket_pay_on_delivery_refusals(p_user_id) >= v_policy.max_refused_deliveries then
    return jsonb_build_object('eligible',false,'reason','Pay on delivery is unavailable after refused deliveries; please pay online'); end if;
  select count(*) into v_open from orders o
   where o.user_id=p_user_id and o.payment_timing='on_delivery' and o.status in ('confirmed','fulfilling','shipped')
     and not exists(select 1 from payments p where p.order_id=o.id and p.status='completed');
  if v_open >= v_policy.max_open_orders then
    return jsonb_build_object('eligible',false,'reason','You have unpaid pay-on-delivery orders on the way'); end if;
  return jsonb_build_object('eligible',true,'maxOrderAmount',v_policy.max_order_amount::text,'openOrders',v_open,
                            'maxOpenOrders',v_policy.max_open_orders);
end $$;

-- Called in the checkout transaction right after create_pending_order.
create or replace function choose_pay_on_delivery(p_user_id text, p_group_id text) returns jsonb
language plpgsql as $$
declare v_policy pay_on_delivery_policy; v_elig jsonb; v_order record; v_count integer := 0; v_open integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('elemarket:pay-on-delivery:' || p_user_id, 0));
  select * into v_policy from pay_on_delivery_policy where id;
  v_elig := elemarket_pay_on_delivery_eligibility(p_user_id);
  if not (v_elig->>'eligible')::boolean then raise exception '%', v_elig->>'reason'; end if;
  v_open := (v_elig->>'openOrders')::int;
  for v_order in
    select o.* from orders o where o.group_id=p_group_id and o.user_id=p_user_id order by o.id for update
  loop
    if v_order.status <> 'payment_pending' or v_order.payment_timing <> 'upfront' then raise exception 'order is not awaiting a payment choice'; end if;
    if v_order.grand_total > v_policy.max_order_amount then
      raise exception 'Pay on delivery is limited to GHS % per order', v_policy.max_order_amount; end if;
    if not exists(select 1 from payments p where p.order_id=v_order.id and p.status='initiated' and p.method='mobile_money') then
      raise exception 'pay on delivery requires a mobile money payment'; end if;
    if exists(select 1 from payments p join payment_attempts a on a.payment_id=p.id where p.order_id=v_order.id) then
      raise exception 'payment has already been started online'; end if;
    v_count := v_count + 1;
    if v_open + v_count > v_policy.max_open_orders then raise exception 'You have unpaid pay-on-delivery orders on the way'; end if;
    update orders set payment_timing='on_delivery', status='confirmed', payment_deadline=null, updated_at=now() where id=v_order.id;
    perform record_audit_event('order.pay_on_delivery.chosen','order',v_order.id,p_user_id,'customer',null,'success',
      jsonb_build_object('groupId',p_group_id,'amount',v_order.grand_total::text));
  end loop;
  if v_count = 0 then raise exception 'order group not found'; end if;
  return jsonb_build_object('orders',v_count,'paymentTiming','on_delivery');
end $$;

-- No handover of an unpaid pay-on-delivery parcel: not the OTP request, not the
-- OTP verification, and not the order's delivered status.
create or replace function elemarket_pay_on_delivery_paid(p_order_id text) returns boolean
language sql stable as $$
  select not exists(select 1 from orders where id=p_order_id and payment_timing='on_delivery')
      or exists(select 1 from payments where order_id=p_order_id and status='completed')
$$;
create or replace function elemarket_guard_pay_on_delivery_handover() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'delivery_handover_requests' then
    if new.state = 'issuing' and not elemarket_pay_on_delivery_paid(new.order_id) then
      raise exception 'collect the mobile money payment before the handover code'; end if;
  elsif tg_table_name = 'order_delivery_handover' then
    if new.verified_at is not null and (tg_op='INSERT' or old.verified_at is null) and not elemarket_pay_on_delivery_paid(new.order_id) then
      raise exception 'collect the mobile money payment before handover'; end if;
  elsif tg_table_name = 'orders' then
    if new.status in ('delivered','completed') and old.status is distinct from new.status and not elemarket_pay_on_delivery_paid(new.id) then
      raise exception 'unpaid pay-on-delivery order cannot be delivered'; end if;
  end if;
  return new;
end $$;
drop trigger if exists pay_on_delivery_handover_request_gate on delivery_handover_requests;
create trigger pay_on_delivery_handover_request_gate before insert or update on delivery_handover_requests
  for each row execute function elemarket_guard_pay_on_delivery_handover();
drop trigger if exists pay_on_delivery_handover_gate on order_delivery_handover;
create trigger pay_on_delivery_handover_gate before insert or update on order_delivery_handover
  for each row execute function elemarket_guard_pay_on_delivery_handover();
drop trigger if exists pay_on_delivery_delivered_gate on orders;
create trigger pay_on_delivery_delivered_gate before update of status on orders
  for each row execute function elemarket_guard_pay_on_delivery_handover();

-- Refused or undeliverable: when the parcel is back with the merchant (job
-- 'returned'), an unpaid pay-on-delivery order is
-- cancelled, its stock goes back on sale and promotion/flash-sale use is released.
create or replace function cancel_unpaid_pay_on_delivery_order(p_order_id text, p_reason text) returns boolean
language plpgsql as $$
declare v_order record; q record;
begin
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || p_order_id, 0));
  select * into v_order from orders where id=p_order_id for update;
  if not found or v_order.payment_timing <> 'on_delivery' or v_order.status not in ('confirmed','fulfilling','shipped') then return false; end if;
  if exists(select 1 from payments where order_id=p_order_id and status in ('completed','authorized','refunded')) then return false; end if;
  -- A prompt the customer may still approve must settle first.
  if exists(select 1 from payments p join payment_attempts a on a.payment_id=p.id
             where p.order_id=p_order_id and a.status in ('initiated','pending','authorized')) then
    raise exception 'a mobile money prompt is still open; wait for it to finish'; end if;
  perform elemarket_restore_reservation_stock(p_order_id, 'reserved');
  for q in
    select fsi.id, oi.quantity from flash_sale_redemptions fsr
      join flash_sale_items fsi on fsi.flash_sale_id=fsr.flash_sale_id
      join order_items oi on oi.order_id=p_order_id and oi.product_id=fsi.product_id
        and ((fsi.variant_id is not null and oi.variant_id=fsi.variant_id) or (fsi.variant_id is null and oi.variant_id is null))
     where fsr.order_id=p_order_id and fsr.status='consumed' for update of fsi
  loop
    update flash_sale_items set sold_quantity=greatest(sold_quantity-q.quantity,0), updated_at=now() where id=q.id;
  end loop;
  update flash_sale_redemptions set status='released', released_at=coalesce(released_at,now()) where order_id=p_order_id and status='consumed';
  update promotion_redemptions set status='released', released_at=coalesce(released_at,now()) where order_id=p_order_id and status='applied';
  update payments set status='failed', updated_at=now() where order_id=p_order_id and status='initiated';
  update orders set status='cancelled', updated_at=now() where id=p_order_id;
  perform record_audit_event('order.pay_on_delivery.refused','order',p_order_id,null,'system',null,'success',
    jsonb_build_object('reason',left(coalesce(p_reason,''),500)));
  return true;
end $$;
create or replace function elemarket_pay_on_delivery_job_closed() returns trigger language plpgsql as $$
begin
  if new.status = 'returned' and old.status is distinct from new.status then
    perform cancel_unpaid_pay_on_delivery_order(new.order_id, 'delivery job ' || new.status);
  end if;
  return new;
end $$;
drop trigger if exists pay_on_delivery_job_closed on delivery_jobs;
create trigger pay_on_delivery_job_closed after update of status on delivery_jobs
  for each row execute function elemarket_pay_on_delivery_job_closed();

-- Payment webhooks. Same as 0214 except two pay-on-delivery rules:
--  * completion is accepted while the order is confirmed/fulfilling/shipped, and
--    the order keeps its fulfilment status (it is not moved back to 'paid');
--  * a failed prompt fails only that attempt, so the rider can prompt again.
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
    -- Pay on delivery: a declined or expired prompt at the door fails only that
    -- attempt. The payment stays startable so the rider can prompt again, and the
    -- order (already dispatched) is not cancelled.
    if p_status='failed' and v_order.payment_timing='on_delivery' and v_order.status<>'payment_pending'
       and v_payment.status='initiated' then
      update payment_attempts set status='failed',updated_at=now()
       where payment_id=v_payment.id and provider_key=p_provider_key and provider_reference=p_provider_reference
         and status in ('initiated','pending','authorized');
      update payment_webhook_events set processing_status='processed',error_code=null,processed_at=now() where id=v_event.id;
      return jsonb_build_object('duplicate',false,'paymentId',v_payment.id,'orderId',v_order.id,'status','initiated','attemptFailed',true);
    end if;
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
    if v_payment.status<>'completed' and v_order.status<>'payment_pending'
       and not (v_order.payment_timing='on_delivery' and v_order.status in ('confirmed','fulfilling','shipped')) then
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
