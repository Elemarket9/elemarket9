-- Allow partial merchant listings to enter review, but never publish category-required specs missing.
-- Forward replacement of the original catalog trigger function without editing historical migration 0008.
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

  -- Draft and review-stage listings can be completed in the merchant dashboard.
  -- Required specifications become mandatory before any active publication.
  if new.status = 'active' then
    foreach required_key in array required_keys loop
      if not (a ? required_key) or a -> required_key is null or a ->> required_key = '' then
        raise exception 'missing required product attribute: %', required_key;
      end if;
    end loop;
  end if;

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

