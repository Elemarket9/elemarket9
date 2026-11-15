-- Money-integrity audit fixes (PR #33).
--
-- H2  A cancelled order kept a payable payment: after an admin cancel, customer
--     cancel or unpaid expiry, a new payment attempt could still be started and
--     paid, capturing cash for an order that no longer exists (and, for a
--     promoted order, giving the discount outside the campaign budget).
--     New payment attempts are now refused once the order is cancelled. A
--     payment the customer had ALREADY started before the cancellation still
--     lands in the existing late-payment reconciliation path.
-- M2  A fully refunded order kept its ELEMARKET-funded promotion redemption as
--     "applied", so the campaign budget stayed spent on sales that never
--     happened (buy -> cancel -> refund could drain a budget). The redemption
--     is now released on refund; the budget trigger returns the amount.
--     Merchant-funded promotions keep their existing behaviour.

create or replace function forbid_payment_attempt_for_cancelled_order() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_status text;
begin
  if new.status not in ('initiated','pending','authorized') then return new; end if;
  select o.status into v_status
    from payments p join orders o on o.id = p.order_id
   where p.id = new.payment_id;
  if v_status = 'cancelled' then
    raise exception 'order is cancelled; payment can no longer be started' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists payment_attempt_cancelled_order_guard on payment_attempts;
create trigger payment_attempt_cancelled_order_guard
  before insert on payment_attempts
  for each row execute function forbid_payment_attempt_for_cancelled_order();

create or replace function release_platform_promotion_on_refund() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status = 'refunded' and old.status is distinct from 'refunded' then
    update promotion_redemptions r
       set status = 'released', released_at = coalesce(r.released_at, now())
      from promotions p
     where r.order_id = new.id and r.status = 'applied'
       and p.id = r.promotion_id and p.funding_source = 'platform';
  end if;
  return new;
end $$;

drop trigger if exists orders_release_platform_promotion_on_refund on orders;
create trigger orders_release_platform_promotion_on_refund
  after update of status on orders
  for each row execute function release_platform_promotion_on_refund();
