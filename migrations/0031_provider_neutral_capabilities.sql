-- Provider-neutral payment capabilities. The core never selects a vendor by name.
-- Operational configuration determines which active provider is used and which
-- merchant-account capability it requires.
alter table payment_providers
  add column if not exists requires_merchant_account boolean not null default false,
  add column if not exists supports_webhook_verification boolean not null default true;

-- Paystack may use merchant subaccounts, but this is capability data rather
-- than business logic in the checkout engine. Other providers can be enabled
-- with their own capability profile.
update payment_providers set requires_merchant_account = true
where provider_key in ('paystack','paystack-card','paystack-bank-transfer');

comment on column payment_providers.requires_merchant_account is
  'Provider capability: an active merchant provider account must exist before checkout can start.';
