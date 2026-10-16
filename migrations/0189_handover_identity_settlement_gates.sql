-- Additive, fail-closed controls. Not a claim of provider custody or live call integrations.
-- Reuse the configured SMS OTP adapter, but keep handover codes a distinct,
-- privately callable purpose (not exposed in the generic OTP public endpoint).
alter table otp_challenges drop constraint if exists otp_challenges_purpose_check;
alter table otp_challenges add constraint otp_challenges_purpose_check check
 (purpose in ('signup','login','phone_verification','password_reset','transactional','delivery_handover'));
-- Existing paid orders have NO authoritative historical phone snapshot. Mark them
-- unverified and require recovery before using OTP. Do not rewrite history.
alter table orders add column if not exists delivery_contact_phone text;
alter table orders add column if not exists delivery_contact_snapshot_verified boolean not null default false;
alter table orders drop constraint if exists orders_delivery_confirmation_source_check;
alter table orders add constraint orders_delivery_confirmation_source_check
  check (delivery_confirmation_source is null or delivery_confirmation_source in ('carrier_webhook','customer_confirmation','delivery_otp'));

create table if not exists order_delivery_handover (
 order_id text primary key references orders(id),
 job_id text not null references delivery_jobs(id),
 challenge_id text not null unique references otp_challenges(id),
 issued_at timestamptz not null default now(),
 verified_at timestamptz,
 verified_by text,
 verification_method text not null default 'otp' check(verification_method='otp')
);
create index if not exists order_delivery_handover_job_idx on order_delivery_handover(job_id);

create table if not exists profile_phone_change_requests (
 id text primary key,
 user_id text not null references profiles(user_id),
 old_phone text not null, new_phone text not null,
 status text not null default 'pending_old_call' check(status in ('pending_old_call','needs_recovery','approved','rejected','applied')),
 name_check_status text not null default 'unavailable' check(name_check_status in ('unavailable','matched','mismatch','review')),
 old_number_call_status text not null default 'queued' check(old_number_call_status in ('queued','placed','confirmed','denied','failed')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 completed_at timestamptz,
 check (old_phone <> new_phone)
);
create unique index if not exists profile_phone_change_one_open on profile_phone_change_requests(user_id)
 where status in ('pending_old_call','needs_recovery','approved');
create table if not exists profile_phone_change_call_outbox (
 request_id text primary key references profile_phone_change_requests(id),
 status text not null default 'pending' check (status in ('pending','processing','needs_configuration','completed','failed')),
 attempt_count integer not null default 0,
 last_attempt_at timestamptz,
 created_at timestamptz not null default now()
);

-- Keep the original number until an independently authenticated old-number call
-- AND an authorized identity decision have completed. Normal profile APIs cannot
-- use direct UPDATE to sidestep this gate. Initial phone assignment remains allowed.
create or replace function elemarket_guard_profile_phone_change() returns trigger language plpgsql as $$
begin
 if tg_op='UPDATE' and old.phone is not null and new.phone is distinct from old.phone then
   if not exists(select 1 from profile_phone_change_requests r where r.user_id=old.user_id
     and r.old_phone=old.phone and r.new_phone is not distinct from new.phone
     and r.status='approved' and r.old_number_call_status='confirmed'
     and r.name_check_status in ('matched','review') for update) then
     raise exception 'phone change requires verified old-number call and identity review';
   end if;
   update profile_phone_change_requests set status='applied',completed_at=now(),updated_at=now()
    where user_id=old.user_id and old_phone=old.phone and new_phone is not distinct from new.phone
      and status='approved' and old_number_call_status='confirmed';
 end if;
 return new;
end $$;
drop trigger if exists elemarket_profile_phone_change_gate on profiles;
create trigger elemarket_profile_phone_change_gate before update of phone on profiles
 for each row execute function elemarket_guard_profile_phone_change();

-- Snapshot delivery address already exists in orders; lock that snapshot and
-- the newly captured number once the payment is accepted. On legacy paid orders,
-- the missing phone remains unverified (not silently certified).
create or replace function elemarket_guard_paid_delivery_snapshot() returns trigger language plpgsql as $$
declare v_phone text;
begin
 -- Reject a new high-value checkout WITHOUT a reachable, canonical contact
 -- before any payment provider is asked to collect the money.
 if tg_op='INSERT' and new.grand_total>5000 then
   select p.phone into v_phone from profiles p where p.user_id=new.user_id;
   if v_phone is null or v_phone !~ '^[+]233[25][0-9]{8}$' then
     raise exception 'delivery contact number required before high-value checkout';
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
   if v_phone is not null and v_phone ~ '^[+]233[25][0-9]{8}$' then
     new.delivery_contact_phone:=v_phone;
     new.delivery_contact_snapshot_verified:=true;
   end if;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_paid_order_snapshot_guard on orders;
create trigger elemarket_paid_order_snapshot_guard before insert or update on orders
 for each row execute function elemarket_guard_paid_delivery_snapshot();

-- A delivered state is a receipt attestation, not a self-reported merchant or
-- carrier transition. High-value confirmation MUST be linked to consumed OTP.
create or replace function elemarket_guard_customer_receipt() returns trigger language plpgsql as $$
begin
 if new.status='delivered' and (tg_op='INSERT' or old.status is distinct from 'delivered') then
   if new.customer_received_at is null then raise exception 'customer receipt proof required'; end if;
   if new.grand_total>5000 then
     if new.delivery_confirmation_source is distinct from 'delivery_otp' or
        not exists(select 1 from order_delivery_handover h where h.order_id=new.id
          and h.verified_at is not null) then
       raise exception 'high-value delivery OTP required';
     end if;
   elsif new.delivery_confirmation_source is distinct from 'customer_confirmation' then
     raise exception 'customer receipt confirmation required';
   end if;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_customer_receipt_gate on orders;
create trigger elemarket_customer_receipt_gate before insert or update of status on orders
 for each row execute function elemarket_guard_customer_receipt();

-- Eliminate historical merchant-state-based withdrawal clock; use only the
-- actual customer-confirmed receipt timestamp. This automatically updates every
-- existing eligibility function/view that calls elemarket_order_delivered_at().
create or replace function elemarket_order_delivered_at(p_order_id text)
 returns timestamptz language sql stable as $$
 select customer_received_at from orders where id=p_order_id and
  delivery_confirmation_source in ('customer_confirmation','delivery_otp')
 $$;

-- Reject customer clicks for high-value orders and refuse confirmation when
-- no independent delivery partner has actually marked the job delivered.
create or replace function customer_confirm_order_received(p_order_id text,p_customer_id text)
returns jsonb language plpgsql as $$
declare v_order record; v_now timestamptz;
begin
 select * into v_order from orders where id=p_order_id and user_id=p_customer_id for update;
 if not found then raise exception 'order not found'; end if;
 if v_order.grand_total>5000 then raise exception 'high-value receipt requires delivery OTP'; end if;
 if v_order.status<>'shipped' then raise exception 'order is not awaiting receipt'; end if;
 if not exists(select 1 from delivery_jobs j where j.order_id=v_order.id
   and j.status='delivered' and j.delivered_at is not null and j.proof_of_delivery_url is not null)
 then raise exception 'independent delivery provider confirmation required'; end if;
 v_now:=now();
 update orders set status='delivered',delivery_confirmation_source='customer_confirmation',
   customer_received_at=v_now,updated_at=v_now where id=v_order.id;
 insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note)
 values(v_order.id,v_order.merchant_id,v_order.status,'delivered',p_customer_id,'Customer confirmed provider delivery');
 perform record_audit_event('customer.order.received','order',v_order.id,p_customer_id,'customer',null,'success',jsonb_build_object('source','customer_confirmation'));
 return jsonb_build_object('orderId',v_order.id,'status','delivered','deliveredAt',v_now);
end $$;

-- An operational provider status cannot impersonate customer receipt. For
-- orders > GHS5000 the transition to delivered is only permitted after the
-- handover challenge was consumed by the authenticated delivery workflow.
create or replace function elemarket_guard_high_value_job_delivery() returns trigger language plpgsql as $$
declare v_total numeric;
begin
 if new.status='delivered' and old.status is distinct from 'delivered' then
   select grand_total into v_total from orders where id=new.order_id;
   if v_total>5000 and not exists(select 1 from order_delivery_handover h
      where h.order_id=new.order_id and h.job_id=new.id and h.verified_at is not null) then
     raise exception 'delivery OTP verification required before high-value handover';
   end if;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_high_value_job_gate on delivery_jobs;
create trigger elemarket_high_value_job_gate before update of status on delivery_jobs
 for each row execute function elemarket_guard_high_value_job_delivery();

comment on function elemarket_order_delivered_at(text) is 'Customer-confirmed receipt time; do not use provider/merchant status history for withdrawal eligibility.';
comment on table profile_phone_change_call_outbox is 'Pending old-number verification calls. No call is claimed until a real voice adapter and authenticated callback are provisioned.';
