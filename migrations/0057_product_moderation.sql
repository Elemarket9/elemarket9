-- Product moderation lifecycle for real-world merchant onboarding.
-- New merchant listings start in pending_review and require an admin decision
-- before they become visible in the public catalogue.

alter table admin_moderation_actions
  drop constraint if exists admin_moderation_actions_action_check;
alter table admin_moderation_actions
  add constraint admin_moderation_actions_action_check
  check (action in ('suspend','reinstate','blacklist','unblacklist','archive','approve'));

create or replace function admin_set_product_status(
  p_product_id text,
  p_admin_id text,
  p_status text,
  p_reason text
) returns jsonb language plpgsql as $$
declare v_product record; v_action text;
begin
  if p_status not in ('active','suspended','archived') then raise exception 'invalid product status'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  select * into v_product from products where id=p_product_id for update;
  if not found then raise exception 'product not found'; end if;
  if p_status = 'active' and v_product.merchant_id is null then raise exception 'product merchant missing'; end if;

  update products
     set status=p_status, published_at=case when p_status='active' then coalesce(published_at,now()) else published_at end
   where id=p_product_id;

  v_action := case when p_status='active' then 'approve' when p_status='archived' then 'archive' else 'suspend' end;
  insert into admin_moderation_actions(target_type,target_id,action,reason,actor_user_id)
  values ('product',p_product_id,v_action,trim(p_reason),p_admin_id);

  perform record_audit_event(
    'admin.product.'||v_action, 'product', p_product_id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('reason',trim(p_reason),'previousStatus',v_product.status,'newStatus',p_status)
  );
  return jsonb_build_object('productId',p_product_id,'status',p_status);
end;
$$;
