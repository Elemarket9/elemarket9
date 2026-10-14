-- v1.90: provider refund retry and actor-bound execution hardening.
-- A provider-confirmed refund failure is retryable without recreating a second
-- refund record. Customer-originated requests remain customer-owned; admins may
-- retry through the separately authenticated admin path.

create or replace function prepare_provider_refund_for_payment(
  p_payment_id text,
  p_actor_id text,
  p_reason text default 'customer_order_cancellation'
) returns jsonb language plpgsql as $$
declare
  v_payment record;
  v_order record;
  v_existing record;
  v_actor_role text;
  v_request text := 'prr_'||replace(gen_random_uuid()::text,'-','');
begin
  if p_payment_id is null or length(trim(p_payment_id)) < 1 then raise exception 'payment required'; end if;
  if p_actor_id is null or length(trim(p_actor_id)) < 1 then raise exception 'actor identity required'; end if;

  select role into v_actor_role from "user" where id=p_actor_id;
  if v_actor_role is null then raise exception 'actor not found'; end if;

  select * into v_payment from payments where id=p_payment_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.status <> 'completed' then raise exception 'only completed payments can be refunded'; end if;
  if v_payment.provider_reference is null then raise exception 'payment has no provider reference'; end if;

  select * into v_order from orders where id=v_payment.order_id and payment_id=v_payment.id for update;
  if not found then raise exception 'payment/order binding mismatch'; end if;

  select * into v_existing
    from provider_refund_requests
   where payment_id=v_payment.id
     and status in ('requested','processing','needs_attention','failed','processed')
   order by requested_at desc
   limit 1
   for update;

  if found then
    if v_existing.requested_by is distinct from p_actor_id and v_actor_role <> 'admin' then
      raise exception 'refund request is not owned by this customer';
    end if;
    if v_existing.status = 'failed' then
      update provider_refund_requests
         set status='requested', reason=coalesce(nullif(left(trim(coalesce(p_reason,'')),200),''),reason), updated_at=now()
       where id=v_existing.id and status='failed';
      return jsonb_build_object('requestId',v_existing.id,'status','requested','existing',true,'retry',true);
    end if;
    return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'existing',true);
  end if;

  -- New customer cancellation requests are limited to early paid states.
  if v_order.status not in ('paid','confirmed') then
    raise exception 'order is not cancellable in its current state';
  end if;

  insert into provider_refund_requests(
    id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,reason,requested_by
  ) values(
    v_request,v_payment.id,v_payment.order_id,v_payment.provider_key,v_payment.provider_reference,
    v_payment.amount,v_payment.currency,'requested',left(trim(coalesce(p_reason,'')),200),p_actor_id
  );

  update orders set status='refund_pending',updated_at=now()
   where id=v_order.id and status in ('paid','confirmed');
  if not found then raise exception 'order changed before refund request'; end if;

  return jsonb_build_object('requestId',v_request,'status','requested','existing',false);
end;
$$;

revoke all on function prepare_provider_refund_for_payment(text,text,text) from public;
