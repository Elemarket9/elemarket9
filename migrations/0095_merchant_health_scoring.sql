-- v1.65: provider-facing Merchant Health Score.
-- This is marketplace performance data for financing providers, NOT a credit decision.
-- ELEMARKET remains non-custodial and providers make their own underwriting decisions.

alter table merchant_scores
  add column if not exists data_period_start timestamptz,
  add column if not exists data_period_end timestamptz,
  add column if not exists sample_size integer not null default 0 check (sample_size >= 0),
  add column if not exists freshness_status text not null default 'fresh' check (freshness_status in ('fresh','stale')),
  add column if not exists fresh_until timestamptz,
  add column if not exists methodology_version text not null default 'merchant-health-v1';

create table if not exists merchant_score_history (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  score integer not null check (score between 0 and 1000),
  band text not null check (band in ('not_ready','building','eligible_small','eligible_medium','strong_profile')),
  model_version text not null,
  methodology_version text not null,
  components jsonb not null check (jsonb_typeof(components) = 'object'),
  data_period_start timestamptz not null,
  data_period_end timestamptz not null,
  sample_size integer not null check (sample_size >= 0),
  calculated_at timestamptz not null,
  unique (merchant_id, calculated_at)
);
create index if not exists merchant_score_history_merchant_idx
  on merchant_score_history(merchant_id, calculated_at desc);

create table if not exists merchant_financing_provider_access (
  id text primary key,
  provider_id text not null references financing_providers(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  token_hash text not null unique,
  token_prefix text not null check (char_length(token_prefix) between 6 and 24),
  scopes jsonb not null default '["merchant_health:read"]'::jsonb
    check (jsonb_typeof(scopes) = 'array'),
  consented_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists merchant_financing_provider_access_lookup_idx
  on merchant_financing_provider_access(provider_id, merchant_id, revoked_at, expires_at);

create or replace function merchant_health_band(p_score integer)
returns text language plpgsql immutable as $$
begin
  return case
    when p_score < 400 then 'not_ready'
    when p_score < 550 then 'building'
    when p_score < 700 then 'eligible_small'
    when p_score < 850 then 'eligible_medium'
    else 'strong_profile'
  end;
end;
$$;

create or replace function recalculate_merchant_health_score(p_merchant_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

comment on function recalculate_merchant_health_score(text) is
  'Server-side marketplace health scoring only. Not a credit decision, guarantee, or provider underwriting result.';

-- Provider access is scoped to a specific merchant grant. No global provider enumeration is possible.
create or replace function merchant_health_access_valid(
  p_token_hash text,
  p_merchant_id text,
  p_required_scope text default 'merchant_health:read'
) returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from merchant_financing_provider_access a
      join financing_providers fp on fp.id=a.provider_id
     where a.token_hash=p_token_hash
       and a.merchant_id=p_merchant_id
       and a.revoked_at is null
       and (a.expires_at is null or a.expires_at > now())
       and fp.audience='merchant'
       and fp.status='active'
       and a.scopes ? p_required_scope
  );
$$;

create or replace function prevent_merchant_score_history_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'merchant score history is immutable';
end;
$$;
drop trigger if exists merchant_score_history_immutable on merchant_score_history;
create trigger merchant_score_history_immutable
before update or delete on merchant_score_history
for each row execute function prevent_merchant_score_history_mutation();

create or replace function protect_merchant_health_provider_access()
returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' then
    if new.token_hash <> old.token_hash
       or new.provider_id <> old.provider_id
       or new.merchant_id <> old.merchant_id
       or new.created_by_user_id <> old.created_by_user_id
       or new.scopes <> old.scopes then
      raise exception 'provider access identity is immutable';
    end if;
    return new;
  end if;
  if tg_op='DELETE' then
    raise exception 'provider access must be revoked, not deleted';
  end if;
  return new;
end;
$$;
drop trigger if exists merchant_health_provider_access_protect on merchant_financing_provider_access;
create trigger merchant_health_provider_access_protect
before update or delete on merchant_financing_provider_access
for each row execute function protect_merchant_health_provider_access();
