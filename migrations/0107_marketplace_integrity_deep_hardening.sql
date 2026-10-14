-- v1.77: marketplace data-integrity and privileged-operation hardening.
-- Defense in depth for high-risk marketplace invariants.

create or replace function assert_actor_role(p_actor_id text, p_required_role text)
returns void language plpgsql as $$
declare v_role text;
begin
  if p_actor_id is null or length(trim(p_actor_id)) < 1 then raise exception 'actor identity required'; end if;
  select role into v_role from "user" where id=p_actor_id;
  if v_role is distinct from p_required_role then raise exception 'required actor role not satisfied'; end if;
end;
$$;

create or replace function validate_order_graph_integrity()
returns trigger language plpgsql as $$
declare v_group_user text; v_quote record; v_product_merchant text; v_variant_product text;
begin
  select user_id into v_group_user from order_groups where id=new.group_id;
  if v_group_user is null or v_group_user<>new.user_id then raise exception 'order/group customer mismatch'; end if;
  select id,user_id,merchant_id,expires_at into v_quote from delivery_quotes where id=new.delivery_quote_id;
  if not found or v_quote.user_id<>new.user_id or v_quote.merchant_id<>new.merchant_id then raise exception 'order/delivery quote mismatch'; end if;
  if v_quote.expires_at < new.created_at then raise exception 'order references expired delivery quote'; end if;
  return new;
end;
$$;

drop trigger if exists orders_graph_integrity on orders;
create constraint trigger orders_graph_integrity
after insert or update of group_id,user_id,merchant_id,delivery_quote_id,created_at on orders
deferrable initially immediate
for each row execute function validate_order_graph_integrity();

create or replace function validate_order_item_graph_integrity()
returns trigger language plpgsql as $$
declare v_order_merchant text; v_product_merchant text; v_variant_product text;
begin
  select merchant_id into v_order_merchant from orders where id=new.order_id;
  if v_order_merchant is null then raise exception 'order missing for item'; end if;
  select merchant_id into v_product_merchant from products where id=new.product_id;
  if v_product_merchant is null or v_product_merchant<>v_order_merchant then raise exception 'order item merchant mismatch'; end if;
  if new.variant_id is not null then
    select product_id into v_variant_product from product_variants where id=new.variant_id;
    if v_variant_product is null or v_variant_product<>new.product_id then raise exception 'order item variant mismatch'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_graph_integrity on order_items;
create constraint trigger order_items_graph_integrity
after insert or update of order_id,product_id,variant_id on order_items
deferrable initially immediate
for each row execute function validate_order_item_graph_integrity();

create or replace function validate_payment_graph_integrity()
returns trigger language plpgsql as $$
declare v_order record;
begin
  select user_id,grand_total,currency into v_order from orders where id=new.order_id;
  if not found then raise exception 'payment order missing'; end if;
  if v_order.user_id<>new.user_id then raise exception 'payment/order customer mismatch'; end if;
  if v_order.currency<>new.currency then raise exception 'payment/order currency mismatch'; end if;
  if round(new.amount,2)<>round(v_order.grand_total,2) then raise exception 'payment/order amount mismatch'; end if;
  return new;
end;
$$;

drop trigger if exists payments_graph_integrity on payments;
create constraint trigger payments_graph_integrity
after insert or update of order_id,user_id,amount,currency on payments
deferrable initially immediate
for each row execute function validate_payment_graph_integrity();

-- Privileged database functions reject the wrong actor class even when called
-- directly. HTTP/API authorization remains the primary boundary.
create or replace function merchant_adjust_inventory(
  p_merchant_id text,p_product_id text,p_variant_id text,p_delta integer,p_reason text,p_actor_user_id text
) returns jsonb language plpgsql as $$
declare v_product record; v_variant record; v_new_stock integer; v_id text := 'mia_'||replace(gen_random_uuid()::text,'-','');
begin
  perform assert_actor_role(p_actor_user_id,'merchant');
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
declare v_order record; v_allowed boolean:=false;
begin
  perform assert_actor_role(p_actor_user_id,'merchant');
  if p_to_status not in ('confirmed','fulfilling','shipped','delivered','completed') then raise exception 'invalid merchant order status'; end if;
  select * into v_order from orders where id=p_order_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'order not found'; end if;
  v_allowed:=(v_order.status,p_to_status) in (('paid','confirmed'),('confirmed','fulfilling'),('fulfilling','shipped'),('shipped','delivered'),('delivered','completed'));
  if not v_allowed then raise exception 'invalid order status transition'; end if;
  update orders set status=p_to_status,updated_at=now() where id=p_order_id;
  insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note) values(p_order_id,p_merchant_id,v_order.status,p_to_status,p_actor_user_id,nullif(left(trim(coalesce(p_note,'')),500),''));
  perform record_audit_event('merchant.order.status_changed','order',p_order_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id,'from',v_order.status,'to',p_to_status));
  return jsonb_build_object('orderId',p_order_id,'fromStatus',v_order.status,'status',p_to_status);
end;
$$;

create or replace function admin_set_product_status(
  p_product_id text,p_admin_id text,p_status text,p_reason text
) returns jsonb language plpgsql as $$
declare v_product record; v_action text;
begin
  perform assert_actor_role(p_admin_id,'admin');
  if p_status not in ('active','suspended','archived') then raise exception 'invalid product status'; end if;
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'reason required'; end if;
  select * into v_product from products where id=p_product_id for update;
  if not found then raise exception 'product not found'; end if;
  update products set status=p_status,published_at=case when p_status='active' then coalesce(published_at,now()) else published_at end where id=p_product_id;
  v_action:=case when p_status='active' then 'approve' when p_status='archived' then 'archive' else 'suspend' end;
  insert into admin_moderation_actions(target_type,target_id,action,reason,actor_user_id) values('product',p_product_id,v_action,trim(p_reason),p_admin_id);
  perform record_audit_event('admin.product.'||v_action,'product',p_product_id,p_admin_id,'admin',null,'success',jsonb_build_object('reason',trim(p_reason),'previousStatus',v_product.status,'newStatus',p_status));
  return jsonb_build_object('productId',p_product_id,'status',p_status);
end;
$$;

create or replace function admin_set_merchant_status(
  p_merchant_id text,p_admin_id text,p_status text,p_reason text default null
) returns jsonb language plpgsql as $$
declare v_merchant record; v_reason text;
begin
  perform assert_actor_role(p_admin_id,'admin');
  if p_status not in ('active','suspended') then raise exception 'invalid merchant status'; end if;
  v_reason:=coalesce(nullif(trim(p_reason),''),case when p_status='suspended' then 'Administrative merchant suspension' else 'Administrative merchant reinstatement' end);
  if char_length(v_reason)<3 or char_length(v_reason)>2000 then raise exception 'reason must be between 3 and 2000 characters'; end if;
  select m.* into v_merchant from merchants m where m.id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  update merchants set status=p_status where id=p_merchant_id;
  update merchant_accounts set status=case when p_status='active' then 'active' else 'suspended' end,updated_at=now() where merchant_id=p_merchant_id;
  insert into admin_moderation_actions(target_type,target_id,action,reason,actor_user_id) values('merchant',p_merchant_id,case when p_status='active' then 'reinstate' else 'suspend' end,v_reason,p_admin_id);
  perform record_audit_event('admin.merchant.'||case when p_status='active' then 'reinstated' else 'suspended' end,'merchant',p_merchant_id,p_admin_id,'admin',null,'success',jsonb_build_object('reason',v_reason,'previousStatus',v_merchant.status,'newStatus',p_status));
  return jsonb_build_object('merchantId',p_merchant_id,'status',p_status,'changed',v_merchant.status is distinct from p_status);
end;
$$;
