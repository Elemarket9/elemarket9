-- Prevent new duplicate native merchant listings without merging historical products.
-- Existing rows, order references and enterprise/brand integrations remain untouched.
-- Comparisons are case-insensitive and ignore excess whitespace.
create or replace function catalog_duplicate_key(p_value text)
returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g'))
$$;

create index if not exists products_native_sku_lookup_idx
  on products (merchant_id, catalog_duplicate_key(sku))
  where catalog_source='native' and status<>'archived'
    and catalog_duplicate_key(sku)<>'';

create index if not exists products_native_name_lookup_idx
  on products (merchant_id, category, listing_type, catalog_duplicate_key(name))
  where catalog_source='native' and status<>'archived'
    and catalog_duplicate_key(sku)='';

create or replace function prevent_native_catalog_duplicates()
returns trigger language plpgsql as $$
declare
  v_existing_id text;
  v_sku_key text;
begin
  -- Enterprise feeds and integration-specific identities have their own upsert contracts.
  if new.catalog_source is distinct from 'native' or new.status='archived' then
    return new;
  end if;

  -- Don't break inventory, price, moderation or suspension updates on historical
  -- duplicates. However, re-activating an archived row must pass the guard.
  if tg_op='UPDATE' then
    if old.status<>'archived'
     and old.merchant_id is not distinct from new.merchant_id
     and old.catalog_source is not distinct from new.catalog_source
     and old.sku is not distinct from new.sku
     and old.name is not distinct from new.name
     and old.category is not distinct from new.category
     and old.subcategory is not distinct from new.subcategory
     and old.brand is not distinct from new.brand
     and old.model is not distinct from new.model
     and old.condition is not distinct from new.condition
     and old.listing_type is not distinct from new.listing_type then
      return new;
    end if;
  end if;

  -- Serialize all native identity writes for this merchant, including bulk uploads.
  -- Transaction-level lock is released automatically on commit/rollback.
  perform pg_advisory_xact_lock(hashtext('elemarket-native-catalog:' || new.merchant_id));
  v_sku_key := catalog_duplicate_key(new.sku);

  if v_sku_key<>'' then
    select p.id into v_existing_id
      from products p
     where p.merchant_id=new.merchant_id
       and p.id<>new.id
       and p.catalog_source='native'
       and p.status<>'archived'
       and catalog_duplicate_key(p.sku)=v_sku_key
     limit 1;
  else
    -- Exact normalized no-SKU identities only; shared names with different
    -- categories, conditions, brands or models are not automatically merged.
    select p.id into v_existing_id
      from products p
     where p.merchant_id=new.merchant_id
       and p.id<>new.id
       and p.catalog_source='native'
       and p.status<>'archived'
       and catalog_duplicate_key(p.sku)=''
       and catalog_duplicate_key(p.name)=catalog_duplicate_key(new.name)
       and p.category=new.category
       and p.listing_type=new.listing_type
       and coalesce(p.subcategory,'')=coalesce(new.subcategory,'')
       and catalog_duplicate_key(p.brand)=catalog_duplicate_key(new.brand)
       and catalog_duplicate_key(p.model)=catalog_duplicate_key(new.model)
       and p.condition=new.condition
     limit 1;
  end if;

  if v_existing_id is not null then
    raise exception using
      errcode='23505',
      message='Duplicate merchant catalog listing; edit the existing listing instead',
      constraint='merchant_native_product_identity_guard';
  end if;
  return new;
end;
$$;

drop trigger if exists products_native_duplicate_guard on products;
create trigger products_native_duplicate_guard
before insert or update of merchant_id, catalog_source, status, sku, name,
                           category, subcategory, brand, model, condition, listing_type
on products for each row execute function prevent_native_catalog_duplicates();
