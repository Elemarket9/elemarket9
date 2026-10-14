-- EIDE v4: dirty-feature scheduling, trusted-change invalidation and SEO discovery support.
-- Anonymous funnel traffic deliberately does NOT enqueue immediate refresh work: bots must not
-- be able to turn cheap events into expensive database recomputation.

create table if not exists eide_feature_dirty (
  product_id text primary key references products(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 40),
  dirty_at timestamptz not null default now()
);
create index if not exists eide_feature_dirty_time_idx on eide_feature_dirty(dirty_at,product_id);

create or replace function eide_mark_product_dirty(p_product_id text,p_reason text)
returns void language sql security definer set search_path=public,pg_temp as $$
  insert into eide_feature_dirty(product_id,reason,dirty_at)
  values(p_product_id,left(coalesce(nullif(trim(p_reason),''),'change'),40),now())
  on conflict(product_id) do update set reason=excluded.reason,dirty_at=excluded.dirty_at
$$;
revoke all on function eide_mark_product_dirty(text,text) from public;
grant execute on function eide_mark_product_dirty(text,text) to current_user;

create or replace function eide_product_dirty_trigger()
returns trigger language plpgsql as $$
begin
  perform eide_mark_product_dirty(new.id,'catalog');
  return new;
end $$;
drop trigger if exists eide_product_dirty_guard on products;
create trigger eide_product_dirty_guard
after insert or update of name,category,subcategory,brand,model,price,stock,description,image_path,status on products
for each row execute function eide_product_dirty_trigger();

create or replace function eide_order_item_dirty_trigger()
returns trigger language plpgsql as $$
begin
  perform eide_mark_product_dirty(new.product_id,'order-item');
  return new;
end $$;
drop trigger if exists eide_order_item_dirty_guard on order_items;
create trigger eide_order_item_dirty_guard after insert on order_items
for each row execute function eide_order_item_dirty_trigger();

create or replace function eide_order_status_dirty_trigger()
returns trigger language plpgsql as $$
declare r record;
begin
  if new.status is distinct from old.status then
    for r in select distinct product_id from order_items where order_id=new.id
    loop perform eide_mark_product_dirty(r.product_id,'order-status'); end loop;
  end if;
  return new;
end $$;
drop trigger if exists eide_order_status_dirty_guard on orders;
create trigger eide_order_status_dirty_guard after update of status on orders
for each row execute function eide_order_status_dirty_trigger();

-- Dirty trusted changes are refreshed first. Remaining capacity rotates through stale features,
-- preserving trend/freshness updates without requiring a full-catalog scan on every run.
create or replace function refresh_eide_features(p_limit integer default 500)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; n integer:=0; v_limit integer:=least(greatest(p_limit,1),2000);
begin
  if not pg_try_advisory_xact_lock(hashtext('elemarket:eide:feature-refresh')) then return 0; end if;
  for r in
    with selected as (
      select d.product_id as id,0 priority,d.dirty_at sort_at
        from eide_feature_dirty d join products p on p.id=d.product_id
       where p.status='active'
      union all
      select p.id,1 priority,coalesce(ef.feature_stale_after,ef.calculated_at,'-infinity'::timestamptz) sort_at
        from products p left join eide_product_features ef on ef.product_id=p.id
       where p.status='active' and not exists(select 1 from eide_feature_dirty d where d.product_id=p.id)
    )
    select id from selected order by priority,sort_at asc,id limit v_limit
  loop
    perform refresh_eide_product_feature(r.id);
    delete from eide_feature_dirty where product_id=r.id;
    n:=n+1;
  end loop;
  return n;
end $$;
revoke all on function refresh_eide_features(integer) from public;
grant execute on function refresh_eide_features(integer) to current_user;

