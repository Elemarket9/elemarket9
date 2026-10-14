-- ELEMARKET Intelligence & Discovery Engine (EIDE) v1.
-- Explainable, provider-neutral ranking/SEO features. Never mutates payment/order state.

create table if not exists eide_product_features (
  product_id text primary key references products(id) on delete cascade,
  merchant_confidence double precision not null default 0.50 check (merchant_confidence between 0 and 1),
  conversion_quality double precision not null default 0 check (conversion_quality between 0 and 1),
  popularity double precision not null default 0 check (popularity between 0 and 1),
  trend_momentum double precision not null default 0 check (trend_momentum between 0 and 1),
  freshness double precision not null default 0 check (freshness between 0 and 1),
  inventory_health double precision not null default 0 check (inventory_health between 0 and 1),
  exploration_bonus double precision not null default 0 check (exploration_bonus between 0 and 1),
  seo_quality double precision not null default 0 check (seo_quality between 0 and 1),
  indexability_score double precision not null default 0 check (indexability_score between 0 and 1),
  sample_size integer not null default 0 check (sample_size >= 0),
  model_version text not null default 'eide-v1',
  calculated_at timestamptz not null default now()
);
create index if not exists eide_product_features_rank_idx on eide_product_features(indexability_score desc,popularity desc,product_id);

create table if not exists eide_ranking_events (
  id bigserial primary key,
  event_type text not null check(event_type in ('impression','click','view','add_to_cart','purchase','delivered','cancelled','returned')),
  product_id text references products(id) on delete cascade,
  query_hash text,
  position integer check(position is null or position between 1 and 1000),
  model_version text not null default 'eide-v1',
  created_at timestamptz not null default now()
);
create index if not exists eide_ranking_events_product_time_idx on eide_ranking_events(product_id,created_at desc,event_type);
create index if not exists eide_ranking_events_query_time_idx on eide_ranking_events(query_hash,created_at desc) where query_hash is not null;
comment on table eide_ranking_events is 'Privacy-minimized EIDE feedback. No user id, IP, device fingerprint, or external analytics identifier.';

create table if not exists eide_seo_pages (
  page_key text primary key,
  page_type text not null check(page_type in ('product','category','subcategory','brand')),
  entity_key text not null,
  demand_score double precision not null default 0 check(demand_score between 0 and 1),
  inventory_depth_score double precision not null default 0 check(inventory_depth_score between 0 and 1),
  uniqueness_score double precision not null default 0 check(uniqueness_score between 0 and 1),
  content_quality_score double precision not null default 0 check(content_quality_score between 0 and 1),
  freshness_score double precision not null default 0 check(freshness_score between 0 and 1),
  indexability_score double precision not null default 0 check(indexability_score between 0 and 1),
  index_decision text not null default 'noindex' check(index_decision in ('index','noindex')),
  reason jsonb not null default '{}'::jsonb,
  model_version text not null default 'eide-seo-v1',
  calculated_at timestamptz not null default now()
);
create index if not exists eide_seo_pages_decision_idx on eide_seo_pages(index_decision,indexability_score desc,page_type);

-- Refresh one product from verified marketplace evidence. Bayesian priors deliberately
-- protect new/small merchants and prevent tiny samples from dominating established evidence.
create or replace function refresh_eide_product_feature(p_product_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v record;
  v_views numeric := 0; v_carts numeric := 0; v_orders numeric := 0; v_delivered numeric := 0;
  v_recent_views numeric := 0; v_prior_views numeric := 0;
  v_merchant numeric := 0.50; v_conversion numeric; v_pop numeric; v_trend numeric;
  v_fresh numeric; v_inventory numeric; v_explore numeric; v_seo numeric; v_index numeric; v_sample integer;
begin
  select p.*,m.status merchant_status,m.verified merchant_verified,coalesce(ms.score,500) merchant_score
    into v from products p join merchants m on m.id=p.merchant_id left join merchant_scores ms on ms.merchant_id=m.id
   where p.id=p_product_id;
  if not found then return; end if;

  select count(*) filter(where event_type='view'),count(*) filter(where event_type='add_to_cart'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '7 days'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '14 days' and created_at<now()-interval '7 days')
    into v_views,v_carts,v_recent_views,v_prior_views from marketplace_product_events where product_id=p_product_id and created_at>=now()-interval '90 days';
  select count(distinct oi.order_id),count(distinct oi.order_id) filter(where o.status in ('delivered','completed'))
    into v_orders,v_delivered from order_items oi join orders o on o.id=oi.order_id
   where oi.product_id=p_product_id and o.created_at>=now()-interval '180 days' and o.status<>'cancelled';

  -- Bayesian conversion estimate: Beta(2,38) prior ~= 5% until evidence accumulates.
  v_conversion := least(1,greatest(0,(2+v_orders)/(40+greatest(v_views,0))));
  -- Saturating popularity avoids winner-take-all behavior.
  v_pop := 1-exp(-greatest(0,v_views + 4*v_carts + 12*v_orders + 20*v_delivered)/250.0);
  -- Bounded week-over-week acceleration; neutral at 0.5 with no history.
  v_trend := least(1,greatest(0,0.5 + 0.5*((v_recent_views-v_prior_views)/(v_recent_views+v_prior_views+10))));
  v_fresh := exp(-greatest(0,extract(epoch from (now()-v.created_at))/86400.0)/90.0);
  v_inventory := case when v.stock<=0 then 0 else least(1,ln(1+v.stock::numeric)/ln(21)) end;
  v_sample := (v_views+v_carts+v_orders)::integer;
  -- UCB-inspired exploration, capped at 0.35 so relevance/quality still dominate.
  v_explore := least(0.35,sqrt(2*ln(2+greatest(v_views+v_orders,1))/(1+greatest(v_views+v_orders,0))));
  v_merchant := least(1,greatest(0,(v.merchant_score::numeric/1000.0)));
  if not v.merchant_verified or v.merchant_status<>'active' then v_merchant:=0; end if;

  -- Product-page SEO quality is based only on genuine catalog completeness.
  v_seo := least(1,greatest(0,
      (case when length(trim(v.name))>=12 then .18 else .08 end)
    + (case when length(trim(coalesce(v.description,'')))>=120 then .24 when length(trim(coalesce(v.description,'')))>=40 then .12 else 0 end)
    + (case when v.image_path is not null then .16 else 0 end)
    + (case when nullif(trim(coalesce(v.brand,'')),'') is not null then .10 else 0 end)
    + (case when nullif(trim(coalesce(v.model,'')),'') is not null then .08 else 0 end)
    + (case when v.stock>0 then .12 else 0 end)
    + .12*v_merchant));
  -- Geometric mean punishes thin pages rather than letting one strong signal hide weakness.
  v_index := power(greatest(v_seo,.001),.45)*power(greatest(v_inventory,.001),.20)*power(greatest(v_fresh,.001),.15)*power(greatest(v_merchant,.001),.20);

  insert into eide_product_features(product_id,merchant_confidence,conversion_quality,popularity,trend_momentum,freshness,inventory_health,exploration_bonus,seo_quality,indexability_score,sample_size,model_version,calculated_at)
  values(p_product_id,v_merchant,v_conversion,v_pop,v_trend,v_fresh,v_inventory,v_explore,v_seo,v_index,v_sample,'eide-v1',now())
  on conflict(product_id) do update set merchant_confidence=excluded.merchant_confidence,conversion_quality=excluded.conversion_quality,popularity=excluded.popularity,trend_momentum=excluded.trend_momentum,freshness=excluded.freshness,inventory_health=excluded.inventory_health,exploration_bonus=excluded.exploration_bonus,seo_quality=excluded.seo_quality,indexability_score=excluded.indexability_score,sample_size=excluded.sample_size,model_version=excluded.model_version,calculated_at=excluded.calculated_at;

  insert into eide_seo_pages(page_key,page_type,entity_key,demand_score,inventory_depth_score,uniqueness_score,content_quality_score,freshness_score,indexability_score,index_decision,reason,model_version,calculated_at)
  values('product:'||p_product_id,'product',p_product_id,v_pop,v_inventory,1,v_seo,v_fresh,v_index,case when v_index>=.42 and v.stock>0 and v.merchant_verified then 'index' else 'noindex' end,
    jsonb_build_object('seoQuality',round(v_seo::numeric,4),'inventoryHealth',round(v_inventory::numeric,4),'freshness',round(v_fresh::numeric,4),'merchantConfidence',round(v_merchant::numeric,4),'threshold',.42),'eide-seo-v1',now())
  on conflict(page_key) do update set demand_score=excluded.demand_score,inventory_depth_score=excluded.inventory_depth_score,uniqueness_score=excluded.uniqueness_score,content_quality_score=excluded.content_quality_score,freshness_score=excluded.freshness_score,indexability_score=excluded.indexability_score,index_decision=excluded.index_decision,reason=excluded.reason,model_version=excluded.model_version,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_product_feature(text) from public;
grant execute on function refresh_eide_product_feature(text) to current_user;

create or replace function refresh_eide_features(p_limit integer default 5000)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; n integer:=0;
begin
  for r in select p.id from products p left join eide_product_features ef on ef.product_id=p.id where p.status='active' order by ef.calculated_at asc nulls first,p.id limit least(greatest(p_limit,1),50000)
  loop perform refresh_eide_product_feature(r.id); n:=n+1; end loop;
  return n;
end $$;
revoke all on function refresh_eide_features(integer) from public;
grant execute on function refresh_eide_features(integer) to current_user;

-- Seed safe defaults; scheduled refreshes replace them with evidence-backed values.
insert into eide_product_features(product_id,freshness,inventory_health,seo_quality,indexability_score)
select p.id,exp(-greatest(0,extract(epoch from(now()-p.created_at))/86400.0)/90.0),case when p.stock>0 then .5 else 0 end,
       case when length(trim(coalesce(p.description,'')))>=40 and p.image_path is not null then .55 else .30 end,
       case when p.stock>0 then .40 else .05 end
from products p on conflict(product_id) do nothing;
