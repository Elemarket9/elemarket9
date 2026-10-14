-- EIDE v5 developer-test hardening.
-- Fixes a lost-invalidation race in the trusted dirty-feature queue.
-- Workers now claim (delete) a dirty marker BEFORE recomputation. PostgreSQL row locking means
-- a concurrent trusted catalog/order change waits and then inserts a fresh marker after commit;
-- it can no longer be erased by an older refresh finishing later.

-- Stamp the current algorithm version explicitly so observability/A-B attribution is truthful.
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
  values(p_product_id,v_merchant,v_conversion,v_pop,v_trend,v_fresh,v_inventory,v_explore,v_seo,v_index,v_sample,'eide-v5',now(),v_trusted,now()+interval '6 hours')
  on conflict(product_id) do update set merchant_confidence=excluded.merchant_confidence,conversion_quality=excluded.conversion_quality,popularity=excluded.popularity,trend_momentum=excluded.trend_momentum,freshness=excluded.freshness,inventory_health=excluded.inventory_health,exploration_bonus=excluded.exploration_bonus,seo_quality=excluded.seo_quality,indexability_score=excluded.indexability_score,sample_size=excluded.sample_size,model_version=excluded.model_version,calculated_at=excluded.calculated_at,trusted_commerce_score=excluded.trusted_commerce_score,feature_stale_after=excluded.feature_stale_after;

  insert into eide_seo_pages(page_key,page_type,entity_key,demand_score,inventory_depth_score,uniqueness_score,content_quality_score,freshness_score,indexability_score,index_decision,reason,model_version,calculated_at)
  values('product:'||p_product_id,'product',p_product_id,v_pop,v_inventory,1,v_seo,v_seo_fresh,v_index,
    case when v_index>=.42 and v.stock>0 and v.merchant_verified and v.merchant_status='active' and v.status='active' then 'index' else 'noindex' end,
    jsonb_build_object('seoQuality',round(v_seo::numeric,4),'inventoryHealth',round(v_inventory::numeric,4),'seoFreshness',round(v_seo_fresh::numeric,4),'merchantConfidence',round(v_merchant::numeric,4),'trustedCommerce',round(v_trusted::numeric,4),'threshold',.42),'eide-seo-v5',now())
  on conflict(page_key) do update set demand_score=excluded.demand_score,inventory_depth_score=excluded.inventory_depth_score,uniqueness_score=excluded.uniqueness_score,content_quality_score=excluded.content_quality_score,freshness_score=excluded.freshness_score,indexability_score=excluded.indexability_score,index_decision=excluded.index_decision,reason=excluded.reason,model_version=excluded.model_version,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_product_feature(text) from public;
grant execute on function refresh_eide_product_feature(text) to current_user;


create or replace function refresh_eide_features(p_limit integer default 500)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r record; n integer:=0; v_limit integer:=least(greatest(p_limit,1),2000);
begin
  if not pg_try_advisory_xact_lock(hashtext('elemarket:eide:feature-refresh')) then return 0; end if;

  -- Markers for inactive/deleted catalog entries have no ranking value and must not poison the queue.
  delete from eide_feature_dirty d
   where not exists(select 1 from products p where p.id=d.product_id and p.status='active');

  -- Trusted changes first. DELETE ... RETURNING is the claim operation. If recomputation raises,
  -- the statement/transaction rolls back and the marker is restored. A concurrent trigger cannot
  -- lose its newer invalidation because it must wait on this row and then upsert after commit.
  for r in
    with claimed as (
      delete from eide_feature_dirty d
       where d.product_id in (
         select d2.product_id
           from eide_feature_dirty d2
           join products p2 on p2.id=d2.product_id and p2.status='active'
          order by d2.dirty_at asc,d2.product_id asc
          limit v_limit
          for update of d2 skip locked
       )
       returning d.product_id
    )
    select product_id as id from claimed order by product_id
  loop
    perform refresh_eide_product_feature(r.id);
    n:=n+1;
  end loop;

  -- Use remaining capacity for missing/stale/oldest features. Dirty rows are excluded because a
  -- trusted invalidation always has priority on the next pass.
  if n < v_limit then
    for r in
      select p.id
        from products p
        left join eide_product_features ef on ef.product_id=p.id
       where p.status='active'
         and not exists(select 1 from eide_feature_dirty d where d.product_id=p.id)
       order by coalesce(ef.feature_stale_after,ef.calculated_at,'-infinity'::timestamptz) asc,p.id asc
       limit (v_limit-n)
    loop
      perform refresh_eide_product_feature(r.id);
      n:=n+1;
    end loop;
  end if;
  return n;
end $$;
revoke all on function refresh_eide_features(integer) from public;
grant execute on function refresh_eide_features(integer) to current_user;
