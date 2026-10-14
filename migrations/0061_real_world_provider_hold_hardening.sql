-- Real-world provider-held funds hardening.
--
-- ELEMARKET is the marketplace control plane, not a custodian. A successful
-- provider payment is sufficient evidence that the configured PSP received the
-- customer payment. The PSP/subaccount remains responsible for safeguarding
-- and settlement. ELEMARKET records only marketplace entitlement, verification
-- decisions, provider references and audit history.

-- The historical release_escrow function created local merchant_settlements
-- rows and required a local payout destination. That is incompatible with the
-- current provider-held model. Keep the function for backward compatibility,
-- but make it an entitlement transition only.
create or replace function release_escrow(p_escrow_id text, p_reference text)
returns jsonb language plpgsql as $$
declare
  v_e record;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:escrow:'||p_escrow_id));
  select * into v_e from escrows where id=p_escrow_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if v_e.state <> 'release_pending' then raise exception 'escrow is not release eligible'; end if;
  if v_e.release_eligible_at is null or v_e.release_eligible_at > now() then
    raise exception 'buyer protection window is still active';
  end if;
  if exists(select 1 from escrow_disputes where escrow_id=v_e.id and status in ('open','under_review')) then
    raise exception 'escrow is disputed';
  end if;

  update escrows
     set state='released', released_at=now(), updated_at=now()
   where id=v_e.id;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(
    v_e.id,'release','debit',v_e.merchant_entitlement,p_reference,
    jsonb_build_object('providerSettlementRequired',true,'custodyBoundary','external_provider')
  ) on conflict do nothing;

  perform record_audit_event(
    'escrow.entitlement.released','escrow',v_e.id,null,'system',null,'success',
    jsonb_build_object('providerSettlementRequired',true,'amount',v_e.merchant_entitlement)
  );

  return jsonb_build_object(
    'escrowId',v_e.id,
    'amount',v_e.merchant_entitlement,
    'status','eligible_for_provider_release',
    'providerSettlementRequired',true
  );
end;
$$;

-- The old settlement-attempt function must not be usable as a hidden local
-- payout path. Provider settlement is initiated/managed at the provider
-- boundary after ELEMARKET verification.
create or replace function create_settlement_attempt(p_settlement_id text,p_provider_key text)
returns jsonb language plpgsql as $$
begin
  raise exception 'local settlement execution is disabled; use merchant fund release verification and the external payment provider';
end;
$$;

-- Payment completion from the configured PSP creates the marketplace escrow
-- and marks it provider-funded. This avoids the old state where successful PSP
-- payments could remain permanently in funding_pending waiting for a second,
-- non-existent local custody confirmation.
create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$
declare
  v_order record;
  v_escrow text;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;

  select id, merchant_id, product_total, delivery_total, platform_fee, merchant_net, grand_total
    into v_order
    from orders
   where id=new.order_id
   for update;
  if not found then raise exception 'escrow order not found'; end if;
  if round(new.amount,2) <> round(v_order.grand_total,2) then
    raise exception 'escrow payment/order amount mismatch';
  end if;

  v_escrow := 'esc_' || replace(gen_random_uuid()::text,'-','');
  insert into escrows(
    id,order_id,payment_id,merchant_id,gross_amount,delivery_amount,
    platform_fee,merchant_entitlement,state,funded_at,created_at,updated_at
  ) values(
    v_escrow,v_order.id,new.id,v_order.merchant_id,v_order.grand_total,
    v_order.delivery_total,v_order.platform_fee,v_order.merchant_net,
    'held',now(),now(),now()
  ) on conflict(order_id) do nothing;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'funded','credit',e.gross_amount,new.id,
         jsonb_build_object(
           'paymentId',new.id,
           'providerKey',new.provider_key,
           'providerConfirmed',true,
           'custodyBoundary','external_provider'
         )
    from escrows e
   where e.order_id=v_order.id
  on conflict do nothing;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'fee_reserved','debit',e.platform_fee,new.id,
         jsonb_build_object('source','provider_payment_completion')
    from escrows e
   where e.order_id=v_order.id and e.platform_fee > 0
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists payment_completed_escrow_create on payments;
create trigger payment_completed_escrow_create
after update of status on payments
for each row execute function create_escrow_for_completed_payment();

-- Make the approval boundary race-safe. The current request is already part
-- of the reservation set, so approval checks the eligible amount minus OTHER
-- active reservations, not the requestable amount that excludes itself.
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
  v_risk jsonb;
  v_other_reserved numeric := 0;
  v_eligible numeric := 0;
  v_note text := left(trim(coalesce(p_note,'')),2000);
begin
  if p_decision not in ('approve','reject') then raise exception 'invalid fund release decision'; end if;
  if p_admin_id is null or length(trim(p_admin_id))<1 then raise exception 'admin identity required'; end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:fund-release-request:'||p_request_id));
  select * into v_r from merchant_fund_release_requests where id=p_request_id for update;
  if not found then raise exception 'fund release request not found'; end if;
  if v_r.status <> 'pending_verification' then raise exception 'fund release request is no longer awaiting verification'; end if;
  v_merchant := v_r.merchant_id;

  if p_decision='approve' then
    select coalesce(sum(e.merchant_entitlement),0)
      into v_eligible
      from escrows e
     where e.merchant_id=v_merchant
       and (e.state='released' or (e.state='release_pending' and e.release_eligible_at is not null and e.release_eligible_at<=now()));

    select coalesce(sum(i.amount),0)
      into v_other_reserved
      from merchant_fund_release_request_items i
      join merchant_fund_release_requests r on r.id=i.request_id
     where r.merchant_id=v_merchant
       and r.id<>v_r.id
       and r.status in ('pending_verification','approved_for_provider','submitted_to_provider','provider_confirmed');

    if v_eligible - v_other_reserved < v_r.amount then
      raise exception 'provider-held eligible amount is no longer sufficient';
    end if;

    -- Re-run the risk model at approval time so stale request-time evidence
    -- cannot be used after disputes, velocity or merchant status changes.
    v_risk := evaluate_merchant_withdrawal_risk(v_merchant,v_r.amount);
    if v_risk->>'decision'='block' then raise exception 'risk engine blocked this request'; end if;
    if v_risk->>'decision'='review' and length(v_note)<3 then
      raise exception 'admin review note is required for a review-risk request';
    end if;

    v_status := 'approved_for_provider';
    update merchant_fund_release_requests
       set status=v_status,
           risk_assessment_id=coalesce(nullif(v_risk->>'assessmentId',''),risk_assessment_id),
           risk_decision=v_risk->>'decision',
           admin_note=v_note,
           reviewed_at=now(),
           reviewed_by=p_admin_id,
           updated_at=now()
     where id=v_r.id;
  else
    v_status := 'rejected';
    update merchant_fund_release_requests
       set status=v_status,admin_note=v_note,reviewed_at=now(),reviewed_by=p_admin_id,updated_at=now()
     where id=v_r.id;
  end if;

  perform record_audit_event(
    'admin.merchant_fund_release.'||p_decision,
    'merchant_fund_release_request',v_r.id,p_admin_id,'admin',null,'success',
    jsonb_build_object(
      'merchantId',v_merchant,
      'amount',v_r.amount,
      'riskDecision',coalesce(v_risk->>'decision',v_r.risk_decision),
      'providerActionRequired',p_decision='approve',
      'custodyBoundary','external_provider'
    )
  );

  return jsonb_build_object(
    'requestId',v_r.id,
    'status',v_status,
    'providerActionRequired',p_decision='approve'
  );
end;
$$;

comment on function release_escrow(text,text) is 'Marketplace entitlement transition only. Never creates local payout/settlement records.';
comment on function create_settlement_attempt(text,text) is 'Disabled legacy local-settlement path. Provider settlement remains external.';

drop function if exists create_merchant_fund_release_request(text,numeric,text);

alter table merchant_fund_release_requests
  add column if not exists idempotency_key text;
create unique index if not exists merchant_fund_release_requests_idempotency_uq
  on merchant_fund_release_requests(merchant_id,idempotency_key)
  where idempotency_key is not null;

create or replace function create_merchant_fund_release_request(
  p_merchant_id text,
  p_amount numeric,
  p_merchant_note text default '',
  p_idempotency_key text default null
) returns jsonb language plpgsql as $$
declare
  v_existing record;
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
  if p_idempotency_key is not null and (length(trim(p_idempotency_key)) < 16 or length(trim(p_idempotency_key)) > 128) then
    raise exception 'invalid fund release idempotency key';
  end if;

  if p_idempotency_key is not null then
    select id,status,amount,risk_decision into v_existing
      from merchant_fund_release_requests
     where merchant_id=p_merchant_id and idempotency_key=trim(p_idempotency_key)
     limit 1;
    if found then
      return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'amount',v_existing.amount,'riskDecision',v_existing.risk_decision,'duplicate',true);
    end if;
  end if;

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

  v_assessment := evaluate_merchant_withdrawal_risk(p_merchant_id,p_amount);
  v_risk_id := nullif(v_assessment->>'assessmentId','');
  v_risk_decision := v_assessment->>'decision';
  v_risk_score := coalesce((v_assessment->>'score')::integer,0);

  insert into merchant_fund_release_requests(
    id,merchant_id,amount,status,risk_assessment_id,risk_decision,merchant_note,idempotency_key,created_at,updated_at
  ) values(
    v_request,p_merchant_id,p_amount,'pending_verification',v_risk_id,v_risk_decision,
    left(trim(coalesce(p_merchant_note,'')),2000),nullif(trim(p_idempotency_key),''),now(),now()
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

  return jsonb_build_object('requestId',v_request,'status','pending_verification','amount',p_amount,'riskDecision',v_risk_decision,'riskScore',v_risk_score,'verificationRequired',true,'duplicate',false);
exception
  when unique_violation then
    if p_idempotency_key is not null then
      select id,status,amount,risk_decision into v_existing
        from merchant_fund_release_requests
       where merchant_id=p_merchant_id and idempotency_key=trim(p_idempotency_key)
       limit 1;
      if found then
        return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'amount',v_existing.amount,'riskDecision',v_existing.risk_decision,'duplicate',true);
      end if;
    end if;
    raise;
end;
$$;
