-- Provider-neutral customer financing configuration.
-- ELEMARKET orchestrates applications; the selected financing provider underwrites/funds.
-- No provider is enabled by this migration.

alter table financing_providers
  add column if not exists contribution_basis text not null default 'order_amount'
    check (contribution_basis in ('order_amount','financed_amount'));

create index if not exists financing_providers_neutral_customer_idx
  on financing_providers(audience, product_type, status, plan_mode);

-- Preserve provider-neutral semantics: no provider-specific seed or URL is installed here.
-- A commercial partner may be activated through controlled configuration after due diligence,
-- signed terms, API/webhook validation, settlement/reconciliation testing and compliance approval.

-- Remove any legacy provider-specific seed left by an earlier development build.
delete from financing_providers where lower(provider_key) in ('motito_paysmallsmall', 'motito');
