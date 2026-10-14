-- v1.70: atomic financing application state transitions.
-- Prevents pooled-connection lock loss, duplicate applications, and double-use of
-- customer financing quotes under concurrent/replayed requests.

create or replace function start_customer_financing_application(
  p_user_id text,
  p_provider_id text,
  p_quote_id text,
  p_order_group_id text,
  p_initial_contribution numeric,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote record;
  v_provider record;
  v_existing record;
  v_order_total numeric(12,2);
  v_initial numeric(12,2);
  v_min numeric := 0;
  v_id text;
  v_redirect text := null;
begin
  if p_user_id is null or length(trim(p_user_id)) < 1 then raise exception 'customer identity required'; end if;
  if p_provider_id is null or length(trim(p_provider_id)) < 1 then raise exception 'financing provider required'; end if;
  if p_quote_id is null or length(trim(p_quote_id)) < 1 then raise exception 'financing quote required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;

  -- Idempotency is checked first so a replay returns the original application and
  -- never consumes the quote a second time.
  select id,status,amount::text,initial_contribution_amount::text,plan_mode,integration_mode,redirect_url
    into v_existing
    from customer_financing_applications
   where user_id=p_user_id and idempotency_key=p_idempotency_key
   limit 1
   for update;
  if found then
    return jsonb_build_object(
      'applicationId',v_existing.id,
      'status',v_existing.status,
      'initialContributionAmount',v_existing.initial_contribution_amount,
      'remainingAmount',case when v_existing.initial_contribution_amount is null then null else (v_existing.amount::numeric - v_existing.initial_contribution_amount::numeric) end,
      'minimumInitialContributionPercent',0,
      'planMode',v_existing.plan_mode,
      'integrationMode',v_existing.integration_mode,
      'redirectUrl',v_existing.redirect_url,
      'providerApprovalRequired',true,
      'replayed',true
    );
  end if;

  select id,amount,expires_at,used_at,currency
    into v_quote
    from customer_financing_quotes
   where id=p_quote_id and user_id=p_user_id
   for update;
  if not found or v_quote.used_at is not null or v_quote.expires_at <= now() then
    raise exception 'financing quote expired';
  end if;
  if v_quote.currency <> 'GHS' then raise exception 'unsupported financing currency'; end if;

  select id,minimum_initial_contribution_percent,plan_mode,integration_mode,application_url
    into v_provider
    from financing_providers
   where id=p_provider_id
     and audience='customer'
     and status='active'
     and product_type in ('bnpl','installment')
   for share;
  if not found then raise exception 'financing provider unavailable'; end if;

  v_min := greatest(0,coalesce(v_provider.minimum_initial_contribution_percent,0));
  v_initial := coalesce(p_initial_contribution, round(v_quote.amount * v_min / 100, 2));
  if v_initial <= 0 then
    v_initial := null;
  end if;
  if v_initial is not null and v_initial < round(v_quote.amount * v_min / 100,2) then
    raise exception 'initial contribution is below provider minimum';
  end if;
  if v_initial is not null and v_initial >= v_quote.amount then
    raise exception 'initial contribution must be less than the financing amount';
  end if;

  if p_order_group_id is not null then
    select coalesce(sum(o.grand_total),0)::numeric(12,2)
      into v_order_total
      from orders o
     where o.group_id=p_order_group_id and o.user_id=p_user_id;
    if v_order_total <= 0 or v_quote.amount > v_order_total then
      raise exception 'financing amount exceeds order total';
    end if;
    if exists (select 1 from orders o where o.group_id=p_order_group_id and o.user_id=p_user_id and o.status in ('cancelled','disputed')) then
      raise exception 'order is not financeable';
    end if;
  end if;

  v_id := 'cfa_'||replace(gen_random_uuid()::text,'-','');
  v_redirect := case when v_provider.integration_mode='partner_handoff' then v_provider.application_url else null end;

  insert into customer_financing_applications(
    id,user_id,provider_id,order_group_id,amount,currency,status,
    initial_contribution_amount,plan_mode,redirect_url,idempotency_key,quote_id
  ) values (
    v_id,p_user_id,p_provider_id,p_order_group_id,v_quote.amount,'GHS','started',
    v_initial,v_provider.plan_mode,v_redirect,p_idempotency_key,p_quote_id
  );

  update customer_financing_quotes
     set used_at=now()
   where id=p_quote_id and user_id=p_user_id and used_at is null;
  if not found then raise exception 'financing quote was already consumed'; end if;

  return jsonb_build_object(
    'applicationId',v_id,
    'status','started',
    'initialContributionAmount',v_initial,
    'remainingAmount',case when v_initial is null then null else round(v_quote.amount-v_initial,2) end,
    'minimumInitialContributionPercent',v_min,
    'planMode',v_provider.plan_mode,
    'integrationMode',v_provider.integration_mode,
    'redirectUrl',v_redirect,
    'providerApprovalRequired',true,
    'replayed',false
  );
end;
$$;

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
  v_score record;
  v_result jsonb;
  v_id text;
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant identity required'; end if;
  if p_provider_id is null or length(trim(p_provider_id)) < 1 then raise exception 'financing provider required'; end if;
  if p_requested_amount is null or p_requested_amount <= 0 or p_requested_amount > 100000000 then raise exception 'invalid requested amount'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;

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

  select id,minimum_initial_contribution_percent,plan_mode,integration_mode,application_url
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

  return jsonb_build_object(
    'applicationId',v_id,
    'status','started',
    'scoreSnapshot',case when v_score is null then null else v_score.score end,
    'providerApprovalRequired',true,
    'replayed',false
  );
end;
$$;

comment on function start_customer_financing_application(text,text,text,text,numeric,text) is
  'Atomic provider-led customer financing application start. Locks the quote and consumes it exactly once; ELEMARKET does not make the credit decision.';
comment on function start_merchant_financing_application(text,text,numeric,text) is
  'Atomic merchant financing application start. Serializes merchant scoring/application creation; provider makes the lending decision.';
