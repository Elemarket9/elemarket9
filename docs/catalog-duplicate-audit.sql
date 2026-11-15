-- Read-only catalogue diagnostics. Run only after migration 0225 has been
-- applied. Queries do not change or archive any product, variant or order.
-- Review resulting IDs, their order history, offers and attributes before
-- proposing any manual merge/archival procedure.

-- A. Native duplicates: case-insensitive SKU identity within one merchant.
select merchant_id, 'normalized_sku'::text as match_type,
       catalog_duplicate_key(sku) as identity_key,
       count(*)::integer as listing_count,
       array_agg(id order by created_at,id) as product_ids,
       array_agg(status order by created_at,id) as statuses
  from products
 where catalog_source='native'
   and status<>'archived'
   and catalog_duplicate_key(sku)<>''
 group by merchant_id,catalog_duplicate_key(sku)
having count(*)>1
 order by listing_count desc,merchant_id,identity_key;

-- B. Native duplicates with no SKU: exact normalized product identity.
select merchant_id, 'normalized_without_sku'::text as match_type,
       jsonb_build_object(
         'name',catalog_duplicate_key(name),
         'category',category,
         'listingType',listing_type,
         'subcategory',coalesce(subcategory,''),
         'brand',catalog_duplicate_key(brand),
         'model',catalog_duplicate_key(model),
         'condition',condition
       ) as identity_key,
       count(*)::integer as listing_count,
       array_agg(id order by created_at,id) as product_ids,
       array_agg(status order by created_at,id) as statuses
  from products
 where catalog_source='native'
   and status<>'archived'
   and catalog_duplicate_key(sku)=''
 group by merchant_id,catalog_duplicate_key(name),category,listing_type,
          coalesce(subcategory,''),catalog_duplicate_key(brand),
          catalog_duplicate_key(model),condition
having count(*)>1
 order by listing_count desc,merchant_id;

-- C. Catalogue taxonomy drift: invalid or inactive category / subcategory.
select p.id,p.merchant_id,p.name,p.status,p.category,p.subcategory
  from products p
  left join category_taxonomy c on c.category_key=p.category
  left join category_subcategories s
    on s.category_key=p.category and s.subcategory_key=p.subcategory
 where p.status='active'
   and (c.category_key is null or c.active is distinct from true
        or (p.subcategory is not null and
            (s.subcategory_key is null or s.active is distinct from true)))
 order by p.merchant_id,p.id;

-- D. Parent/variant stock disagreement: manual investigation, not auto-fix.
select p.id,p.merchant_id,p.name,p.stock as parent_stock,
       coalesce(sum(v.stock) filter(where v.status='active'),0) as active_variant_stock
  from products p
  join product_variants v on v.product_id=p.id
 where p.status='active'
 group by p.id,p.merchant_id,p.name,p.stock
having p.stock=0 and coalesce(sum(v.stock) filter(where v.status='active'),0)>0
 order by active_variant_stock desc,p.id;
