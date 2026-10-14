-- Enterprise API catalogue products and brand/distributor offers are two distinct
-- integration paths. The earlier brand freshness guard unintentionally required
-- *every* enterprise_api listing to have a brand_integration_offer, preventing
-- ordinary enterprise catalogue purchases.
-- Do not change historical migrations; this is a forward-only correction.
create or replace function validate_fresh_brand_product_order_item()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare
  v_stock integer;
  v_has_brand_offer boolean;
begin
  select stock into v_stock from products where id=new.product_id;
  if not found then raise exception 'product not found'; end if;
  select exists(
    select 1 from brand_integration_product_map m where m.product_id=new.product_id
    union all
    select 1 from brand_integration_offers o where o.product_id=new.product_id
  ) into v_has_brand_offer;
  if v_has_brand_offer then
    if coalesce(v_stock,0) <= 0 or not exists (
      select 1 from brand_integration_offers o
      join brand_integration_connections c on c.id=o.connection_id
      where o.product_id=new.product_id and o.status='active' and c.status='active'
        and o.last_seen_at >= now() - make_interval(secs=>c.stale_after_seconds)
        and o.available >= new.quantity
        and assert_brand_integration_authorized(c.id)
    ) then raise exception 'brand integration inventory is stale or unavailable'; end if;
  end if;
  return new;
end;
$$;

-- Before-order guard: enterprise catalogue merchants need a fresh catalogue
-- connection; enterprise merchants relying exclusively on authorized brand
-- integration feeds instead use offer-level freshness in the order-item guard.
create or replace function enforce_enterprise_inventory_freshness()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare
  v_catalog text;
  v_last_sync timestamptz;
  v_max_age integer;
  v_has_catalog boolean;
begin
  select catalog_source into v_catalog from merchants where id=new.merchant_id;
  if v_catalog is distinct from 'enterprise_api' then return new; end if;
  select last_inventory_sync_at,inventory_stale_after_seconds into v_last_sync,v_max_age
    from enterprise_catalog_connections where merchant_id=new.merchant_id and status='active';
  v_has_catalog := found;
  if v_has_catalog then
    if v_last_sync is null or v_last_sync < now() - make_interval(secs=>coalesce(v_max_age,900)) then
      raise exception 'enterprise inventory is stale; order creation is temporarily unavailable';
    end if;
  elsif not exists(
    select 1 from brand_integration_connections c
    where c.merchant_id=new.merchant_id and c.status='active'
      and 'catalog:read'=any(c.scopes) and assert_brand_integration_authorized(c.id)
  ) then
    raise exception 'enterprise catalogue/integration is not active';
  end if;
  return new;
end;
$$;

comment on function validate_fresh_brand_product_order_item() is
  'Brand distributor feed items require an active, fresh brand offer; independent enterprise API catalogue items use their own inventory freshness contract.';
