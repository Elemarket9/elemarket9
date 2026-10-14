-- v1.71: production integrity hardening.
-- Non-custodial provider settlement remains authoritative. This migration closes
-- database-level configuration drift and hardens security-definer execution.

-- -----------------------------------------------------------------------------
-- 1. Make the non-custodial settlement model the only live default.
-- -----------------------------------------------------------------------------
alter table merchants drop constraint if exists merchants_settlement_model_check;
update merchants
   set settlement_model='provider_direct'
 where settlement_model is null or settlement_model='marketplace_escrow';
alter table merchants
  add constraint merchants_settlement_model_check
  check (settlement_model in ('provider_direct','enterprise_direct')) not valid;
alter table merchants validate constraint merchants_settlement_model_check;
alter table merchants alter column settlement_model set default 'provider_direct';

-- -----------------------------------------------------------------------------
-- 2. Harden security-definer functions against search_path object shadowing.
--    The application DB role still executes these functions through the API;
--    PUBLIC does not receive an additional execution privilege.
-- -----------------------------------------------------------------------------
alter function start_customer_financing_application(text,text,text,text,numeric,text)
  set search_path = pg_catalog, public;
alter function start_merchant_financing_application(text,text,numeric,text)
  set search_path = pg_catalog, public;
alter function recalculate_merchant_health_score(text)
  set search_path = pg_catalog, public;
alter function merchant_health_access_valid(text,text,text)
  set search_path = pg_catalog, public;
alter function calculate_product_listing_quality(text)
  set search_path = pg_catalog, public;

-- -----------------------------------------------------------------------------
-- 3. Prevent direct execution by unrelated database roles. Migrations execute
--    under the application DB principal in the supported deployment model, so
--    restore execution to the current migration principal explicitly.
-- -----------------------------------------------------------------------------
revoke execute on function start_customer_financing_application(text,text,text,text,numeric,text) from public;
revoke execute on function start_merchant_financing_application(text,text,numeric,text) from public;
revoke execute on function recalculate_merchant_health_score(text) from public;
revoke execute on function merchant_health_access_valid(text,text,text) from public;
revoke execute on function calculate_product_listing_quality(text) from public;
grant execute on function start_customer_financing_application(text,text,text,text,numeric,text) to current_user;
grant execute on function start_merchant_financing_application(text,text,numeric,text) to current_user;
grant execute on function recalculate_merchant_health_score(text) to current_user;
grant execute on function merchant_health_access_valid(text,text,text) to current_user;
grant execute on function calculate_product_listing_quality(text) to current_user;

-- -----------------------------------------------------------------------------
-- 4. High-volume live dispute gate indexes. Partial indexes keep the hot path
--    small while retaining historical disputes for audit.
-- -----------------------------------------------------------------------------
create index if not exists customer_order_disputes_active_order_idx
  on customer_order_disputes(order_id,created_at desc)
  where status in ('open','under_review');

create index if not exists customer_order_disputes_protection_window_idx
  on customer_order_disputes(order_id,created_at)
  where created_at is not null;

-- -----------------------------------------------------------------------------
-- 5. Make the financing domain contract explicit at the DB boundary.
-- -----------------------------------------------------------------------------
create or replace function validate_financing_provider_definition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.audience='customer' and new.product_type not in ('bnpl','installment') then
    raise exception 'customer financing providers may only offer bnpl or installment products';
  end if;
  if new.audience='merchant' and new.product_type not in ('merchant_cash_advance','line_of_credit','term_loan') then
    raise exception 'merchant financing providers may only offer merchant financing products';
  end if;
  return new;
end;
$$;

comment on function validate_financing_provider_definition() is
  'Database trust boundary: provider audience and financing product type must remain in the same domain.';
