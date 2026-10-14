-- v1.49 real-provider deployment hardening
create table if not exists merchant_payment_accounts (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  provider_key text not null references payment_providers(provider_key) on delete restrict,
  provider_account_ref text not null,
  status text not null default 'pending' check (status in ('pending','active','suspended','rejected')),
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id,provider_key), unique(provider_key,provider_account_ref)
);
comment on column merchant_payment_accounts.provider_account_ref is 'Opaque provider identifier only; never raw bank/card credentials.';
update payment_providers set status='review' where provider_key in ('paystack','paystack-card','hubtel','hubtel-card');
create unique index if not exists payment_attempts_provider_ref_uq on payment_attempts(provider_key,provider_reference) where provider_reference is not null;

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
 select e.id,'funding_pending','credit',e.gross_amount,new.id,jsonb_build_object('paymentId',new.id,'providerKey',new.provider_key) from escrows e where e.order_id=v_order.id on conflict do nothing;
 return new;
end; $$;
drop trigger if exists payment_completed_escrow_create on payments;
create trigger payment_completed_escrow_create after update of status on payments for each row execute function create_escrow_for_completed_payment();

-- Bind real webhook effects to a payment attempt/provider reference, never to a client reference alone.
create or replace function apply_payment_webhook(p_provider_key text,p_event_id text,p_event_type text,p_provider_reference text,p_status text,p_amount numeric,p_currency text,p_payload_hash text)
returns jsonb language plpgsql as $$
declare v_event record; v_attempt record; v_payment record; v_order record; v_new_status text;
begin
 if p_provider_key is null or p_event_id is null or p_event_type is null or p_payload_hash is null or p_provider_reference is null then raise exception 'invalid webhook'; end if;
 if p_status not in ('authorized','completed','failed','refunded') then raise exception 'unsupported payment status'; end if;
 if p_currency <> 'GHS' or p_amount <= 0 then raise exception 'invalid payment amount'; end if;
 select * into v_event from payment_webhook_events where provider_key=p_provider_key and event_id=p_event_id for update;
 if found then if v_event.payload_hash<>p_payload_hash then raise exception 'webhook event replay with different payload'; end if; return jsonb_build_object('duplicate',true,'status',v_event.processing_status); end if;
 insert into payment_webhook_events(provider_key,event_id,event_type,provider_reference,payload_hash,signature_verified,processing_status) values(p_provider_key,p_event_id,p_event_type,p_provider_reference,p_payload_hash,true,'received') returning * into v_event;
 select pa.*,p.status payment_status,p.order_id payment_order_id,p.amount payment_amount,p.currency payment_currency into v_attempt from payment_attempts pa join payments p on p.id=pa.payment_id where pa.provider_key=p_provider_key and pa.provider_reference=p_provider_reference for update;
 if not found then update payment_webhook_events set processing_status='rejected',error_code='attempt_not_found',processed_at=now() where id=v_event.id; raise exception 'payment attempt not found'; end if;
 if round(v_attempt.amount,2)<>round(p_amount,2) or v_attempt.currency<>p_currency then update payment_webhook_events set processing_status='rejected',error_code='amount_mismatch',processed_at=now() where id=v_event.id; raise exception 'payment amount mismatch'; end if;
 select * into v_payment from payments where id=v_attempt.payment_id for update;
 select * into v_order from orders where id=v_payment.order_id for update;
 if p_status='authorized' then v_new_status='authorized'; elsif p_status='completed' then v_new_status='completed'; elsif p_status='failed' then v_new_status='failed'; else v_new_status='refunded'; end if;
 if v_payment.status='completed' and v_new_status in ('authorized','failed') then update payment_webhook_events set processing_status='ignored',processed_at=now() where id=v_event.id; return jsonb_build_object('ignored',true,'paymentId',v_payment.id,'status',v_payment.status); end if;
 if v_payment.status='refunded' then update payment_webhook_events set processing_status='ignored',processed_at=now() where id=v_event.id; return jsonb_build_object('ignored',true,'paymentId',v_payment.id,'status',v_payment.status); end if;
 if p_status='refunded' and v_payment.status<>'completed' then update payment_webhook_events set processing_status='rejected',error_code='invalid_refund_state',processed_at=now() where id=v_event.id; raise exception 'refund requires completed payment'; end if;
 update payments set provider_reference=p_provider_reference,status=v_new_status,updated_at=now() where id=v_payment.id;
 update payment_attempts set status=case when v_new_status='completed' then 'completed' when v_new_status='failed' then 'failed' when v_new_status='authorized' then 'authorized' else 'cancelled' end,updated_at=now() where id=v_attempt.id;
 insert into payment_state_transitions(payment_id,from_status,to_status,source,provider_event_id) values(v_payment.id,v_payment.status,v_new_status,'provider_webhook',p_event_id);
 if v_new_status='completed' then update order_stock_reservations set status='consumed' where order_id=v_order.id and status='reserved'; update orders set status='paid',updated_at=now() where id=v_order.id and status='payment_pending'; elsif v_new_status='failed' then update orders set status='payment_pending',updated_at=now() where id=v_order.id and status='payment_pending'; elsif v_new_status='refunded' then update orders set status='refunded',updated_at=now() where id=v_order.id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed'); end if;
 update payment_webhook_events set processing_status='processed',processed_at=now() where id=v_event.id;
 return jsonb_build_object('duplicate',false,'paymentId',v_payment.id,'orderId',v_order.id,'status',v_new_status);
end; $$;
