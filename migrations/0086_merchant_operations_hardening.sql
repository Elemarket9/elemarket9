-- Merchant operations control plane.
-- All inventory/order mutations are database-authoritative and ownership-scoped by merchant_id.

create table if not exists merchant_inventory_adjustments (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  product_id text not null references products(id) on delete cascade,
  variant_id text references product_variants(id) on delete cascade,
  delta integer not null check (delta <> 0 and delta between -1000000 and 1000000),
  reason text not null check (char_length(trim(reason)) between 3 and 240),
  actor_user_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists merchant_inventory_adjustments_merchant_idx
  on merchant_inventory_adjustments(merchant_id, created_at desc);
create index if not exists merchant_inventory_adjustments_product_idx
  on merchant_inventory_adjustments(product_id, created_at desc);

create table if not exists merchant_order_status_history (
  id bigserial primary key,
  order_id text not null references orders(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  actor_user_id text not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists merchant_order_status_history_order_idx
  on merchant_order_status_history(order_id, created_at desc);

create or replace function merchant_adjust_inventory(
  p_merchant_id text,
  p_product_id text,
  p_variant_id text,
  p_delta integer,
  p_reason text,
  p_actor_user_id text
) returns jsonb language plpgsql as $$
declare
  v_product record;
  v_variant record;
  v_new_stock integer;
  v_id text := 'mia_'||replace(gen_random_uuid()::text,'-','');
begin
  if p_delta is null or p_delta = 0 or p_delta < -1000000 or p_delta > 1000000 then raise exception 'invalid inventory adjustment'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'inventory reason required'; end if;
  if p_actor_user_id is null then raise exception 'merchant identity required'; end if;

  if p_variant_id is not null then
    select pv.*, p.merchant_id into v_variant
      from product_variants pv join products p on p.id=pv.product_id
     where pv.id=p_variant_id and pv.product_id=p_product_id and p.merchant_id=p_merchant_id
     for update;
    if not found then raise exception 'variant not found'; end if;
    v_new_stock := v_variant.stock + p_delta;
    if v_new_stock < 0 or v_new_stock > 1000000 then raise exception 'inventory would become invalid'; end if;
    update product_variants set stock=v_new_stock, updated_at=now() where id=p_variant_id;
  else
    if exists(select 1 from product_variants where product_id=p_product_id and status='active') then
      raise exception 'adjust the active variant inventory instead of product inventory';
    end if;
    select * into v_product from products where id=p_product_id and merchant_id=p_merchant_id for update;
    if not found then raise exception 'product not found'; end if;
    v_new_stock := v_product.stock + p_delta;
    if v_new_stock < 0 or v_new_stock > 1000000 then raise exception 'inventory would become invalid'; end if;
    update products set stock=v_new_stock where id=p_product_id;
  end if;

  insert into merchant_inventory_adjustments(id,merchant_id,product_id,variant_id,delta,reason,actor_user_id)
  values(v_id,p_merchant_id,p_product_id,p_variant_id,p_delta,left(trim(p_reason),240),p_actor_user_id);
  perform record_audit_event('merchant.inventory.adjusted','product',p_product_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id,'variantId',p_variant_id,'delta',p_delta,'reason',left(trim(p_reason),240)));
  return jsonb_build_object('adjustmentId',v_id,'productId',p_product_id,'variantId',p_variant_id,'stock',v_new_stock);
end;
$$;

create or replace function merchant_advance_order(
  p_merchant_id text,
  p_order_id text,
  p_to_status text,
  p_actor_user_id text,
  p_note text default null
) returns jsonb language plpgsql as $$
declare
  v_order record;
  v_allowed boolean := false;
begin
  if p_to_status not in ('confirmed','fulfilling','shipped','delivered','completed') then raise exception 'invalid merchant order status'; end if;
  select * into v_order from orders where id=p_order_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'order not found'; end if;

  v_allowed := (v_order.status,p_to_status) in (
    ('paid','confirmed'),('confirmed','fulfilling'),('fulfilling','shipped'),
    ('shipped','delivered'),('delivered','completed')
  );
  if not v_allowed then raise exception 'invalid order status transition'; end if;

  update orders set status=p_to_status, updated_at=now() where id=p_order_id;
  insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note)
  values(p_order_id,p_merchant_id,v_order.status,p_to_status,p_actor_user_id,nullif(left(trim(coalesce(p_note,'')),500),''));
  perform record_audit_event('merchant.order.status_changed','order',p_order_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id,'from',v_order.status,'to',p_to_status));
  return jsonb_build_object('orderId',p_order_id,'fromStatus',v_order.status,'status',p_to_status);
end;
$$;
