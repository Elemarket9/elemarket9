-- EIDE v2 hardening: manipulation resistance, freshness safety and scheduler concurrency.

create index if not exists marketplace_product_events_product_time_idx
  on marketplace_product_events(product_id,created_at desc,event_type);
create index if not exists order_items_product_order_idx on order_items(product_id,order_id);

alter table eide_product_features
  add column if not exists trusted_commerce_score double precision not null default 0
    check (trusted_commerce_score between 0 and 1),
  add column if not exists feature_stale_after timestamptz;

-- v2 deliberately treats anonymous views/carts as weak discovery evidence. Completed commerce
-- is the authoritative popularity signal; bot-inflatable funnel activity is capped.
create or replace function refresh_eide_product_feature(p_product_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v record;
  v_views numeric := 0; v_carts numeric := 0; v_orders numeric := 0; v_delivered numeric := 0;
  v_recent_views numeric := 0; v_prior_views numeric := 0;
  v_merchant numeric := 0.50; v_conversion numeric; v_pop numeric; v_trend numeric;
  v_fresh numeric; v_inventory numeric; v_explore numeric; v_seo numeric; v_index numeric;
  v_trusted numeric; v_sample integer;
begin
  select p.*,m.status merchant_status,m.verified merchant_verified,coalesce(ms.score,500) merchant_score
    into v from products p join merchants m on m.id=p.merchant_id left join merchant_scores ms on ms.merchant_id=m.id
   where p.id=p_product_id;
  if not found then return; end if;

  select count(*) filter(where event_type='view'),count(*) filter(where event_type='add_to_cart'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '7 days'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '14 days' and created_at<now()-interval '7 days')
    into v_views,v_carts,v_recent_views,v_prior_views
    from marketplace_product_events where product_id=p_product_id and created_at>=now()-interval '90 days';

  select count(distinct oi.order_id),count(distinct oi.order_id) filter(where o.status in ('delivered','completed'))
    into v_orders,v_delivered from order_items oi join orders o on o.id=oi.order_id
   where oi.product_id=p_product_id and o.created_at>=now()-interval '180 days' and o.status not in ('cancelled','refunded');

  -- Beta prior plus bounded denominator: anonymous view inflation can only reduce this signal,
  -- never manufacture purchases. The ranking weight is intentionally small.
  v_conversion := least(1,greatest(0,(2+v_orders)/(40+greatest(v_views,0))));
  -- Trusted commerce dominates. Anonymous engagement contributes at most 0.18 of popularity.
  v_trusted := 1-exp(-greatest(0,10*v_orders + 22*v_delivered)/180.0);
  v_pop := least(1, .82*v_trusted + .18*(1-exp(-least(500,greatest(0,v_views + 3*v_carts))/180.0)));
  -- Trend is confidence-shrunk toward neutral until there is enough recent evidence.
  v_trend := least(1,greatest(0,0.5 +
    (least(1,(v_recent_views+v_prior_views)/80.0) * 0.5*((v_recent_views-v_prior_views)/(v_recent_views+v_prior_views+20)))));
  v_fresh := exp(-greatest(0,extract(epoch from (now()-v.created_at))/86400.0)/90.0);
  v_inventory := case when v.stock<=0 then 0 else least(1,ln(1+v.stock::numeric)/ln(21)) end;
  v_sample := least(2147483647,(v_views+v_carts+v_orders))::integer;
  -- Exploration is confidence-aware and strictly capped; it cannot rescue irrelevant results.
  v_explore := 0.25/sqrt(1+greatest(v_orders+v_delivered,0));
  v_merchant := least(1,greatest(0,(v.merchant_score::numeric/1000.0)));
  if not v.merchant_verified or v.merchant_status<>'active' then v_merchant:=0; end if;

  v_seo := least(1,greatest(0,
      (case when length(trim(v.name))>=12 then .18 else .08 end)
    + (case when length(trim(coalesce(v.description,'')))>=120 then .24 when length(trim(coalesce(v.description,'')))>=40 then .12 else 0 end)
    + (case when v.image_path is not null then .16 else 0 end)
    + (case when nullif(trim(coalesce(v.brand,'')),'') is not null then .10 else 0 end)
    + (case when nullif(trim(coalesce(v.model,'')),'') is not null then .08 else 0 end)
    + (case when v.stock>0 then .12 else 0 end)
    + .12*v_merchant));
  v_index := power(greatest(v_seo,.001),.45)*power(greatest(v_inventory,.001),.20)*power(greatest(v_fresh,.001),.15)*power(greatest(v_merchant,.001),.20);

  insert into eide_product_features(product_id,merchant_confidence,conversion_quality,popularity,trend_momentum,freshness,inventory_health,exploration_bonus,seo_quality,indexability_score,sample_size,model_version,calculated_at,trusted_commerce_score,feature_stale_after)
  values(p_product_id,v_merchant,v_conversion,v_pop,v_trend,v_fresh,v_inventory,v_explore,v_seo,v_index,v_sample,'eide-v2',now(),v_trusted,now()+interval '6 hours')
  on conflict(product_id) do update set merchant_confidence=excluded.merchant_confidence,conversion_quality=excluded.conversion_quality,popularity=excluded.popularity,trend_momentum=excluded.trend_momentum,freshness=excluded.freshness,inventory_health=excluded.inventory_health,exploration_bonus=excluded.exploration_bonus,seo_quality=excluded.seo_quality,indexability_score=excluded.indexability_score,sample_size=excluded.sample_size,model_version=excluded.model_version,calculated_at=excluded.calculated_at,trusted_commerce_score=excluded.trusted_commerce_score,feature_stale_after=excluded.feature_stale_after;

  insert into eide_seo_pages(page_key,page_type,entity_key,demand_score,inventory_depth_score,uniqueness_score,content_quality_score,freshness_score,indexability_score,index_decision,reason,model_version,calculated_at)
  values('product:'||p_product_id,'product',p_product_id,v_pop,v_inventory,1,v_seo,v_fresh,v_index,
    case when v_index>=.42 and v.stock>0 and v.merchant_verified and v.merchant_status='active' then 'index' else 'noindex' end,
    jsonb_build_object('seoQuality',round(v_seo::numeric,4),'inventoryHealth',round(v_inventory::numeric,4),'freshness',round(v_fresh::numeric,4),'merchantConfidence',round(v_merchant::numeric,4),'trustedCommerce',round(v_trusted::numeric,4),'threshold',.42),'eide-seo-v2',now())
  on conflict(page_key) do update set demand_score=excluded.demand_score,inventory_depth_score=excluded.inventory_depth_score,uniqueness_score=excluded.uniqueness_score,content_quality_score=excluded.content_quality_score,freshness_score=excluded.freshness_score,indexability_score=excluded.indexability_score,index_decision=excluded.index_decision,reason=excluded.reason,model_version=excluded.model_version,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_product_feature(text) from public;
grant execute on function refresh_eide_product_feature(text) to current_user;

create or replace function refresh_eide_features(p_limit integer default 250)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; n integer:=0;
begin
  -- One refresher per database at a time. A skipped overlapping run is safe because the next
  -- scheduled run selects the oldest/stalest rows first.
  if not pg_try_advisory_xact_lock(hashtext('elemarket:eide:feature-refresh')) then return 0; end if;
  for r in
    select p.id from products p left join eide_product_features ef on ef.product_id=p.id
     where p.status='active'
     order by coalesce(ef.feature_stale_after,ef.calculated_at, '-infinity'::timestamptz) asc,p.id
     limit least(greatest(p_limit,1),2000)
  loop perform refresh_eide_product_feature(r.id); n:=n+1; end loop;
  return n;
end $$;
revoke all on function refresh_eide_features(integer) from public;
grant execute on function refresh_eide_features(integer) to current_user;

create or replace function prune_eide_events(p_limit integer default 10000)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer:=0;
begin
  with doomed as (
    select ctid from eide_ranking_events where created_at < now()-interval '180 days'
    order by created_at asc limit least(greatest(p_limit,1),50000)
  )
  delete from eide_ranking_events e using doomed d where e.ctid=d.ctid;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function prune_eide_events(integer) from public;
grant execute on function prune_eide_events(integer) to current_user;
