-- Remove indexes that are exact duplicates of another index on the same table
-- (same columns, order, uniqueness and predicate). Each duplicate cost a second
-- write on every insert/update and protected nothing extra. The surviving twin
-- is named on each line. Constraint-backed indexes are the ones kept.
drop index if exists brand_integration_product_map_stale_idx;      -- = brand_integration_product_map_snapshot_idx
drop index if exists customer_financing_application_owner_idx;     -- = customer_financing_user_idx
drop index if exists merchant_financing_application_owner_idx;     -- = merchant_financing_merchant_idx
drop index if exists settlement_provider_reference_uq;             -- = merchant_settlements_provider_ref_uq
drop index if exists payment_attempts_payment_attempt_no_uq;       -- = payment_attempts_payment_id_attempt_no_key (constraint)
drop index if exists payment_attempts_provider_ref_uq;             -- = payment_attempts_provider_reference_uq
drop index if exists payment_attempt_provider_reference_uq;        -- = payment_attempts_provider_reference_uq

-- Stale function overloads left behind when a newer signature replaced them.
-- evaluate_checkout_risk(4 args) was a complete, older copy of the fraud scoring
-- rules (no order reference, different rule set) that could drift from the one
-- checkout really uses (5 args). Its only caller was dead application code,
-- removed in the same change. create_pending_order(7 args) was an unused
-- wrapper around the real 8-argument checkout function.
drop function if exists evaluate_checkout_risk(text, text, numeric, numeric);
drop function if exists create_pending_order(text, text, text, jsonb, jsonb, text, text);
