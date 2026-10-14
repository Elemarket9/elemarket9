-- Remove the legacy 8-argument compatibility wrapper introduced in 0070.
-- The canonical provider-refund-aware function has 9 arguments, with the ninth
-- parameter defaulting to NULL, so it already accepts legacy 8-argument calls.
-- Keeping a separate 8-argument overload makes PostgreSQL unable to resolve
-- parameterized calls whose arguments arrive as UNKNOWN.
drop function if exists apply_payment_webhook(text,text,text,text,text,numeric,text,text);

comment on function apply_payment_webhook(text,text,text,text,text,numeric,text,text,text) is
  'Canonical provider webhook processor. The provider refund ID is optional for legacy 8-argument callers.';
