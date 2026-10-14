-- Deep fraud/risk hardening.
-- Fixes the initial risk layer's auditability and ensures withdrawal risk is
-- enforced at the settlement-attempt boundary.

alter table risk_assessments
  add column if not exists reference_id text;

create index if not exists risk_assessments_reference_idx
  on risk_assessments(reference_id)
  where reference_id is not null;

-- A risk assessment is an audit event, not a cache. Repeated fingerprints must
-- not overwrite earlier assessments.
drop index if exists risk_assessments_fingerprint_uq;

create or replace function evaluate_checkout_risk(
  p_user_id text,
  p_fingerprint text,
  p_product_total numeric,
  p_grand_total numeric,
  p_reference_id text default null
) returns jsonb language plpgsql as $$
declare
  v_score integer := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_decision text := 'allow';
  v_id text := 'risk_' || replace(gen_random_uuid()::text,'-','');
  v_recent_orders integer;
  v_failed_payments integer;
  v_recent_disputes integer;
  v_account_age interval;
  v_existing_flag boolean;
begin
  if p_user_id is null or char_length(p_user_id) < 3 then raise exception 'invalid risk subject'; end if;
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'invalid risk fingerprint'; end if;
  if p_product_total < 0 or p_grand_total < 0 or p_grand_total < p_product_total then raise exception 'invalid risk amount'; end if;

  select count(*) into v_recent_orders
    from orders where user_id=p_user_id and created_at > now()-interval '10 minutes';
  if v_recent_orders >= 5 then v_score := v_score + 35; v_reasons := v_reasons || jsonb_build_array('checkout_velocity'); end if;
  if v_recent_orders >= 10 then v_score := v_score + 40; v_reasons := v_reasons || jsonb_build_array('excessive_checkout_velocity'); end if;

  select count(*) into v_failed_payments
    from payment_attempts pa join payments p on p.id=pa.payment_id
   where p.user_id=p_user_id and pa.status='failed' and pa.created_at > now()-interval '30 minutes';
  if v_failed_payments >= 3 then v_score := v_score + 20; v_reasons := v_reasons || jsonb_build_array('payment_failures'); end if;
  if v_failed_payments >= 8 then v_score := v_score + 25; v_reasons := v_reasons || jsonb_build_array('excessive_payment_failures'); end if;

  select count(*) into v_recent_disputes
    from escrow_disputes d join escrows e on e.id=d.escrow_id
   where e.order_id in (select id from orders where user_id=p_user_id)
     and d.created_at > now()-interval '90 days';
  if v_recent_disputes >= 3 then v_score := v_score + 15; v_reasons := v_reasons || jsonb_build_array('repeated_disputes'); end if;
  if v_recent_disputes >= 8 then v_score := v_score + 25; v_reasons := v_reasons || jsonb_build_array('high_dispute_frequency'); end if;

  select now()-"createdAt" into v_account_age from "user" where id=p_user_id;
  if v_account_age is null then raise exception 'risk user not found'; end if;
  if v_account_age < interval '24 hours' and p_grand_total >= 5000 then v_score := v_score + 20; v_reasons := v_reasons || jsonb_build_array('new_account_high_value'); end if;
  if p_grand_total >= 20000 then v_score := v_score + 30; v_reasons := v_reasons || jsonb_build_array('high_value_checkout'); end if;

  v_score := least(v_score,100);
  if v_score >= 70 then v_decision := 'block'; elsif v_score >= 40 then v_decision := 'review'; end if;

  insert into risk_assessments(id,subject_type,subject_id,reference_id,fingerprint,decision,score,reasons,amount)
  values(v_id,'customer',p_user_id,p_reference_id,p_fingerprint,v_decision,v_score,v_reasons,p_grand_total);

  if v_decision='review' and p_reference_id is not null then
    select exists(
      select 1 from risk_flags
       where subject_type='customer' and subject_id=p_user_id
         and flag_code='checkout_review' and status='open'
         and evidence->>'referenceId'=p_reference_id
    ) into v_existing_flag;
    if not v_existing_flag then
      insert into risk_flags(id,subject_type,subject_id,flag_code,severity,status,evidence)
      values(
        'rf_'||replace(gen_random_uuid()::text,'-',''),
        'customer',p_user_id,'checkout_review','high','open',
        jsonb_build_object('assessmentId',v_id,'referenceId',p_reference_id,'reasons',v_reasons,'score',v_score)
      );
    end if;
  end if;

  return jsonb_build_object('assessmentId',v_id,'decision',v_decision,'score',v_score,'reasons',v_reasons);
end; $$;

create or replace function evaluate_merchant_withdrawal_risk(
  p_merchant_id text,
  p_amount numeric
) returns jsonb language plpgsql as $$
declare
  v_score integer := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_decision text := 'allow';
  v_id text := 'risk_' || replace(gen_random_uuid()::text,'-','');
  v_available numeric := 0;
  v_disputed numeric := 0;
  v_recent_payouts integer := 0;
  v_status text;
begin
  if p_amount <= 0 then raise exception 'invalid withdrawal amount'; end if;
  select status into v_status from merchants where id=p_merchant_id;
  if v_status is null then raise exception 'merchant not found'; end if;
  if v_status <> 'active' then v_score := 100; v_reasons := v_reasons || jsonb_build_array('merchant_not_active'); end if;

  select coalesce(available_amount,0), coalesce(disputed_amount,0)
    into v_available,v_disputed
    from merchant_financial_summary where merchant_id=p_merchant_id;
  if p_amount > v_available then v_score := v_score + 100; v_reasons := v_reasons || jsonb_build_array('withdrawal_exceeds_available'); end if;
  if v_disputed > 0 then v_score := v_score + 20; v_reasons := v_reasons || jsonb_build_array('active_dispute_exposure'); end if;

  select count(*) into v_recent_payouts
    from merchant_settlements
   where merchant_id=p_merchant_id and created_at > now()-interval '24 hours';
  if v_recent_payouts >= 5 then v_score := v_score + 25; v_reasons := v_reasons || jsonb_build_array('payout_velocity'); end if;
  if p_amount >= 20000 then v_score := v_score + 20; v_reasons := v_reasons || jsonb_build_array('high_value_withdrawal'); end if;

  v_score := least(v_score,100);
  if v_score >= 70 then v_decision := 'block'; elsif v_score >= 40 then v_decision := 'review'; end if;

  insert into risk_assessments(id,subject_type,subject_id,decision,score,reasons,amount)
  values(v_id,'withdrawal',p_merchant_id,v_decision,v_score,v_reasons,p_amount);
  if v_decision='review' then
    insert into risk_flags(id,subject_type,subject_id,flag_code,severity,status,evidence)
    values('rf_'||replace(gen_random_uuid()::text,'-',''),'merchant',p_merchant_id,'withdrawal_review','high','open',
      jsonb_build_object('assessmentId',v_id,'amount',p_amount,'reasons',v_reasons,'score',v_score));
  end if;
  return jsonb_build_object('assessmentId',v_id,'decision',v_decision,'score',v_score,'reasons',v_reasons);
end; $$;

create or replace function enforce_checkout_risk_before_order()
returns trigger language plpgsql as $$
declare
  v_risk jsonb;
  v_fingerprint text;
begin
  if new.status <> 'payment_pending' then return new; end if;
  select fingerprint into v_fingerprint from order_idempotency where group_id=new.group_id limit 1;
  if v_fingerprint is null then raise exception 'checkout risk fingerprint missing'; end if;
  v_risk := evaluate_checkout_risk(new.user_id, v_fingerprint, new.product_total, new.grand_total, new.id);
  if v_risk->>'decision' = 'block' then
    raise exception 'checkout blocked by ELEMARKET risk controls';
  end if;
  return new;
end; $$;

drop trigger if exists trg_checkout_risk_guard on orders;
create trigger trg_checkout_risk_guard
before insert on orders
for each row execute function enforce_checkout_risk_before_order();

-- Enforce withdrawal risk immediately before a settlement attempt is created.
-- A review/block can never be bypassed by calling the custody adapter directly.
create or replace function create_settlement_attempt(p_settlement_id text,p_provider_key text)
returns jsonb language plpgsql as $$
declare
  v_s record; v_p record; v_attempt integer; v_id text; v_key text; v_risk jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement:'||p_settlement_id));
  select * into v_s from merchant_settlements where id=p_settlement_id for update;
  if not found then raise exception 'settlement not found'; end if;
  if v_s.status <> 'eligible' then raise exception 'settlement is not eligible'; end if;

  v_risk := evaluate_merchant_withdrawal_risk(v_s.merchant_id, v_s.amount);
  if v_risk->>'decision' <> 'allow' then
    raise exception 'withdrawal blocked or requires manual risk review';
  end if;

  select * into v_p from custody_providers where provider_key=p_provider_key and status='active';
  if not found then raise exception 'custody provider unavailable'; end if;
  select coalesce(max(attempt_no),0)+1 into v_attempt from settlement_attempts where settlement_id=v_s.id;
  v_id := 'sat_'||replace(gen_random_uuid()::text,'-','');
  v_key := 'settlement:'||v_s.id||':attempt:'||v_attempt;
  insert into settlement_attempts(id,settlement_id,attempt_no,provider_id,idempotency_key,status)
  values(v_id,v_s.id,v_attempt,v_p.id,v_key,'created');
  update merchant_settlements set status='processing',updated_at=now() where id=v_s.id;
  update settlement_attempts set status='submitted' where id=v_id;
  return jsonb_build_object('attemptId',v_id,'settlementId',v_s.id,'idempotencyKey',v_key,'amount',v_s.amount,'currency',v_s.currency,'destinationRef',v_s.payout_destination_ref);
end; $$;
