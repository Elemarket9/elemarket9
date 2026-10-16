-- Cross-check owned code consumption for all NEW delivery OTP receipt updates.
-- Preserve already-delivered historical receipt records.
create or replace function elemarket_guard_owned_rider_receipt() returns trigger language plpgsql as $$
begin
 if new.status='delivered' and (tg_op='INSERT' or old.status is distinct from new.status) then
  if not exists (
   select 1 from order_delivery_handover h
   join delivery_otp_verifiers v on v.challenge_id=h.challenge_id and v.order_id=h.order_id and v.job_id=h.job_id
   join otp_challenges c on c.id=v.challenge_id and c.status='verified'
   join delivery_jobs j on j.id=v.job_id and j.order_id=v.order_id
   where h.order_id=new.id and h.verified_at is not null and v.consumed_at is not null
     and h.verified_by=v.rider_user_id and h.initiated_by=v.rider_user_id
     and j.handover_rider_user_id=v.rider_user_id and c.purpose='delivery_handover'
     and c.destination=new.delivery_contact_phone and c.user_id=new.user_id
     and h.verified_at <= c.expires_at
  ) then raise exception 'ELEMARKET-owned rider OTP required for delivery receipt'; end if;
 end if;
 return new;
end $$;
drop trigger if exists elemarket_owned_receipt_gate on orders;
create trigger elemarket_owned_receipt_gate before insert or update of status on orders
 for each row execute function elemarket_guard_owned_rider_receipt();
