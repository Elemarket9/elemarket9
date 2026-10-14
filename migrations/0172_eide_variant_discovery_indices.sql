-- Supports indexed variant-aware discovery prices and merchant stock decisions.
-- Forward-only: past migration checksums remain immutable.
create index if not exists eide_active_variants_lowest_stock_price_idx
 on product_variants(product_id,price) where status='active' and stock>0;
create index if not exists eide_active_variants_lowest_price_idx
 on product_variants(product_id,price) where status='active';
