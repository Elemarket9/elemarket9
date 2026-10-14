-- v1.45 payment-provider selection.
-- ELEMARKET does not operate its own payment network. Customer payment
-- collection is delegated to a configured external provider such as Paystack
-- or Hubtel. Actual safeguarding/settlement remains with the regulated
-- custody provider configured by the marketplace.

insert into payment_providers(id, provider_key, name, method, status) values
  ('pp-paystack-mobile-money','paystack','Paystack','mobile_money','review'),
  ('pp-paystack-card','paystack-card','Paystack Card','card','review'),
  ('pp-hubtel-mobile-money','hubtel','Hubtel','mobile_money','review'),
  ('pp-hubtel-card','hubtel-card','Hubtel Card','card','review')
on conflict (provider_key) do update
set name=excluded.name, method=excluded.method, updated_at=now();

-- Never activate a provider merely because its row exists. Activation requires
-- credentials, webhook verification, sandbox/UAT approval and operations signoff.
comment on table payment_providers is
  'External payment collection providers. Paystack/Hubtel may collect payments; they are not assumed to be the marketplace custody provider.';
