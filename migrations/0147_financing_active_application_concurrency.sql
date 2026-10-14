-- V2009: database-enforced active financing application concurrency.
-- Customer applications are already serialized by quote row locking and the
-- unique quote_id application index. Merchant applications are serialized by
-- a per-merchant transaction advisory lock; this migration adds the missing
-- business invariant: at most one active application per merchant/provider.

do $$
declare
  v_duplicates text;
begin
  select string_agg(merchant_id || ':' || provider_id || '=' || cnt::text, ', ' order by merchant_id, provider_id)
    into v_duplicates
    from (
      select merchant_id, provider_id, count(*) cnt
        from merchant_financing_applications
       where status in ('started','pending','approved')
       group by merchant_id, provider_id
      having count(*) > 1
    ) d;

  if v_duplicates is not null then
    raise exception 'cannot enforce merchant active financing uniqueness; resolve duplicate active merchant/provider applications first: %', v_duplicates;
  end if;
end
$$;

create unique index if not exists merchant_financing_one_active_provider_uq
  on merchant_financing_applications(merchant_id, provider_id)
  where status in ('started','pending','approved');

comment on index merchant_financing_one_active_provider_uq is
  'V2009 defense-in-depth: one active financing exposure per merchant/provider. Terminal declined/cancelled/expired applications remain historical and do not block reapplication.';

create or replace function start_merchant_financing_application(
  p_merchant_id text,
  p_provider_id text,
  p_requested_amount numeric,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider record;
  v_existing record;
  v_active record;
  v_score record;
  v_result jsonb;
  v_id text;
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant identity required'; end if;
  if p_provider_id is null or length(trim(p_provider_id)) < 1 then raise exception 'financing provider required'; end if;
  if p_requested_amount is null or p_requested_amount <= 0 or p_requested_amount > 100000000 then raise exception 'invalid requested amount'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;

  -- Serialize all financing starts for a merchant. After waiting for the lock,
  -- re-read both replay and active-exposure state inside this transaction.
  perform pg_advisory_xact_lock(hashtext('elemarket:merchant-financing:'||p_merchant_id));

  select id,status,requested_amount::text,score_snapshot
    into v_existing
    from merchant_financing_applications
   where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key
   limit 1
   for update;
  if found then
    return jsonb_build_object('applicationId',v_existing.id,'status',v_existing.status,'scoreSnapshot',v_existing.score_snapshot,'replayed',true);
  end if;

  select id,status,requested_amount::text,score_snapshot
    into v_active
    from merchant_financing_applications
   where merchant_id=p_merchant_id
     and provider_id=p_provider_id
     and status in ('started','pending','approved')
   order by created_at desc
   limit 1
   for update;
  if found then
    raise exception 'active financing application already exists for this provider';
  end if;

  select id,minimum_initial_contribution_percent,plan_mode,integration_mode,application_url,partner_organization_id,application_sla_hours
    into v_provider
    from financing_providers
   where id=p_provider_id
     and audience='merchant'
     and status='active'
     and product_type in ('merchant_cash_advance','line_of_credit','term_loan')
   for share;
  if not found then raise exception 'merchant financing provider unavailable'; end if;

  select score,model_version,fresh_until
    into v_score
    from merchant_scores
   where merchant_id=p_merchant_id
   limit 1;

  if v_score.score is null or v_score.fresh_until is null or v_score.fresh_until <= now() then
    v_result := recalculate_merchant_health_score(p_merchant_id);
    if coalesce(v_result->>'status','')='fresh' then
      v_score.score := (v_result->>'score')::integer;
      v_score.model_version := coalesce(v_result->>'modelVersion','merchant-health-v1');
    else
      v_score := null;
    end if;
  end if;

  v_id := 'mfa_'||replace(gen_random_uuid()::text,'-','');
  insert into merchant_financing_applications(
    id,merchant_id,provider_id,requested_amount,currency,status,
    score_snapshot,score_model_version,idempotency_key
  ) values (
    v_id,p_merchant_id,p_provider_id,p_requested_amount,'GHS','started',
    case when v_score is null then null else v_score.score end,
    case when v_score is null then null else v_score.model_version end,
    p_idempotency_key
  );

  if v_provider.partner_organization_id is not null then
    insert into financing_application_cases(id,organization_id,provider_id,application_audience,application_id,sla_due_at)
    values('fc_'||v_id,v_provider.partner_organization_id,p_provider_id,'merchant',v_id,now()+(coalesce(v_provider.application_sla_hours,24)||' hours')::interval)
    on conflict(provider_id,application_audience,application_id) do nothing;
  end if;

  return jsonb_build_object(
    'applicationId',v_id,
    'status','started',
    'scoreSnapshot',case when v_score is null then null else v_score.score end,
    'providerApprovalRequired',true,
    'replayed',false
  );
end;
$$;

comment on function start_merchant_financing_application(text,text,numeric,text) is
  'V2009 atomic merchant financing start. Serializes by merchant, preserves idempotent replay, rejects same-provider active exposure, and relies on a partial unique index as database defense in depth.';
