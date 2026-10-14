-- v1.88 production financial-flow hardening.
-- Customer cancellation/refund must be an explicit early-order transition.
-- Provider refunds are full-amount in the current contract; partial refunds are
-- not silently accepted as fully processed.

create or replace function prepare_provider_refund_for_payment(
  p_payment_id text,
  p_actor_id text,
  p_reason text default 'customer_order_cancellation'
) returns jsonb language plpgsql as $$
declare
  v_payment record;
  v_order record;
  v_existing record;
  v_request text := 'prr_'||replace(gen_random_uuid()::text,'-','');
begin
  if p_payment_id is null or length(trim(p_payment_id)) < 1 then raise exception 'payment required'; end if;
  if p_actor_id is null or length(trim(p_actor_id)) < 1 then raise exception 'actor identity required'; end if;

  select * into v_payment from payments where id=p_payment_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.status <> 'completed' then raise exception 'only completed payments can be refunded'; end if;
  if v_payment.provider_reference is null then raise exception 'payment has no provider reference'; end if;

  select * into v_order from orders where id=v_payment.order_id and payment_id=v_payment.id for update;
  if not found then raise exception 'payment/order binding mismatch'; end if;

  -- Customer cancellation is intentionally limited to the same early states
  -- exposed by the customer UI. Later fulfillment/dispute states require the
  -- dedicated dispute/provider-refund workflow instead.
  if v_order.status not in ('paid','confirmed') then
    raise exception 'order is not cancellable in its current state';
  end if;

  select * into v_existing
    from provider_refund_requests
   where payment_id=v_payment.id
     and status in ('requested','processing','needs_attention','processed')
   order by requested_at desc
   limit 1
   for update;
  if found then
    return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'existing',true);
  end if;

  insert into provider_refund_requests(
    id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,reason,requested_by
  ) values(
    v_request,v_payment.id,v_payment.order_id,v_payment.provider_key,v_payment.provider_reference,
    v_payment.amount,v_payment.currency,'requested',left(trim(coalesce(p_reason,'')),200),p_actor_id
  );

  update orders
     set status='refund_pending',updated_at=now()
   where id=v_order.id and status in ('paid','confirmed');
  if not found then raise exception 'order changed before refund request'; end if;

  return jsonb_build_object('requestId',v_request,'status','requested','existing',false);
end;
$$;

comment on function prepare_provider_refund_for_payment(text,text,text) is
  'Prepares a provider-managed full refund only for paid/confirmed orders. Later order states require the dispute/provider-refund workflow.';
