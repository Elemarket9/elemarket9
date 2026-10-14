-- ELEMARKET fraud/risk controls.
-- Risk is an internal decision layer. It does not custody funds and does not
-- replace Hubtel/Paystack or other provider fraud/compliance controls.

create table if not exists risk_assessments (
  id text primary key,
  subject_type text not null check (subject_type in ('customer','merchant','transaction','withdrawal')),
  subject_id text not null,
  fingerprint text,
  decision text not null check (decision in ('allow','review','block')),
  score integer not null check (score between 0 and 100),
  reasons jsonb not null default '[]'::jsonb,
  amount numeric(12,2),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  created_at timestamptz not null default now()
);
create index if not exists risk_assessments_subject_idx on risk_assessments(subject_type,subject_id,created_at desc);
create index if not exists risk_assessments_decision_idx on risk_assessments(decision,created_at desc);
create unique index if not exists risk_assessments_fingerprint_uq on risk_assessments(subject_type,subject_id,fingerprint) where fingerprint is not null;

create table if not exists risk_flags (
  id text primary key,
  subject_type text not null check (subject_type in ('customer','merchant')),
  subject_id text not null,
  flag_code text not null,
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index if not exists risk_flags_subject_idx on risk_flags(subject_type,subject_id,status,created_at desc);

create or replace function evaluate_checkout_risk(
  p_user_id text,
  p_fingerprint text,
  p_product_total numeric,
  p_grand_total numeric
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
  v_recent_same_fingerprint integer;
begin
  if p_user_id is null or char_length(p_user_id) < 3 then raise exception 'invalid risk subject'; end if;
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 then raise exception 'invalid risk fingerprint'; end if;
  if p_product_total < 0 or p_grand_total < 0 then raise exception 'invalid risk amount'; end if;

  select count(*) into v_recent_orders from orders where user_id=p_user_id and created_at > now()-interval '10 minutes';
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

  insert into risk_assessments(id,subject_type,subject_id,fingerprint,decision,score,reasons,amount)
  values(v_id,'customer',p_user_id,p_fingerprint,v_decision,v_score,v_reasons,p_grand_total)
  on conflict (subject_type,subject_id,fingerprint) where fingerprint is not null do update
    set decision=excluded.decision,score=excluded.score,reasons=excluded.reasons,amount=excluded.amount,created_at=now();

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

  select coalesce(sum(case when e.state in ('released','settled') then e.merchant_entitlement else 0 end),0),
         coalesce(sum(case when e.state='disputed' then e.merchant_entitlement else 0 end),0)
    into v_available,v_disputed from escrows e where e.merchant_id=p_merchant_id;
  if p_amount > v_available then v_score := v_score + 100; v_reasons := v_reasons || jsonb_build_array('withdrawal_exceeds_available'); end if;
  if v_disputed > 0 then v_score := v_score + 20; v_reasons := v_reasons || jsonb_build_array('active_dispute_exposure'); end if;

  select count(*) into v_recent_payouts from merchant_settlements where merchant_id=p_merchant_id and created_at > now()-interval '24 hours';
  if v_recent_payouts >= 5 then v_score := v_score + 25; v_reasons := v_reasons || jsonb_build_array('payout_velocity'); end if;
  if p_amount >= 20000 then v_score := v_score + 20; v_reasons := v_reasons || jsonb_build_array('high_value_withdrawal'); end if;

  v_score := least(v_score,100);
  if v_score >= 70 then v_decision := 'block'; elsif v_score >= 40 then v_decision := 'review'; end if;
  insert into risk_assessments(id,subject_type,subject_id,decision,score,reasons,amount)
  values(v_id,'withdrawal',p_merchant_id,v_decision,v_score,v_reasons,p_amount);
  return jsonb_build_object('assessmentId',v_id,'decision',v_decision,'score',v_score,'reasons',v_reasons);
end; $$;

create or replace function enforce_checkout_risk_before_order()
returns trigger language plpgsql as $$
declare
  v_risk jsonb;
begin
  if new.status='payment_pending' then
    v_risk := evaluate_checkout_risk(new.user_id, coalesce((select fingerprint from order_idempotency where group_id=new.group_id limit 1), repeat('0',64)), new.product_total, new.grand_total);
    if v_risk->>'decision' = 'block' then
      raise exception 'checkout blocked by ELEMARKET risk controls';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_checkout_risk_guard on orders;
create trigger trg_checkout_risk_guard
before insert on orders
for each row execute function enforce_checkout_risk_before_order();
