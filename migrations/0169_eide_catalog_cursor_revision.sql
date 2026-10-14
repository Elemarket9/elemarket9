-- Monotonic catalog epoch for search cursor invalidation. Deploy before the application change.
create table if not exists eide_catalog_revision (
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 0 check(revision >= 0)
);
insert into eide_catalog_revision(singleton,revision) values(true,0) on conflict(singleton) do nothing;
create or replace function bump_eide_catalog_revision() returns trigger language plpgsql as $$
begin
  update eide_catalog_revision set revision=revision+1 where singleton=true;
  return null;
end $$;
-- Statement triggers avoid per-row increments during bulk catalog synchronization.
drop trigger if exists eide_catalog_products_revision on products;
create trigger eide_catalog_products_revision after insert or update or delete on products
for each statement execute function bump_eide_catalog_revision();
drop trigger if exists eide_catalog_variants_revision on product_variants;
create trigger eide_catalog_variants_revision after insert or update or delete on product_variants
for each statement execute function bump_eide_catalog_revision();
drop trigger if exists eide_catalog_merchants_revision on merchants;
create trigger eide_catalog_merchants_revision after insert or update or delete on merchants
for each statement execute function bump_eide_catalog_revision();
