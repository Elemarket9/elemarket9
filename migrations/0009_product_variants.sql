-- Product variant / SKU architecture.
-- A product is the catalogue family; variants are the purchasable inventory units.
-- Example: Galaxy A25 -> 128GB/8GB/Black and 256GB/8GB/Black are separate variants.

create table if not exists product_variants (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  sku text not null,
  name text,
  attributes jsonb not null default '{}'::jsonb,
  price numeric(12,2) not null check (price > 0),
  stock integer not null default 0 check (stock >= 0),
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variant_status_check check (status in ('draft','active','suspended','archived')),
  constraint product_variant_attributes_object_check check (jsonb_typeof(attributes) = 'object')
);

create unique index if not exists product_variants_product_sku_uq
  on product_variants(product_id, lower(sku));
create index if not exists product_variants_product_status_idx
  on product_variants(product_id, status);

alter table order_items add column if not exists variant_id text references product_variants(id);
create index if not exists order_items_variant_idx on order_items(variant_id);

-- Keep the legacy product-level stock usable while variants are introduced. Once a product
-- has variants, its stock is the sum of active variant stock.
create or replace function sync_product_stock_from_variants() returns trigger language plpgsql as $$
declare
  v_product text := coalesce(new.product_id, old.product_id);
begin
  update products
     set stock = coalesce((select sum(pv.stock) from product_variants pv where pv.product_id = v_product and pv.status = 'active'), 0)
   where id = v_product;
  return coalesce(new, old);
end;
$$;

drop trigger if exists product_variants_sync_product_stock on product_variants;
create trigger product_variants_sync_product_stock
after insert or update of stock, status, product_id or delete on product_variants
for each row execute function sync_product_stock_from_variants();

-- Create one explicit default variant for every existing product that does not have one.
-- This gives every legacy product a stable SKU without changing its public price/stock.
insert into product_variants(id, product_id, sku, name, attributes, price, stock, status)
select 'var_' || p.id,
       p.id,
       coalesce(nullif(btrim(p.sku), ''), upper(replace(p.id, '-', '_')) || '_DEFAULT'),
       'Default',
       coalesce(p.attributes, '{}'::jsonb),
       p.price,
       p.stock,
       case when p.status = 'active' then 'active' else 'draft' end
  from products p
 where not exists (select 1 from product_variants pv where pv.product_id = p.id);

-- A product SKU, when present, remains the family/legacy identifier. Variant SKUs must be
-- unique within a product and should be the identifier used for inventory/order operations.
