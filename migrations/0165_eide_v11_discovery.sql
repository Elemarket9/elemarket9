-- EIDE V11: bounded database-managed discovery metadata. No financial tables altered.
create table if not exists marketplace_discovery_taxonomy_aliases (
  alias text primary key check(char_length(alias) between 1 and 60),
  category text not null references category_taxonomy(category_key),
  subcategory text,
  active boolean not null default true,
  foreign key(category,subcategory) references category_subcategories(category_key,subcategory_key)
);
create table if not exists marketplace_discovery_attribute_definitions (
  category text not null references category_taxonomy(category_key),
  subcategory text not null default '',
  attribute_key text not null check(char_length(attribute_key) between 1 and 60),
  attribute_keys text[] not null check(cardinality(attribute_keys) between 1 and 8),
  aliases text[] not null check(cardinality(aliases) between 1 and 8),
  unit text check(unit is null or unit in ('gb','inch')),
  active boolean not null default true,
  primary key(category,subcategory,attribute_key)
);
insert into marketplace_search_synonyms(id,term,synonym,locale)
values ('eide11_tv','tv','television','en-GH'),('eide11_phone','phone','smartphone','en-GH'),
 ('eide11_notebook','notebook','laptop','en-GH'),('eide11_phones','phone','phones','en-GH'),
 ('eide11_tvs','tv','tvs','en-GH'),('eide11_laptops','laptop','laptops','en-GH')
on conflict(term,synonym,locale) do nothing;
insert into marketplace_discovery_taxonomy_aliases(alias,category,subcategory)
values ('phone','electronics','mobile-phones'),('phones','electronics','mobile-phones'),('smartphone','electronics','mobile-phones'),
 ('smartphones','electronics','mobile-phones'),('laptop','electronics','laptops'),('laptops','electronics','laptops'),('notebook','electronics','laptops'),
 ('tv','electronics','tv'),('tvs','electronics','tv'),('television','electronics','tv'),('televisions','electronics','tv'),
 ('shoes','fashion','footwear'),('shoe','fashion','footwear')
on conflict(alias) do nothing;
insert into marketplace_discovery_attribute_definitions(category,subcategory,attribute_key,attribute_keys,aliases,unit)
values
 ('electronics','mobile-phones','storage',array['storage_gb','storage','capacity','internal_storage'],array['storage','capacity'],'gb'),
 ('electronics','mobile-phones','ram',array['ram_gb','ram','memory'],array['ram'],'gb'),
 ('electronics','laptops','ram',array['ram_gb','ram','memory'],array['ram'],'gb'),
 ('electronics','laptops','storage',array['storage_gb','storage','capacity','ssd_capacity'],array['storage','ssd'],'gb'),
 ('electronics','laptops','storage_type',array['storage_type','drive_type'],array['drive'],null) ,
 ('electronics','tv','display_size',array['screen_inches','display_size','screen_size','size'],array['screen','display'],'inch'),
 ('electronics','tv','resolution',array['resolution','display_resolution'],array['resolution'],null) ,
 ('fashion','footwear','size',array['size','shoe_size'],array['size'],null) ,
 ('fashion','footwear','color',array['color','colour'],array['color','colour'],null)
on conflict do nothing;
create or replace function refresh_eide_merchant_service_quality(p_merchant_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_orders integer:=0; v_cancel integer:=0; v_dispute integer:=0; v_returns integer:=0;
  v_cancel_rate numeric:=0; v_dispute_rate numeric:=0; v_return_rate numeric:=0;
  v_band text:='new'; v_start timestamptz:=now()-interval '180 days'; v_end timestamptz:=now();
begin
  if not exists(select 1 from merchants where id=p_merchant_id) then return; end if;
  select count(*)::int,
         count(*) filter(where status='cancelled')::int,
         count(*) filter(where status='disputed')::int
    into v_orders,v_cancel,v_dispute
    from orders o where merchant_id=p_merchant_id and created_at>=v_start and not exists(select 1 from merchant_accounts ma where ma.merchant_id=o.merchant_id and ma.user_id=o.user_id) and (o.status in ('delivered','completed','refunded','disputed') or exists(select 1 from payments pay where pay.order_id=o.id and pay.status='completed'));
  select count(distinct rr.order_id)::int into v_returns
    from return_requests rr where rr.merchant_id=p_merchant_id and rr.created_at>=v_start
      and rr.status in ('approved','received','refund_pending','refunded');
  if v_orders>0 then
    v_cancel_rate:=least(1,v_cancel::numeric/v_orders);
    v_dispute_rate:=least(1,v_dispute::numeric/v_orders);
    v_return_rate:=least(1,v_returns::numeric/v_orders);
    v_band:=case when v_dispute_rate>=.15 or v_cancel_rate>=.25 then 'restricted'
                 when v_dispute_rate>=.08 or v_cancel_rate>=.15 or v_return_rate>=.20 then 'watch'
                 else 'standard' end;
  end if;
  -- Inventory accuracy, response rate and late shipping require dedicated evidence not available
  -- for every merchant. Store neutral .5 rather than manufacturing perfect 1.0 values.
  insert into merchant_service_quality_snapshots(id,merchant_id,window_start,window_end,order_count,
    cancellation_rate,late_ship_rate,return_rate,dispute_rate,inventory_accuracy,response_rate,service_band,model_version,calculated_at)
  values('eide11_'||md5(p_merchant_id||date_trunc('day',v_end)::text),p_merchant_id,date_trunc('day',v_start),date_trunc('day',v_end),v_orders,
    v_cancel_rate,.5,v_return_rate,v_dispute_rate,.5,.5,v_band,'eide-service-v11',now())
  on conflict(merchant_id,window_start,window_end,model_version) do update set
    order_count=excluded.order_count,cancellation_rate=excluded.cancellation_rate,late_ship_rate=excluded.late_ship_rate,
    return_rate=excluded.return_rate,dispute_rate=excluded.dispute_rate,inventory_accuracy=excluded.inventory_accuracy,
    response_rate=excluded.response_rate,service_band=excluded.service_band,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_merchant_service_quality(text) from public;
grant execute on function refresh_eide_merchant_service_quality(text) to current_user;



-- One-VPS bounded service-quality worker: each merchant history is aggregated once per refresh cycle,
-- not once for every product belonging to that merchant.
create or replace function refresh_eide_merchant_quality_batch(p_limit integer default 10)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; n integer:=0; v_limit integer:=least(greatest(p_limit,1),50);
begin
  if not pg_try_advisory_xact_lock(hashtext('elemarket:eide:merchant-quality-refresh')) then return 0; end if;
  for r in
    select m.id
      from merchants m
      left join lateral (
        select q.calculated_at from merchant_service_quality_snapshots q
         where q.merchant_id=m.id and q.model_version='eide-service-v11'
         order by q.calculated_at desc limit 1
      ) q on true
     where m.status='active'
     order by coalesce(q.calculated_at,'-infinity'::timestamptz) asc,m.id asc
     limit v_limit
  loop
    perform refresh_eide_merchant_service_quality(r.id); n:=n+1;
  end loop;
  return n;
end $$;
revoke all on function refresh_eide_merchant_quality_batch(integer) from public;
grant execute on function refresh_eide_merchant_quality_batch(integer) to current_user;

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
  -- Repair derived attribute vocabulary on the existing bounded feature sweep.
  perform refresh_discovery_product_attributes(p_product_id);

  select count(*) filter(where event_type='view'),count(*) filter(where event_type='add_to_cart'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '7 days'),
         count(*) filter(where event_type='view' and created_at>=now()-interval '14 days' and created_at<now()-interval '7 days')
    into v_views,v_carts,v_recent_views,v_prior_views
    from marketplace_product_events where product_id=p_product_id and created_at>=now()-interval '90 days';

  select count(distinct oi.order_id) filter(where o.status in ('delivered','completed')),
         count(distinct oi.order_id) filter(where o.status in ('delivered','completed')),
         count(distinct oi.order_id) filter(where o.status in ('refunded','disputed'))
    into v_orders,v_delivered,v_failures
    from order_items oi join orders o on o.id=oi.order_id
   where oi.product_id=p_product_id and o.created_at>=now()-interval '180 days' and not exists(select 1 from merchant_accounts ma where ma.merchant_id=o.merchant_id and ma.user_id=o.user_id) and not exists(select 1 from return_requests rr where rr.order_id=o.id and rr.status in ('approved','received','refund_pending','refunded'));

  -- Never let anonymous traffic hurt another listing. Quality is derived only from trusted
  -- commerce outcomes with a conservative Beta prior. View floods cannot lower this score.
  v_conversion := least(1,greatest(0,(4+v_delivered)/(8+v_delivered+v_failures)));
  v_trusted := 1-exp(-greatest(0,10*v_orders + 22*v_delivered)/180.0);
  -- Anonymous engagement is a capped positive hint only; verified commerce owns 88% of popularity.
  v_pop := least(1, .88*v_trusted + .12*(1-exp(-least(300,greatest(0,v_views + 2*v_carts))/180.0)));
  -- Anonymous engagement must never penalize a competitor; trend is neutral
  -- until a trustworthy attributed time-series is available.
  v_trend := .5;
  -- Ranking freshness rewards genuinely newer/changed inventory but decays; SEO freshness has an
  -- evergreen floor so an old, complete, in-stock product is not automatically deindexed by age.
  v_fresh := exp(-greatest(0,extract(epoch from (now()-v.created_at))/86400.0)/180.0);
  v_seo_fresh := greatest(.65,v_fresh);
  v_inventory := case when v.stock<=0 then 0 else least(1,ln(1+v.stock::numeric)/ln(21)) end;
  v_sample := least(2147483647,(v_views+v_carts+v_orders+v_delivered+v_failures))::integer;
  v_explore := 0.22/sqrt(1+greatest(v_orders+v_delivered,0));
  -- Merchant service quality is refreshed by a bounded batch worker. Product refresh must never
  -- recursively scan a merchant's 180-day order history; on a one-VPS deployment that creates
  -- N-products x merchant-history amplification. Missing evidence remains neutral.

  select * into v_service from merchant_service_quality_snapshots q where q.merchant_id=v.merchant_id and q.model_version='eide-service-v11' order by q.calculated_at desc limit 1;
  if found then
    v_merchant := 0.5 + exp(-greatest(0,extract(epoch from (now()-v_service.calculated_at))/86400.0)/30.0) *
      (least(greatest(coalesce(v_service.order_count,0),0),200)::numeric/(least(greatest(coalesce(v_service.order_count,0),0),200)+20)) *
      ((.35*coalesce(v_service.inventory_accuracy,.5) + .20*coalesce(v_service.response_rate,.5) + .15*(1-coalesce(v_service.cancellation_rate,0)) + .10*(1-coalesce(v_service.late_ship_rate,.5)) + .10*(1-coalesce(v_service.return_rate,0)) + .10*(1-coalesce(v_service.dispute_rate,0))) - .5);
    if v_service.service_band='watch' then v_merchant:=least(v_merchant,.5 + exp(-greatest(0,extract(epoch from (now()-v_service.calculated_at))/86400.0)/30.0)*(-.05)); end if;
    if v_service.service_band='restricted' then v_merchant:=least(v_merchant,.5 + exp(-greatest(0,extract(epoch from (now()-v_service.calculated_at))/86400.0)/30.0)*(-.25)); end if;
  else v_merchant:=.5; end if;
  if not v.merchant_verified or v.merchant_status<>'active' then v_merchant:=0; end if;

  -- Canonical-equivalent merchant offers are not all unique SEO documents. Elect one stable,
  -- eligible representative; other offers remain live/searchable but are noindex.
  if nullif(trim(coalesce(v.canonical_product_key,'')),'') is not null then
    select (p2.id=p_product_id) into v_is_seo_primary
      from products p2 join merchants m2 on m2.id=p2.merchant_id
     where p2.canonical_product_key=v.canonical_product_key and p2.model is not distinct from v.model and p2.condition=v.condition and p2.attributes=v.attributes and p2.status='active' and p2.stock>0
       and m2.status='active' and m2.verified=true and exists(select 1 from category_taxonomy ct where ct.category_key=p2.category and ct.active=true) and (p2.subcategory is null or exists(select 1 from category_subcategories cs where cs.category_key=p2.category and cs.subcategory_key=p2.subcategory and cs.active=true))
     order by p2.created_at asc,p2.id asc limit 1;
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
  values(p_product_id,v_merchant,v_conversion,v_pop,v_trend,v_fresh,v_inventory,v_explore,v_seo,v_index,v_sample,'eide-v11',now(),v_trusted,now()+interval '6 hours')
  on conflict(product_id) do update set merchant_confidence=excluded.merchant_confidence,conversion_quality=excluded.conversion_quality,popularity=excluded.popularity,trend_momentum=excluded.trend_momentum,freshness=excluded.freshness,inventory_health=excluded.inventory_health,exploration_bonus=excluded.exploration_bonus,seo_quality=excluded.seo_quality,indexability_score=excluded.indexability_score,sample_size=excluded.sample_size,model_version=excluded.model_version,calculated_at=excluded.calculated_at,trusted_commerce_score=excluded.trusted_commerce_score,feature_stale_after=excluded.feature_stale_after;

  insert into eide_seo_pages(page_key,page_type,entity_key,demand_score,inventory_depth_score,uniqueness_score,content_quality_score,freshness_score,indexability_score,index_decision,reason,model_version,calculated_at)
  values('product:'||p_product_id,'product',p_product_id,v_pop,v_inventory,v_unique,v_seo,v_seo_fresh,v_index,
    case when v_index>=.42 and v_unique>=.5 and v.stock>0 and v.merchant_verified and v.merchant_status='active' and v.status='active' then 'index' else 'noindex' end,
    jsonb_build_object('seoQuality',round(v_seo::numeric,4),'inventoryHealth',round(v_inventory::numeric,4),'seoFreshness',round(v_seo_fresh::numeric,4),'merchantConfidence',round(v_merchant::numeric,4),'trustedCommerce',round(v_trusted::numeric,4),'uniqueness',round(v_unique::numeric,4),'canonicalRepresentative',v_is_seo_primary,'threshold',.42),'eide-seo-v11',now())
  on conflict(page_key) do update set demand_score=excluded.demand_score,inventory_depth_score=excluded.inventory_depth_score,uniqueness_score=excluded.uniqueness_score,content_quality_score=excluded.content_quality_score,freshness_score=excluded.freshness_score,indexability_score=excluded.indexability_score,index_decision=excluded.index_decision,reason=excluded.reason,model_version=excluded.model_version,calculated_at=excluded.calculated_at;
end $$;
revoke all on function refresh_eide_product_feature(text) from public;
grant execute on function refresh_eide_product_feature(text) to current_user;



-- Retention must include search observations too. All deletes are bounded so a neglected beta VPS
-- never performs an unbounded cleanup transaction during a scheduler run.


alter table eide_ranking_events alter column model_version set default 'eide-v11';
alter table eide_product_features alter column model_version set default 'eide-v11';
alter table eide_seo_pages alter column model_version set default 'eide-seo-v11';
update eide_product_features set feature_stale_after=now() where model_version<>'eide-v11';
update eide_seo_pages set index_decision='noindex' where model_version<>'eide-seo-v11';

-- Shared, category-owned unit normalization; no free-form SQL or executable patterns.
create or replace function eide_normalize_attribute(p_value text,p_unit text)
returns text language plpgsql immutable as $$
declare v text:=lower(trim(normalize(coalesce(p_value,''),NFKC))); m text[];
begin
 if p_unit='gb' then
  m:=regexp_match(v,'^([0-9]+(?:\.[0-9]+)?)[[:space:]]*(gb|tb)?$');
  if m is not null then return rtrim(trim(to_char(m[1]::numeric*(case when m[2]='tb' then 1024 else 1 end),'FM999999999999990.999999')),'.')||'gb'; end if;
 elsif p_unit='inch' then
  m:=regexp_match(v,'^([0-9]+(?:\.[0-9]+)?)[[:space:]]*(?:inch|inches|in|")?$');
  if m is not null then return rtrim(trim(to_char(m[1]::numeric,'FM999999999999990.999999')),'.')||'inch'; end if;
 end if;
 return regexp_replace(v,'[[:space:]]+','','g');
end $$;

-- Indexed, derived vocabulary avoids expanding JSON over the catalog per query.
-- Product/variant mutation triggers only enqueue; background work expands attributes.
create table if not exists marketplace_discovery_product_attributes (
 product_id text not null references products(id) on delete cascade,
 category text not null, subcategory text,
 attribute_key text not null, source_key text not null,
 calculated_at timestamptz not null default now(),
 normalized_value text not null, raw_value text not null,
 primary key(product_id,attribute_key,source_key,normalized_value)
);
create index if not exists discovery_attribute_value_idx on marketplace_discovery_product_attributes(category,normalized_value,source_key,subcategory);
create or replace function refresh_discovery_product_attributes(p_product_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 delete from marketplace_discovery_product_attributes where product_id=p_product_id;
 insert into marketplace_discovery_product_attributes(product_id,category,subcategory,attribute_key,source_key,normalized_value,raw_value)
 select distinct p.id,p.category,p.subcategory,d.attribute_key,e.key,eide_normalize_attribute(e.value,d.unit),e.value
 from products p
 join marketplace_discovery_attribute_definitions d on d.category=p.category and d.active=true and (p.subcategory is null or d.subcategory='' or d.subcategory=p.subcategory)
 cross join lateral (
   select p.attributes data
   union all select v.attributes from product_variants v where v.product_id=p.id and v.status='active' and v.stock>0
 ) a
 cross join lateral jsonb_each_text(case when jsonb_typeof(a.data)='object' then a.data else '{}'::jsonb end)e
 where p.id=p_product_id and e.key=any(d.attribute_keys) and char_length(e.value) between 1 and 60
 on conflict do nothing;
-- Background failure rolls back the claim, retaining dirty invalidations.
end $$;
revoke all on function refresh_discovery_product_attributes(text) from public;
grant execute on function refresh_discovery_product_attributes(text) to current_user;
create or replace function discovery_attributes_dirty_trigger()
returns trigger language plpgsql as $$
begin
 if TG_TABLE_NAME='products' then perform eide_mark_product_dirty(new.id,'attributes');
 elsif TG_OP='DELETE' then perform eide_mark_product_dirty(old.product_id,'variant');
 else
  perform eide_mark_product_dirty(new.product_id,'variant');
  if TG_OP='UPDATE' and old.product_id is distinct from new.product_id then perform eide_mark_product_dirty(old.product_id,'variant'); end if;
 end if;
 return coalesce(new,old);
end $$;
drop trigger if exists discovery_attributes_product_guard on products;
create trigger discovery_attributes_product_guard after insert or update of attributes,category,subcategory on products for each row execute function discovery_attributes_dirty_trigger();
drop trigger if exists discovery_attributes_variant_guard on product_variants;
create trigger discovery_attributes_variant_guard after insert or update or delete on product_variants for each row execute function discovery_attributes_dirty_trigger();
-- Upgrade backfill: write only derived rows, not product/financial state.
insert into marketplace_discovery_product_attributes(product_id,category,subcategory,attribute_key,source_key,normalized_value,raw_value)
select distinct p.id,p.category,p.subcategory,d.attribute_key,e.key,eide_normalize_attribute(e.value,d.unit),e.value
from products p join marketplace_discovery_attribute_definitions d on d.category=p.category and d.active=true and (p.subcategory is null or d.subcategory='' or d.subcategory=p.subcategory)
cross join lateral (select p.attributes data union all select v.attributes from product_variants v where v.product_id=p.id and v.status='active' and v.stock>0)a
cross join lateral jsonb_each_text(case when jsonb_typeof(a.data)='object' then a.data else '{}'::jsonb end)e
where e.key=any(d.attribute_keys) and char_length(e.value) between 1 and 60 on conflict do nothing;

-- Idempotent signed exposure observations. Cheap/client events remain untrusted.
alter table eide_ranking_events add column if not exists exposure_event_key text;
create unique index if not exists eide_exposure_event_key_idx on eide_ranking_events(exposure_event_key) where exposure_event_key is not null;
alter table eide_ranking_events drop constraint if exists eide_ranking_events_event_type_check;
alter table eide_ranking_events add constraint eide_ranking_events_event_type_check
 check(event_type in ('impression','click','view','add_to_cart','checkout','purchase','delivered','cancelled','returned','refunded','disputed'));

-- Normalized one-hop vocabulary lookups and bounded typo-prefix lookup.
create or replace function eide_normalize_synonym(value text) returns text language sql immutable as $$
 select regexp_replace(lower(trim(normalize(value,NFKC))),'[[:space:]]+',' ','g')
$$;
create index if not exists discovery_synonym_term_idx on marketplace_search_synonyms(locale,eide_normalize_synonym(term)) where status='active';
create index if not exists discovery_synonym_target_idx on marketplace_search_synonyms(locale,eide_normalize_synonym(synonym)) where status='active';
create index if not exists discovery_brand_prefix_idx on products(left(normalized_brand,3)) where status='active';
