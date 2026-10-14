-- Admin-controlled catalog availability.
-- Disabling a category/subcategory hides it from discovery and blocks new/updated
-- listings through the existing validate_product_taxonomy trigger without deleting
-- historical products, orders, audit records, or merchant declarations.

create or replace function admin_set_catalog_taxonomy_state(
  p_admin_id text,
  p_scope text,
  p_category_key text,
  p_subcategory_key text,
  p_active boolean,
  p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role text;
  v_name text;
begin
  if current_setting('app.user_id',true) is distinct from p_admin_id then
    raise exception 'unauthorized';
  end if;
  select role into v_role from "user" where id=p_admin_id;
  if v_role <> 'admin' then raise exception 'admin role required'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'reason required'; end if;
  if p_scope not in ('category','subcategory') then raise exception 'invalid taxonomy scope'; end if;

  if p_scope='category' then
    update category_taxonomy
       set active=p_active
     where category_key=p_category_key
     returning name into v_name;
    if v_name is null then raise exception 'category not found'; end if;
  else
    if p_subcategory_key is null or length(trim(p_subcategory_key))=0 then
      raise exception 'subcategory required';
    end if;
    update category_subcategories
       set active=p_active
     where category_key=p_category_key and subcategory_key=p_subcategory_key
     returning name into v_name;
    if v_name is null then raise exception 'subcategory not found'; end if;
  end if;

  perform record_audit_event(
    'admin.catalog_taxonomy.updated',
    p_scope,
    case when p_scope='category' then p_category_key else p_category_key||':'||p_subcategory_key end,
    p_admin_id,
    'admin',
    null,
    'success',
    jsonb_build_object(
      'categoryKey',p_category_key,
      'subcategoryKey',p_subcategory_key,
      'active',p_active,
      'reason',left(trim(p_reason),2000),
      'name',v_name
    )
  );

  return jsonb_build_object(
    'scope',p_scope,
    'categoryKey',p_category_key,
    'subcategoryKey',p_subcategory_key,
    'active',p_active
  );
end;
$$;

revoke all on function admin_set_catalog_taxonomy_state(text,text,text,text,boolean,text) from public;

comment on function admin_set_catalog_taxonomy_state(text,text,text,text,boolean,text)
is 'Admin-only catalog availability switch. Preserves historical records while discovery and taxonomy validation enforce the current active state.';

-- A hidden category must also be unavailable to stale carts/direct checkout calls.
-- This extends the existing order-item publication invariant without rewriting
-- historical checkout migrations.
create or replace function enforce_order_item_product_active() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
      from products p
      join category_taxonomy ct on ct.category_key=p.category and ct.active=true
      left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory
     where p.id=new.product_id
       and p.status='active'
       and (p.subcategory is null or cs.active=true)
  ) then
    raise exception 'product is not available for purchase';
  end if;
  return new;
end;
$$;
