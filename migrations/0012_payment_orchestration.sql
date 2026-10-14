-- Payment orchestration hardening.
-- Payment providers are external authorities. ELEMARKET may initiate an attempt,
-- but only a verified provider event may move money/order state forward.

alter table payments add column if not exists provider_key text;
alter table payments add column if not exists client_reference text;
alter table payments add column if not exists failure_code text;
alter table payments add column if not exists failure_message text;
create unique index if not exists payments_client_reference_uq
  on payments(client_reference) where client_reference is not null;

create table if not exists payment_providers (
  id text primary key,
  provider_key text not null unique,
  name text not null check (char_length(name) between 2 and 160),
  method text not null check (method in ('mobile_money','card','bank_transfer')),
  status text not null default 'review' check (status in ('active','inactive','review')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_providers_method_idx on payment_providers(method, status);

create table if not exists payment_attempts (
  id text primary key,
  payment_id text not null references payments(id) on delete cascade,
  attempt_no integer not null check (attempt_no > 0),
  provider_key text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null check (currency = 'GHS'),
  status text not null check (status in ('initiated','pending','authorized','completed','failed','cancelled')),
  provider_reference text,
  checkout_url text,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(payment_id, attempt_no),
  unique(provider_key, provider_reference)
);
create index if not exists payment_attempts_payment_idx on payment_attempts(payment_id, attempt_no desc);

create table if not exists payment_webhook_events (
  id bigserial primary key,
  provider_key text not null,
  event_id text not null,
  event_type text not null,
  provider_reference text,
  payload_hash text not null,
  signature_verified boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received','processed','ignored','rejected')),
  error_code text,
  unique(provider_key, event_id)
);
create index if not exists payment_webhook_events_reference_idx
  on payment_webhook_events(provider_key, provider_reference);

create table if not exists payment_state_transitions (
  id bigserial primary key,
  payment_id text not null references payments(id) on delete cascade,
  from_status text,
  to_status text not null,
  source text not null check (source in ('checkout','provider_webhook','system')),
  provider_event_id text,
  created_at timestamptz not null default now()
);
create index if not exists payment_state_transitions_payment_idx
  on payment_state_transitions(payment_id, created_at desc);

insert into payment_providers(id, provider_key, name, method, status) values
  ('pp-mobile-money-external','external-mobile-money','External Mobile Money Provider','mobile_money','review'),
  ('pp-card-external','external-card','External Card Processor','card','review'),
  ('pp-bank-external','external-bank-transfer','External Bank Transfer Provider','bank_transfer','review')
on conflict (provider_key) do nothing;

-- Valid provider references must never silently collide across payment attempts.
create or replace function apply_payment_webhook(
  p_provider_key text,
  p_event_id text,
  p_event_type text,
  p_provider_reference text,
  p_status text,
  p_amount numeric,
  p_currency text,
  p_payload_hash text
) returns jsonb
language plpgsql
as $$
declare
  v_event record;
  v_payment record;
  v_order record;
  v_attempt record;
  v_new_status text;
begin
  if p_provider_key is null or p_event_id is null or p_event_type is null or p_payload_hash is null then
    raise exception 'invalid webhook';
  end if;
  if p_status not in ('authorized','completed','failed','refunded') then
    raise exception 'unsupported payment status';
  end if;
  if p_currency <> 'GHS' or p_amount <= 0 then
    raise exception 'invalid payment amount';
  end if;

  select * into v_event from payment_webhook_events
   where provider_key = p_provider_key and event_id = p_event_id
   for update;
  if found then
    if v_event.payload_hash <> p_payload_hash then
      raise exception 'webhook event replay with different payload';
    end if;
    return jsonb_build_object('duplicate', true, 'status', v_event.processing_status);
  end if;

  insert into payment_webhook_events(provider_key,event_id,event_type,provider_reference,payload_hash,signature_verified,processing_status)
  values (p_provider_key,p_event_id,p_event_type,p_provider_reference,p_payload_hash,true,'received')
  returning * into v_event;

  select p.* into v_payment
    from payments p
   where p.provider_key = p_provider_key
     and (p.provider_reference = p_provider_reference or p.client_reference = p_provider_reference)
   for update;
  if not found then
    update payment_webhook_events set processing_status='rejected', error_code='payment_not_found', processed_at=now() where id=v_event.id;
    raise exception 'payment not found';
  end if;

  if round(v_payment.amount,2) <> round(p_amount,2) or v_payment.currency <> p_currency then
    update payment_webhook_events set processing_status='rejected', error_code='amount_mismatch', processed_at=now() where id=v_event.id;
    raise exception 'payment amount mismatch';
  end if;

  select * into v_order from orders where id = v_payment.order_id for update;
  if not found then raise exception 'order not found'; end if;

  if p_status = 'authorized' then v_new_status := 'authorized';
  elsif p_status = 'completed' then v_new_status := 'completed';
  elsif p_status = 'failed' then v_new_status := 'failed';
  else v_new_status := 'refunded';
  end if;

  -- Monotonic state machine: a late failure can never overwrite a completed payment.
  if v_payment.status = 'completed' and v_new_status in ('authorized','failed') then
    update payment_webhook_events set processing_status='ignored', processed_at=now() where id=v_event.id;
    return jsonb_build_object('duplicate',false,'ignored',true,'paymentId',v_payment.id,'status',v_payment.status);
  end if;
  if v_payment.status = 'refunded' then
    update payment_webhook_events set processing_status='ignored', processed_at=now() where id=v_event.id;
    return jsonb_build_object('duplicate',false,'ignored',true,'paymentId',v_payment.id,'status',v_payment.status);
  end if;
  if p_status = 'refunded' and v_payment.status <> 'completed' then
    update payment_webhook_events set processing_status='rejected', error_code='invalid_refund_state', processed_at=now() where id=v_event.id;
    raise exception 'refund requires completed payment';
  end if;

  if p_provider_reference is not null then
    update payments set provider_reference=p_provider_reference, status=v_new_status, updated_at=now() where id=v_payment.id;
  else
    update payments set status=v_new_status, updated_at=now() where id=v_payment.id;
  end if;

  insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id)
  values (v_payment.id,v_payment.status,v_new_status,'provider_webhook',p_event_id);

  if v_new_status = 'completed' then
    update order_stock_reservations set status='consumed'
     where order_id=v_order.id and status='reserved';
    update orders set status='paid', updated_at=now() where id=v_order.id and status='payment_pending';
  elsif v_new_status = 'failed' then
    update orders set status='payment_pending', updated_at=now() where id=v_order.id and status='payment_pending';
  elsif v_new_status = 'refunded' then
    update orders set status='refunded', updated_at=now() where id=v_order.id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed');
  end if;

  update payment_webhook_events set processing_status='processed', processed_at=now() where id=v_event.id;
  return jsonb_build_object('duplicate',false,'ignored',false,'paymentId',v_payment.id,'orderId',v_order.id,'status',v_new_status);
end;
$$;
