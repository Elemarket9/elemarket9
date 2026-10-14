-- v1.82: CTO-prioritized high-scale marketplace control plane.
-- Tax/VAT is intentionally outside ELEMARKET's calculation/remittance boundary.

-- -----------------------------------------------------------------------------
-- 1. Canonical product identity + PostgreSQL search index.
-- -----------------------------------------------------------------------------
alter table products add column if not exists canonical_product_key text;
alter table products add column if not exists search_vector tsvector;
create index if not exists products_canonical_product_key_idx on products(canonical_product_key) where canonical_product_key is not null;
create index if not exists products_search_vector_gin_idx on products using gin(search_vector);

create or replace function refresh_product_search_vector()
returns trigger language plpgsql as $$
begin
  new.search_vector :=
    setweight(to_tsvector('simple',coalesce(new.name,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.brand,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.model,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(new.category,'')),'B') ||
    setweight(to_tsvector('simple',coalesce(new.subcategory,'')),'B') ||
    setweight(to_tsvector('simple',coalesce(new.description,'')),'C');
  return new;
end $$;
drop trigger if exists products_search_vector_guard on products;
create trigger products_search_vector_guard
before insert or update of name,brand,model,category,subcategory,description on products
for each row execute function refresh_product_search_vector();
update products set search_vector =
    setweight(to_tsvector('simple',coalesce(name,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(brand,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(model,'')),'A') ||
    setweight(to_tsvector('simple',coalesce(category,'')),'B') ||
    setweight(to_tsvector('simple',coalesce(subcategory,'')),'B') ||
    setweight(to_tsvector('simple',coalesce(description,'')),'C')
where search_vector is null;

-- -----------------------------------------------------------------------------
-- 2. Offer groups + explainable buy-box/ranking snapshots.
-- -----------------------------------------------------------------------------
create table if not exists marketplace_offer_rankings (
  id text primary key,
  canonical_product_key text not null,
  product_id text not null references products(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  rank_position integer not null check (rank_position > 0),
  score numeric(10,4) not null check (score >= 0),
  model_version text not null,
  factors jsonb not null default '{}'::jsonb,
  selected boolean not null default false,
  calculated_at timestamptz not null default now(),
  unique(canonical_product_key,model_version,product_id)
);
create index if not exists marketplace_offer_rankings_lookup_idx
  on marketplace_offer_rankings(canonical_product_key,model_version,rank_position);
create index if not exists marketplace_offer_rankings_selected_idx
  on marketplace_offer_rankings(canonical_product_key,model_version,selected)
  where selected=true;

create or replace function rank_marketplace_offers(p_canonical_product_key text,p_limit integer default 20)
returns table(product_id text,merchant_id text,rank_position integer,score numeric,selected boolean,factors jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_limit integer := least(greatest(coalesce(p_limit,20),1),100); v_model text := 'offer-rank-v1';
begin
  if p_canonical_product_key is null or length(trim(p_canonical_product_key)) < 3 then raise exception 'canonical product key required'; end if;
  return query
  with candidates as (
    select p.id as product_id,p.merchant_id,p.price,
           coalesce(p.stock,0) as stock,
           coalesce(m.verified,false) as verified,
           coalesce(ms.score,0) as merchant_score,
           coalesce(plq.score,0) as listing_score,
           row_number() over (order by p.price asc,p.id) as price_rank
      from products p
      join merchants m on m.id=p.merchant_id
      left join merchant_scores ms on ms.merchant_id=p.merchant_id
      left join product_listing_quality plq on plq.product_id=p.id
       and plq.calculated_at=(select max(x.calculated_at) from product_listing_quality x where x.product_id=p.id)
     where p.canonical_product_key=p_canonical_product_key
       and p.status='active' and m.status='active' and m.verified=true and p.stock>0
  ), scored as (
    select c.*,
      greatest(0,least(100,(
        35 * (1.0 / greatest(c.price,0.01)) / greatest(max(1.0/max(c.price,0.01)) over (),0.0001) +
        20 * least(c.stock,20)::numeric/20 +
        20 * c.merchant_score/1000 +
        15 * c.listing_score/100 +
        10 * case when c.verified then 1 else 0 end
      )))::numeric(10,4) as score
    from candidates c
  ), ranked as (
    select s.*,row_number() over(order by s.score desc,s.price asc,s.product_id) as pos
    from scored s
  )
  select r.product_id,r.merchant_id,r.pos::int,r.score,(r.pos=1),jsonb_build_object(
    'price',r.price,'stock',r.stock,'merchantScore',r.merchant_score,
    'listingQuality',r.listing_score,'verifiedMerchant',r.verified,
    'modelVersion',v_model
  )
  from ranked r where r.pos<=v_limit order by r.pos;
end $$;
revoke all on function rank_marketplace_offers(text,integer) from public;
grant execute on function rank_marketplace_offers(text,integer) to current_user;

-- -----------------------------------------------------------------------------
-- 3. Seller operational quality: separate from Merchant Health/credit scoring.
-- -----------------------------------------------------------------------------
create table if not exists merchant_service_quality_snapshots (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  window_start timestamptz not null,
  window_end timestamptz not null,
  order_count integer not null default 0 check (order_count>=0),
  cancellation_rate numeric(7,4) not null default 0 check (cancellation_rate between 0 and 1),
  late_ship_rate numeric(7,4) not null default 0 check (late_ship_rate between 0 and 1),
  return_rate numeric(7,4) not null default 0 check (return_rate between 0 and 1),
  dispute_rate numeric(7,4) not null default 0 check (dispute_rate between 0 and 1),
  inventory_accuracy numeric(7,4) not null default 1 check (inventory_accuracy between 0 and 1),
  response_rate numeric(7,4) not null default 1 check (response_rate between 0 and 1),
  service_band text not null check (service_band in ('new','standard','watch','restricted')),
  model_version text not null,
  calculated_at timestamptz not null default now(),
  unique(merchant_id,window_start,window_end,model_version)
);
create index if not exists merchant_service_quality_current_idx
  on merchant_service_quality_snapshots(merchant_id,calculated_at desc);

create table if not exists merchant_service_controls (
  merchant_id text primary key references merchants(id) on delete cascade,
  listing_limit integer,
  promotion_access boolean not null default true,
  offer_rank_cap integer,
  fulfillment_access boolean not null default true,
  reason_code text,
  effective_at timestamptz not null default now(),
  expires_at timestamptz
);

-- -----------------------------------------------------------------------------
-- 4. Privacy-minimized risk graph. No raw PII is stored in graph nodes.
-- -----------------------------------------------------------------------------
create table if not exists risk_graph_nodes (
  id text primary key,
  node_type text not null check (node_type in ('customer','merchant','device_hash','address_hash','phone_hash','email_hash','payment_ref_hash','ip_hash')),
  stable_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(node_type,stable_hash)
);
create table if not exists risk_graph_edges (
  id text primary key,
  from_node_id text not null references risk_graph_nodes(id) on delete cascade,
  to_node_id text not null references risk_graph_nodes(id) on delete cascade,
  relation_type text not null check (relation_type in ('used_by','owns','placed','paid_with','shipped_to','managed_by','shares')),
  confidence numeric(5,4) not null default 1 check (confidence between 0 and 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(from_node_id,to_node_id,relation_type)
);
create index if not exists risk_graph_edges_from_idx on risk_graph_edges(from_node_id,relation_type);
create index if not exists risk_graph_edges_to_idx on risk_graph_edges(to_node_id,relation_type);

-- -----------------------------------------------------------------------------
-- 5. Promotion budgets: separate hard concurrency boundary from redemptions.
-- -----------------------------------------------------------------------------
create table if not exists promotion_budgets (
  promotion_id text primary key references promotions(id) on delete cascade,
  max_discount_amount numeric(14,2) check (max_discount_amount is null or max_discount_amount>0),
  reserved_discount_amount numeric(14,2) not null default 0 check (reserved_discount_amount>=0),
  consumed_discount_amount numeric(14,2) not null default 0 check (consumed_discount_amount>=0),
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  check (max_discount_amount is null or reserved_discount_amount+consumed_discount_amount<=max_discount_amount)
);

create or replace function reserve_promotion_budget(p_promotion_id text,p_amount numeric)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v record;
begin
  if p_amount<=0 then raise exception 'invalid promotion budget amount'; end if;
  select * into v from promotion_budgets where promotion_id=p_promotion_id for update;
  if not found then return true; end if;
  if v.max_discount_amount is not null and v.reserved_discount_amount+v.consumed_discount_amount+p_amount>v.max_discount_amount then return false; end if;
  update promotion_budgets set reserved_discount_amount=reserved_discount_amount+p_amount,version=version+1,updated_at=now() where promotion_id=p_promotion_id;
  return true;
end $$;
revoke all on function reserve_promotion_budget(text,numeric) from public;
grant execute on function reserve_promotion_budget(text,numeric) to current_user;

-- -----------------------------------------------------------------------------
-- 6. Enterprise developer portal / sandbox metadata.
-- -----------------------------------------------------------------------------
create table if not exists enterprise_api_apps (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 160),
  environment text not null default 'sandbox' check (environment in ('sandbox','production')),
  status text not null default 'active' check (status in ('active','suspended','revoked')),
  scopes text[] not null default '{}',
  webhook_signing_secret_hash text,
  api_version text not null default 'v1',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enterprise_api_apps_org_env_idx on enterprise_api_apps(organization_id,environment,status);

create table if not exists enterprise_webhook_subscriptions (
  id text primary key,
  app_id text not null references enterprise_api_apps(id) on delete cascade,
  event_type text not null check (char_length(trim(event_type)) between 3 and 120),
  endpoint_url text not null,
  status text not null default 'active' check (status in ('active','paused','revoked')),
  secret_hash text not null,
  created_at timestamptz not null default now(),
  unique(app_id,event_type,endpoint_url)
);
create index if not exists enterprise_webhook_subscription_app_idx on enterprise_webhook_subscriptions(app_id,status);

-- -----------------------------------------------------------------------------
-- 7. Reliability/SLO control plane.
-- -----------------------------------------------------------------------------
create table if not exists platform_slos (
  id text primary key,
  service_key text not null,
  indicator_key text not null,
  target numeric(8,5) not null check (target>0 and target<=1),
  window_days integer not null default 30 check (window_days between 1 and 365),
  owner_team text not null,
  status text not null default 'active' check (status in ('active','paused','retired')),
  unique(service_key,indicator_key)
);
create table if not exists platform_slo_measurements (
  id bigserial primary key,
  slo_id text not null references platform_slos(id) on delete cascade,
  measured_at timestamptz not null default now(),
  good_events bigint not null default 0 check (good_events>=0),
  total_events bigint not null default 0 check (total_events>=0),
  error_budget_remaining numeric(10,6),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists platform_slo_measurements_idx on platform_slo_measurements(slo_id,measured_at desc);

create table if not exists platform_health_checks (
  service_key text primary key,
  status text not null check (status in ('healthy','degraded','unhealthy','unknown')),
  checked_at timestamptz not null default now(),
  latency_ms integer,
  detail jsonb not null default '{}'::jsonb
);

comment on table merchant_service_quality_snapshots is 'Marketplace operational quality only; never a credit score or financing decision.';
comment on table risk_graph_nodes is 'Privacy-minimized risk graph. Stable hashes only; no raw customer PII.';
comment on table platform_slos is 'Operational reliability targets; not customer-facing product claims.';

-- -----------------------------------------------------------------------------
-- 8. Remove legacy escrow dependencies from live risk evaluation.
-- -----------------------------------------------------------------------------
create or replace function evaluate_checkout_risk(
  p_user_id text,
  p_fingerprint text,
  p_product_total numeric,
  p_grand_total numeric,
  p_reference_id text default null
) returns jsonb language plpgsql as $$
declare
  v_score integer := 0; v_reasons jsonb := '[]'::jsonb; v_decision text := 'allow';
  v_id text := 'risk_'||replace(gen_random_uuid()::text,'-','');
  v_recent_orders integer; v_failed_payments integer; v_recent_disputes integer; v_account_age interval;
begin
  if p_user_id is null or length(trim(p_user_id))<3 then raise exception 'invalid risk subject'; end if;
  if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'invalid risk fingerprint'; end if;
  if p_product_total<0 or p_grand_total<p_product_total then raise exception 'invalid risk amount'; end if;
  select count(*) into v_recent_orders from orders where user_id=p_user_id and created_at>now()-interval '10 minutes';
  if v_recent_orders>=5 then v_score:=v_score+35; v_reasons:=v_reasons||jsonb_build_array('checkout_velocity'); end if;
  if v_recent_orders>=10 then v_score:=v_score+40; v_reasons:=v_reasons||jsonb_build_array('excessive_checkout_velocity'); end if;
  select count(*) into v_failed_payments from payment_attempts pa join payments p on p.id=pa.payment_id where p.user_id=p_user_id and pa.status='failed' and pa.created_at>now()-interval '30 minutes';
  if v_failed_payments>=3 then v_score:=v_score+20; v_reasons:=v_reasons||jsonb_build_array('payment_failures'); end if;
  if v_failed_payments>=8 then v_score:=v_score+25; v_reasons:=v_reasons||jsonb_build_array('excessive_payment_failures'); end if;
  select count(*) into v_recent_disputes from customer_order_disputes d where d.customer_id=p_user_id and d.created_at>now()-interval '90 days' and d.status in ('open','under_review','resolved_refund','closed');
  if v_recent_disputes>=3 then v_score:=v_score+15; v_reasons:=v_reasons||jsonb_build_array('repeated_disputes'); end if;
  if v_recent_disputes>=8 then v_score:=v_score+25; v_reasons:=v_reasons||jsonb_build_array('high_dispute_frequency'); end if;
  select now()-"createdAt" into v_account_age from "user" where id=p_user_id;
  if v_account_age is null then raise exception 'risk user not found'; end if;
  if v_account_age<interval '24 hours' and p_grand_total>=5000 then v_score:=v_score+20; v_reasons:=v_reasons||jsonb_build_array('new_account_high_value'); end if;
  if p_grand_total>=20000 then v_score:=v_score+30; v_reasons:=v_reasons||jsonb_build_array('high_value_checkout'); end if;
  v_score:=least(v_score,100);
  if v_score>=70 then v_decision:='block'; elsif v_score>=40 then v_decision:='review'; end if;
  insert into risk_assessments(id,subject_type,subject_id,reference_id,fingerprint,decision,score,reasons,amount)
  values(v_id,'customer',p_user_id,p_reference_id,p_fingerprint,v_decision,v_score,v_reasons,p_grand_total)
  on conflict do nothing;
  return jsonb_build_object('assessmentId',v_id,'decision',v_decision,'score',v_score,'reasons',v_reasons);
end $$;

create or replace function evaluate_merchant_withdrawal_risk(p_merchant_id text,p_amount numeric)
returns jsonb language plpgsql as $$
declare
  v_score integer:=0; v_reasons jsonb:='[]'::jsonb; v_decision text:='allow';
  v_id text:='risk_'||replace(gen_random_uuid()::text,'-',''); v_requestable numeric:=0; v_disputed integer:=0; v_recent_requests integer:=0; v_status text;
begin
  if p_amount<=0 then raise exception 'invalid fund release amount'; end if;
  select status into v_status from merchants where id=p_merchant_id;
  if v_status is null then raise exception 'merchant not found'; end if;
  if v_status<>'active' then v_score:=100; v_reasons:=v_reasons||jsonb_build_array('merchant_not_active'); end if;
  select coalesce(provider_requestable_amount,0) into v_requestable from merchant_provider_funds_summary where merchant_id=p_merchant_id;
  if p_amount>v_requestable then v_score:=100; v_reasons:=v_reasons||jsonb_build_array('release_exceeds_provider_eligible_amount'); end if;
  select count(*) into v_disputed from customer_order_disputes d join orders o on o.id=d.order_id where o.merchant_id=p_merchant_id and d.status in ('open','under_review');
  if v_disputed>0 then v_score:=v_score+20; v_reasons:=v_reasons||jsonb_build_array('active_dispute_exposure'); end if;
  select count(*) into v_recent_requests from merchant_fund_release_requests where merchant_id=p_merchant_id and created_at>now()-interval '24 hours' and status not in ('rejected','cancelled','failed');
  if v_recent_requests>=3 then v_score:=v_score+25; v_reasons:=v_reasons||jsonb_build_array('release_request_velocity'); end if;
  if v_recent_requests>=6 then v_score:=v_score+35; v_reasons:=v_reasons||jsonb_build_array('excessive_release_request_velocity'); end if;
  if p_amount>=20000 then v_score:=v_score+20; v_reasons:=v_reasons||jsonb_build_array('high_value_release_request'); end if;
  v_score:=least(v_score,100);
  if v_score>=70 then v_decision:='block'; elsif v_score>=40 then v_decision:='review'; end if;
  insert into risk_assessments(id,subject_type,subject_id,decision,score,reasons,amount) values(v_id,'withdrawal',p_merchant_id,v_decision,v_score,v_reasons,p_amount);
  return jsonb_build_object('assessmentId',v_id,'decision',v_decision,'score',v_score,'reasons',v_reasons);
end $$;
