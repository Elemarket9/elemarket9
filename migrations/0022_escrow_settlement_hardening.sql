-- v1.42.1: close escrow lifecycle gaps discovered in CTO deep scan.
-- This migration separates entitlement release from provider payout/refund
-- confirmation and makes payment/refund transitions consistent with escrow.

alter table escrows drop constraint if exists escrows_state_check;
alter table escrows add constraint escrows_state_check check (
  state in ('funding_pending','funded','held','fulfilling','delivered','release_pending','released','settled','disputed','refund_pending','refunded','cancelled')
);

alter table merchant_settlements
  add column if not exists processed_at timestamptz,
  add column if not exists failure_code text,
  add column if not exists failure_message text;
create unique index if not exists merchant_settlements_provider_ref_uq
  on merchant_settlements(provider_reference)
  where provider_reference is not null;

-- A payment cannot be provider-refunded after the marketplace entitlement has
-- already been released/settled. Such cases require a controlled post-settlement
-- refund/chargeback workflow rather than silently creating a contradictory ledger.
create or replace function guard_payment_refund_against_escrow()
returns trigger language plpgsql as $$
declare v_state text;
begin
  if new.status = 'refunded' and old.status <> 'refunded' then
    select state into v_state from escrows where payment_id=new.id for update;
    if v_state in ('released','settled') then
      raise exception 'payment refund requires post-settlement refund workflow';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists payment_refund_escrow_guard on payments;
create trigger payment_refund_escrow_guard
before update of status on payments
for each row execute function guard_payment_refund_against_escrow();

-- Provider-confirmed refunds are the only path that makes the escrow ledger
-- terminally refunded. A dispute decision only creates refund_pending.
create or replace function finalize_escrow_for_refunded_payment()
returns trigger language plpgsql as $$
declare v_e record;
begin
  if new.status <> 'refunded' or old.status = 'refunded' then return new; end if;
  select * into v_e from escrows where payment_id=new.id for update;
  if not found then return new; end if;
  if v_e.state not in ('held','fulfilling','delivered','release_pending','disputed','refund_pending') then
    raise exception 'escrow cannot be refunded from current state';
  end if;
  update escrows set state='refunded', updated_at=now() where id=v_e.id;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'refund','debit',v_e.gross_amount,new.id,jsonb_build_object('paymentId',new.id,'source','provider_webhook'))
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists payment_refunded_escrow_finalize on payments;
create trigger payment_refunded_escrow_finalize
after update of status on payments
for each row execute function finalize_escrow_for_refunded_payment();

-- Release creates an entitlement for payout; it does not claim that the
-- licensed provider has paid the merchant.
create or replace function begin_merchant_settlement(p_settlement_id text)
returns jsonb language plpgsql as $$
declare v_s record; v_e record;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement:'||p_settlement_id));
  select * into v_s from merchant_settlements where id=p_settlement_id for update;
  if not found then raise exception 'settlement not found'; end if;
  select * into v_e from escrows where id=v_s.escrow_id for update;
  if v_s.status <> 'eligible' then raise exception 'settlement is not eligible'; end if;
  if v_e.state <> 'released' then raise exception 'escrow is not released'; end if;
  update merchant_settlements set status='processing',updated_at=now() where id=v_s.id;
  return jsonb_build_object('settlementId',v_s.id,'status','processing','amount',v_s.amount);
end;
$$;

create or replace function confirm_merchant_settlement(p_settlement_id text,p_provider_reference text)
returns jsonb language plpgsql as $$
declare v_s record; v_e record;
begin
  if p_provider_reference is null or length(trim(p_provider_reference)) < 3 then raise exception 'provider reference required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement:'||p_settlement_id));
  select * into v_s from merchant_settlements where id=p_settlement_id for update;
  if not found then raise exception 'settlement not found'; end if;
  select * into v_e from escrows where id=v_s.escrow_id for update;
  if v_s.status <> 'processing' then raise exception 'settlement is not processing'; end if;
  if v_e.state <> 'released' then raise exception 'escrow is not released'; end if;
  update merchant_settlements
     set status='paid',provider_reference=trim(p_provider_reference),processed_at=now(),updated_at=now()
   where id=v_s.id;
  update escrows set state='settled',settled_at=now(),updated_at=now() where id=v_e.id;
  return jsonb_build_object('settlementId',v_s.id,'status','paid','escrowId',v_e.id);
end;
$$;

create or replace function fail_merchant_settlement(p_settlement_id text,p_failure_code text,p_failure_message text default '')
returns jsonb language plpgsql as $$
declare v_s record;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:settlement:'||p_settlement_id));
  select * into v_s from merchant_settlements where id=p_settlement_id for update;
  if not found then raise exception 'settlement not found'; end if;
  if v_s.status <> 'processing' then raise exception 'settlement is not processing'; end if;
  update merchant_settlements
     set status='eligible',failure_code=left(coalesce(p_failure_code,'provider_failure'),120),failure_message=left(coalesce(p_failure_message,''),500),updated_at=now()
   where id=v_s.id;
  return jsonb_build_object('settlementId',v_s.id,'status','eligible');
end;
$$;

-- A dispute decision is not the same thing as a provider refund.
create or replace function resolve_escrow_dispute(p_dispute_id text, p_resolution text, p_admin_id text, p_note text default '')
returns jsonb language plpgsql as $$
declare v_d record; v_e record;
begin
  if p_resolution not in ('release','refund') then raise exception 'invalid dispute resolution'; end if;
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:dispute:'||p_dispute_id));
  select * into v_d from escrow_disputes where id=p_dispute_id for update;
  if not found then raise exception 'dispute not found'; end if;
  if v_d.status not in ('open','under_review') then raise exception 'dispute already resolved'; end if;
  select * into v_e from escrows where id=v_d.escrow_id for update;
  if p_resolution='release' then
    update escrow_disputes set status='resolved_release',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now() where id=v_d.id;
    update escrows set state='released',released_at=now(),updated_at=now() where id=v_e.id;
    insert into merchant_settlements(id,escrow_id,merchant_id,amount,status)
      values('set_'||replace(gen_random_uuid()::text,'-',''),v_e.id,v_e.merchant_id,v_e.merchant_entitlement,'eligible') on conflict(escrow_id) do nothing;
    insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
      values(v_e.id,'release','debit',v_e.merchant_entitlement,p_dispute,jsonb_build_object('resolution','release','adminId',p_admin_id)) on conflict do nothing;
  else
    if v_e.state in ('released','settled') then raise exception 'released escrow requires post-settlement refund workflow'; end if;
    update escrow_disputes set status='resolved_refund',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now() where id=v_d.id;
    update escrows set state='refund_pending',updated_at=now() where id=v_e.id;
  end if;
  return jsonb_build_object('disputeId',v_d.id,'escrowId',v_e.id,'resolution',p_resolution,'state',(select state from escrows where id=v_e.id));
end;
$$;

-- Recreate the merchant financial view for databases that already applied 0021,
-- so refund_pending remains visible as held without requiring a destructive rebuild.
create or replace view merchant_financial_summary as
select m.id merchant_id,
       m.name merchant_name,
       coalesce(sum(case when e.state in ('held','fulfilling','delivered','release_pending','disputed','refund_pending') then e.merchant_entitlement else 0 end),0)::numeric(12,2) as held_amount,
       coalesce(sum(case when s.status='eligible' then s.amount else 0 end),0)::numeric(12,2) as available_amount,
       coalesce(sum(case when s.status='processing' then s.amount else 0 end),0)::numeric(12,2) as payout_processing,
       coalesce(sum(case when s.status='paid' then s.amount else 0 end),0)::numeric(12,2) as paid_out
from merchants m
left join escrows e on e.merchant_id=m.id
left join merchant_settlements s on s.escrow_id=e.id
group by m.id,m.name;
