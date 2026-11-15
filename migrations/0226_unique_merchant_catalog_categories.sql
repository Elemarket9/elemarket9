-- Merchant category arrays must be sets, not lists with repeated category keys.
-- Preserve historical records; reject new duplicate category assignments only.
-- Existing 0134 taxonomy and primary-category constraints remain authoritative.
create or replace function enforce_unique_merchant_catalog_categories()
returns trigger language plpgsql as $$
begin
  if cardinality(new.catalog_categories) is distinct from (
    select count(distinct category)::integer
      from unnest(new.catalog_categories) as categories(category)
  ) then
    raise exception using
      errcode='23514',
      message='Merchant catalog categories must be unique',
      constraint='merchant_catalog_categories_unique';
  end if;
  return new;
end;
$$;

drop trigger if exists merchants_unique_catalog_categories on merchants;
create trigger merchants_unique_catalog_categories
before insert or update of category,catalog_categories on merchants
for each row execute function enforce_unique_merchant_catalog_categories();

drop trigger if exists merchant_applications_unique_catalog_categories on merchant_applications;
create trigger merchant_applications_unique_catalog_categories
before insert or update of category,catalog_categories on merchant_applications
for each row execute function enforce_unique_merchant_catalog_categories();
