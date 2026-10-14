-- v1.94 production actor binding and scheduler compatibility hardening.
-- Keeps the application authorization boundary while making privileged merchant
-- mutation functions independently enforce active merchant membership.

create or replace function assert_merchant_actor(
  p_actor_user_id text,
  p_merchant_id text
) returns void language plpgsql as $$
begin
  if p_actor_user_id is null or length(trim(p_actor_user_id)) < 1 then
    raise exception 'merchant identity required';
  end if;
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then
    raise exception 'merchant account required';
  end if;

  perform assert_actor_role(p_actor_user_id,'merchant');

  if not exists (
    select 1
      from merchant_accounts ma
     where ma.merchant_id=p_merchant_id
       and ma.user_id=p_actor_user_id
       and ma.status='active'
  ) then
    raise exception 'merchant actor is not an active member of this merchant account';
  end if;
end;
$$;

revoke all on function assert_merchant_actor(text,text) from public;
grant execute on function assert_merchant_actor(text,text) to current_user;

create or replace function merchant_adjust_inventory(
  p_merchant_id text,p_product_id text,p_variant_id text,p_delta integer,p_reason text,p_actor_user_id text
) returns jsonb language plpgsql as $$
declare v_product record; v_variant record; v_new_stock integer; v_id text := 'mia_'||replace(gen_random_uuid()::text,'-','');
begin
  perform assert_merchant_actor(p_actor_user_id,p_merchant_id);
  if p_delta is null or p_delta=0 or p_delta<-1000000 or p_delta>1000000 then raise exception 'invalid inventory adjustment'; end if;
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'inventory reason required'; end if;
  if p_variant_id is not null then
    select pv.*,p.merchant_id into v_variant from product_variants pv join products p on p.id=pv.product_id where pv.id=p_variant_id and pv.product_id=p_product_id and p.merchant_id=p_merchant_id for update;
    if not found then raise exception 'variant not found'; end if;
    v_new_stock:=v_variant.stock+p_delta; if v_new_stock<0 or v_new_stock>1000000 then raise exception 'inventory would become invalid'; end if;
    update product_variants set stock=v_new_stock,updated_at=now() where id=p_variant_id;
  else
    if exists(select 1 from product_variants where product_id=p_product_id and status='active') then raise exception 'adjust the active variant inventory instead of product inventory'; end if;
    select * into v_product from products where id=p_product_id and merchant_id=p_merchant_id for update;
    if not found then raise exception 'product not found'; end if;
    v_new_stock:=v_product.stock+p_delta; if v_new_stock<0 or v_new_stock>1000000 then raise exception 'inventory would become invalid'; end if;
    update products set stock=v_new_stock where id=p_product_id;
  end if;
  insert into merchant_inventory_adjustments(id,merchant_id,product_id,variant_id,delta,reason,actor_user_id) values(v_id,p_merchant_id,p_product_id,p_variant_id,p_delta,left(trim(p_reason),240),p_actor_user_id);
  perform record_audit_event('merchant.inventory.adjusted','product',p_product_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id,'variantId',p_variant_id,'delta',p_delta,'reason',left(trim(p_reason),240)));
  return jsonb_build_object('adjustmentId',v_id,'productId',p_product_id,'variantId',p_variant_id,'stock',v_new_stock);
end;
$$;

create or replace function merchant_advance_order(
  p_merchant_id text,p_order_id text,p_to_status text,p_actor_user_id text,p_note text default null
) returns jsonb language plpgsql as $$
declare v_order record; v_allowed boolean:=false; v_carrier_delivered boolean:=false;
begin
  perform assert_merchant_actor(p_actor_user_id,p_merchant_id);
  if p_to_status not in ('confirmed','fulfilling','shipped','delivered','completed') then raise exception 'invalid merchant order status'; end if;
  select * into v_order from orders where id=p_order_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'order not found'; end if;
  v_allowed:=(v_order.status,p_to_status) in (('paid','confirmed'),('confirmed','fulfilling'),('fulfilling','shipped'),('shipped','delivered'),('delivered','completed'));
  if not v_allowed then raise exception 'invalid order status transition'; end if;
  if p_to_status='delivered' then
    select exists(
      select 1 from shipments s
      join shipment_items si on si.shipment_id=s.id
      join shipment_events se on se.shipment_id=s.id and se.event_type='delivered'
      where s.order_id=v_order.id and s.merchant_id=v_order.merchant_id and s.status='delivered'
    ) into v_carrier_delivered;
    if not v_carrier_delivered and v_order.delivery_confirmation_source is distinct from 'customer_confirmation' then
      raise exception 'delivery must be confirmed by the customer or a verified carrier event';
    end if;
  end if;
  update orders set status=p_to_status,updated_at=now() where id=p_order_id;
  insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note)
  values(p_order_id,p_merchant_id,v_order.status,p_to_status,p_actor_user_id,nullif(left(trim(coalesce(p_note,'')),500),''));
  perform record_audit_event('merchant.order.status_changed','order',p_order_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id,'from',v_order.status,'to',p_to_status,'deliveryProof',case when p_to_status='delivered' then case when v_carrier_delivered then 'carrier_webhook' else 'customer_confirmation' end else null end));
  return jsonb_build_object('orderId',p_order_id,'fromStatus',v_order.status,'status',p_to_status);
end;
$$;

comment on function assert_merchant_actor(text,text) is 'Defense-in-depth merchant actor binding: requires merchant role and active membership in the target merchant account.';
comment on function merchant_adjust_inventory(text,text,text,integer,text,text) is 'Merchant inventory mutation with active merchant-account membership enforcement.';
comment on function merchant_advance_order(text,text,text,text,text) is 'Merchant order transition with active merchant-account membership and delivery-proof enforcement.';
