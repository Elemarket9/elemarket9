-- Verified external charges remain evidence even when fulfillment has ended.
-- No funds are held or released here. A reconciliation case requires provider/operator resolution.
create table payment_provider_evidence (
  provider_key text not null,
  event_id text not null,
  payment_id text not null references payments(id) on delete restrict,
  provider_reference text not null,
  event_type text not null,
  amount numeric(12,2) not null check(amount>0),
  currency text not null check(currency='GHS'),
  payload_hash text not null,
  recorded_at timestamptz not null default now(),
  primary key(provider_key,event_id)
);
create function prevent_payment_evidence_change() returns trigger language plpgsql as $$
begin raise exception 'provider payment evidence is immutable'; end; $$;
create trigger payment_provider_evidence_immutable before update or delete on payment_provider_evidence
for each row execute function prevent_payment_evidence_change();

alter table marketplace_reconciliation_cases add column dedupe_key text;
create unique index marketplace_reconciliation_dedupe_uq on marketplace_reconciliation_cases(dedupe_key) where dedupe_key is not null;

create table payment_webhook_rejections (
  provider_key text not null, event_id text not null, payload_hash text not null,
  error_code text not null, rejected_at timestamptz not null default now(),
  primary key(provider_key,event_id,payload_hash,error_code)
);
create function reject_payment_webhook(p_provider text,p_event text,p_hash text,p_error text)
returns jsonb language plpgsql as $$
begin
  insert into payment_webhook_rejections(provider_key,event_id,payload_hash,error_code)
  values(p_provider,p_event,p_hash,p_error) on conflict do nothing;
  return jsonb_build_object('rejected',true,'errorCode',p_error);
end; $$;
revoke all on function reject_payment_webhook(text,text,text,text) from public;

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
  elsif v_new_status='refunded' then
    update order_stock_reservations
       set status='released',released_at=now()
     where order_id=v_order.id and status='consumed';
  end if;

  update payments
     set provider_reference=coalesce(p_provider_reference,provider_reference),status=v_new_status,updated_at=now()
   where id=v_payment.id;

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


-- Recover cases already ignored by the old implementation. Do not invent a refund
-- or change payment state without a fresh provider confirmation; surface durable work.
insert into marketplace_reconciliation_cases(id,merchant_id,order_id,external_reference,case_type,severity,dedupe_key,details)
select distinct on (p.id) 'mrc_'||replace(gen_random_uuid()::text,'-',''),o.merchant_id,o.id,e.provider_reference,'payment','high',
  'late-payment:'||p.id,jsonb_build_object('reason','late_successful_payment','paymentId',p.id,'providerKey',e.provider_key,
    'providerReference',e.provider_reference,'eventId',e.event_id,'payloadHash',e.payload_hash,
    'historical',true,'resolution','reverify_with_provider_before_resolution')
from payment_webhook_events e join payment_attempts pa on pa.provider_key=e.provider_key and pa.provider_reference=e.provider_reference
join payments p on p.id=pa.payment_id join orders o on o.id=p.order_id
where e.processing_status='ignored' and e.error_code='order_already_resolved' and e.signature_verified
  and o.status='cancelled' and p.status<>'refunded'
order by p.id,e.received_at
on conflict(dedupe_key) where dedupe_key is not null do nothing;
