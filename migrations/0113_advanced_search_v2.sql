-- ELEMARKET Search v2: unified, identifier-aware, faceted, cursor-safe search foundation.
-- No tax/VAT calculation is introduced here.

alter table products add column if not exists normalized_name text;
alter table products add column if not exists normalized_brand text;
alter table products add column if not exists normalized_model text;
alter table products add column if not exists search_aliases text[] not null default '{}';
alter table products add column if not exists search_identifiers text[] not null default '{}';

create index if not exists products_normalized_name_idx on products (normalized_name);
create index if not exists products_normalized_brand_idx on products (normalized_brand);
create index if not exists products_normalized_model_idx on products (normalized_model);
create index if not exists products_search_identifiers_gin_idx on products using gin(search_identifiers);
create index if not exists products_search_aliases_gin_idx on products using gin(search_aliases);
create index if not exists products_attributes_gin_idx on products using gin(attributes jsonb_path_ops);
create index if not exists product_identifiers_normalized_lookup_idx on product_identifiers(normalized_value,identifier_type,product_id);
create index if not exists products_price_active_idx on products(price,id) where status='active' and stock>0;
create index if not exists products_newest_active_idx on products(created_at desc,id) where status='active' and stock>0;

create or replace function normalize_marketplace_search_value(p_value text)
returns text language sql immutable as $$
  select trim(regexp_replace(lower(normalize(coalesce(p_value,''), NFKC)), '[^[:alnum:][:space:]./_-]+', ' ', 'g'));
$$;

create or replace function refresh_product_search_v2()
returns trigger language plpgsql as $$
begin
  new.normalized_name := normalize_marketplace_search_value(new.name);
  new.normalized_brand := normalize_marketplace_search_value(new.brand);
  new.normalized_model := normalize_marketplace_search_value(new.model);
  new.search_vector :=
    setweight(to_tsvector('simple',coalesce(new.normalized_name,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.normalized_brand,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.normalized_model,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.sku,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.category,'')),'B') ||
    setweight(to_tsvector('simple',coalesce(new.subcategory,'')),'B') ||
    setweight(to_tsvector('simple',coalesce(new.description,'')),'C') ||
    setweight(to_tsvector('simple',array_to_string(new.search_aliases,' ')),'B') ||
    setweight(to_tsvector('simple',array_to_string(new.search_identifiers,' ')),'A');
  return new;
end $$;

drop trigger if exists products_search_v2_guard on products;
create trigger products_search_v2_guard
before insert or update of name,brand,model,sku,category,subcategory,description,search_aliases,search_identifiers on products
for each row execute function refresh_product_search_v2();

update products set
  normalized_name=normalize_marketplace_search_value(name),
  normalized_brand=normalize_marketplace_search_value(brand),
  normalized_model=normalize_marketplace_search_value(model)
where normalized_name is null or normalized_brand is null or normalized_model is null;

create table if not exists marketplace_search_synonyms (
  id text primary key,
  term text not null,
  synonym text not null,
  locale text not null default 'en-GH',
  status text not null default 'active' check(status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique(term,synonym,locale)
);
create index if not exists marketplace_search_synonyms_term_idx on marketplace_search_synonyms(term,status,locale);

create table if not exists marketplace_search_events (
  id bigserial primary key,
  query_hash text not null,
  query_normalized text not null check(char_length(query_normalized)<=160),
  result_count integer not null check(result_count>=0),
  zero_result boolean not null,
  selected_product_id text references products(id) on delete set null,
  selected_position integer check(selected_position is null or selected_position>0),
  filter_fingerprint text,
  search_version text not null default 'search-v2',
  created_at timestamptz not null default now()
);
create index if not exists marketplace_search_events_query_idx on marketplace_search_events(query_hash,created_at desc);
create index if not exists marketplace_search_events_zero_idx on marketplace_search_events(zero_result,created_at desc) where zero_result=true;

create table if not exists marketplace_search_index_jobs (
  id bigserial primary key,
  product_id text references products(id) on delete cascade,
  operation text not null check(operation in ('upsert','delete','reindex')),
  status text not null default 'pending' check(status in ('pending','processing','completed','failed')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketplace_search_index_jobs_ready_idx on marketplace_search_index_jobs(status,available_at,id);

comment on table marketplace_search_events is 'Privacy-minimized search analytics; do not store raw user PII.';
comment on table marketplace_search_index_jobs is 'Durable search-index synchronization/outbox.';
