-- EIDE v3 adversarial hardening: sabotage resistance, trusted-commerce ranking,
-- evergreen SEO safety, product update compatibility, and bounded event retention.

alter table products add column if not exists updated_at timestamptz not null default now();

create or replace function eide_touch_product_updated_at()
returns trigger language plpgsql as $$
begin
  -- Only meaningful catalog changes refresh the product timestamp. EIDE feature writes never touch products.
  if row(new.name,new.category,new.subcategory,new.brand,new.model,new.price,new.stock,new.description,new.image_path,new.status)
     is distinct from
     row(old.name,old.category,old.subcategory,old.brand,old.model,old.price,old.stock,old.description,old.image_path,old.status) then
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists products_updated_at_guard on products;
create trigger products_updated_at_guard before update on products for each row execute function eide_touch_product_updated_at();

create or replace function refresh_eide_product_feature(p_product_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v record;
  v_views numeric := 0; v_carts numeric := 0; v_orders numeric := 0; v_delivered numeric := 0;
  v_failures numeric := 0; v_recent_views numeric := 0; v_prior_views numeric := 0;
  v_merchant numeric := 0.50; v_conversion numeric; v_pop numeric; v_trend numeric;
  v_fresh numeric; v_seo_fresh numeric; v_inventory numeric; v_explore numeric; v_seo numeric; v_index numeric;
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
  v_fresh := exp(-greatest(0,extract(epoch from (now()-greatest(v.created_at,v.updated_at)))/86400.0)/180.0);
  v_seo_fresh := greatest(.65,v_fresh);
  v_inventory := case when v.stock<=0 then 0 else least(1,ln(1+v.stock::numeric)/ln(21)) end;
  v_sample := least(2147483647,(v_views+v_carts+v_orders+v_delivered+v_failures))::integer;
  v_explore := 0.22/sqrt(1+greatest(v_orders+v_delivered,0));
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
  v_index := power(greatest(v_seo,.001),.45)*power(greatest(v_inventory,.001),.20)*power(greatest(v_seo_fresh,.001),.15)*power(greatest(v_merchant,.001),.20);

  insert into eide_product_features(product_id,merchant_confidence,conversion_quality,popularity,trend_momentum,freshness,inventory_health,exploration_bonus,seo_quality,indexability_score,sample_size,model_version,calculated_at,trusted_commerce_score,feature_stale_after)
  values(p_product_id,v_merchant,v_conversion,v_pop,v_trend,v_fresh,v_inventory,v_explore,v_seo,v_index,v_sample,'eide-v3',now(),v_trusted,now()+interval '6 hours')
  on conflict(product_id) do update set merchant_confidence=excluded.merchant_confidence,conversion_quality=excluded.conversion_quality,popularity=excluded.popularity,trend_momentum=excluded.trend_momentum,freshness=excluded.freshness,inventory_health=excluded.inventory_health,exploration_bonus=excluded.exploration_bonus,seo_quality=excluded.seo_quality,indexability_score=excluded.indexability_score,sample_size=excluded.sample_size,model_version=excluded.model_version,calculated_at=excluded.calculated_at,trusted_commerce_score=excluded.trusted_commerce_score,feature_stale_after=excluded.feature_stale_after;

  insert into eide_seo_pages(page_key,page_type,entity_key,demand_score,inventory_depth_score,uniqueness_score,content_quality_score,freshness_score,indexability_score,index_decision,reason,model_version,calculated_at)
  values('product:'||p_product_id,'product',p_product_id,v_pop,v_inventory,1,v_seo,v_seo_fresh,v_index,
    case when v_index>=.42 and v.stock>0 and v.merchant_verified and v.merchant_status='active' and v.status='active' then 'index' else 'noindex' end,
    jsonb_build_object('seoQuality',round(v_seo::numeric,4),'inventoryHealth',round(v_inventory::numeric,4),'seoFreshness',round(v_seo_fresh::numeric,4),'merchantConfidence',round(v_merchant::numeric,4),'trustedCommerce',round(v_trusted::numeric,4),'threshold',.42),'eide-seo-v3',now())
  on conflict(page_key) do update set demand_score=excluded.demand_score,inventory_depth_score=excluded.inventory_depth_score,uniqueness_score=excluded.uniqueness_score,content_quality_score=excluded.content_quality_score,freshness_score=excluded.freshness_score,indexability_score=excluded.indexability_score,index_decision=excluded.index_decision,reason=excluded.reason,model_version=excluded.model_version,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_product_feature(text) from public;
grant execute on function refresh_eide_product_feature(text) to current_user;

create or replace function prune_eide_events(p_limit integer default 10000)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n1 integer:=0; n2 integer:=0;
begin
  with doomed as (
    select ctid from eide_ranking_events where created_at < now()-interval '180 days'
    order by created_at asc limit least(greatest(p_limit,1),50000)
  ) delete from eide_ranking_events e using doomed d where e.ctid=d.ctid;
  get diagnostics n1 = row_count;
  -- Funnel events are only consumed over 90 days (merchant dashboard uses 30), so keeping
  -- them forever creates storage/maintenance exposure without ranking value.
  with doomed as (
    select ctid from marketplace_product_events where created_at < now()-interval '120 days'
    order by created_at asc limit least(greatest(p_limit,1),50000)
  ) delete from marketplace_product_events e using doomed d where e.ctid=d.ctid;
  get diagnostics n2 = row_count;
  return n1+n2;
end $$;
revoke all on function prune_eide_events(integer) from public;
grant execute on function prune_eide_events(integer) to current_user;
