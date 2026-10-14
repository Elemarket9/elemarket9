-- Provider-held merchant funds + ELEMARKET release-request controls.
--
-- ELEMARKET never holds, wallets, or pays out merchant money. The configured
-- payment provider owns custody/settlement. This migration restores the
-- marketplace control plane needed to prevent premature/fraudulent release:
-- merchants request provider-held funds, every request enters verification,
-- risk is assessed, admins can approve/reject, and the provider remains the
-- only party that actually executes settlement.

create table if not exists merchant_fund_release_requests (
  id text primary key,
  merchant_id text not null references merchants(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  status text not null default 'pending_verification' check (status in (
    'pending_verification','approved_for_provider','submitted_to_provider',
    'provider_confirmed','rejected','failed','cancelled'
  )),
  risk_assessment_id text references risk_assessments(id) on delete set null,
  risk_decision text check (risk_decision in ('allow','review','block')),
  merchant_note text,
  admin_note text,
  provider_key text,
  provider_reference text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  provider_submitted_at timestamptz,
  provider_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists merchant_fund_release_requests_merchant_idx
  on merchant_fund_release_requests(merchant_id,status,created_at desc);
create index if not exists merchant_fund_release_requests_review_idx
  on merchant_fund_release_requests(status,created_at asc)
  where status='pending_verification';
create unique index if not exists merchant_fund_release_requests_provider_ref_uq
  on merchant_fund_release_requests(provider_key,provider_reference)
  where provider_key is not null and provider_reference is not null;

create table if not exists merchant_fund_release_request_items (
  id text primary key,
  request_id text not null references merchant_fund_release_requests(id) on delete cascade,
  escrow_id text not null references escrows(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique(request_id,escrow_id)
);
create index if not exists merchant_fund_release_request_items_escrow_idx
  on merchant_fund_release_request_items(escrow_id);

create or replace view merchant_provider_funds_summary as
with eligible as (
  select e.merchant_id, e.id escrow_id, e.merchant_entitlement amount
  from escrows e
  where (
    e.state='released'
    or (e.state='release_pending' and e.release_eligible_at is not null and e.release_eligible_at <= now())
  )
), reserved as (
  select i.escrow_id, coalesce(sum(i.amount),0)::numeric(12,2) reserved_amount
  from merchant_fund_release_request_items i
  join merchant_fund_release_requests r on r.id=i.request_id
  where r.status in ('pending_verification','approved_for_provider','submitted_to_provider','provider_confirmed')
  group by i.escrow_id
), merchant_totals as (
  select e.merchant_id,
         coalesce(sum(e.amount),0)::numeric(12,2) eligible_amount,
         coalesce(sum(greatest(e.amount-coalesce(r.reserved_amount,0),0)),0)::numeric(12,2) requestable_amount
  from eligible e
  left join reserved r on r.escrow_id=e.escrow_id
  group by e.merchant_id
)
select m.id merchant_id,
       m.name merchant_name,
       coalesce(t.eligible_amount,0)::numeric(12,2) provider_held_eligible_amount,
       coalesce(t.requestable_amount,0)::numeric(12,2) provider_requestable_amount
from merchants m
left join merchant_totals t on t.merchant_id=m.id;

-- Remove the misleading legacy settlement/payout amounts from the merchant
-- financial read model. Keep the first six legacy columns for compatibility,
-- but force them to zero; provider-held requestability is appended explicitly.
create or replace view merchant_financial_summary as
select m.id merchant_id,
       m.name merchant_name,
       0::numeric(12,2) held_amount,
       0::numeric(12,2) available_amount,
       0::numeric(12,2) payout_processing,
       0::numeric(12,2) paid_out,
       coalesce(sum(case when o.status <> 'cancelled' then o.product_total else 0 end),0)::numeric(12,2) total_sales,
       coalesce(sum(case when e.state in ('held','fulfilling','delivered','release_pending','refund_pending') then e.merchant_entitlement else 0 end),0)::numeric(12,2) pending_amount,
       coalesce(sum(case when e.state='disputed' then e.merchant_entitlement else 0 end),0)::numeric(12,2) disputed_amount,
       coalesce(v.provider_held_eligible_amount,0)::numeric(12,2) provider_held_eligible_amount,
       coalesce(v.provider_requestable_amount,0)::numeric(12,2) provider_requestable_amount
from merchants m
left join orders o on o.merchant_id=m.id
left join escrows e on e.order_id=o.id
left join merchant_provider_funds_summary v on v.merchant_id=m.id
group by m.id,m.name,v.provider_held_eligible_amount,v.provider_requestable_amount;

create or replace function create_merchant_fund_release_request(
  p_merchant_id text,
  p_amount numeric,
  p_merchant_note text default ''
) returns jsonb language plpgsql as $$
declare
  v_merchant_status text;
  v_requestable numeric := 0;
  v_remaining numeric;
  v_request text := 'frq_'||replace(gen_random_uuid()::text,'-','');
  v_item record;
  v_assessment jsonb;
  v_risk_id text;
  v_risk_decision text;
  v_risk_score integer;
  v_items integer := 0;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid fund release amount'; end if;
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant required'; end if;
  if p_amount > 100000000 then raise exception 'fund release amount too large'; end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:fund-release:'||p_merchant_id));
  select status into v_merchant_status from merchants where id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  if v_merchant_status <> 'active' then raise exception 'merchant is not active'; end if;

  select provider_requestable_amount into v_requestable
  from merchant_provider_funds_summary where merchant_id=p_merchant_id;
  v_requestable := coalesce(v_requestable,0);
  if p_amount > v_requestable then
    raise exception 'requested amount exceeds provider-held amount eligible for release request';
  end if;

  -- Every request is first a verification case. Risk is evidence for the
  -- reviewer; it never causes ELEMARKET to move funds.
  v_assessment := evaluate_merchant_withdrawal_risk(p_merchant_id,p_amount);
  v_risk_id := nullif(v_assessment->>'assessmentId','');
  v_risk_decision := v_assessment->>'decision';
  v_risk_score := coalesce((v_assessment->>'score')::integer,0);

  insert into merchant_fund_release_requests(
    id,merchant_id,amount,status,risk_assessment_id,risk_decision,merchant_note,created_at,updated_at
  ) values(
    v_request,p_merchant_id,p_amount,'pending_verification',v_risk_id,v_risk_decision,left(trim(coalesce(p_merchant_note,'')),2000),now(),now()
  );

  v_remaining := p_amount;
  for v_item in
    select e.id escrow_id,
           greatest(e.merchant_entitlement-coalesce(r.reserved_amount,0),0)::numeric(12,2) available_amount
      from escrows e
      left join (
        select i.escrow_id,sum(i.amount)::numeric(12,2) reserved_amount
        from merchant_fund_release_request_items i
        join merchant_fund_release_requests rr on rr.id=i.request_id
        where rr.status in ('pending_verification','approved_for_provider','submitted_to_provider','provider_confirmed')
        group by i.escrow_id
      ) r on r.escrow_id=e.id
     where e.merchant_id=p_merchant_id
       and (e.state='released' or (e.state='release_pending' and e.release_eligible_at is not null and e.release_eligible_at<=now()))
       and greatest(e.merchant_entitlement-coalesce(r.reserved_amount,0),0)>0
     order by coalesce(e.released_at,e.release_eligible_at,e.updated_at),e.id
     for update of e
  loop
    exit when v_remaining <= 0;
    insert into merchant_fund_release_request_items(id,request_id,escrow_id,amount)
    values('frqi_'||replace(gen_random_uuid()::text,'-',''),v_request,v_item.escrow_id,least(v_remaining,v_item.available_amount));
    v_remaining := v_remaining-least(v_remaining,v_item.available_amount);
    v_items := v_items+1;
  end loop;

  if v_remaining > 0.005 or v_items=0 then raise exception 'unable to reserve eligible provider-held funds'; end if;

  perform record_audit_event(
    'merchant.fund_release.requested','merchant_fund_release_request',v_request,p_merchant_id,'merchant',null,'success',
    jsonb_build_object('amount',p_amount,'riskDecision',v_risk_decision,'riskScore',v_risk_score,'verificationRequired',true,'providerCustody',true)
  );
  return jsonb_build_object('requestId',v_request,'status','pending_verification','amount',p_amount,'riskDecision',v_risk_decision,'riskScore',v_risk_score,'verificationRequired',true);
end;
$$;

create or replace function review_merchant_fund_release_request(
  p_request_id text,
  p_decision text,
  p_admin_id text,
  p_note text default ''
) returns jsonb language plpgsql as $$
declare
  v_r record;
  v_status text;
  v_merchant text;
begin
  if p_decision not in ('approve','reject') then raise exception 'invalid fund release decision'; end if;
  if p_admin_id is null or length(trim(p_admin_id))<1 then raise exception 'admin identity required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:fund-release-request:'||p_request_id));
  select * into v_r from merchant_fund_release_requests where id=p_request_id for update;
  if not found then raise exception 'fund release request not found'; end if;
  if v_r.status <> 'pending_verification' then raise exception 'fund release request is no longer awaiting verification'; end if;
  v_merchant := v_r.merchant_id;

  if p_decision='approve' then
    -- Re-check risk and eligibility at the exact approval boundary.
    if v_r.risk_decision='block' then raise exception 'risk engine blocked this request'; end if;
    if not exists (
      select 1 from merchant_provider_funds_summary s
      where s.merchant_id=v_merchant and s.provider_requestable_amount >= v_r.amount
    ) then raise exception 'provider-held eligible amount is no longer sufficient'; end if;
    v_status := 'approved_for_provider';
  else
    v_status := 'rejected';
  end if;

  update merchant_fund_release_requests
     set status=v_status,admin_note=left(trim(coalesce(p_note,'')),2000),reviewed_at=now(),reviewed_by=p_admin_id,updated_at=now()
   where id=v_r.id;

  perform record_audit_event(
    'admin.merchant_fund_release.'||p_decision,'merchant_fund_release_request',v_r.id,p_admin_id,'admin',null,'success',
    jsonb_build_object('merchantId',v_merchant,'amount',v_r.amount,'providerActionRequired',p_decision='approve')
  );
  return jsonb_build_object('requestId',v_r.id,'status',v_status,'providerActionRequired',p_decision='approve');
end;
$$;

-- Risk function remains named for compatibility, but it is now explicitly a
-- release-request risk assessment and must never reference local payout rows.
create or replace function evaluate_merchant_withdrawal_risk(
  p_merchant_id text,
  p_amount numeric
) returns jsonb language plpgsql as $$
declare
  v_score integer := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_decision text := 'allow';
  v_id text := 'risk_'||replace(gen_random_uuid()::text,'-','');
  v_requestable numeric := 0;
  v_disputed numeric := 0;
  v_recent_requests integer := 0;
  v_status text;
begin
  if p_amount<=0 then raise exception 'invalid fund release amount'; end if;
  select status into v_status from merchants where id=p_merchant_id;
  if v_status is null then raise exception 'merchant not found'; end if;
  if v_status<>'active' then v_score:=100; v_reasons:=v_reasons||jsonb_build_array('merchant_not_active'); end if;
  select coalesce(provider_requestable_amount,0) into v_requestable from merchant_provider_funds_summary where merchant_id=p_merchant_id;
  if p_amount>v_requestable then v_score:=100; v_reasons:=v_reasons||jsonb_build_array('release_exceeds_provider_eligible_amount'); end if;
  select coalesce(sum(e.merchant_entitlement),0) into v_disputed from escrows e where e.merchant_id=p_merchant_id and e.state='disputed';
  if v_disputed>0 then v_score:=v_score+20; v_reasons:=v_reasons||jsonb_build_array('active_dispute_exposure'); end if;
  select count(*) into v_recent_requests from merchant_fund_release_requests where merchant_id=p_merchant_id and created_at>now()-interval '24 hours' and status not in ('rejected','cancelled','failed');
  if v_recent_requests>=3 then v_score:=v_score+25; v_reasons:=v_reasons||jsonb_build_array('release_request_velocity'); end if;
  if v_recent_requests>=6 then v_score:=v_score+35; v_reasons:=v_reasons||jsonb_build_array('excessive_release_request_velocity'); end if;
  if p_amount>=20000 then v_score:=v_score+20; v_reasons:=v_reasons||jsonb_build_array('high_value_release_request'); end if;
  v_score:=least(v_score,100);
  if v_score>=70 then v_decision:='block'; elsif v_score>=40 then v_decision:='review'; end if;
  insert into risk_assessments(id,subject_type,subject_id,decision,score,reasons,amount)
  values(v_id,'withdrawal',p_merchant_id,v_decision,v_score,v_reasons,p_amount);
  if v_decision='review' then
    insert into risk_flags(id,subject_type,subject_id,flag_code,severity,status,evidence)
    values('rf_'||replace(gen_random_uuid()::text,'-',''),'merchant',p_merchant_id,'fund_release_review','high','open',jsonb_build_object('assessmentId',v_id,'amount',p_amount,'reasons',v_reasons,'score',v_score));
  elsif v_decision='block' then
    insert into risk_flags(id,subject_type,subject_id,flag_code,severity,status,evidence)
    values('rf_'||replace(gen_random_uuid()::text,'-',''),'merchant',p_merchant_id,'fund_release_blocked','critical','open',jsonb_build_object('assessmentId',v_id,'amount',p_amount,'reasons',v_reasons,'score',v_score));
  end if;
  return jsonb_build_object('assessmentId',v_id,'decision',v_decision,'score',v_score,'reasons',v_reasons);
end;
$$;

comment on table merchant_fund_release_requests is 'Marketplace verification workflow for provider-held merchant funds; ELEMARKET never holds or executes settlement.';
comment on table merchant_fund_release_request_items is 'Eligibility reservations only; no money movement or custody.';
