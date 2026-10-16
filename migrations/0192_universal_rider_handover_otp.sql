-- ELEMARKET universal rider-initiated handover OTP policy.
-- Replaces the prior >GHS 5000 OTP exception with OTP confirmation for EVERY
-- new delivery, regardless of price or payment method. Historic migrations are
-- immutable; these definitions supersede their older functions and triggers.
-- Legacy already-confirmed deliveries are not retroactively invalidated.

-- Ensure every newly created order has a reachable, canonical phone BEFORE
-- initiating the provider payment. Preserve phone/address lock on paid orders.
create or replace function elemarket_guard_paid_delivery_snapshot() returns trigger language plpgsql as $$
declare v_phone text;
begin
 if tg_op='INSERT' then
   select p.phone into v_phone from profiles p where p.user_id=new.user_id;
   if v_phone is null or v_phone !~ '^[+]233[25][0-9]{8}$' then
     raise exception 'verified delivery contact number required for every order';
   end if;
 end if;
 if tg_op='UPDATE' and old.status in ('payment_pending','expired') and
    new.status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed') and
    new.address is distinct from old.address then
   raise exception 'delivery address cannot change during payment confirmation';
 end if;
 if tg_op='UPDATE' and old.status not in ('payment_pending','expired') then
   if new.address is distinct from old.address or new.delivery_contact_phone is distinct from old.delivery_contact_phone then
     raise exception 'paid order delivery address and contact are immutable';
   end if;
 end if;
 if new.status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed')
    and (tg_op='INSERT' or (tg_op='UPDATE' and old.status in ('payment_pending','expired'))) then
   select p.phone into v_phone from profiles p where p.user_id=new.user_id;
   if v_phone is null or v_phone !~ '^[+]233[25][0-9]{8}$' then
     raise exception 'verified delivery contact number required before order payment acceptance';
   end if;
   new.delivery_contact_phone:=v_phone;
   new.delivery_contact_snapshot_verified:=true;
 end if;
 return new;
end $$;

-- Every new transition to receipt-confirmed delivered must have a consumed
-- order-bound handover OTP, never a user-facing receipt button or carrier status.
create or replace function elemarket_guard_customer_receipt() returns trigger language plpgsql as $$
begin
 if new.status='delivered' and (tg_op='INSERT' or old.status is distinct from 'delivered') then
   if new.customer_received_at is null or new.delivery_confirmation_source is distinct from 'delivery_otp' or
      not exists(select 1 from order_delivery_handover h where h.order_id=new.id and h.verified_at is not null) then
      raise exception 'rider-triggered delivery OTP receipt required for every order';
   end if;
 end if;
 return new;
end $$;

-- The old customer-confirmation SQL function might still be callable by
-- earlier clients: fail closed, not an alternative method for cheap orders.
create or replace function customer_confirm_order_received(p_order_id text,p_customer_id text)
returns jsonb language plpgsql as $$
begin
 raise exception 'Customer receipt is confirmed only by the assigned rider handover OTP';
end $$;

-- Replace the provider status trigger without requiring a price lookup.
create or replace function elemarket_guard_all_order_job_delivery() returns trigger language plpgsql as $$
begin
 if new.status='delivered' and old.status is distinct from 'delivered' then
   if not exists(select 1 from order_delivery_handover h
      where h.order_id=new.order_id and h.job_id=new.id and h.verified_at is not null) then
     raise exception 'assigned rider OTP verification required before delivery completion';
   end if;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_high_value_job_gate on delivery_jobs;
drop trigger if exists elemarket_all_order_job_gate on delivery_jobs;
create trigger elemarket_all_order_job_gate before update of status on delivery_jobs
 for each row execute function elemarket_guard_all_order_job_delivery();

-- Require active provider and assigned rider to match both initiator and verifier
-- on ALL new order delivery transitions, regardless of monetary amount.
create or replace function elemarket_guard_rider_confirmed_receipt() returns trigger language plpgsql as $$
begin
 if new.status in ('delivered','completed') and
    (tg_op='INSERT' or old.status is distinct from new.status) then
   -- Once receipt was established, completing the order must not depend on
   -- the rider/provider still being active; accounts can be suspended later.
   -- The delivered-state gate already required OTP for all newly delivered
   -- orders. Existing customer-confirmed receipts remain historical only.
   if tg_op='UPDATE' and old.status='delivered' and old.customer_received_at is not null
      and old.delivery_confirmation_source in ('delivery_otp','customer_confirmation')
      and new.status='completed' then
      return new;
   end if;
   if not exists (
     select 1 from order_delivery_handover h
      join delivery_jobs j on j.id=h.job_id and j.order_id=h.order_id
      join delivery_providers p on p.id=j.provider_id and p.status='active'
      join partner_organization_users pu on pu.organization_id=p.partner_organization_id
        and pu.user_id=h.verified_by and pu.status='active' and pu.role='rider'
      join otp_challenges c on c.id=h.challenge_id and c.status='verified'
     where h.order_id=new.id and h.verified_at is not null
       and h.verified_by=h.initiated_by and h.verified_by=j.handover_rider_user_id
       and c.purpose='delivery_handover' and c.user_id=new.user_id
       and c.destination=new.delivery_contact_phone
       and h.issued_at<=h.verified_at and h.verified_at<=c.expires_at
   ) then raise exception 'assigned rider initiated OTP handover required for every order'; end if;
 end if;
 return new;
end $$;

comment on column delivery_jobs.handover_rider_user_id is
 'Assigned authenticated delivery rider; only this person may request and verify receipt OTP on EVERY delivered order.';
comment on function customer_confirm_order_received(text,text) is
 'Deprecated and always blocked: only assigned-rider handover OTP attests receipt for all orders.';
