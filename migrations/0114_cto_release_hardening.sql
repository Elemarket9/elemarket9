-- ELEMARKET CTO release hardening v1.84.
-- Search analytics never retain arbitrary query text; pending index work is coalesced.

alter table marketplace_search_events drop column if exists query_normalized;

alter table marketplace_search_index_jobs
  add column if not exists catalog_version bigint not null default 0;

-- Collapse duplicate pending work before enforcing the unique coalescing boundary.
delete from marketplace_search_index_jobs a
where a.status='pending'
  and a.product_id is not null
  and exists (
    select 1 from marketplace_search_index_jobs b
    where b.status='pending' and b.product_id=a.product_id and b.id>a.id
  );

-- At most one pending job per product. Producers must update the pending row's
-- operation/catalog_version rather than enqueueing unbounded duplicate work.
create unique index if not exists marketplace_search_index_jobs_pending_product_uidx
  on marketplace_search_index_jobs(product_id)
  where status='pending' and product_id is not null;

create index if not exists marketplace_search_index_jobs_product_version_idx
  on marketplace_search_index_jobs(product_id,catalog_version desc,updated_at desc);

comment on column marketplace_search_index_jobs.catalog_version is
  'Monotonic product/catalog version used to prevent stale search documents from overwriting newer state.';
comment on table marketplace_search_events is
  'Privacy-safe search analytics. query_hash is a keyed application digest; raw query text is intentionally not retained.';
