-- EIDE v6 algorithm-correctness hardening.
-- Separates marketplace discovery quality from financing/credit health, rate-limits freshness
-- manipulation, and prevents canonical-equivalent merchant offers from all becoming SEO documents.

alter table products add column if not exists eide_content_freshness_at timestamptz;
update products set eide_content_freshness_at=created_at where eide_content_freshness_at is null;
alter table products alter column eide_content_freshness_at set default now();
alter table products alter column eide_content_freshness_at set not null;

create or replace function eide_touch_content_freshness()
returns trigger language plpgsql as $$
begin
  -- Price/stock/status churn must not manufacture ranking freshness. Genuine content changes can
  -- refresh this signal at most once every 30 days, bounding deliberate freshness gaming.
  if row(new.name,new.category,new.subcategory,new.brand,new.model,new.description,new.image_path)
     is distinct from row(old.name,old.category,old.subcategory,old.brand,old.model,old.description,old.image_path)
     and old.eide_content_freshness_at <= now()-interval '30 days' then
    new.eide_content_freshness_at:=now();
  end if;
  return new;
end $$;
drop trigger if exists products_eide_content_freshness_guard on products;
create trigger products_eide_content_freshness_guard before update of name,category,subcategory,brand,model,description,image_path on products
for each row execute function eide_touch_content_freshness();

create or replace function refresh_eide_product_feature(p_product_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v record;
  v_views numeric := 0; v_carts numeric := 0; v_orders numeric := 0; v_delivered numeric := 0;
  v_failures numeric := 0; v_recent_views numeric := 0; v_prior_views numeric := 0;
  v_merchant numeric := 0.50; v_conversion numeric; v_pop numeric; v_trend numeric;
  v_fresh numeric; v_seo_fresh numeric; v_inventory numeric; v_explore numeric; v_seo numeric; v_index numeric;
  v_trusted numeric; v_sample integer; v_unique numeric := 1; v_is_seo_primary boolean := true;
  v_service record;
begin
  select p.*,m.status merchant_status,m.verified merchant_verified
    into v from products p join merchants m on m.id=p.merchant_id
   where p.id=p_product_id;
  if not found then return; end if;

  select count(*) filter(where event_type='view'),count(*) filter(where event_type='add_to_cart'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '7 days'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '14 days' and created_at<now()-interval '7 days')
    into v_views,v_carts,v_recent_views,v_prior_views
    from marketplace_product_events where product_id=p_product_id and created_at>=now()-interval '90 days';

  select count(distinct oi.order_id) filter(where o.status not in ('cancelled','refunded')),
         count(distinct oi.order_id) filter(where o.status in ('delivered','completed')),
         count(distinct oi.order_id) filter(where o.status in ('refunded','disputed'))
    into v_orders,v_delivered,v_failures
    from order_items oi join orders o on o.id=oi.order_id
   where oi.product_id=p_product_id and o.created_at>=now()-interval '180 days';

  -- Never let anonymous traffic hurt another listing. Quality is derived only from trusted
  -- commerce outcomes with a conservative Beta prior. View floods cannot lower this score.
  v_conversion := least(1,greatest(0,(4+v_delivered)/(8+v_delivered+v_failures)));
  v_trusted := 1-exp(-greatest(0,10*v_orders + 22*v_delivered)/180.0);
  -- Anonymous engagement is a capped positive hint only; verified commerce owns 88% of popularity.
  v_pop := least(1, .88*v_trusted + .12*(1-exp(-least(300,greatest(0,v_views + 2*v_carts))/180.0)));
  v_trend := least(1,greatest(0,0.5 +
    (least(1,(v_recent_views+v_prior_views)/120.0) * 0.5*((v_recent_views-v_prior_views)/(v_recent_views+v_prior_views+30)))));
  -- Ranking freshness rewards genuinely newer/changed inventory but decays; SEO freshness has an
  -- evergreen floor so an old, complete, in-stock product is not automatically deindexed by age.
  v_fresh := exp(-greatest(0,extract(epoch from (now()-greatest(v.created_at,v.eide_content_freshness_at)))/86400.0)/180.0);
  v_seo_fresh := greatest(.65,v_fresh);
  v_inventory := case when v.stock<=0 then 0 else least(1,ln(1+v.stock::numeric)/ln(21)) end;
  v_sample := least(2147483647,(v_views+v_carts+v_orders+v_delivered+v_failures))::integer;
  v_explore := 0.22/sqrt(1+greatest(v_orders+v_delivered,0));
  -- Discovery uses marketplace service quality, never financing/credit health. Sparse history shrinks to neutral.
  select * into v_service from merchant_service_quality_snapshots q where q.merchant_id=v.merchant_id order by q.calculated_at desc limit 1;
  if found then
    v_merchant := 0.5 + (least(greatest(coalesce(v_service.order_count,0),0),200)::numeric/(least(greatest(coalesce(v_service.order_count,0),0),200)+20)) *
      ((.35*coalesce(v_service.inventory_accuracy,1) + .20*coalesce(v_service.response_rate,1) + .15*(1-coalesce(v_service.cancellation_rate,0)) + .10*(1-coalesce(v_service.late_ship_rate,0)) + .10*(1-coalesce(v_service.return_rate,0)) + .10*(1-coalesce(v_service.dispute_rate,0))) - .5);
    if v_service.service_band='watch' then v_merchant:=least(v_merchant,.45); end if;
    if v_service.service_band='restricted' then v_merchant:=least(v_merchant,.25); end if;
  else v_merchant:=.5; end if;
  if not v.merchant_verified or v.merchant_status<>'active' then v_merchant:=0; end if;

  -- Canonical-equivalent merchant offers are not all unique SEO documents. Elect one stable,
  -- eligible representative; other offers remain live/searchable but are noindex.
  if nullif(trim(coalesce(v.canonical_product_key,'')),'') is not null then
    select (p2.id=p_product_id) into v_is_seo_primary
      from products p2 join merchants m2 on m2.id=p2.merchant_id
     where p2.canonical_product_key=v.canonical_product_key and p2.status='active' and p2.stock>0
       and m2.status='active' and m2.verified=true
     order by p2.id asc limit 1;
    v_is_seo_primary := coalesce(v_is_seo_primary,false);
    v_unique := case when v_is_seo_primary then 1 else .20 end;
  end if;

  v_seo := least(1,greatest(0,
      (case when length(trim(v.name))>=12 then .18 else .08 end)
    + (case when length(trim(coalesce(v.description,'')))>=120 then .24 when length(trim(coalesce(v.description,'')))>=40 then .12 else 0 end)
    + (case when v.image_path is not null then .16 else 0 end)
    + (case when nullif(trim(coalesce(v.brand,'')),'') is not null then .10 else 0 end)
    + (case when nullif(trim(coalesce(v.model,'')),'') is not null then .08 else 0 end)
    + (case when v.stock>0 then .12 else 0 end)
    + .12*v_merchant));
  v_index := power(greatest(v_seo,.001),.40)*power(greatest(v_inventory,.001),.18)*power(greatest(v_seo_fresh,.001),.14)*power(greatest(v_merchant,.001),.18)*power(greatest(v_unique,.001),.10);

  insert into eide_product_features(product_id,merchant_confidence,conversion_quality,popularity,trend_momentum,freshness,inventory_health,exploration_bonus,seo_quality,indexability_score,sample_size,model_version,calculated_at,trusted_commerce_score,feature_stale_after)
  values(p_product_id,v_merchant,v_conversion,v_pop,v_trend,v_fresh,v_inventory,v_explore,v_seo,v_index,v_sample,'eide-v6',now(),v_trusted,now()+interval '6 hours')
  on conflict(product_id) do update set merchant_confidence=excluded.merchant_confidence,conversion_quality=excluded.conversion_quality,popularity=excluded.popularity,trend_momentum=excluded.trend_momentum,freshness=excluded.freshness,inventory_health=excluded.inventory_health,exploration_bonus=excluded.exploration_bonus,seo_quality=excluded.seo_quality,indexability_score=excluded.indexability_score,sample_size=excluded.sample_size,model_version=excluded.model_version,calculated_at=excluded.calculated_at,trusted_commerce_score=excluded.trusted_commerce_score,feature_stale_after=excluded.feature_stale_after;

  insert into eide_seo_pages(page_key,page_type,entity_key,demand_score,inventory_depth_score,uniqueness_score,content_quality_score,freshness_score,indexability_score,index_decision,reason,model_version,calculated_at)
  values('product:'||p_product_id,'product',p_product_id,v_pop,v_inventory,v_unique,v_seo,v_seo_fresh,v_index,
    case when v_index>=.42 and v_unique>=.5 and v.stock>0 and v.merchant_verified and v.merchant_status='active' and v.status='active' then 'index' else 'noindex' end,
    jsonb_build_object('seoQuality',round(v_seo::numeric,4),'inventoryHealth',round(v_inventory::numeric,4),'seoFreshness',round(v_seo_fresh::numeric,4),'merchantConfidence',round(v_merchant::numeric,4),'trustedCommerce',round(v_trusted::numeric,4),'uniqueness',round(v_unique::numeric,4),'canonicalRepresentative',v_is_seo_primary,'threshold',.42),'eide-seo-v6',now())
  on conflict(page_key) do update set demand_score=excluded.demand_score,inventory_depth_score=excluded.inventory_depth_score,uniqueness_score=excluded.uniqueness_score,content_quality_score=excluded.content_quality_score,freshness_score=excluded.freshness_score,indexability_score=excluded.indexability_score,index_decision=excluded.index_decision,reason=excluded.reason,model_version=excluded.model_version,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_product_feature(text) from public;
grant execute on function refresh_eide_product_feature(text) to current_user;

