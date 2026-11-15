-- Retire restaurant and prepared-food catalogues from ELEMARKET.
-- Prepared-food ordering belongs to ELESEND; groceries and pet food are unaffected.
-- Never delete historical orders, refunds, reviews, product IDs or payment evidence.

-- Existing listings are archived, not deleted; this prevents public reappearance
-- while preserving references required for historical orders and dispute handling.
update products
   set status='archived'
 where (category in ('food','restaurants') or listing_type='food')
   and status<>'archived';

update category_subcategories set active=false where category_key in ('food','restaurants');
update category_taxonomy set active=false where category_key in ('food','restaurants');

-- Stop the legacy homepage feature while preserving past ad campaign records.
delete from homepage_sections where section_key='food_spotlight';
update homepage_ad_campaigns
   set status='paused',updated_at=now()
 where placement='food_spotlight' and status in ('active','scheduled');

-- Prevent insertion/reactivation of restaurant/prepared-food listings, including
-- direct SQL, bulk import and external feeds that bypass application validators.
create or replace function block_retired_food_listing()
returns trigger language plpgsql as $$
begin
  if new.category in ('food','restaurants') or new.listing_type='food' then
    if tg_op='INSERT' or new.status<>'archived' then
      raise exception using errcode='23514',
        message='Restaurant and prepared-food catalogues are retired from ELEMARKET',
        constraint='elemarket_retired_food_catalog';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists products_no_retired_food_catalog on products;
create trigger products_no_retired_food_catalog
before insert or update of category, listing_type, status on products
for each row execute function block_retired_food_listing();

-- Retired categories must not be re-added via merchant signup or profile
-- mutations. Existing merchant and application records remain available to
-- administrators for reconciliation and historic account support.
create or replace function block_retired_food_merchant_category()
returns trigger language plpgsql as $$
begin
  if new.category in ('food','restaurants')
     or new.catalog_categories && array['food','restaurants']::text[] then
    raise exception using errcode='23514',
      message='Restaurant and prepared-food merchant catalogues are retired from ELEMARKET',
      constraint='elemarket_retired_food_merchant_category';
  end if;
  return new;
end;
$$;
drop trigger if exists merchants_no_retired_food_catalog on merchants;
create trigger merchants_no_retired_food_catalog
before insert or update of category,catalog_categories on merchants
for each row execute function block_retired_food_merchant_category();
drop trigger if exists applications_no_retired_food_catalog on merchant_applications;
create trigger applications_no_retired_food_catalog
before insert or update of category,catalog_categories on merchant_applications
for each row execute function block_retired_food_merchant_category();

-- Defence in depth: no administrator should be able to make the retired
-- taxonomy visible again without a deliberate subsequent schema change.
create or replace function block_retired_food_taxonomy_activation()
returns trigger language plpgsql as $$
begin
  if new.category_key in ('food','restaurants') and new.active then
    raise exception using errcode='23514',
      message='Retired restaurant and prepared-food taxonomy cannot be activated',
      constraint='elemarket_retired_food_taxonomy';
  end if;
  return new;
end;
$$;
drop trigger if exists taxonomy_no_retired_food_activation on category_taxonomy;
create trigger taxonomy_no_retired_food_activation
before insert or update of active,category_key on category_taxonomy
for each row execute function block_retired_food_taxonomy_activation();
