-- V2011: financing lifecycle, legacy-intent, and active-exposure integrity.
-- Forward-only repair: do not rewrite prior migrations.

alter table customer_financing_quotes
  add column if not exists checkout_intent_version smallint not null default 1
  check (checkout_intent_version between 1 and 1000);

alter table customer_financing_applications
  add column if not exists checkout_intent_version smallint not null default 1
  check (checkout_intent_version between 1 and 1000),
  add column if not exists intent_closed_at timestamptz;

alter table merchant_financing_applications
  add column if not exists exposure_closed_at timestamptz;

-- Recover lifecycle closure from servicing history that existed before V2011.
with closed as (
  select c.application_id, min(s.effective_at) as closed_at
    from financing_application_cases c
    join financing_servicing_updates s on s.case_id=c.id and s.organization_id=c.organization_id
   where c.application_audience='customer'
     and s.update_type in ('purchase_authorized','disbursed','repayment_completed','cancelled')
   group by c.application_id
)
update customer_financing_applications a
   set intent_closed_at=closed.closed_at
  from closed
 where a.id=closed.application_id and a.intent_closed_at is null;

with closed as (
  select c.application_id, min(s.effective_at) as closed_at
    from financing_application_cases c
    join financing_servicing_updates s on s.case_id=c.id and s.organization_id=c.organization_id
   where c.application_audience='merchant'
     and s.update_type in ('repayment_completed','cancelled')
   group by c.application_id
)
update merchant_financing_applications a
   set exposure_closed_at=closed.closed_at
  from closed
 where a.id=closed.application_id and a.exposure_closed_at is null;

-- V2007/V2008 marked an approved case completed immediately. Reconstruct the
-- operational lifecycle from the latest servicing event where one exists;
-- otherwise an approved application belongs in the approved state.
with latest as (
  select distinct on (s.case_id)
         s.case_id,
         case s.update_type
           when 'purchase_authorized' then 'approved'
           when 'disbursed' then 'disbursed'
           when 'repayment_current' then 'repaying'
           when 'repayment_late' then 'repaying'
           when 'repayment_completed' then 'completed'
           when 'cancelled' then 'cancelled'
         end as workflow_status
    from financing_servicing_updates s
   order by s.case_id,s.effective_at desc,s.created_at desc,s.id desc
)
update financing_application_cases c
   set workflow_status=latest.workflow_status,
       updated_at=now(),
       last_activity_at=greatest(c.last_activity_at,now()),
       version=c.version+1
  from latest
 where c.id=latest.case_id
   and latest.workflow_status is not null
   and c.workflow_status is distinct from latest.workflow_status;

update financing_application_cases c
   set workflow_status='approved',updated_at=now(),last_activity_at=now(),version=c.version+1
 where c.application_audience='customer'
   and c.workflow_status='completed'
   and exists(select 1 from customer_financing_applications a where a.id=c.application_id and a.status='approved')
   and not exists(select 1 from financing_servicing_updates s where s.case_id=c.id);

update financing_application_cases c
   set workflow_status='approved',updated_at=now(),last_activity_at=now(),version=c.version+1
 where c.application_audience='merchant'
   and c.workflow_status='completed'
   and exists(select 1 from merchant_financing_applications a where a.id=c.application_id and a.status='approved')
   and not exists(select 1 from financing_servicing_updates s where s.case_id=c.id);

-- Closed checkout intents / merchant exposures no longer block a later purchase
-- or financing cycle. The provider decision remains immutable in its own table.
drop index if exists customer_financing_one_active_intent_provider_uq;
create unique index customer_financing_one_active_intent_provider_uq
  on customer_financing_applications(user_id,provider_id,checkout_intent_id)
  where checkout_intent_id is not null
    and intent_closed_at is null
    and status in ('started','pending','approved');

drop index if exists merchant_financing_one_active_provider_uq;
create unique index merchant_financing_one_active_provider_uq
  on merchant_financing_applications(merchant_id,provider_id)
  where exposure_closed_at is null
    and status in ('started','pending','approved');

comment on column customer_financing_quotes.checkout_intent_version is
  'Checkout-intent derivation version. V1 is the historical quote fingerprint fallback; V2 is the stable server-derived cart intent.';
comment on column customer_financing_applications.intent_closed_at is
  'Closes duplicate-prevention for this purchase intent after provider-authorized purchase/disbursement/cancellation while preserving the immutable decision history.';
comment on column merchant_financing_applications.exposure_closed_at is
  'Closes merchant/provider active-exposure uniqueness after provider-reported repayment completion or cancellation.';

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
  v_quote record; v_provider record; v_existing record; v_active record;
  v_order_total numeric(12,2); v_initial numeric(12,2); v_min numeric := 0;
  v_id text; v_redirect text := null;
begin
  if p_user_id is null or length(trim(p_user_id)) < 1 then raise exception 'customer identity required'; end if;
  if p_provider_id is null or length(trim(p_provider_id)) < 1 then raise exception 'financing provider required'; end if;
  if p_quote_id is null or length(trim(p_quote_id)) < 1 then raise exception 'financing quote required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
  if p_initial_contribution is not null and round(p_initial_contribution,2) <> p_initial_contribution then raise exception 'initial contribution must have at most two decimal places'; end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:customer-financing:'||p_user_id));

  select id,status,amount::text,initial_contribution_amount::text,plan_mode,integration_mode,redirect_url
    into v_existing
    from customer_financing_applications
   where user_id=p_user_id and idempotency_key=p_idempotency_key
   limit 1 for update;
  if found then
    return jsonb_build_object(
      'applicationId',v_existing.id,'status',v_existing.status,
      'initialContributionAmount',v_existing.initial_contribution_amount,
      'remainingAmount',case when v_existing.initial_contribution_amount is null then null else (v_existing.amount::numeric-v_existing.initial_contribution_amount::numeric) end,
      'minimumInitialContributionPercent',0,'planMode',v_existing.plan_mode,'integrationMode',v_existing.integration_mode,
      'redirectUrl',v_existing.redirect_url,'providerApprovalRequired',true,'replayed',true
    );
  end if;

  select id,amount,expires_at,used_at,currency,checkout_intent_id,checkout_intent_version
    into v_quote
    from customer_financing_quotes
   where id=p_quote_id and user_id=p_user_id
   for update;
  if not found or v_quote.used_at is not null or v_quote.expires_at <= now() then raise exception 'financing quote expired'; end if;
  if v_quote.currency <> 'GHS' then raise exception 'unsupported financing currency'; end if;

  -- Historical V1 rows cannot be mathematically converted to the V2 intent hash
  -- because their original cart components were never persisted. Fail safely:
  -- while a legacy active application exists for this customer/provider, do not
  -- allow a V2 application to bypass it with a different hash.
  if v_quote.checkout_intent_version >= 2 then
    select id,status into v_active
      from customer_financing_applications
     where user_id=p_user_id and provider_id=p_provider_id
       and checkout_intent_version=1
       and intent_closed_at is null
       and status in ('started','pending','approved')
     order by created_at desc limit 1 for update;
    if found then raise exception 'legacy active financing application exists for this provider'; end if;
  end if;

  select id,status into v_active
    from customer_financing_applications
   where user_id=p_user_id and provider_id=p_provider_id
     and checkout_intent_id=v_quote.checkout_intent_id
     and intent_closed_at is null
     and status in ('started','pending','approved')
   order by created_at desc limit 1 for update;
  if found then raise exception 'active financing application already exists for this checkout intent and provider'; end if;

  select id,minimum_initial_contribution_percent,plan_mode,integration_mode,application_url,partner_organization_id,application_sla_hours
    into v_provider
    from financing_providers
   where id=p_provider_id and audience='customer' and status='active' and product_type in ('bnpl','installment')
     and marketplace_enabled=true
     and marketplace_partner_status='active'
     and security_review_status in ('passed','waived')
     and integration_status='ready'
     and commercial_status='active'
     and customer_channel_enabled=true
   for share;
  if not found then raise exception 'financing provider unavailable'; end if;

  v_min:=greatest(0,coalesce(v_provider.minimum_initial_contribution_percent,0));
  v_initial:=coalesce(p_initial_contribution,round(v_quote.amount*v_min/100,2));
  if v_initial<=0 then v_initial:=null; end if;
  if v_initial is not null and v_initial<round(v_quote.amount*v_min/100,2) then raise exception 'initial contribution is below provider minimum'; end if;
  if v_initial is not null and v_initial>=v_quote.amount then raise exception 'initial contribution must be less than the financing amount'; end if;

  if p_order_group_id is not null then
    select coalesce(sum(o.grand_total),0)::numeric(12,2) into v_order_total
      from orders o where o.group_id=p_order_group_id and o.user_id=p_user_id;
    if v_order_total<=0 or v_quote.amount>v_order_total then raise exception 'financing amount exceeds order total'; end if;
    if exists(select 1 from orders o where o.group_id=p_order_group_id and o.user_id=p_user_id and o.status in ('cancelled','disputed')) then raise exception 'order is not financeable'; end if;
  end if;

  v_id:='cfa_'||replace(gen_random_uuid()::text,'-','');
  v_redirect:=case when v_provider.integration_mode='partner_handoff' then v_provider.application_url else null end;

  insert into customer_financing_applications(
    id,user_id,provider_id,order_group_id,amount,currency,status,initial_contribution_amount,
    plan_mode,redirect_url,idempotency_key,quote_id,checkout_intent_id,checkout_intent_version
  ) values(
    v_id,p_user_id,p_provider_id,p_order_group_id,v_quote.amount,'GHS','started',v_initial,
    v_provider.plan_mode,v_redirect,p_idempotency_key,p_quote_id,v_quote.checkout_intent_id,v_quote.checkout_intent_version
  );

  update customer_financing_quotes set used_at=now()
   where id=p_quote_id and user_id=p_user_id and used_at is null;
  if not found then raise exception 'financing quote was already consumed'; end if;

  if v_provider.partner_organization_id is not null then
    insert into financing_application_cases(id,organization_id,provider_id,application_audience,application_id,sla_due_at)
    values('fc_'||v_id,v_provider.partner_organization_id,p_provider_id,'customer',v_id,now()+(coalesce(v_provider.application_sla_hours,24)||' hours')::interval)
    on conflict(provider_id,application_audience,application_id) do nothing;
  end if;

  return jsonb_build_object(
    'applicationId',v_id,'status','started','initialContributionAmount',v_initial,
    'remainingAmount',case when v_initial is null then null else round(v_quote.amount-v_initial,2) end,
    'minimumInitialContributionPercent',v_min,'planMode',v_provider.plan_mode,'integrationMode',v_provider.integration_mode,
    'redirectUrl',v_redirect,'providerApprovalRequired',true,'replayed',false
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
  v_provider record; v_existing record; v_active record; v_score record; v_result jsonb; v_id text;
begin
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant identity required'; end if;
  if p_provider_id is null or length(trim(p_provider_id)) < 1 then raise exception 'financing provider required'; end if;
  if p_requested_amount is null or p_requested_amount <= 0 or p_requested_amount > 100000000 then raise exception 'invalid requested amount'; end if;
  if round(p_requested_amount,2) <> p_requested_amount then raise exception 'requested amount must have at most two decimal places'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:merchant-financing:'||p_merchant_id));

  select id,status,requested_amount::text,score_snapshot into v_existing
    from merchant_financing_applications
   where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key
   limit 1 for update;
  if found then
    return jsonb_build_object('applicationId',v_existing.id,'status',v_existing.status,'scoreSnapshot',v_existing.score_snapshot,'replayed',true);
  end if;

  select id,status,requested_amount::text,score_snapshot into v_active
    from merchant_financing_applications
   where merchant_id=p_merchant_id and provider_id=p_provider_id
     and exposure_closed_at is null
     and status in ('started','pending','approved')
   order by created_at desc limit 1 for update;
  if found then raise exception 'active financing application already exists for this provider'; end if;

  select id,minimum_initial_contribution_percent,plan_mode,integration_mode,application_url,partner_organization_id,application_sla_hours
    into v_provider
    from financing_providers
   where id=p_provider_id and audience='merchant' and status='active'
     and product_type in ('merchant_cash_advance','line_of_credit','term_loan')
     and marketplace_enabled=true
     and marketplace_partner_status='active'
     and security_review_status in ('passed','waived')
     and integration_status='ready'
     and commercial_status='active'
     and customer_channel_enabled=true
   for share;
  if not found then raise exception 'merchant financing provider unavailable'; end if;

  select score,model_version,fresh_until into v_score
    from merchant_scores where merchant_id=p_merchant_id limit 1;
  if v_score.score is null or v_score.fresh_until is null or v_score.fresh_until <= now() then
    v_result:=recalculate_merchant_health_score(p_merchant_id);
    if coalesce(v_result->>'status','')='fresh' then
      v_score.score:=(v_result->>'score')::integer;
      v_score.model_version:=coalesce(v_result->>'modelVersion','merchant-health-v1');
    else
      v_score:=null;
    end if;
  end if;

  v_id:='mfa_'||replace(gen_random_uuid()::text,'-','');
  insert into merchant_financing_applications(
    id,merchant_id,provider_id,requested_amount,currency,status,score_snapshot,score_model_version,idempotency_key
  ) values(
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
    'applicationId',v_id,'status','started',
    'scoreSnapshot',case when v_score is null then null else v_score.score end,
    'providerApprovalRequired',true,'replayed',false
  );
end;
$$;

comment on function start_customer_financing_application(text,text,text,text,numeric,text) is
  'V2011 atomic customer financing start. V2 stable checkout intents cannot bypass legacy active applications; closed purchase intents may be financed again later.';
comment on function start_merchant_financing_application(text,text,numeric,text) is
  'V2011 atomic merchant financing start. One open provider exposure per merchant; provider-reported completion/cancellation releases the exposure lock.';

-- -----------------------------------------------------------------------------
-- Offer maker/checker and case workflow defense-in-depth.
-- -----------------------------------------------------------------------------
alter table financing_offers
  drop constraint if exists financing_offer_maker_checker_distinct;
alter table financing_offers
  add constraint financing_offer_maker_checker_distinct
  check (approved_by_user_id is null or approved_by_user_id is distinct from created_by_user_id);

do $$
declare v_duplicates text;
begin
  select string_agg(case_id||'='||cnt::text, ', ' order by case_id)
    into v_duplicates
    from (
      select case_id,count(*) cnt
        from financing_offers
       where status in ('draft','pending_supervisor','issued','accepted')
       group by case_id
      having count(*) > 1
    ) d;
  if v_duplicates is not null then
    raise exception 'cannot enforce one open financing offer per case; resolve open offer duplicates first: %',v_duplicates;
  end if;
end $$;

create unique index if not exists financing_offer_one_open_per_case_uq
  on financing_offers(case_id)
  where status in ('draft','pending_supervisor','issued','accepted');

create or replace function enforce_financing_case_workflow_transition()
returns trigger language plpgsql as $$
begin
  if new.workflow_status is not distinct from old.workflow_status then return new; end if;
  if
    (old.workflow_status='new' and new.workflow_status in ('assigned','under_review','information_requested','awaiting_supervisor','offer_issued','approved','declined','cancelled')) or
    (old.workflow_status='assigned' and new.workflow_status in ('under_review','information_requested','awaiting_supervisor','offer_issued','approved','declined','cancelled')) or
    (old.workflow_status='under_review' and new.workflow_status in ('assigned','information_requested','awaiting_supervisor','offer_issued','approved','declined','cancelled')) or
    (old.workflow_status='information_requested' and new.workflow_status in ('assigned','under_review','awaiting_supervisor','offer_issued','approved','declined','cancelled')) or
    (old.workflow_status='awaiting_supervisor' and new.workflow_status in ('under_review','offer_issued','declined','cancelled')) or
    (old.workflow_status='offer_issued' and new.workflow_status in ('under_review','offer_accepted','offer_declined','approved','declined','cancelled')) or
    (old.workflow_status='offer_accepted' and new.workflow_status in ('approved','declined','cancelled')) or
    (old.workflow_status='offer_declined' and new.workflow_status in ('under_review','declined','cancelled')) or
    (old.workflow_status='approved' and new.workflow_status in ('disbursed','cancelled')) or
    (old.workflow_status='disbursed' and new.workflow_status in ('repaying','completed','cancelled')) or
    (old.workflow_status='repaying' and new.workflow_status in ('completed','cancelled'))
  then
    return new;
  end if;
  raise exception 'invalid financing case workflow transition: % -> %',old.workflow_status,new.workflow_status;
end;
$$;

drop trigger if exists financing_case_workflow_transition_guard on financing_application_cases;
create trigger financing_case_workflow_transition_guard
before update of workflow_status on financing_application_cases
for each row execute function enforce_financing_case_workflow_transition();

comment on function enforce_financing_case_workflow_transition() is
  'Database defense-in-depth for financing operational workflow. Completed, declined and cancelled states are terminal; approval proceeds through approved/disbursed/repaying/completed.';
