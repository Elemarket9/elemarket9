-- Enforce rider-initiated delivery OTP: no merchant, customer, provider manager,
-- generic operator or webhook may request/verify the handover challenge.
-- A rider is an explicitly provisioned and assigned active partner member.
alter table partner_organization_users drop constraint if exists partner_organization_users_role_check;
alter table partner_organization_users add constraint partner_organization_users_role_check
 check (role in ('owner','admin','operator','analyst','rider'));
alter table delivery_jobs add column if not exists handover_rider_user_id text;
alter table delivery_jobs add column if not exists handover_rider_assigned_at timestamptz;
create index if not exists delivery_jobs_rider_idx on delivery_jobs(handover_rider_user_id, status)
 where handover_rider_user_id is not null;
alter table order_delivery_handover add column if not exists initiated_by text;
-- Reservation MUST be persisted before contacting the external SMS provider:
-- serializes concurrent rider requests and prevents different codes being bound.
create table if not exists delivery_handover_requests (
 order_id text primary key references orders(id),
 job_id text not null references delivery_jobs(id),
 rider_user_id text not null,
 request_token text not null,
 state text not null check (state in ('issuing','issued','failed')),
 started_at timestamptz not null default now(),
 expires_at timestamptz not null,
 updated_at timestamptz not null default now()
);
create index if not exists delivery_handover_requests_active_idx on delivery_handover_requests(job_id, expires_at);

-- A job rider must be a currently active rider at this provider's organization.
-- Prevent switching an active handover onto an accomplice's account.
create or replace function elemarket_guard_handover_rider_assignment() returns trigger language plpgsql as $$
declare v_org text;
begin
 if new.handover_rider_user_id is distinct from old.handover_rider_user_id then
   if old.status not in ('assigned','accepted','picked_up','in_transit') then
     raise exception 'cannot change rider assignment after delivery';
   end if;
   if exists(select 1 from delivery_handover_requests r where r.job_id=old.id
       and r.state in ('issuing','issued') and r.expires_at>now()) then
     raise exception 'cannot reassign while delivery OTP handover is active';
   end if;
   select partner_organization_id into v_org from delivery_providers where id=new.provider_id;
   if v_org is null or new.handover_rider_user_id is null or not exists (
      select 1 from partner_organization_users pu
       where pu.organization_id=v_org and pu.user_id=new.handover_rider_user_id
         and pu.status='active' and pu.role='rider') then
     raise exception 'handover rider must be an active rider for the assigned provider';
   end if;
   new.handover_rider_assigned_at:=now();
 end if;
 return new;
end $$;
drop trigger if exists elemarket_rider_assignment_gate on delivery_jobs;
create trigger elemarket_rider_assignment_gate before update of handover_rider_user_id on delivery_jobs
 for each row execute function elemarket_guard_handover_rider_assignment();

-- Enforce the rider-only proof even if an alternate SQL path updates the order.
create or replace function elemarket_guard_rider_confirmed_receipt() returns trigger language plpgsql as $$
begin
 if new.status in ('delivered','completed') and (tg_op='INSERT' or old.status is distinct from new.status)
    and new.grand_total>5000 then
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
       and h.issued_at <= h.verified_at and h.verified_at <= c.expires_at
   ) then raise exception 'assigned rider initiated OTP handover required'; end if;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_rider_receipt_gate on orders;
create trigger elemarket_rider_receipt_gate before insert or update of status on orders
 for each row execute function elemarket_guard_rider_confirmed_receipt();

comment on column delivery_jobs.handover_rider_user_id is 'Assigned authenticated delivery rider; only that person may request and verify high-value receipt OTP.';

-- The OTP threshold is computed from a paid order. Guard against changing its
-- total or principals post-payment to force the order below GH₵5,000.
create or replace function elemarket_guard_paid_order_economics() returns trigger language plpgsql as $$
begin
 if old.status not in ('payment_pending','expired') and (
   new.grand_total is distinct from old.grand_total or
   new.product_total is distinct from old.product_total or
   new.delivery_total is distinct from old.delivery_total or
   new.platform_fee is distinct from old.platform_fee or
   new.merchant_net is distinct from old.merchant_net or
   new.currency is distinct from old.currency or
   new.user_id is distinct from old.user_id or
   new.merchant_id is distinct from old.merchant_id or
   new.group_id is distinct from old.group_id or
   new.delivery_tier is distinct from old.delivery_tier or
   new.delivery_quote_id is distinct from old.delivery_quote_id
 ) then raise exception 'paid order economic and identity snapshot is immutable'; end if;
 return new;
end $$;
drop trigger if exists elemarket_paid_order_economics_gate on orders;
create trigger elemarket_paid_order_economics_gate before update on orders
 for each row execute function elemarket_guard_paid_order_economics();

create or replace function elemarket_guard_handover_delivery_job() returns trigger language plpgsql as $$
begin
 if new.order_id is distinct from old.order_id then
   raise exception 'delivery job order identity cannot change';
 end if;
 if new.provider_id is distinct from old.provider_id then
   if exists(select 1 from delivery_handover_requests r
      where r.job_id=old.id and r.state in ('issuing','issued') and r.expires_at>now()) then
     raise exception 'cannot change delivery provider during an active OTP handover';
   end if;
   -- A new provider must explicitly assign its own rider.
   new.handover_rider_user_id:=null;
   new.handover_rider_assigned_at:=null;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_handover_job_identity_gate on delivery_jobs;
create trigger elemarket_handover_job_identity_gate before update on delivery_jobs
 for each row execute function elemarket_guard_handover_delivery_job();

-- Confirmed receipt cannot be backdated to prematurely pass the 24-hour hold.
-- Nor can an order jump straight to completed without valid receipt.
create or replace function elemarket_guard_receipt_clock_and_terminal_state() returns trigger language plpgsql as $$
begin
 if old.customer_received_at is not null and
   (new.customer_received_at is distinct from old.customer_received_at or
    new.delivery_confirmation_source is distinct from old.delivery_confirmation_source) then
   raise exception 'confirmed receipt clock and proof source are immutable';
 end if;
 if new.status='completed' and old.status is distinct from 'completed' and
    (old.status<>'delivered' or old.customer_received_at is null or
      old.delivery_confirmation_source not in ('delivery_otp','customer_confirmation')) then
   raise exception 'order completion requires previously verified receipt';
 end if;
 return new;
end $$;
drop trigger if exists elemarket_receipt_clock_guard on orders;
create trigger elemarket_receipt_clock_guard before update on orders
 for each row execute function elemarket_guard_receipt_clock_and_terminal_state();
