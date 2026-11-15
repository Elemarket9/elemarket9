-- Product review moderation (admin.reviews.moderate).
--
-- Reviews still go live immediately (verified purchase, migration 0106). This
-- adds the ability to hide a review (with a recorded reason), restore it, and
-- for signed-in customers to report a review they believe breaks the rules.
--
-- A hidden review stays in the database (evidence, legal hold, audit) but is
-- excluded from EVERY public read and every rating aggregate:
--   * public_reviews view            -> used by all application read paths
--   * calculate_product_listing_quality(text)  (search ranking signal)
--   * merchant_performance_snapshot(text)      (seller performance)
--   * recalculate_merchant_health_score(text)  (merchant health)
-- review_order_item() is intentionally unchanged: a hidden review must still
-- block the same customer from posting a second review for the same item.
-- Merchants cannot hide reviews: the only write path is the admin moderation
-- server code, gated by admin.reviews.moderate, fresh session and audit.

alter table reviews add column if not exists moderation_status text not null default 'published';
alter table reviews add column if not exists hidden_reason text;
alter table reviews add column if not exists hidden_note text;
alter table reviews add column if not exists moderated_by text;
alter table reviews add column if not exists moderated_at timestamptz;

alter table reviews drop constraint if exists reviews_moderation_status_check;
alter table reviews add constraint reviews_moderation_status_check
  check (moderation_status in ('published','hidden'));
alter table reviews drop constraint if exists reviews_hidden_reason_check;
alter table reviews add constraint reviews_hidden_reason_check
  check (hidden_reason is null or hidden_reason in ('abusive','spam','off_topic','personal_data','fake_or_incentivised','legal','other'));
alter table reviews drop constraint if exists reviews_hidden_note_check;
alter table reviews add constraint reviews_hidden_note_check
  check (hidden_note is null or char_length(hidden_note) <= 1000);
-- Hidden => reason, moderator and time are recorded. Published => no hidden reason/note.
alter table reviews drop constraint if exists reviews_moderation_consistency_check;
alter table reviews add constraint reviews_moderation_consistency_check check (
  (moderation_status = 'hidden' and hidden_reason is not null and moderated_by is not null and moderated_at is not null)
  or (moderation_status = 'published' and hidden_reason is null and hidden_note is null)
);

create index if not exists reviews_published_product_created_idx
  on reviews(product_id, created_at desc, id desc) where moderation_status = 'published';
create index if not exists reviews_moderation_queue_idx
  on reviews(moderation_status, created_at desc);

-- The only view application code may use to show reviews or compute ratings.
create or replace view public_reviews as
  select id, user_id, product_id, order_id, rating, body, created_at
    from reviews
   where moderation_status = 'published';
comment on view public_reviews is 'Published (not hidden) reviews. Every customer-facing read and rating aggregate must use this view.';

create table if not exists review_reports (
  id text primary key,
  review_id text not null references reviews(id) on delete cascade,
  reporter_user_id text not null,
  reason text not null check (reason in ('abusive','spam','off_topic','personal_data','fake_or_incentivised','legal','other')),
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'open' check (status in ('open','dismissed','actioned')),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint review_reports_one_per_reporter unique (review_id, reporter_user_id),
  constraint review_reports_resolution_check check (
    (status = 'open' and resolved_by is null and resolved_at is null)
    or (status <> 'open' and resolved_by is not null and resolved_at is not null)
  )
);
create index if not exists review_reports_open_idx on review_reports(review_id) where status = 'open';
create index if not exists review_reports_reporter_idx on review_reports(reporter_user_id, created_at desc);

-- A customer cannot report their own review; enforced here so it holds even if
-- application code is bypassed.
create or replace function elemarket_review_report_guard() returns trigger
language plpgsql set search_path to pg_catalog, public as $$
declare v_author text;
begin
  select user_id into v_author from reviews where id = new.review_id;
  if not found then raise exception 'review not found'; end if;
  if v_author = new.reporter_user_id then
    raise exception 'review_reports_no_self_report: you cannot report your own review' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists review_reports_no_self_report on review_reports;
create trigger review_reports_no_self_report
  before insert or update of review_id, reporter_user_id on review_reports
  for each row execute function elemarket_review_report_guard();

-- Redefined from their live definitions (pg_get_functiondef after 0230);
-- the only change in each is the moderation_status = 'published' filter, plus
-- one pre-existing bug fix in calculate_product_listing_quality: it called
-- jsonb_object_length(), which does not exist in PostgreSQL, so every call
-- failed with 42883. It now counts attribute keys with jsonb_object_keys().

CREATE OR REPLACE FUNCTION public.calculate_product_listing_quality(p_product_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  p record;
  v_content integer;
  v_discoverability integer;
  v_offer integer;
  v_availability integer;
  v_customer integer;
  v_score integer;
begin
  select * into p from products where id=p_product_id;
  if not found then raise exception 'product not found'; end if;

  v_content := least(100,
    (case when length(btrim(coalesce(p.name,''))) >= 8 then 20 else 0 end) +
    (case when length(btrim(coalesce(p.description,''))) >= 80 then 20 else 0 end) +
    (case when p.image_path is not null and length(btrim(p.image_path)) > 0 then 20 else 0 end) +
    (case when p.brand is not null and length(btrim(p.brand)) > 0 then 10 else 0 end) +
    (case when p.model is not null and length(btrim(p.model)) > 0 then 10 else 0 end) +
    (case when jsonb_typeof(coalesce(p.attributes,'{}'::jsonb))='object' and (select count(*) from jsonb_object_keys(coalesce(p.attributes,'{}'::jsonb))) >= 2 then 20 else 0 end)
  );

  v_discoverability := least(100,
    (case when p.category is not null then 25 else 0 end) +
    (case when p.subcategory is not null then 25 else 0 end) +
    (case when p.sku is not null and length(btrim(p.sku)) > 0 then 15 else 0 end) +
    (case when p.brand is not null and length(btrim(p.brand)) > 0 then 15 else 0 end) +
    (case when p.status='active' then 20 else 0 end)
  );

  v_offer := least(100,
    (case when p.price > 0 then 35 else 0 end) +
    (case when p.returnable then 20 else 10 end) +
    (case when coalesce(p.return_window_days,0) > 0 then 15 else 0 end) +
    (case when p.fulfillment_type is not null then 15 else 0 end) +
    (case when p.condition is not null then 15 else 0 end)
  );

  v_availability := case
    when p.status <> 'active' then 0
    when coalesce(p.stock,0) <= 0 then 25
    when p.stock >= 10 then 100
    else 50 + least(50, p.stock * 5)
  end;

  select least(100, greatest(0,
    50 + round((coalesce(avg(r.rating),0) - 3.0) * 25)::int
  )) into v_customer
    from reviews r
   where r.product_id=p_product_id
     and r.moderation_status = 'published';

  v_score := round(
    v_content * 0.30 +
    v_discoverability * 0.20 +
    v_offer * 0.20 +
    v_availability * 0.15 +
    v_customer * 0.15
  );

  insert into product_listing_quality(
    product_id,score,content_score,discoverability_score,offer_score,
    availability_score,customer_signal_score,calculated_at,model_version
  ) values (
    p_product_id,v_score,v_content,v_discoverability,v_offer,
    v_availability,v_customer,now(),'listing-quality-v1'
  ) on conflict (product_id) do update set
    score=excluded.score,content_score=excluded.content_score,
    discoverability_score=excluded.discoverability_score,offer_score=excluded.offer_score,
    availability_score=excluded.availability_score,customer_signal_score=excluded.customer_signal_score,
    calculated_at=excluded.calculated_at,model_version=excluded.model_version;

  return jsonb_build_object(
    'score',v_score,'contentScore',v_content,'discoverabilityScore',v_discoverability,
    'offerScore',v_offer,'availabilityScore',v_availability,'customerSignalScore',v_customer,
    'modelVersion','listing-quality-v1','calculatedAt',now()
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.merchant_performance_snapshot(p_merchant_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
with scope as (
  select o.id,o.status,o.created_at,o.updated_at,
    exists(select 1 from merchant_order_status_history h where h.order_id=o.id and h.to_status='shipped') as shipped,
    exists(select 1 from merchant_order_status_history h where h.order_id=o.id and h.to_status='delivered') as delivered
  from orders o where o.merchant_id=p_merchant_id and o.created_at >= now()-interval '90 days'
),
reviews_agg as (select coalesce(avg(r.rating),0)::numeric(4,2) avg_rating,count(*)::int review_count from reviews r join products p on p.id=r.product_id where p.merchant_id=p_merchant_id and r.moderation_status='published' and r.created_at>=now()-interval '90 days'),
returns_agg as (select count(*)::int return_count from return_requests rr where rr.merchant_id=p_merchant_id and rr.created_at>=now()-interval '90 days'),
disputes_agg as (select count(*)::int dispute_count from customer_order_disputes d join orders o on o.id=d.order_id where o.merchant_id=p_merchant_id and d.created_at>=now()-interval '90 days')
select jsonb_build_object(
  'windowDays',90,
  'orders',count(*)::int,
  'completedOrders',count(*) filter(where status in ('delivered','completed'))::int,
  'cancellations',count(*) filter(where status='cancelled')::int,
  'cancellationRate',case when count(*)=0 then 0 else round((count(*) filter(where status='cancelled')::numeric/count(*)::numeric)*100,2) end,
  'shippedOrders',count(*) filter(where shipped)::int,
  'deliveredOrders',count(*) filter(where delivered)::int,
  'avgRating',(select avg_rating from reviews_agg),
  'reviewCount',(select review_count from reviews_agg),
  'returnCount',(select return_count from returns_agg),
  'disputeCount',(select dispute_count from disputes_agg)
) from scope;
$function$;

CREATE OR REPLACE FUNCTION public.recalculate_merchant_health_score(p_merchant_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_merchant record;
  v_start timestamptz := now() - interval '180 days';
  v_end timestamptz := now();
  v_total_orders integer := 0;
  v_completed_orders integer := 0;
  v_cancelled_orders integer := 0;
  v_disputed_orders integer := 0;
  v_total_gmv numeric := 0;
  v_active_months integer := 0;
  v_avg_rating numeric;
  v_review_count integer := 0;
  v_active_products integer := 0;
  v_in_stock_products integer := 0;
  v_score integer;
  v_band text;
  v_id text := 'msh_' || replace(gen_random_uuid()::text, '-', '');
  v_components jsonb;
  v_sample integer;
  v_fresh_until timestamptz := now() + interval '24 hours';
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) = 0 then
    raise exception 'merchant identity required';
  end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:merchant-health:' || p_merchant_id));

  select id,status,verified,created_at into v_merchant
    from merchants where id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;

  select
    count(*) filter (where o.status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed'))::int,
    count(*) filter (where o.status in ('delivered','completed'))::int,
    count(*) filter (where o.status='cancelled')::int,
    coalesce(sum(o.grand_total) filter (where o.status in ('delivered','completed')),0),
    count(distinct date_trunc('month',o.created_at))::int
  into v_total_orders,v_completed_orders,v_cancelled_orders,v_total_gmv,v_active_months
  from orders o
  where o.merchant_id=p_merchant_id and o.created_at >= v_start and o.created_at <= v_end;

  select count(*)::int into v_disputed_orders
    from customer_order_disputes d
    join orders o on o.id=d.order_id
   where o.merchant_id=p_merchant_id and d.created_at >= v_start and d.created_at <= v_end;

  select avg(r.rating)::numeric, count(*)::int
    into v_avg_rating,v_review_count
    from reviews r
    join orders o on o.id=r.order_id
    join products p on p.id=r.product_id and p.merchant_id=p_merchant_id
   where o.merchant_id=p_merchant_id
     and o.status in ('delivered','completed')
     and r.moderation_status = 'published'
     and r.created_at >= v_start and r.created_at <= v_end;

  select count(*) filter (where p.status in ('active','pending_review','suspended'))::int,
         count(*) filter (where p.status in ('active','pending_review','suspended') and p.stock > 0)::int
    into v_active_products,v_in_stock_products
    from products p where p.merchant_id=p_merchant_id;

  v_sample := v_total_orders + v_review_count;

  -- Minimum evidence threshold prevents a thin/noisy history from becoming an
  -- underwriting signal. Provider-facing APIs expose insufficient_data explicitly.
  if v_completed_orders < 3 or v_total_orders < 5 then
    return jsonb_build_object(
      'status','insufficient_data','merchantId',p_merchant_id,
      'modelVersion','merchant-health-v1','methodologyVersion','merchant-health-v1',
      'sampleSize',v_sample,'dataPeriodStart',v_start,'dataPeriodEnd',v_end
    );
  end if;

  v_components := jsonb_build_object(
    'salesConsistency', round(1000 * least(1.0, (v_active_months::numeric / 6.0) * 0.55 + least(v_total_gmv / 100000.0,1.0) * 0.45)),
    'orderReliability', round(1000 * greatest(0, least(1, v_completed_orders::numeric / greatest(v_total_orders,1)::numeric))),
    'cancellationHealth', round(1000 * greatest(0, 1 - least(1, v_cancelled_orders::numeric / greatest(v_total_orders,1)::numeric))),
    'customerOutcomes', round(1000 * (greatest(0, least(1, coalesce(v_avg_rating,0) / 5.0)) * 0.65 + greatest(0, 1 - least(1, v_disputed_orders::numeric / greatest(v_total_orders,1)::numeric)) * 0.35)),
    'inventoryHealth', round(1000 * case when v_active_products=0 then 0 else v_in_stock_products::numeric / v_active_products::numeric end),
    'businessActivity', round(1000 * least(1, v_active_months::numeric / 6.0)),
    'complianceHealth', case when v_merchant.status='active' and v_merchant.verified then 1000 when v_merchant.status='active' then 700 else 0 end,
    'verifiedMetrics', jsonb_build_object('orders',v_total_orders,'completedOrders',v_completed_orders,'reviews',v_review_count,'gmvGhs',round(v_total_gmv,2),'activeProducts',v_active_products,'inStockProducts',v_in_stock_products)
  );

  v_score := round(
    (v_components->>'salesConsistency')::numeric * 0.20 +
    (v_components->>'orderReliability')::numeric * 0.20 +
    (v_components->>'cancellationHealth')::numeric * 0.10 +
    (v_components->>'customerOutcomes')::numeric * 0.15 +
    (v_components->>'inventoryHealth')::numeric * 0.10 +
    (v_components->>'businessActivity')::numeric * 0.10 +
    (v_components->>'complianceHealth')::numeric * 0.15
  );
  v_score := greatest(0, least(1000, v_score));
  v_band := merchant_health_band(v_score);

  insert into merchant_score_history(
    id,merchant_id,score,band,model_version,methodology_version,components,
    data_period_start,data_period_end,sample_size,calculated_at
  ) values (
    v_id,p_merchant_id,v_score,v_band,'merchant-health-v1','merchant-health-v1',v_components,
    v_start,v_end,v_sample,now()
  );

  insert into merchant_scores(
    merchant_id,score,band,model_version,components,calculated_at,updated_at,
    data_period_start,data_period_end,sample_size,freshness_status,fresh_until,methodology_version
  ) values (
    p_merchant_id,v_score,v_band,'merchant-health-v1',v_components,now(),now(),
    v_start,v_end,v_sample,'fresh',v_fresh_until,'merchant-health-v1'
  )
  on conflict (merchant_id) do update set
    score=excluded.score,band=excluded.band,model_version=excluded.model_version,
    components=excluded.components,calculated_at=excluded.calculated_at,updated_at=excluded.updated_at,
    data_period_start=excluded.data_period_start,data_period_end=excluded.data_period_end,
    sample_size=excluded.sample_size,freshness_status='fresh',fresh_until=excluded.fresh_until,
    methodology_version=excluded.methodology_version;

  perform record_audit_event(
    'merchant.health_score.calculated','merchant',p_merchant_id,null,'system',null,'success',
    jsonb_build_object('score',v_score,'band',v_band,'modelVersion','merchant-health-v1','sampleSize',v_sample)
  );

  return jsonb_build_object(
    'status','fresh','merchantId',p_merchant_id,'score',v_score,'band',v_band,
    'modelVersion','merchant-health-v1','methodologyVersion','merchant-health-v1',
    'components',v_components,'sampleSize',v_sample,'dataPeriodStart',v_start,'dataPeriodEnd',v_end,
    'calculatedAt',now(),'freshUntil',v_fresh_until
  );
end;
$function$;
