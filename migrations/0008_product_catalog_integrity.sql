-- ELEMARKET Step 3: production product-catalogue integrity.
-- Enforces category-specific merchandising requirements at the database boundary.

alter table products add column if not exists status text not null default 'active';
alter table products add column if not exists return_window_days integer;
alter table products add column if not exists returnable boolean not null default true;
alter table products add column if not exists published_at timestamptz;

alter table products drop constraint if exists products_status_check;
alter table products add constraint products_status_check
  check (status in ('draft','pending_review','active','suspended','archived')) not valid;

alter table products drop constraint if exists products_return_window_check;
alter table products add constraint products_return_window_check
  check (return_window_days is null or return_window_days between 0 and 90) not valid;

create index if not exists products_status_category_idx on products(status, category, subcategory);
create index if not exists products_published_idx on products(published_at desc) where status = 'active';

-- A product may have many media assets. image_path remains as the backwards-compatible
-- primary/legacy image while this table provides an extensible media model.
create table if not exists product_media (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  media_type text not null default 'image',
  storage_key text not null,
  alt_text text,
  sort_order integer not null default 0 check (sort_order >= 0),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint product_media_type_check check (media_type in ('image','video'))
);
create index if not exists product_media_product_idx on product_media(product_id, sort_order);
create unique index if not exists product_media_one_primary_uq on product_media(product_id) where is_primary;
create unique index if not exists product_media_storage_uq on product_media(storage_key);

-- Canonical validation helpers. Attribute names are stable API keys; values are validated
-- as JSON types and basic ranges, while merchants may still provide additional attributes.
create or replace function product_attr_text(attrs jsonb, key text) returns text language sql immutable as $$
  select case when jsonb_typeof(attrs -> key) = 'string' then attrs ->> key else null end
$$;

create or replace function product_attr_num(attrs jsonb, key text) returns numeric language sql immutable as $$
  select case when jsonb_typeof(attrs -> key) = 'number' then (attrs ->> key)::numeric else null end
$$;

create or replace function validate_product_catalog_integrity() returns trigger language plpgsql as $$
declare
  a jsonb := coalesce(new.attributes, '{}'::jsonb);
  required_key text;
  required_keys text[];
begin
  if jsonb_typeof(a) <> 'object' then
    raise exception 'product attributes must be a JSON object';
  end if;

  if new.status = 'active' and (new.name is null or length(btrim(new.name)) < 3) then
    raise exception 'active product requires a valid name';
  end if;

  if new.status = 'active' and (new.price is null or new.price <= 0) then
    raise exception 'active product requires a positive price';
  end if;

  if new.status = 'active' and (new.stock is null or new.stock < 0) then
    raise exception 'active product requires non-negative stock';
  end if;

  -- Product-specific required specifications.
  required_keys := case new.subcategory
    when 'mobile-phones' then array['network','storage_gb','ram_gb']
    when 'laptops' then array['cpu','ram_gb','storage_gb','screen_inches','os']
    when 'desktops' then array['cpu','ram_gb','storage_gb','os']
    when 'tablets' then array['storage_gb','ram_gb','screen_inches','os']
    when 'monitors' then array['screen_inches','resolution','refresh_rate_hz']
    when 'printers' then array['print_type','connectivity']
    when 'networking' then array['device_type','ports']
    when 'storage' then array['storage_type','capacity_gb']
    when 'components' then array['component_type','compatibility']
    when 'tv' then array['screen_inches','resolution','smart_tv']
    when 'refrigerators' then array['capacity_litres','energy_rating']
    when 'freezers' then array['capacity_litres','energy_rating']
    when 'washing-machines' then array['capacity_kg','energy_rating']
    when 'dryers' then array['capacity_kg','energy_rating']
    when 'dishwashers' then array['capacity_place_settings','energy_rating']
    when 'cookers-ovens' then array['fuel_type','burners']
    when 'microwaves' then array['capacity_litres','power_watts']
    when 'air-conditioners' then array['capacity_btu','energy_rating']
    when 'fans' then array['fan_type','speed_levels']
    when 'water-heaters' then array['capacity_litres','energy_rating']
    when 'vacuum-cleaners' then array['vacuum_type','power_watts']
    when 'irons' then array['iron_type','power_watts']
    else array[]::text[]
  end;

  foreach required_key in array required_keys loop
    if not (a ? required_key) or a -> required_key is null then
      raise exception 'missing required product attribute: %', required_key;
    end if;
  end loop;

  -- Strongly typed numeric checks for common catalogue fields.
  foreach required_key in array array['storage_gb','ram_gb','screen_inches','refresh_rate_hz','capacity_litres','capacity_kg','power_watts','capacity_btu','burners','speed_levels','ports','capacity_place_settings'] loop
    if a ? required_key and product_attr_num(a, required_key) is null then
      raise exception 'product attribute % must be numeric', required_key;
    end if;
    if a ? required_key and product_attr_num(a, required_key) <= 0 then
      raise exception 'product attribute % must be positive', required_key;
    end if;
  end loop;

  if new.status = 'active' and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists products_catalog_integrity_validate on products;
create trigger products_catalog_integrity_validate
before insert or update of name, category, subcategory, attributes, price, stock, status, published_at
on products for each row execute function validate_product_catalog_integrity();

-- Existing seed records are already valid; ensure their lifecycle timestamp is populated.
update products set published_at = coalesce(published_at, now()) where status = 'active';
