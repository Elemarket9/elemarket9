-- Configure integration routing without enabling money movement.
-- Existing provider status and merchant account requirements are preserved.
update payment_providers
set driver_key = 'paystack', updated_at = now()
where provider_key in ('paystack', 'paystack-card', 'paystack-bank-transfer');
